// Domera: сервер для ИИ-помощников. Ключ OpenRouter хранится в Netlify,
// в переменной окружения OPENROUTER_KEY (в коде ключа нет).
const PREFER = [/llama-3\.3-70b/i, /gemma-3-27b/i, /qwen.*(72b|32b|235b)/i, /deepseek.*(chat|v3)/i, /mistral-small/i, /gemini.*flash/i];
let modelCache = { t: 0, ids: [] };

function getKey() {
  try { if (globalThis.Netlify && Netlify.env) { const k = Netlify.env.get('OPENROUTER_KEY'); if (k) return k; } } catch (e) {}
  return process.env.OPENROUTER_KEY || '';
}

async function freeModels() {
  if (modelCache.ids.length && Date.now() - modelCache.t < 6 * 3600e3) return modelCache.ids;
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models');
    const j = await r.json();
    const free = (j.data || []).filter(m => /:free$/.test(m.id) && (m.context_length || 0) >= 8000 &&
      !(m.architecture && m.architecture.output_modalities && !m.architecture.output_modalities.includes('text'))).map(m => m.id);
    const ranked = [];
    PREFER.forEach(re => free.forEach(id => { if (re.test(id) && !ranked.includes(id)) ranked.push(id); }));
    free.forEach(id => { if (!ranked.includes(id)) ranked.push(id); });
    if (ranked.length) modelCache = { t: Date.now(), ids: ranked };
  } catch (e) {}
  return modelCache.ids.length ? modelCache.ids : ['meta-llama/llama-3.3-70b-instruct:free'];
}

function extractJson(t) {
  t = String(t || '').replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(t); } catch (e) {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
  return undefined;
}

const J = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export default async (req) => {
  const key = getKey();
  if (req.method === 'GET') return J({ ok: true, hasKey: !!key });
  if (req.method !== 'POST') return J({ error: 'method' }, 405);
  if (!key) return J({ code: 'sampling_disabled', error: 'no key' }, 500);
  let body; try { body = await req.json(); } catch (e) { return J({ code: 'bad', error: 'bad json' }, 400); }
  const prompt = String(body.prompt || '').slice(0, 14000);
  if (!prompt) return J({ code: 'bad', error: 'empty' }, 400);
  const wantJson = !!body.json;
  const models = (await freeModels()).slice(0, 3);
  const sys = 'Ты помощник приложения Domera для подбора интерьера. Пиши по-русски.' + (wantJson ? ' Отвечай строго одним JSON-объектом без пояснений и без markdown.' : '');
  let lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'HTTP-Referer': new URL(req.url).origin, 'X-Title': 'Domera' },
        body: JSON.stringify({ models, messages: [{ role: 'system', content: sys }, { role: 'user', content: prompt }], temperature: 0.6, max_tokens: 1200 })
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 429) return J({ code: 'rate_limited', error: 'limit' }, 429);
      if (!r.ok) { lastErr = (j.error && j.error.message) || ('http ' + r.status); continue; }
      const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '';
      if (!text) { lastErr = 'empty'; continue; }
      if (!wantJson) return J({ text });
      const data = extractJson(text);
      if (data && typeof data === 'object') return J({ data, model: j.model });
      lastErr = 'invalid json';
    } catch (e) { lastErr = String(e && e.message || e); }
  }
  return J({ code: lastErr === 'invalid json' ? 'invalid_json' : 'error', error: lastErr }, 502);
};

export const config = { path: '/api/ai' };
