// /api/chat.js — Função serverless do Vercel
// Recebe a pergunta do usuário, injeta o conteúdo do case no system prompt,
// chama a API da Anthropic com streaming, e devolve o texto em tempo real.
// A API key fica escondida aqui, nunca no navegador.

const fs = require("fs");
const path = require("path");

let CASE_TEXT = "";
try {
  CASE_TEXT = fs.readFileSync(path.join(process.cwd(), "api", "case_text.txt"), "utf-8");
} catch (e) {
  console.error("Não consegui ler case_text.txt:", e);
}

const SYSTEM_PROMPT = `Você é o assistente do "Jota People OS", um case de estratégia de People (RH) preparado por Leandro, candidato a Head of People do Jota (fintech brasileira de IA para pequenos negócios).

Sua função é responder perguntas da banca e do time do Jota SOMENTE com base no conteúdo do case abaixo. Regras:

- Responda em português do Brasil, de forma clara, direta e com o tom profissional e caloroso do próprio documento.
- Use APENAS as informações do case abaixo. Se a resposta não estiver no material, diga com honestidade que aquele ponto não é coberto pelo case e sugira a seção mais próxima que existe.
- Nunca invente números, nomes de empresas ou fatos que não estejam no texto.
- Quando fizer sentido, aponte em qual capítulo do case a resposta vive (ex.: "isso está no capítulo de Atração", "veja a seção People + IA").
- Formate para um chat estreito: NÃO use cabeçalhos markdown (#, ##, ###) — não cabem bem numa bolha de chat. Use **negrito** para destacar um termo ou título curto dentro do parágrafo, e listas com moderação. Prefira listas simples a tabelas quando possível; só use tabelas markdown quando os dados forem genuinamente tabulares (ex.: várias colunas de dados).
- Seja conciso por padrão — 3 a 6 frases costuma bastar; aprofunde só quando a pergunta pedir claramente.
- Se perguntarem algo fora do escopo do case (assuntos gerais, outras empresas, opinião pessoal), redirecione gentilmente para o conteúdo do case.

=== CONTEÚDO COMPLETO DO CASE ===

${CASE_TEXT}

=== FIM DO CASE ===`;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "API key não configurada no servidor." });
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  } catch (e) {
    return res.status(400).json({ error: "Corpo da requisição inválido." });
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) {
    return res.status(400).json({ error: "Nenhuma mensagem enviada." });
  }

  const trimmed = messages.slice(-10);
  const last = trimmed[trimmed.length - 1];
  if (last && typeof last.content === "string") {
    last.content = [
      { type: "text", text: last.content, cache_control: { type: "ephemeral" } },
    ];
  }

  let upstream;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 700,
        stream: true,
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: trimmed,
      }),
    });
  } catch (err) {
    console.error("Erro ao chamar a Anthropic:", err);
    return res.status(502).json({ error: "Não consegui falar com o assistente agora. Tente de novo." });
  }

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => "");
    console.error("Erro da Anthropic:", upstream.status, errText);
    return res.status(502).json({ error: "O assistente está indisponível no momento. Tente de novo em instantes." });
  }

  // Streaming de verdade: repassa o texto para o navegador conforme chega
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop(); // guarda linha incompleta para o próximo pedaço

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (!payload || payload === "[DONE]") continue;

        let evt;
        try {
          evt = JSON.parse(payload);
        } catch {
          continue;
        }

        if (evt.type === "content_block_delta" && evt.delta && evt.delta.type === "text_delta") {
          res.write(evt.delta.text);
        }
        if (evt.type === "error") {
          console.error("Erro de stream da Anthropic:", evt.error);
        }
      }
    }
  } catch (err) {
    console.error("Erro ao ler o stream:", err);
  }

  res.end();
};
