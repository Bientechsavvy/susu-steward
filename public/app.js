// Susu Steward front end: plain JS, no build step.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LS = 'susu_v1';
  const store = {
    get() { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch { return {}; } },
    set(v) { try { localStorage.setItem(LS, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  let CONFIG = {}, curToken = '', curId = '', view = null;

  async function api(path, { method = 'GET', body, token } = {}) {
    const r = await fetch('/api' + path, {
      method, headers: { 'Content-Type': 'application/json', 'x-token': token === undefined ? curToken : token },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || 'Error ' + r.status); e.data = j; throw e; }
    return j;
  }
  let tt;
  function toast(msg, bad) {
    const t = $('#toast'); t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(tt); tt = setTimeout(() => { t.className = ''; }, 4500);
  }
  const act = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

  // ---------- routing ----------
  async function route() {
    const h = location.hash || '#/';
    const main = $('#app');
    try {
      let m;
      if ((m = h.match(/^#\/c\/([\w]+)$/))) await circlePage(m[1]);
      else if ((m = h.match(/^#\/join\/([\w]+)$/))) await joinPage(m[1]);
      else homePage();
    } catch (e) {
      main.innerHTML = `<div class="card"><h2>Something went wrong</h2><p>${esc(e.message)}</p><p><a href="#/">Back home</a></p></div>`;
    }
    main.focus({ preventScroll: true });
  }

  // ---------- home + planner ----------
  function homePage() {
    const st = store.get();
    const mine = Object.entries(st.circles || {});
    $('#app').innerHTML = `
      <h1>Save together. Let the Steward do the paperwork.</h1>
      <p class="mute">A rotating savings circle (susu, ajo, esusu) where an AI agent collects contributions through PayPal, checks every payout for risk, and pays the right person.</p>
      <section class="card" aria-labelledby="pl">
        <h2 id="pl">1. Describe your circle</h2>
        <label for="ptext">In your own words</label>
        <textarea id="ptext" placeholder="6 people, $25 each, every Friday, start Nov 20"></textarea>
        <div class="btns"><button data-act="plan">Draft my circle</button><button class="ghost" data-act="manual">Fill it in myself</button></div>
        <form id="cform" hidden data-act-submit="create">
          <h2 style="margin-top:16px">2. Check and create</h2>
          <p class="small mute" id="pnotes"></p>
          <div class="row"><div><label for="f_name">Circle name</label><input id="f_name" required maxlength="60"></div>
          <div><label for="f_n">Members</label><input id="f_n" type="number" min="2" max="30" required></div></div>
          <div class="row"><div><label for="f_amt">Amount each (USD)</label><input id="f_amt" type="number" min="1" max="10000" step="0.01" required></div>
          <div><label for="f_cad">How often</label><select id="f_cad"><option value="weekly">Weekly</option><option value="biweekly">Every 2 weeks</option><option value="monthly">Monthly</option></select></div>
          <div><label for="f_date">First round due</label><input id="f_date" type="date" required></div></div>
          <div class="row"><div><label for="f_me">Your name</label><input id="f_me" required maxlength="40" autocomplete="name"></div>
          <div><label for="f_email">Your PayPal email</label><input id="f_email" type="email" required autocomplete="email"></div></div>
          <div class="btns"><button type="submit">Create circle</button></div>
        </form>
      </section>
      ${CONFIG.demo ? `<section class="card"><h2>Just want to see it work?</h2><p class="mute">Creates a ready-to-run circle with 4 members and lets you switch between them.</p><div class="btns"><button class="ghost" data-act="seed">Load the demo circle</button></div></section>` : ''}
      ${mine.length ? `<section class="card"><h2>Your circles</h2><ul class="members">${mine.map(([id, c]) => `<li><span>${esc(c.name)}</span><a href="#/c/${esc(id)}">Open</a></li>`).join('')}</ul></section>` : ''}`;
  }
  function showForm(d, notes) {
    const f = $('#cform'); f.hidden = false;
    $('#f_name').value = d.name || 'Our Susu Circle'; $('#f_n').value = d.n_members || 5; $('#f_amt').value = d.amount || 20;
    $('#f_cad').value = d.cadence || 'weekly'; $('#f_date').value = d.start_date || new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    $('#pnotes').textContent = notes || '';
    $('#f_me').focus();
  }

  // ---------- join ----------
  async function joinPage(id) {
    const v = await api('/circles/' + id, { token: '' });
    $('#app').innerHTML = `<h1>Join ${esc(v.circle.name)}</h1>
      <p class="mute">$${esc(v.circle.amount)} each, ${esc(v.circle.cadence)}. ${v.members.length} of ${v.circle.n_members} joined.</p>
      <form class="card" data-act-submit="join"><label for="j_name">Your name</label><input id="j_name" required maxlength="40">
      <label for="j_email">Your PayPal email</label><input id="j_email" type="email" required>
      <p class="small mute">Payouts are sent to this email. Use your PayPal sandbox Personal account email for the hackathon demo.</p>
      <div class="btns"><button type="submit">Join circle</button></div></form>`;
    $('#app').dataset.cid = id;
  }

  // ---------- circle ----------
  async function circlePage(id) {
    const st = store.get(); curId = id;
    const demoList = (st.demo || {})[id];
    const pick = (st.viewAs || {})[id];
    curToken = demoList ? ((demoList.find((m) => m.id === pick) || demoList[0]).token) : ((st.circles || {})[id] || {}).token || '';
    view = await api('/circles/' + id);
    draw();
  }
  const chip = (m, round) => m.receives ? '<span class="pill warn">Receives this round</span> ' : '';
  function draw() {
    const v = view, c = v.circle, me = v.me, owner = me && me.isOwner;
    const st = store.get(), demoList = (st.demo || {})[curId];
    let h = `<h1>${esc(c.name)}</h1>
      <p class="mute">$${esc(c.amount)} each · ${esc(c.cadence)} · ${esc(c.status)}${v.round ? ' · round ' + v.round.number + ' of ' + c.n_members + ', due ' + esc(v.round.due_date) : ''}
      ${me ? ' · you are <b>' + esc(me.name) + '</b>' + (owner ? ' (organizer)' : '') : ''}</p>`;
    if (demoList) h += `<div class="card"><label for="viewas">Demo: view as</label><select id="viewas">${demoList.map((m) => `<option value="${esc(m.id)}"${me && me.id === m.id ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>`;
    if (!me) h += `<div class="card"><p>You are not a member of this circle on this device. <a href="#/join/${esc(curId)}">Join it</a>.</p></div>`;

    if (c.status === 'forming') {
      const link = location.origin + '/#/join/' + curId;
      h += `<section class="card"><h2>Members (${v.members.length} of ${c.n_members})</h2><ul class="members" id="mlist">${v.members.map((m, i) => `<li><span>${m.position}. ${esc(m.name)}</span>${owner ? `<span><button class="ghost" data-act="up" data-i="${i}" aria-label="Move ${esc(m.name)} up">↑</button> <button class="ghost" data-act="down" data-i="${i}" aria-label="Move ${esc(m.name)} down">↓</button></span>` : ''}</li>`).join('')}</ul>
        <p class="small mute">The order here is the payout order. It locks when the circle starts.</p>
        ${owner ? `<p class="small">Invite link:</p><div class="invite">${esc(link)}</div><div class="btns"><button class="ghost" data-act="copy" data-v="${esc(link)}">Copy invite link</button><button data-act="activate">Start the circle</button></div>` : ''}</section>`;
    }
    if (c.status === 'active' && v.round) {
      const r = v.round, pct = Math.min(100, Math.round((parseFloat(r.pot) / parseFloat(r.target)) * 100));
      h += `<section class="card"><h2>Round ${r.number} pot</h2><div class="big">$${esc(r.pot)} <span class="mute small">of $${esc(r.target)}</span></div>
        <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Pot progress"><i style="width:${pct}%"></i></div>
        <ul class="members">${v.members.map((m) => `<li><span>${esc(m.name)} ${chip(m)}</span><span class="pill ${m.paid ? 'ok' : m.late ? 'bad' : 'warn'}">${m.paid ? 'Paid' : m.late ? 'Late' : 'Due ' + esc(r.due_date)}</span></li>`).join('')}</ul></section>`;
      const iPaid = me && (v.members.find((m) => m.id === me.id) || {}).paid;
      if (me && !iPaid) h += `<section class="card"><h2>Pay your $${esc(c.amount)}</h2><p class="small mute">${CONFIG.mock ? 'Mock mode (tests only).' : 'Pays with PayPal sandbox. Log in with a sandbox Personal account.'}</p><div id="pp"></div></section>`;
      else if (me) h += `<section class="card"><p>✔ You paid round ${r.number}. Thank you.</p></section>`;
    }
    if (c.status === 'completed') h += `<section class="card"><h2>Circle complete 🎉</h2><p>Every member has received their payout.</p></section>`;

    if (owner && c.status === 'active' && v.round) {
      const held = v.payouts.find((p) => p.status === 'held');
      h += `<section class="card"><h2>Organizer: payout</h2>`;
      if (held) {
        h += `<div class="risk high"><b>Held for your approval: $${esc(held.amount)} to ${esc(held.risk && held.risk.recipient)}</b><ul>${(held.risk.flags || []).map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>
          <div class="btns"><button data-act="approve" data-p="${esc(held.id)}">Approve and send</button><button class="danger" data-act="reject" data-p="${esc(held.id)}">Reject</button></div>`;
      } else if (v.round.status === 'funded') {
        h += `<p>The pot is full. The Steward will check the payout, then send it.</p><div class="btns"><button data-act="propose">Review and send payout</button></div>`;
      } else h += `<p class="mute">Waiting for ${v.members.filter((m) => !m.paid).length} more contribution(s).</p>`;
      const late = v.members.filter((m) => !m.paid);
      if (late.length) h += `<details><summary>Chase unpaid members</summary><div class="row"><div><label for="rm">Member</label><select id="rm">${late.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</select></div>
        <div><label for="rl">Language</label><select id="rl"><option value="en">English</option><option value="fr">Français</option><option value="yo">Yorùbá</option></select></div></div>
        <div class="btns"><button class="ghost" data-act="remind">Draft reminder</button><button class="ghost" data-act="invoice">Send PayPal invoice</button></div><div id="rout"></div></details>`;
      if (CONFIG.demo) h += `<details><summary>Demo tools</summary><div class="btns"><button class="ghost" data-act="skip">Skip time to after the next due date</button></div></details>`;
      h += `</section>`;
    }
    if (v.payouts.length) h += `<section class="card"><h2>Payouts</h2>${v.payouts.map((p) => `<div class="risk ${esc(p.risk_level || '')}"><b>$${esc(p.amount)}</b> to ${esc(p.risk && p.risk.recipient)} · <span class="pill ${p.status === 'sent' || p.status === 'confirmed' ? 'ok' : p.status === 'held' ? 'warn' : 'bad'}">${esc(p.status)}</span>${p.batch_id ? `<div class="small mute">PayPal batch ${esc(p.batch_id)}</div>` : ''}${p.risk && p.risk.flags && p.risk.flags.length ? `<ul class="small">${p.risk.flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}</div>`).join('')}</section>`;

    if (me) h += `<section class="card"><h2>My PayPal email</h2><div class="row"><input id="myemail" type="email" value="${esc(me.email)}" aria-label="My PayPal email"><button class="ghost" data-act="email" style="flex:0 0 auto">Update</button></div><p class="small mute">If you change it, a payout to you is held for the organizer to approve for 48 hours.</p></section>
      <section class="card"><h2>Ask the Steward</h2><div class="chat"><input id="q" placeholder="When is my turn? Who has not paid?" aria-label="Question for the Steward" maxlength="300"><button data-act="ask" style="flex:0 0 auto">Ask</button></div><div id="qa"></div></section>
      <section class="card"><h2>Circle health</h2><p class="small mute">A guide for the organizer. Never used to remove anyone automatically.</p><div class="btns"><button class="ghost" data-act="health">Show health</button></div><div id="hl"></div></section>`;

    h += `<section class="card"><h2>Audit log</h2><p class="small mute">Every action the Steward and PayPal took, newest first.</p><div class="audit">${v.audit.map((a) => `<div><b>${esc(a.action)}</b> · ${esc(a.actor)} <span class="mute">${esc(a.ts.slice(0, 19).replace('T', ' '))}</span><div class="small mute">${esc(summ(a.detail))}</div></div>`).join('')}</div></section>
      <div class="btns"><button class="ghost" data-act="refresh">Refresh</button></div>`;
    $('#app').innerHTML = h;
    const vs = $('#viewas');
    if (vs) vs.onchange = () => { const s = store.get(); s.viewAs = s.viewAs || {}; s.viewAs[curId] = vs.value; store.set(s); route(); };
    if ($('#pp')) mountPay();
  }
  function summ(d) { try { return Object.entries(d).map(([k, v]) => k + ': ' + (typeof v === 'object' ? JSON.stringify(v) : v)).join(' · '); } catch { return ''; } }

  // ---------- PayPal checkout ----------
  let sdkP;
  function loadSdk() {
    if (window.paypal) return Promise.resolve();
    if (sdkP) return sdkP;
    sdkP = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(CONFIG.paypalClientId)}&currency=USD&intent=capture&components=buttons`;
      s.onload = res; s.onerror = () => rej(new Error('Could not load PayPal. Check your internet connection.'));
      document.head.appendChild(s);
    });
    return sdkP;
  }
  async function mountPay() {
    const box = $('#pp');
    const create = async () => (await api(`/circles/${curId}/pay/create`, { method: 'POST' })).orderId;
    const capture = async (orderId) => { await api(`/circles/${curId}/pay/capture`, { method: 'POST', body: { orderId } }); toast('Payment confirmed'); await circlePage(curId); };
    if (CONFIG.mock) {
      box.innerHTML = '<button id="mockpay">Pay (mock)</button>';
      $('#mockpay').onclick = act(async () => capture(await create()));
      return;
    }
    if (!CONFIG.paypalClientId) { box.innerHTML = '<p class="bad pill">PayPal client id missing in .env</p>'; return; }
    try {
      await loadSdk();
      window.paypal.Buttons({
        createOrder: () => create().catch((e) => { toast(e.message, true); throw e; }),
        onApprove: (d) => capture(d.orderID).catch((e) => toast(e.message, true)),
        onError: () => toast('PayPal reported a problem. Try again.', true),
      }).render('#pp');
    } catch (e) { box.textContent = e.message; }
  }

  // ---------- actions ----------
  const A = {
    async plan() {
      const text = $('#ptext').value.trim();
      if (!text) return toast('Describe your circle first', true);
      const d = await api('/planner', { method: 'POST', body: { text }, token: '' });
      showForm(d, (d.source === 'ai' ? 'Drafted by AI. ' : 'Drafted with simple rules. ') + (d.notes || []).join(' ') + ' Please check every field.');
    },
    manual() { showForm({}, ''); },
    async seed() {
      const r = await api('/demo/seed', { method: 'POST', token: '' });
      const s = store.get(); s.demo = s.demo || {}; s.demo[r.circleId] = r.members; s.circles = s.circles || {};
      s.circles[r.circleId] = { name: 'Demo Susu Circle', token: r.members[0].token }; store.set(s);
      location.hash = '#/c/' + r.circleId;
    },
    up(el) { return move(+el.dataset.i, -1); }, down(el) { return move(+el.dataset.i, 1); },
    async activate() { await api(`/circles/${curId}/activate`, { method: 'POST' }); toast('Circle started'); await circlePage(curId); },
    async copy(el) { try { await navigator.clipboard.writeText(el.dataset.v); toast('Copied'); } catch { toast('Copy it by hand from the box above', true); } },
    async propose() {
      try { const r = await api(`/circles/${curId}/payout/propose`, { method: 'POST' }); toast(r.payout.status === 'held' ? 'Payout held for your approval' : 'Payout sent'); }
      catch (e) { toast(e.message, true); }
      await circlePage(curId);
    },
    async approve(el) { await api(`/circles/${curId}/payout/${el.dataset.p}/approve`, { method: 'POST' }); toast('Payout sent'); await circlePage(curId); },
    async reject(el) { await api(`/circles/${curId}/payout/${el.dataset.p}/reject`, { method: 'POST' }); toast('Payout rejected'); await circlePage(curId); },
    async skip() { await api(`/circles/${curId}/demo/skip`, { method: 'POST' }); toast('Time moved forward'); await circlePage(curId); },
    async email() { await api(`/circles/${curId}/me/email`, { method: 'POST', body: { email: $('#myemail').value } }); toast('Email updated'); await circlePage(curId); },
    async ask() {
      const q = $('#q').value.trim(); if (!q) return;
      const r = await api(`/circles/${curId}/steward`, { method: 'POST', body: { question: q } });
      $('#qa').innerHTML = `<div class="ans">${esc(r.answer)}</div><details><summary>What the Steward looked at</summary><pre>${esc(JSON.stringify(r.trace, null, 2))}</pre></details>`;
    },
    async health() {
      const r = await api(`/circles/${curId}/health`);
      $('#hl').innerHTML = `<ul class="members">${r.members.map((m) => `<li><span>${esc(m.name)}<br><span class="small mute">${esc(m.note)}</span></span><span class="pill ${m.score === null ? '' : m.score >= 80 ? 'ok' : 'warn'}">${m.score === null ? '–' : m.score + '%'}</span></li>`).join('')}</ul>`;
    },
    async remind() {
      const r = await api(`/circles/${curId}/reminder`, { method: 'POST', body: { member_id: $('#rm').value, language: $('#rl').value } });
      $('#rout').innerHTML = `<label for="rtext">Draft (${esc(r.source)}), edit before you send</label><textarea id="rtext">${esc(r.text)}</textarea><div class="btns"><button class="ghost" data-act="copy" data-v="${esc(r.text)}">Copy message</button></div>`;
    },
    async invoice() {
      const r = await api(`/circles/${curId}/invoice-late`, { method: 'POST', body: { member_id: $('#rm').value } });
      toast('Invoice sent: ' + r.invoiceId); await circlePage(curId);
    },
    refresh() { return circlePage(curId); },
  };
  async function move(i, d) {
    const ids = view.members.map((m) => m.id), j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await api(`/circles/${curId}/reorder`, { method: 'POST', body: { order: ids } });
    await circlePage(curId);
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (el && A[el.dataset.act]) { e.preventDefault(); act(A[el.dataset.act])(el); }
  });
  document.addEventListener('submit', (e) => {
    const k = e.target.dataset.actSubmit; if (!k) return;
    e.preventDefault();
    act(async () => {
      if (k === 'create') {
        const body = { name: $('#f_name').value, n_members: $('#f_n').value, amount: $('#f_amt').value, cadence: $('#f_cad').value, start_date: $('#f_date').value, owner_name: $('#f_me').value, owner_email: $('#f_email').value };
        const r = await api('/circles', { method: 'POST', body, token: '' });
        const s = store.get(); s.circles = s.circles || {}; s.circles[r.id] = { name: body.name, token: r.token }; store.set(s);
        location.hash = '#/c/' + r.id;
      } else if (k === 'join') {
        const id = $('#app').dataset.cid;
        const r = await api(`/circles/${id}/join`, { method: 'POST', body: { name: $('#j_name').value, email: $('#j_email').value }, token: '' });
        const s = store.get(); s.circles = s.circles || {}; s.circles[id] = { name: 'Circle', token: r.token }; store.set(s);
        location.hash = '#/c/' + id;
      }
    })();
  });
  window.addEventListener('hashchange', route);
  (async () => {
    try { CONFIG = await api('/config', { token: '' }); } catch { /* ignore */ }
    $('#modetag').textContent = CONFIG.mock ? 'mock mode' : 'PayPal sandbox' + (CONFIG.aiEnabled ? ' · AI on' : ' · AI off');
    route();
  })();
})();
