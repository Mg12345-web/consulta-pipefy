import express from "express";
import "dotenv/config";
import fetch from "node-fetch";
import https from "https";

const app = express();
const PORT = process.env.PORT || 8080;
const PIPEFY_GQL = "https://api.pipefy.com/graphql";

// servir arquivos estáticos (./public)
app.use(express.static("public", { etag: false, lastModified: false, maxAge: 0 }));

// ------------------------- helpers -------------------------
const authHeaders = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${process.env.PIPEFY_TOKEN}`,
};

// HTTP keep-alive para acelerar chamadas GraphQL
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

// Timeout das requisições GraphQL (ms)
const GQL_TIMEOUT_MS = Number(process.env.GQL_TIMEOUT_MS || 15000);

// Cache simples em memória (TTL em ms)
const CACHE_MS = Number(process.env.CACHE_MS || 20000);
const cache = new Map(); // key -> { data, expiresAt }
const getCache = (key) => {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.data;
  cache.delete(key);
  return null;
};
const setCache = (key, data, ttl = CACHE_MS) =>
  cache.set(key, { data, expiresAt: Date.now() + ttl });

async function gql(query, variables = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), GQL_TIMEOUT_MS);
  try {
    const r = await fetch(PIPEFY_GQL, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ query, variables }),
      agent: keepAliveAgent,
      signal: ctrl.signal,
    });
    const j = await r.json();
    return j; // { data, errors? }
  } finally {
    clearTimeout(t);
  }
}

const onlyDigits = (s = "") => s.replace(/\D/g, "");

const mapAnexos = (att = []) =>
  att
    .map((a) => {
      const url = a?.url || "";
      const filename = decodeURIComponent(url.split("?")[0].split("/").pop() || "");
      return {
        filename: filename || null,
        url,
        createdAt: a?.createdAt || null,
        // flag simples por nome (reforçamos depois com o código do AIT)
        isAIT: /(^|[^a-z])ait([^a-z]|$)/i.test(filename),
      };
    })
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

// ------------------------- rotas básicas -------------------------
app.get("/", (_req, res) => {
  res.send("Servidor rodando com sucesso 🚀");
});

// Teste rápido de acesso ao primeiro pipe
app.get("/api/teste", async (_req, res) => {
  try {
    const firstPipeId = (process.env.PIPE_IDS || "").split(",")[0]?.trim();
    if (!firstPipeId) return res.status(400).json({ error: "Defina PIPE_IDS no .env" });

    const query = `query($id: ID!) { pipe(id: $id) { id name } }`;
    const j = await gql(query, { id: firstPipeId });
    return res.status(j.errors ? 502 : 200).json(j);
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// Anexos por card (id -> anexos)
app.get("/api/anexos-by-card", async (req, res) => {
  try {
    const cardId = (req.query.id || "").trim();
    if (!cardId) return res.status(400).json({ error: "Passe ?id=ID_DO_CARD" });

    const query = `
      query($id: ID!) {
        card(id: $id) {
          id
          title
          attachments { url createdAt }
        }
      }
    `;
    const j = await gql(query, { id: cardId });
    if (j.errors) return res.status(502).json(j);

    const card = j.data?.card || null;
    const anexos = mapAnexos(card?.attachments || []);

   return res.json({
  cardId: card?.id || null,
  title: card?.title || null,
  protocolo: anexos[0] || null,  // <- só o último
});
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// Descobrir campo conector "cliente" no pipe
app.get("/api/discover-clientes", async (_req, res) => {
  try {
    const firstPipeId = (process.env.PIPE_IDS || "").split(",")[0]?.trim();
    if (!firstPipeId) return res.status(400).json({ error: "Defina PIPE_IDS no .env" });

    const query = `
      query($id: ID!) {
        pipe(id: $id) {
          id
          name
          start_form_fields { id label type options }
        }
      }
    `;
    const j = await gql(query, { id: firstPipeId });
    if (j.errors) return res.status(502).json(j);

    const sff = j.data?.pipe?.start_form_fields || [];
    const connector =
      sff.find((f) => f.id === (process.env.CLIENTE_CONNECTOR_ID || "cliente")) ||
      sff.find((f) => f.type === "connector" && /cliente/i.test(f.label || ""));

    return res.json({
      pipe: { id: j.data?.pipe?.id, name: j.data?.pipe?.name },
      connector_detectado: connector || null,
      dica: "Se connector_detectado.options tiver tableId/databaseId, copie para CLIENTES_TABLE_ID no .env",
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// Campos da tabela Clientes (para achar CPF)
app.get("/api/clientes-fields", async (_req, res) => {
  try {
    const tableId = (process.env.CLIENTES_TABLE_ID || "").trim();
    if (!tableId) return res.status(400).json({ error: "Defina CLIENTES_TABLE_ID no .env" });

    const query = `
      query($id: ID!) {
        table(id: $id) {
          id
          name
          table_fields { id label type description }
        }
      }
    `;
    const j = await gql(query, { id: tableId });
    return res.status(j.errors ? 502 : 200).json(j);
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// ------------------------- rota principal: CPF -> anexos (+ AIT) -------------------------
/**
 * CPF -> cliente (tabela) -> cards conectados nos pipes -> anexos + AIT
 * Estratégia:
 *   - 1ª passada rápida por conector (paralela e paginada)
 *   - se nada encontrado e deep ≠ 0: fallback automático varrendo phases
 * Flags:
 *   deep=0 (só rápida) | deep=1 (força profundo) | padrão = auto-fallback
 *   nocache=1 (ignora cache) | debug=1 (métricas)
 * GET /api/anexos?cpf=103.142.726-07
 */
app.get("/api/anexos", async (req, res) => {
  const t0 = Date.now();
  try {
    const cpfInput = (req.query.cpf || "").trim();
    const deepParam = String(req.query.deep || "auto"); // "0" | "1" | "auto"
    const noCache = String(req.query.nocache || "") === "1";
    const debugFlag = String(req.query.debug || "") === "1";
    if (!cpfInput) return res.status(400).json({ error: "Passe ?cpf=NUMERO (com ou sem pontuação)" });

    const tableId = (process.env.CLIENTES_TABLE_ID || "").trim();
    const cpfFieldId = (process.env.CPF_FIELD_ID || "").trim();
    const AIT_FIELD_ID = (process.env.AIT_FIELD_ID || "").trim(); // opcional
    const pipeIds = (process.env.PIPE_IDS || "").split(",").map((x) => x.trim()).filter(Boolean);

    if (!tableId || pipeIds.length === 0) {
      return res.status(400).json({ error: "Config .env incompleta (CLIENTES_TABLE_ID / PIPE_IDS)" });
    }

    // cache (chave = parâmetros relevantes)
    const cacheKey = `anexos:${cpfInput}|deep=${deepParam}`;
    if (!noCache) {
      const cached = getCache(cacheKey);
      if (cached) {
        if (debugFlag) cached.debug = { ...(cached.debug || {}), fromCache: true, timeMs: Date.now() - t0 };
        return res.json(cached);
      }
    }

    // ---- localizar cliente (por campo CPF e/ou por título com paginação) ----
    async function buscaClientePorCampo(valorExato) {
      if (!cpfFieldId) return null;
      const query = `
        query($tableId: ID!, $cpfFieldId: ID!, $cpf: String!) {
          table_record_search(table_id: $tableId, field_id: $cpfFieldId, field_value: $cpf, first: 1) {
            edges { node { id title } }
          }
        }
      `;
      const j = await gql(query, { tableId, cpfFieldId, cpf: valorExato });
      return j.data?.table_record_search?.edges?.[0]?.node || null;
    }

    async function buscaClientePorTitulo(tituloCPF, digitsCPF) {
      let after = null;
      for (let i = 0; i < 50; i++) {
        const query = `
          query($id: ID!, $first: Int!, $after: String) {
            table(id: $id) {
              table_records(first: $first, after: $after) {
                pageInfo { hasNextPage endCursor }
                edges { node { id title } }
              }
            }
          }
        `;
        const j = await gql(query, { id: tableId, first: 100, after });
        const edges = j.data?.table?.table_records?.edges || [];

        let found = edges.map((e) => e.node).find((n) => (n.title || "").trim() === tituloCPF);
        if (found) return found;

        if (digitsCPF) {
          found = edges.map((e) => e.node).find((n) => onlyDigits(n.title) === digitsCPF);
          if (found) return found;
        }

        const pageInfo = j.data?.table?.table_records?.pageInfo;
        if (!pageInfo?.hasNextPage) break;
        after = pageInfo.endCursor;
      }
      return null;
    }

    const digits = onlyDigits(cpfInput);
    let cliente = await buscaClientePorCampo(cpfInput);
    if (!cliente && digits && digits !== cpfInput) cliente = await buscaClientePorCampo(digits);
    if (!cliente) cliente = await buscaClientePorTitulo(cpfInput, digits);
    if (!cliente) {
      const empty = { cpf: cpfInput, found: false, msg: "Cliente não encontrado na tabela Clientes" };
      if (!noCache) setCache(cacheKey, empty);
      return res.json(empty);
    }

    // ---- queries (com fields para extrair AIT sem chamada extra) ----
    const Q_PIPE_BY_CONNECTOR = `
      query($pipeId: ID!, $recordId: ID!, $first: Int!, $after: String) {
        pipe(id: $pipeId) {
          cards(first: $first, after: $after, search: { table_record_ids: [$recordId] }) {
            pageInfo { hasNextPage endCursor }
            edges { node {
              id
              title
              fields { value field { id label type } }
              attachments { url createdAt }
            } }
          }
        }
      }
    `;
    const Q_PIPE_PHASES = `
      query($pipeId: ID!) { pipe(id: $pipeId) { id name phases { id name } } }
    `;
    const Q_PHASE_CARDS = `
      query($phaseId: ID!, $first: Int!, $after: String) {
        phase(id: $phaseId) {
          cards(first: $first, after: $after) {
            pageInfo { hasNextPage endCursor }
            edges { node {
              id
              title
              fields { value field { id label type } }
              attachments { url createdAt }
            } }
          }
        }
      }
    `;

    async function coletaCardsDePipe(pipeId, deepScan) {
      // 1) por conector
      const edgesConnector = [];
      let after = null;
      for (let i = 0; i < 50; i++) {
        const j = await gql(Q_PIPE_BY_CONNECTOR, { pipeId, recordId: cliente.id, first: 100, after });
        const block = j.data?.pipe?.cards?.edges || [];
        edgesConnector.push(...block);
        const pi = j.data?.pipe?.cards?.pageInfo;
        if (!pi?.hasNextPage) break;
        after = pi.endCursor;
      }

      // 2) por fases (opcional)
      const edgesPhase = [];
      if (deepScan) {
        const phasesJson = await gql(Q_PIPE_PHASES, { pipeId });
        const phases = phasesJson.data?.pipe?.phases || [];
        for (const ph of phases) {
          let afterP = null;
          for (let i = 0; i < 50; i++) {
            const j = await gql(Q_PHASE_CARDS, { phaseId: ph.id, first: 100, after: afterP });
            const list = j.data?.phase?.cards?.edges || [];
            const filtered = list.filter((e) => {
              const t = (e.node?.title || "").trim();
              return t.includes(cpfInput) || (digits && t.replace(/\D/g, "").includes(digits));
            });
            edgesPhase.push(...filtered);
            const pi = j.data?.phase?.cards?.pageInfo;
            if (!pi?.hasNextPage) break;
            afterP = pi.endCursor;
          }
        }
      }

      // unir & deduplicar
      const edges = [...edgesConnector, ...edgesPhase];
      const seen = new Set();
      const cards = [];
      for (const e of edges) {
        const n = e.node;
        if (!n?.id || seen.has(n.id)) continue;
        seen.add(n.id);
        cards.push(n);
      }
      return { cards, counts: { byConnector: edgesConnector.length, byTitleViaPhases: edgesPhase.length } };
    }

    function montar(cards, pipeId) {
  return cards.map((card) => {
    const anexos = mapAnexos(card.attachments);

    // pega somente o último (mais recente)
    const ultimo = anexos[0] || null;

    return {
      pipeId,
      cardId: card.id,
      title: card.title,
      protocolo: ultimo,   // <- aqui já vem só o protocolo
    };
  });
}

        // extrair AIT dos fields
        let aitValue = null;
        if (AIT_FIELD_ID) {
          const byId = (card.fields || []).find((f) => (f.field?.id || "") === AIT_FIELD_ID);
          if (byId) aitValue = byId.value || null;
        }
        if (!aitValue) {
          const byLabel = (card.fields || []).find((f) => /(^|\W)ait(\W|$)/i.test(f.field?.label || ""));
          if (byLabel) aitValue = byLabel.value || null;
        }

        let anexoAIT = null;
        if (aitValue) {
          const code = String(aitValue).toUpperCase();
          anexoAIT = anexos.find((a) => (a.filename || "").toUpperCase().includes(code)) || null;
          anexos.forEach((a) => {
            if ((a.filename || "").toUpperCase().includes(code)) a.isAIT = true;
          });
        }

        return {
          pipeId,
          cardId: card.id,
          title: card.title,
          ait: aitValue || null,
          anexoAIT,
          ultimoAnexo: anexos[0] || null,
          anexos,
        };
      });
    }

    // Modo deep: "0" (off), "1" (force), "auto" (fallback)
    const deepForce = deepParam === "1";
    const deepOff = deepParam === "0";

    // 1ª passada rápida (deep=false), paralela
    let results = await Promise.all(pipeIds.map((id) => coletaCardsDePipe(id, deepForce)));
    let cardsResult = [];
    results.forEach(({ cards }, idx) => (cardsResult = cardsResult.concat(montar(cards, pipeIds[idx]))));

    // fallback automático se nada encontrado e deep ≠ 0
    let deepAutoUsed = false;
    if (!cardsResult.length && !deepOff && !deepForce) {
      deepAutoUsed = true;
      results = await Promise.all(pipeIds.map((id) => coletaCardsDePipe(id, true)));
      cardsResult = [];
      results.forEach(({ cards }, idx) => (cardsResult = cardsResult.concat(montar(cards, pipeIds[idx]))));
    }

    const response = { cpf: cpfInput, cliente, cards: cardsResult };
    if (debugFlag) {
      response.debug = {
        perPipe: results.map((r, i) => ({ pipeId: pipeIds[i], ...r.counts })),
        timeMs: Date.now() - t0,
        deepMode: deepForce ? "force" : deepOff ? "off" : deepAutoUsed ? "auto-fallback" : "fast",
        fromCache: false,
      };
    }

    if (!noCache) setCache(cacheKey, response);
    return res.json(response);
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});


