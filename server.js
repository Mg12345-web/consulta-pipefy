import express from "express";

const app = express();
const PORT = process.env.PORT || 8080;

// rota inicial
app.get("/", (req, res) => {
  res.send("🚀 Servidor de teste rodando no Railway!");
});

// rota extra para confirmar
app.get("/ping", (req, res) => {
  res.json({
    pong: true,
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
});
