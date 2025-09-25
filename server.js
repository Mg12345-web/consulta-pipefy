import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

// rota inicial
app.get("/", (req, res) => {
  res.send("🚀 Servidor de teste rodando no Railway!");
});

// rota extra para confirmar
app.get("/ping", (req, res) => {
  res.json({ pong: true, timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`✅ Servidor de teste rodando na porta ${PORT}`);
});
