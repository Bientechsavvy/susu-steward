// Susu Steward server: zero npm dependencies (Node 22.13+).
const http = require('http');
const fs = require('fs');
const path = require('path');
const cfg = require('./lib/env');
const { HttpError } = require('./lib/errors');
const { get, run } = require('./lib/db');
const C = require('./lib/circles');
const planner = require('./lib/planner');
const payouts = require('./lib/payouts');
const steward = require('./lib/steward');
const demo = require('./lib/demo');
const paypal = require('./lib/paypal');
const ai = require('./lib/ai');

const routes = [];
const add = (m, p, h) => routes.push({ m, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), h });

// ---- auth helpers: one token per member; the organizer is the owner member ----
function who(c, headers) {
  const t = headers['x-token'];
  if (!t) return null;
  return get('SELECT * FROM members WHERE circle_id=? AND token=?', c.id, String(t)) || null;
}
function needMember(c, headers) {
  const m = who(c, headers);
  if (!m) throw new HttpError(401, 'Join the circle first (missing or wrong token)');
  return m;
}
function needOwner(c, headers) {
  const m = needMember(c, headers);
  if (m.id !== c.owner_member_id) throw new HttpError(403, 'Only the organizer can do this');
  return m;
}
const circle = (p) => C.getCircle(p.id);

add('GET', '/api/config', () => ({
  paypalClientId: cfg.paypal.clientId, mock: cfg.paypal.mock, aiEnabled: ai.enabled(), demo: cfg.demo,
}));
add('POST', '/api/planner', async ({ body }) => planner.plan(body.text));
add('POST', '/api/circles', ({ body }) => C.createCircle(body));
add('GET', '/api/circles/:id', ({ params, headers }) => { const c = circle(params); return C.view(c, who(c, headers)); });
add('POST', '/api/circles/:id/join', ({ params, body }) => C.join(circle(params), body));
add('POST', '/api/circles/:id/reorder', ({ params, body, headers }) => { const c = circle(params); needOwner(c, headers); C.reorder(c, body.order); return { ok: true }; });
add('POST', '/api/circles/:id/activate', ({ params, headers }) => { const c = circle(params); needOwner(c, headers); C.activate(c); return { ok: true }; });
add('POST', '/api/circles/:id/pay/create', ({ params, headers }) => { const c = circle(params); return C.payCreate(c, needMember(c, headers)); });
add('POST', '/api/circles/:id/pay/capture', ({ params, body, headers }) => { const c = circle(params); return C.payCapture(c, needMember(c, headers), body.orderId); });
add('POST', '/api/circles/:id/me/email', ({ params, body, headers }) => { const c = circle(params); C.updateEmail(c, needMember(c, headers), body.email); return { ok: true }; });
add('POST', '/api/circles/:id/payout/propose', async ({ params, headers }) => {
  const c = circle(params); const o = needOwner(c, headers);
  const p = await payouts.propose(c, o.name);
  return { payout: p };
});
add('POST', '/api/circles/:id/payout/:pid/approve', async ({ params, headers }) => {
  const c = circle(params); const o = needOwner(c, headers);
  return { payout: await payouts.send(c, params.pid, o.name) };
});
add('POST', '/api/circles/:id/payout/:pid/reject', ({ params, headers }) => {
  const c = circle(params); const o = needOwner(c, headers);
  return { payout: payouts.reject(c, params.pid, o.name) };
});
add('POST', '/api/circles/:id/steward', async ({ params, body, headers }) => { const c = circle(params); return steward.ask(c, needMember(c, headers), body.question); });
add('POST', '/api/circles/:id/reminder', async ({ params, body, headers }) => { const c = circle(params); needOwner(c, headers); return steward.draftReminder(c, body.member_id, body.language); });
add('POST', '/api/circles/:id/invoice-late', async ({ params, body, headers }) => { const c = circle(params); needOwner(c, headers); return steward.invoiceLate(c, body.member_id); });
add('GET', '/api/circles/:id/health', ({ params, headers }) => { const c = circle(params); needMember(c, headers); return { members: C.health(c) }; });

