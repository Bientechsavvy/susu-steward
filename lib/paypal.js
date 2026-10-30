// PayPal sandbox REST client (Orders v2, Payouts, Invoicing v2, Webhook verification).
// PAYPAL_MOCK=1 swaps in an in-memory fake so the test suite can run offline.
const crypto = require('crypto');
const { HttpError } = require('./errors');
const cfg = require('./env');
const P = cfg.paypal;
const dollars = (c) => (c / 100).toFixed(2);

let cached = null;
async function accessToken() {
  if (cached && cached.exp > Date.now() + 60000) return cached.t;
  if (!P.clientId || !P.secret) throw new HttpError(503, 'PayPal credentials are missing. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env and restart.');
  const r = await fetch(P.base + '/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(P.clientId + ':' + P.secret).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(502, 'PayPal rejected the credentials (' + (j.error_description || r.status) + '). Check you copied the SANDBOX Client ID and Secret.');
  cached = { t: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return cached.t;
}

async function api(method, path, body, requestId) {
  const t = await accessToken();
  const headers = { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  if (requestId) headers['PayPal-Request-Id'] = requestId;
  const r = await fetch(P.base + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
  if (!r.ok) {
    throw new HttpError(502, `PayPal ${method} ${path} failed (${r.status}): ${j.message || j.name || text.slice(0, 200)}`);
  }
  return j;
}

// ---------- mock store ----------
const mockOrders = new Map();
const rid = (p) => p + crypto.randomBytes(6).toString('hex').toUpperCase();

async function createOrder({ amountCents, currency, customId, description }) {
  if (P.mock) {
    const id = rid('MOCKORD');
    mockOrders.set(id, { amountCents, customId });
    return { id };
  }
  const j = await api('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{
      custom_id: customId,
      description: String(description || '').slice(0, 120),
      amount: { currency_code: currency, value: dollars(amountCents) },
    }],
  });
  return { id: j.id };
}

async function captureOrder(orderId) {
  if (P.mock) {
    const o = mockOrders.get(orderId);
    if (!o) throw new Error('Unknown mock order');
    return { status: 'COMPLETED', captureId: 'MOCKCAP' + orderId.slice(7), customId: o.customId, amountCents: o.amountCents };
  }
  const j = await api('POST', `/v2/checkout/orders/${orderId}/capture`, {}, 'cap-' + orderId);
  const pu = (j.purchase_units || [])[0] || {};
  const cap = ((pu.payments || {}).captures || [])[0] || {};
  return {
    status: cap.status === 'COMPLETED' ? 'COMPLETED' : (cap.status || j.status),
    captureId: cap.id,
    customId: cap.custom_id || pu.custom_id,
    amountCents: Math.round(parseFloat((cap.amount || {}).value || '0') * 100),
  };
}

async function createPayout({ batchId, currency, items }) {
  if (P.mock) return { batchId: rid('MOCKBATCH'), status: 'PENDING' };
  const j = await api('POST', '/v1/payments/payouts', {
    sender_batch_header: { sender_batch_id: batchId, email_subject: 'Your Susu Steward payout', email_message: 'Your circle round payout has been sent.' },
    items: items.map((it) => ({
      recipient_type: 'EMAIL',
      receiver: it.email,
      amount: { value: dollars(it.amountCents), currency },
      note: it.note,
      sender_item_id: it.itemId,
    })),
  }, batchId);
  const h = j.batch_header || {};
  return { batchId: h.payout_batch_id, status: h.batch_status };
}

async function createAndSendInvoice({ email, amountCents, currency, description }) {
  if (P.mock) return { invoiceId: rid('MOCKINV'), status: 'SENT' };
  const j = await api('POST', '/v2/invoicing/invoices', {
    detail: { currency_code: currency, note: description },
    primary_recipients: [{ billing_info: { email_address: email } }],
    items: [{ name: String(description).slice(0, 100), quantity: '1', unit_amount: { currency_code: currency, value: dollars(amountCents) } }],
  });
  const id = j.id || String(j.href || '').split('/').pop();
  if (!id) throw new Error('PayPal did not return an invoice id');
  await api('POST', `/v2/invoicing/invoices/${id}/send`, { send_to_recipient: true, send_to_invoicer: false });
  return { invoiceId: id, status: 'SENT' };
}

async function verifyWebhook(headers, event) {
  if (P.mock) return true;
  if (!P.webhookId) return false;
  const j = await api('POST', '/v1/notifications/verify-webhook-signature', {
    auth_algo: headers['paypal-auth-algo'],
    cert_url: headers['paypal-cert-url'],
    transmission_id: headers['paypal-transmission-id'],
    transmission_sig: headers['paypal-transmission-sig'],
    transmission_time: headers['paypal-transmission-time'],
    webhook_id: P.webhookId,
    webhook_event: event,
  });
  return j.verification_status === 'SUCCESS';
}

module.exports = { createOrder, captureOrder, createPayout, createAndSendInvoice, verifyWebhook, dollars };
