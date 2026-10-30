// Minimal OpenAI-compatible chat client with tool calling. No SDK needed.
const cfg = require('./env');
const A = cfg.ai;
const enabled = () => !!A.key;

async function chat(messages, { tools } = {}) {
  const body = { model: A.model, messages, temperature: 0.2 };
  if (tools && tools.length) body.tools = tools;
  const r = await fetch(A.base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + A.key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('AI request failed (' + r.status + '): ' + ((j.error && j.error.message) || ''));
  return j.choices[0].message;
}

async function askJson(system, user) {
  const m = await chat([
    { role: 'system', content: system + ' Reply with only one JSON object, no prose, no code fences.' },
    { role: 'user', content: user },
  ]);
  const s = m.content || '';
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error('AI did not return JSON');
  return JSON.parse(s.slice(a, b + 1));
}

module.exports = { enabled, chat, askJson };
