// Tiny .env loader (no dependencies) + typed config.
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', '.env');
if (fs.existsSync(p)) {
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
const e = process.env;
module.exports = {
  port: +e.PORT || 3000,
  paypal: {
    clientId: e.PAYPAL_CLIENT_ID || '',
    secret: e.PAYPAL_CLIENT_SECRET || '',
    // Sandbox only, on purpose: this prototype must never touch real money.
    base: 'https://api-m.sandbox.paypal.com',
    webhookId: e.PAYPAL_WEBHOOK_ID || '',
    mock: e.PAYPAL_MOCK === '1', // offline tests only
  },
  ai: {
    key: e.AI_API_KEY || '',
    base: (e.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    model: e.AI_MODEL || 'gpt-4.1-mini',
  },
  demo: e.DEMO_MODE !== '0',
  demoEmails: (e.DEMO_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean),
  dbPath: e.DB_PATH || 'susu.db',
  allowUnverifiedWebhooks: e.ALLOW_UNVERIFIED_WEBHOOKS === '1',
};
