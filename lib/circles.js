// Core ledger logic: circles, members, rounds, contributions.
const { uid, token, all, get, run } = require('./db');
const { HttpError } = require('./errors');
const paypal = require('./paypal');

const CADENCE = { weekly: 7, biweekly: 14, monthly: 30 };
const cents = (v) => Math.round(Number(v) * 100);
const money = (c) => (c / 100).toFixed(2);
const emailOk = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s || '');
const clean = (s, max = 60) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);

function audit(circleId, actor, action, detail = {}) {
  run('INSERT INTO audit(circle_id,ts,actor,action,detail) VALUES (?,?,?,?,?)',
    circleId, new Date().toISOString(), actor, action, JSON.stringify(detail));
}
const now = (c) => new Date(Date.now() + (c.sim_offset_days || 0) * 86400000);
const today = (c) => now(c).toISOString().slice(0, 10);

function addPeriod(dateStr, cadence, k) {
  const d = new Date(dateStr + 'T00:00:00Z');
  if (cadence === 'monthly') d.setUTCMonth(d.getUTCMonth() + k);
  else d.setUTCDate(d.getUTCDate() + k * CADENCE[cadence]);
  return d.toISOString().slice(0, 10);
}

function validate(i) {
  const v = {
    name: clean(i.name), owner_name: clean(i.owner_name, 40), owner_email: clean(i.owner_email, 120),
    amount: Number(i.amount), n: parseInt(i.n_members, 10), cadence: i.cadence, start_date: String(i.start_date || ''),
  };
  if (!v.name) throw new HttpError(400, 'Circle name is required');
  if (!(v.amount >= 1 && v.amount <= 10000)) throw new HttpError(400, 'Amount per member must be between 1 and 10000');
  if (!(v.n >= 2 && v.n <= 30)) throw new HttpError(400, 'A circle needs between 2 and 30 members');
  if (!CADENCE[v.cadence]) throw new HttpError(400, 'Cadence must be weekly, biweekly or monthly');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.start_date) || isNaN(Date.parse(v.start_date))) throw new HttpError(400, 'Start date must look like 2026-11-20');
  if (!v.owner_name) throw new HttpError(400, 'Your name is required');
  if (!emailOk(v.owner_email)) throw new HttpError(400, 'A valid PayPal email is required');
  return v;
}

function getCircle(id) {
  const c = get('SELECT * FROM circles WHERE id=?', String(id));
  if (!c) throw new HttpError(404, 'Circle not found');
  return c;
}
const members = (cid) => all('SELECT * FROM members WHERE circle_id=? ORDER BY position', cid);
const currentRound = (c) => get('SELECT * FROM rounds WHERE circle_id=? AND number=?', c.id, c.current_round);

