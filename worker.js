// Backend da Lume — Cloudflare Worker + Gemini (plano gratuito)
// A chave fica no segredo GEMINI_KEY (nunca no front-end).

// Cada modo tem uma lista de modelos: se o primeiro estiver sobrecarregado
// ou no limite, o servidor tenta o próximo automaticamente.
// Lista atual em: https://ai.google.dev/gemini-api/docs/models
const MODELS = {
  rapido: ['gemini-2.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-2.5-flash'],
  equilibrado: ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  profundo: ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']
};

// Erros temporários: vale tentar outro modelo
const RETRY_STATUS = [429, 500, 502, 503, 504];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Converte o formato do front-end (estilo Claude) para o do Gemini
function toGemini(messages) {
  return messages.map((m) => {
    const role = m.role === 'assistant' ? 'model' : 'user';

    if (typeof m.content === 'string') {
      return { role, parts: [{ text: m.content }] };
    }

    const parts = (m.content || []).map((block) => {
      if (block.type === 'image') {
        return {
          inlineData: {
            mimeType: block.source.media_type,
            data: block.source.data
          }
        };
      }
      return { text: block.text || '' };
    });

    return { role, parts };
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === '/api/health') {
      return json({ ok: true });
    }

    if (url.pathname !== '/api/chat' || request.method !== 'POST') {
      return json({ error: 'Rota não encontrada.' }, 404);
    }

    if (!env.GEMINI_KEY) {
      return json({ error: 'Chave GEMINI_KEY não configurada no servidor.' }, 500);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Requisição inválida.' }, 400);
    }

    const candidates = MODELS[body.mode] || MODELS.equilibrado;

    const basePayload = {
      systemInstruction: { parts: [{ text: String(body.system || '') }] },
      contents: toGemini(body.messages || [])
    };

    let upstream = null;
    let lastStatus = 500;
    let lastMsg = 'Erro desconhecido.';

    for (let i = 0; i < candidates.length; i++) {
      const model = candidates[i];

      const payload = { ...basePayload, generationConfig: {} };
      if (body.mode === 'profundo' && !model.includes('lite')) {
        payload.generationConfig.thinkingConfig = { thinkingBudget: 8192 };
      }

      let res;
      try {
        res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': env.GEMINI_KEY
            },
            body: JSON.stringify(payload)
          }
        );
      } catch {
        lastStatus = 502;
        lastMsg = 'Não consegui falar com o Gemini.';
        continue;
      }

      if (res.ok) {
        upstream = res;
        break;
      }

      lastStatus = res.status;
      try {
        const e = await res.json();
        if (e?.error?.message) lastMsg = e.error.message;
      } catch {}

      // Erro que não é temporário (chave errada, pedido inválido): não adianta tentar outro
      if (!RETRY_STATUS.includes(res.status)) break;

      await sleep(400);
    }

    if (!upstream) {
      if (lastStatus === 429) {
        lastMsg = 'Limite gratuito atingido. Espere um pouco e tente de novo.';
      } else if (RETRY_STATUS.includes(lastStatus)) {
        lastMsg = 'Os modelos estão sobrecarregados agora. Tente de novo em alguns segundos.';
      }
      return json({ error: lastMsg }, lastStatus);
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const send = (controller, obj) =>
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

    const stream = new ReadableStream({
      async start(controller) {
        const reader = upstream.body.getReader();
        let buffer = '';

        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const raw of lines) {
              const line = raw.trim();
              if (!line.startsWith('data:')) continue;

              const data = line.slice(5).trim();
              if (!data) continue;

              let chunk;
              try {
                chunk = JSON.parse(data);
              } catch {
                continue;
              }

              if (chunk.promptFeedback?.blockReason) {
                send(controller, { error: 'Mensagem bloqueada pelo filtro de segurança.' });
                continue;
              }

              const parts = chunk.candidates?.[0]?.content?.parts || [];
              for (const p of parts) {
                if (p.text && !p.thought) send(controller, { t: p.text });
              }
            }
          }
        } catch (err) {
          send(controller, { error: 'Conexão interrompida.' });
        }

        controller.close();
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...CORS
      }
    });
  }
};
