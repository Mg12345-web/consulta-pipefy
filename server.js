import express from "express";

const app = express();
// REMOVA o || 8080
const PORT = process.env.PORT; 

// ... rotas ...

// Assegure-se de que a porta seja um número
const serverPort = parseInt(PORT || 3000); 

// Adicione um fallback para 3000 (ou o que quiser) se PORT for undefined (nunca deve ser no Railway)
app.listen(serverPort, "0.0.0.0", () => {
    console.log(`Servidor rodando na porta ${serverPort}`);
});