function createCircle(input) {
  const v = validate(input);
  const id = uid(), mid = uid(), tok = token(), ts = new Date().toISOString();
  run('INSERT INTO circles(id,name,amount_cents,currency,cadence,start_date,n_members,status,current_round,owner_member_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    id, v.name, cents(v.amount), 'USD', v.cadence, v.start_date, v.n, 'forming', 0, mid, ts);
  run('INSERT INTO members(id,circle_id,name,email,position,token,joined_at) VALUES (?,?,?,?,?,?,?)',
    mid, id, v.owner_name, v.owner_email, 1, tok, ts);
  audit(id, v.owner_name, 'circle_created', { amount: money(cents(v.amount)), cadence: v.cadence, members: v.n });
  return { id, token: tok, memberId: mid };
}

function join(c, { name, email }) {
  if (c.status !== 'forming') throw new HttpError(409, 'This circle already started');
  const list = members(c.id);
  if (list.length >= c.n_members) throw new HttpError(409, 'This circle is full');
  name = clean(name, 40); email = clean(email, 120);
  if (!name) throw new HttpError(400, 'Your name is required');
  if (!emailOk(email)) throw new HttpError(400, 'A valid PayPal email is required');
  if (list.some((m) => m.email.toLowerCase() === email.toLowerCase())) throw new HttpError(409, 'That email already joined');
  const id = uid(), tok = token();
  run('INSERT INTO members(id,circle_id,name,email,position,token,joined_at) VALUES (?,?,?,?,?,?,?)',
    id, c.id, name, email, list.length + 1, tok, new Date().toISOString());
  audit(c.id, name, 'member_joined', { position: list.length + 1 });
  return { memberId: id, token: tok };
}

function reorder(c, order) {
  if (c.status !== 'forming') throw new HttpError(409, 'Payout order is locked once the circle starts');
  const list = members(c.id);
  if (!Array.isArray(order) || order.length !== list.length || new Set(order).size !== list.length || !order.every((id) => list.some((m) => m.id === id)))
    throw new HttpError(400, 'Order must list every member exactly once');
  order.forEach((id, i) => run('UPDATE members SET position=? WHERE id=?', i + 1, id));
  audit(c.id, 'organizer', 'order_changed', {});
}

function activate(c) {
  if (c.status !== 'forming') throw new HttpError(409, 'Circle already started');
  const list = members(c.id);
  if (list.length < 2) throw new HttpError(409, 'Invite at least one more member first');
  run('UPDATE circles SET n_members=?, status=?, current_round=1 WHERE id=?', list.length, 'active', c.id);
  list.forEach((m, i) => run('INSERT INTO rounds(id,circle_id,number,due_date,recipient_member_id,status) VALUES (?,?,?,?,?,?)',
    uid(), c.id, i + 1, addPeriod(c.start_date, c.cadence, i), m.id, 'open'));
  audit(c.id, 'organizer', 'circle_started', { members: list.length, order: list.map((m) => m.name) });
}

const mask = (e) => e.replace(/^(.).*(@.*)$/, '$1***$2');

function view(c, me) {
  const list = members(c.id);
  const round = c.status === 'active' ? currentRound(c) : null;
  const paid = new Set(); let pot = 0;
  if (round) for (const p of all('SELECT member_id,amount_cents FROM payments WHERE round_id=?', round.id)) { paid.add(p.member_id); pot += p.amount_cents; }
  const late = !!round && today(c) > round.due_date;
  const isOwner = !!me && me.id === c.owner_member_id;
  return {
    circle: {
      id: c.id, name: c.name, amount: money(c.amount_cents), currency: c.currency, cadence: c.cadence,
      start_date: c.start_date, status: c.status, current_round: c.current_round, n_members: c.n_members,
      today: today(c), auto_send: !!c.auto_send,
    },
    me: me ? { id: me.id, name: me.name, isOwner, email: me.email } : null,
    members: list.map((m) => ({
      id: m.id, name: m.name, position: m.position,
      email: isOwner || (me && me.id === m.id) ? m.email : mask(m.email),
      paid: paid.has(m.id), late: late && !paid.has(m.id) && !!round,
      receives: !!round && round.recipient_member_id === m.id,
    })),
    round: round ? { number: round.number, due_date: round.due_date, status: round.status, pot: money(pot), target: money(c.amount_cents * list.length), paid_count: paid.size } : null,
    rounds: all('SELECT number,due_date,recipient_member_id,status FROM rounds WHERE circle_id=? ORDER BY number', c.id)
      .map((r) => ({ ...r, recipient: (list.find((m) => m.id === r.recipient_member_id) || {}).name })),
    payouts: all('SELECT id,round_id,status,amount_cents,risk_level,risk_json,batch_id,created_at FROM payouts WHERE circle_id=? ORDER BY created_at DESC', c.id)
      .map((p) => ({ ...p, amount: money(p.amount_cents), risk: p.risk_json ? JSON.parse(p.risk_json) : null, risk_json: undefined })),
    audit: all('SELECT ts,actor,action,detail FROM audit WHERE circle_id=? ORDER BY id DESC LIMIT 40', c.id)
      .map((a) => ({ ...a, detail: a.detail ? JSON.parse(a.detail) : {} })),
  };
}

function refreshFunded(c, round) {
  const r = get('SELECT COALESCE(SUM(amount_cents),0) AS s FROM payments WHERE round_id=?', round.id);
  if (round.status === 'open' && r.s >= c.amount_cents * c.n_members) {
    run("UPDATE rounds SET status='funded' WHERE id=?", round.id);
    audit(c.id, 'system', 'round_funded', { round: round.number, pot: money(r.s) });
  }
}

// Idempotent: called from both the browser capture path and the webhook path.
function recordPayment(p) {
  const c = get('SELECT * FROM circles WHERE id=?', String(p.circleId));
  if (!c) return { ok: false, reason: 'unknown circle' };
  const round = get('SELECT * FROM rounds WHERE id=? AND circle_id=?', String(p.roundId), c.id);
  const member = get('SELECT * FROM members WHERE id=? AND circle_id=?', String(p.memberId), c.id);
  if (!round || !member || !p.captureId) {
    audit(c.id, 'system', 'payment_rejected', { reason: 'unknown round, member or capture', captureId: p.captureId || null });
    return { ok: false, reason: 'unknown round or member' };
  }
  if (get('SELECT 1 AS x FROM payments WHERE capture_id=?', p.captureId)) return { ok: true, duplicate: true };
  if (p.amountCents !== c.amount_cents) {
    audit(c.id, 'system', 'payment_amount_mismatch', { captureId: p.captureId, got: money(p.amountCents), expected: money(c.amount_cents) });
    return { ok: false, reason: 'amount mismatch' };
  }
  if (round.status === 'paid') {
    audit(c.id, 'system', 'payment_for_closed_round', { captureId: p.captureId, member: member.name, note: 'Needs a manual refund' });
    return { ok: false, reason: 'round already paid out' };
  }
  if (get('SELECT 1 AS x FROM payments WHERE round_id=? AND member_id=?', round.id, member.id)) {
    audit(c.id, 'system', 'duplicate_payment_ignored', { captureId: p.captureId, member: member.name, note: 'Needs a manual refund' });
    return { ok: true, duplicate: true };
  }
  run('INSERT INTO payments(id,circle_id,round_id,member_id,order_id,capture_id,amount_cents,status,source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    uid(), c.id, round.id, member.id, p.orderId || null, p.captureId, p.amountCents, 'confirmed', p.source, now(c).toISOString());
  audit(c.id, member.name, 'payment_confirmed', { round: round.number, amount: money(p.amountCents), source: p.source, captureId: p.captureId });
  refreshFunded(c, round);
  return { ok: true, duplicate: false };
}

async function payCreate(c, me) {
  if (c.status !== 'active') throw new HttpError(409, 'The circle is not active');
  const round = currentRound(c);
  if (get('SELECT 1 AS x FROM payments WHERE round_id=? AND member_id=?', round.id, me.id)) throw new HttpError(409, 'You already paid this round');
  const o = await paypal.createOrder({ amountCents: c.amount_cents, currency: c.currency, customId: `${c.id}:${round.id}:${me.id}`, description: `${c.name} round ${round.number}` });
  audit(c.id, me.name, 'order_created', { orderId: o.id, round: round.number });
  return { orderId: o.id };
}

async function payCapture(c, me, orderId) {
  if (!/^[A-Za-z0-9_-]{5,40}$/.test(String(orderId || ''))) throw new HttpError(400, 'Invalid order id');
  const cap = await paypal.captureOrder(orderId);
  if (cap.status !== 'COMPLETED') throw new HttpError(402, 'PayPal did not complete this payment (' + cap.status + ')');
  const [cid, rid, mid] = String(cap.customId || '').split(':');
  if (cid !== c.id || mid !== me.id) throw new HttpError(403, 'This order does not belong to you');
  const r = recordPayment({ circleId: cid, roundId: rid, memberId: mid, orderId, captureId: cap.captureId, amountCents: cap.amountCents, source: 'capture' });
  if (!r.ok) throw new HttpError(409, 'Payment could not be recorded: ' + r.reason);
  return r;
}

function updateEmail(c, me, email) {
  email = clean(email, 120);
  if (!emailOk(email)) throw new HttpError(400, 'A valid PayPal email is required');
  run('UPDATE members SET email=?, email_changed_at=? WHERE id=?', email, now(c).toISOString(), me.id);
  audit(c.id, me.name, 'email_changed', {});
}

// Advisory only: never used to auto-reject anyone.
function health(c) {
  const list = members(c.id);
  const rounds = all('SELECT * FROM rounds WHERE circle_id=?', c.id);
  return list.map((m) => {
    let onTime = 0, lateN = 0;
    for (const p of all('SELECT round_id,created_at FROM payments WHERE member_id=?', m.id)) {
      const r = rounds.find((x) => x.id === p.round_id);
      if (r && p.created_at.slice(0, 10) <= r.due_date) onTime++; else lateN++;
    }
    const cur = c.status === 'active' ? currentRound(c) : null;
    if (cur && today(c) > cur.due_date && !get('SELECT 1 AS x FROM payments WHERE round_id=? AND member_id=?', cur.id, m.id)) lateN++;
    const total = onTime + lateN;
    const score = total ? Math.round((onTime / total) * 100) : null;
    const note = score === null ? 'No history yet.' : `${onTime} on time, ${lateN} late. This is a guide for the organizer, not a reason to remove anyone.`;
    return { id: m.id, name: m.name, on_time: onTime, late: lateN, score, note };
  });
}

module.exports = { CADENCE, cents, money, audit, now, today, addPeriod, getCircle, members, currentRound, createCircle, join, reorder, activate, view, recordPayment, payCreate, payCapture, updateEmail, health, emailOk, clean };
