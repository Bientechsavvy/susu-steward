// End-to-end test of the money paths with the PayPal mock (PAYPAL_MOCK=1). No network needed.
process.env.PAYPAL_MOCK = '1';
process.env.AI_API_KEY = '';
process.env.DB_PATH = require('path').join(require('os').tmpdir(), 'susu-test-' + Date.now() + '.db');
const test = require('node:test');
const assert = require('node:assert/strict');
const { server } = require('../server');

let base;
test.before(async () => { await new Promise((r) => server.listen(0, r)); base = 'http://localhost:' + server.address().port; });
test.after(() => server.close());

async function call(method, path, body, token) {
  const r = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', 'x-token': token || '' }, body: method === 'POST' ? JSON.stringify(body || {}) : undefined });
  return { status: r.status, body: await r.json() };
}
async function payAs(cid, token) {
  const o = await call('POST', `/circles/${cid}/pay/create`, {}, token);
  assert.equal(o.status, 200, JSON.stringify(o.body));
  return call('POST', `/circles/${cid}/pay/capture`, { orderId: o.body.orderId }, token);
}

test('planner understands a plain-language plan', async () => {
  const r = await call('POST', '/planner', { text: '6 people, $25 each, every Friday, start 2027-01-15' });
  assert.equal(r.body.n_members, 6); assert.equal(r.body.amount, 25); assert.equal(r.body.cadence, 'weekly'); assert.equal(r.body.start_date, '2027-01-15');
});

test('full round: pay, payout, advance; guards hold', async () => {
  const s = (await call('POST', '/demo/seed')).body;
  const cid = s.circleId, [owner, m2, m3, m4] = s.members;

  // payout before funding is blocked by rules
  let r = await call('POST', `/circles/${cid}/payout/propose`, {}, owner.token);
  assert.equal(r.status, 409); assert.match(r.body.error, /not fully funded/);

  // non-owner cannot propose; unknown token rejected
  assert.equal((await call('POST', `/circles/${cid}/payout/propose`, {}, m2.token)).status, 403);
  assert.equal((await call('GET', `/circles/${cid}/health`, null, 'bad')).status, 401);

  // duplicate payment by same member is refused
  assert.equal((await payAs(cid, owner.token)).status, 200);
  assert.equal((await call('POST', `/circles/${cid}/pay/create`, {}, owner.token)).status, 409);
  for (const m of [m2, m3, m4]) assert.equal((await payAs(cid, m.token)).status, 200);

  let v = (await call('GET', `/circles/${cid}`, null, owner.token)).body;
  assert.equal(v.round.status, 'funded'); assert.equal(v.round.pot, '100.00');

  // clean payout goes out automatically (low risk)
  r = await call('POST', `/circles/${cid}/payout/propose`, {}, owner.token);
  assert.equal(r.status, 200); assert.equal(r.body.payout.status, 'sent');
  v = (await call('GET', `/circles/${cid}`, null, owner.token)).body;
  assert.equal(v.circle.current_round, 2);

  // round 2: recipient (m2) changes email -> payout is HELD, not sent
  await call('POST', `/circles/${cid}/me/email`, { email: 'new@example.com' }, m2.token);
  for (const m of [owner, m2, m3, m4]) await payAs(cid, m.token);
  r = await call('POST', `/circles/${cid}/payout/propose`, {}, owner.token);
  assert.equal(r.body.payout.status, 'held');
  // a second proposal for the same round is blocked
  assert.equal((await call('POST', `/circles/${cid}/payout/propose`, {}, owner.token)).status, 409);
  // organizer approves
  const ap = await call('POST', `/circles/${cid}/payout/${r.body.payout.id}/approve`, {}, owner.token);
  assert.equal(ap.body.payout.status, 'sent');
});

test('webhook is idempotent and rejects bad payloads', async () => {
  const s = (await call('POST', '/demo/seed')).body;
  const v = (await call('GET', `/circles/${s.circleId}`, null, s.members[0].token)).body;
  const o = await call('POST', `/circles/${s.circleId}/pay/create`, {}, s.members[1].token);
  assert.ok(o.body.orderId);
  // forge a webhook for the same member via custom_id (mock verification accepts)
  const mem = s.members[2];
  const round = v.round; assert.ok(round);
  const roundId = (await call('GET', `/circles/${s.circleId}`, null, mem.token)).body;
  const ev = { id: 'WH-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-X1', custom_id: `${s.circleId}:nope:${mem.id}`, amount: { value: '25.00' } } };
  const a = await call('POST', '/webhooks/paypal', ev);
  assert.equal(a.status, 200);
  const b = await call('POST', '/webhooks/paypal', ev);
  assert.equal(b.body.duplicate, true);
  assert.equal((await call('POST', '/webhooks/paypal', { event_type: 'X' })).status, 400);
});

test('steward answers from the ledger without AI', async () => {
  const s = (await call('POST', '/demo/seed')).body;
  await payAs(s.circleId, s.members[0].token);
  const r = await call('POST', `/circles/${s.circleId}/steward`, { question: 'Who has not paid?' }, s.members[1].token);
  assert.match(r.body.answer, /Kwame|Aïcha|Tunde/);
  assert.ok(r.body.trace.length >= 1);
});
