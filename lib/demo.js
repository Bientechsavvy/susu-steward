// Demo mode helpers: seeded circle + simulated time skip. Disabled with DEMO_MODE=0.
const cfg = require('./env');
const C = require('./circles');
const { run } = require('./db');
const NAMES = ['Adaeze', 'Kwame', 'Aïcha', 'Tunde'];

function seed() {
  const emails = [0, 1, 2, 3].map((i) => cfg.demoEmails[i] || `demo${i + 1}@example.com`);
  const start = new Date().toISOString().slice(0, 10);
  const o = C.createCircle({ name: 'Demo Susu Circle', amount: 25, n_members: 4, cadence: 'weekly', start_date: start, owner_name: NAMES[0], owner_email: emails[0] });
  const c = C.getCircle(o.id);
  const tokens = [{ id: o.memberId, name: NAMES[0], token: o.token }];
  for (let i = 1; i < 4; i++) {
    const j = C.join(c, { name: NAMES[i], email: emails[i] });
    tokens.push({ id: j.memberId, name: NAMES[i], token: j.token });
  }
  C.activate(C.getCircle(o.id));
  C.audit(o.id, 'system', 'demo_seeded', {});
  return { circleId: o.id, members: tokens };
}

function skip(c) {
  const days = C.CADENCE[c.cadence] + 1; // jump just past the next due date
  run('UPDATE circles SET sim_offset_days=sim_offset_days+? WHERE id=?', days, c.id);
  C.audit(c.id, 'demo', 'time_skipped', { days });
}
module.exports = { seed, skip };
