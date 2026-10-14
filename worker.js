// Backend da Lume — Cloudflare Worker + Gemini (plano gratuito)
// A chave fica no segredo GEMINI_KEY (nunca no front-end).

// Se algum modelo mudar de nome, é só trocar aqui.
// Lista atual em: https://ai.google.dev/gemini-api/docs/models
const MODELS = {
  rapido: 'gemini-2.5-flash-lite',
  equilibrado: 'gemini-2.5-flash',
  profundo: 'gemini-2.5-flash'
};

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

    const model = MODELS[body.mode] || MODELS.equilibrado;

    const payload = {
      systemInstruction: { parts: [{ text: String(body.system || '') }] },
      contents: toGemini(body.messages || []),
      generationConfig: {}
    };

    if (body.mode === 'profundo') {
      payload.generationConfig.thinkingConfig = { thinkingBudget: 8192 };
    }

    const upstream = await fetch(
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

    if (!upstream.ok) {
      let msg = `Erro ${upstream.status} do Gemini`;
      try {
        const e = await upstream.json();
        if (e?.error?.message) msg = e.error.message;
      } catch {}
      if (upstream.status === 429) {
        msg = 'Limite gratuito atingido. Espere um pouco e tente de novo.';
      }
      return json({ error: msg }, upstream.status);
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