// Demo mode only
add('POST', '/api/demo/seed', () => { if (!cfg.demo) throw new HttpError(404, 'Demo mode is off'); return demo.seed(); });
add('POST', '/api/circles/:id/demo/skip', ({ params, headers }) => { if (!cfg.demo) throw new HttpError(404, 'Demo mode is off'); const c = circle(params); needOwner(c, headers); demo.skip(c); return { ok: true }; });

// PayPal webhooks: signature verified, idempotent by event id.
add('POST', '/api/webhooks/paypal', async ({ body, headers }) => {
  let ok = false;
  try { ok = await paypal.verifyWebhook(headers, body); } catch (e) { ok = false; }
  if (!ok && !cfg.allowUnverifiedWebhooks) throw new HttpError(400, 'Webhook signature not verified');
  if (!body.id) throw new HttpError(400, 'Missing event id');
  if (get('SELECT 1 AS x FROM webhook_events WHERE event_id=?', body.id)) return { ok: true, duplicate: true };
  run('INSERT INTO webhook_events(event_id,type,received_at) VALUES (?,?,?)', body.id, String(body.event_type), new Date().toISOString());
  const r = body.resource || {};
  switch (body.event_type) {
    case 'PAYMENT.CAPTURE.COMPLETED': {
      const [cid, rid, mid] = String(r.custom_id || '').split(':');
      if (cid && rid && mid) C.recordPayment({ circleId: cid, roundId: rid, memberId: mid, orderId: null, captureId: r.id, amountCents: Math.round(parseFloat((r.amount || {}).value || '0') * 100), source: 'webhook' });
      break;
    }
    case 'PAYMENT.PAYOUTSBATCH.SUCCESS':
    case 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED': {
      const batch = r.payout_batch_id || (r.batch_header || {}).payout_batch_id;
      const p = batch && get("SELECT * FROM payouts WHERE batch_id=? AND status='sent'", batch);
      if (p) { run("UPDATE payouts SET status='confirmed', updated_at=? WHERE id=?", new Date().toISOString(), p.id); C.audit(p.circle_id, 'paypal', 'payout_confirmed', { batchId: batch }); }
      break;
    }
    case 'PAYMENT.PAYOUTS-ITEM.FAILED':
    case 'PAYMENT.PAYOUTS-ITEM.DENIED':
    case 'PAYMENT.PAYOUTS-ITEM.RETURNED': {
      const batch = r.payout_batch_id;
      const p = batch && get('SELECT * FROM payouts WHERE batch_id=?', batch);
      if (p) { run("UPDATE payouts SET status='failed', updated_at=? WHERE id=?", new Date().toISOString(), p.id); C.audit(p.circle_id, 'paypal', 'payout_failed', { event: body.event_type }); }
      break;
    }
    case 'CUSTOMER.DISPUTE.CREATED': await steward.summarizeDispute(body); break;
    default: break;
  }
  return { ok: true };
});

// ---- static files ----
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (d) => { size += d.length; if (size > 100000) { reject(new HttpError(413, 'Body too large')); req.destroy(); } else chunks.push(d); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);
  const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(obj)); };
  try {
    for (const r of routes) {
      if (r.m !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      const body = req.method === 'POST' ? await readBody(req) : {};
      return send(200, await r.h({ params: m.groups || {}, body, headers: req.headers, query: url.searchParams }));
    }
    send(404, { error: 'Not found' });
  } catch (e) {
    if (e instanceof HttpError) return send(e.status, { error: e.message, ...(e.extra || {}) });
    console.error(e);
    send(500, { error: 'Something went wrong on the server' });
  }
});

if (require.main === module) {
  server.listen(cfg.port, () => {
    console.log(`Susu Steward running on http://localhost:${cfg.port}`);
    console.log(`PayPal: ${cfg.paypal.mock ? 'MOCK (tests only)' : cfg.paypal.clientId ? 'sandbox credentials loaded' : 'NO credentials, set .env'} | AI: ${ai.enabled() ? cfg.ai.model : 'off (rule-based fallbacks)'} | Demo mode: ${cfg.demo}`);
  });
}
module.exports = { server };
