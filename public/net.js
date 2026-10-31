/* Transport layer: HTTPS API for actions + one WebSocket per chat for live events (Cloudflare Durable Objects). */
window.Net = (() => {
  let sess = null, h = null, ws = null, gen = 0, retry = 0, timer = null, ping = null;
  const authHeaders = () => (sess ? { 'x-rid': sess.rid, 'x-pid': sess.pid, 'x-token': sess.token } : {});
  const wsUrl = (p) => (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + p;
  const detach = (w) => { if (w) { w.onopen = w.onmessage = w.onclose = w.onerror = null; try { w.close(1000); } catch { /* ignore */ } } };

  async function api(action, body) {
    try {
      const r = await fetch('/api/' + action, { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify(body || {}) });
      let j; try { j = await r.json(); } catch { j = { ok: false, error: 'Server error. Try again.' }; }
      j.status = r.status; return j;
    } catch { return { ok: false, status: 0, error: 'Network error. Check your connection.' }; }
  }

  function close() {
    gen++; clearTimeout(timer); clearInterval(ping);
    const w = ws; ws = null; detach(w);
  }

  function connect(handlers) { close(); h = handlers; retry = 0; open(gen); }
  function later(my) { clearTimeout(timer); timer = setTimeout(() => open(my), Math.min(15000, 1000 * 2 ** Math.min(retry++, 4))); }

  function open(my) {
    if (my !== gen || !sess) return;
    let w;
    try { w = new WebSocket(wsUrl('/api/ws?rid=' + encodeURIComponent(sess.rid))); } catch { h.status(false); return later(my); }
    ws = w;
    w.onopen = () => { try { w.send(JSON.stringify({ t: 'auth', pid: sess.pid, token: sess.token })); } catch { /* closing */ } };
    w.onmessage = (e) => {
      if (my !== gen) return;
      let ev; try { ev = JSON.parse(e.data); } catch { return; } // "pong" replies are not JSON
      if (ev.t === 'ready') { retry = 0; clearInterval(ping); ping = setInterval(() => { if (w.readyState === 1) w.send('ping'); }, 25000); h.status(true); return; }
      if (ev.t === 'presence') h.presence(new Set(ev.online)); else h.event(ev);
    };
    w.onclose = () => { if (my !== gen) return; clearInterval(ping); h.status(false); later(my); };
    w.onerror = () => { /* onclose follows and handles the retry */ };
  }

  /* Public leaderboard feed: read-only, no session needed. */
  let pws = null, pgen = 0, pretry = 0, ptimer = null, pping = null;
  function closePublic() { pgen++; clearTimeout(ptimer); clearInterval(pping); const w = pws; pws = null; detach(w); }
  function connectPublic(onEvent, onStatus) { closePublic(); pretry = 0; openPublic(pgen, onEvent, onStatus); }
  function openPublic(my, onEvent, onStatus) {
    if (my !== pgen) return;
    let w;
    try { w = new WebSocket(wsUrl('/api/public-ws')); } catch { onStatus(false); ptimer = setTimeout(() => openPublic(my, onEvent, onStatus), 4000); return; }
    pws = w;
    w.onopen = () => { pretry = 0; pping = setInterval(() => { if (w.readyState === 1) w.send('ping'); }, 25000); onStatus(true); };
    w.onmessage = (e) => { if (my !== pgen) return; let ev; try { ev = JSON.parse(e.data); } catch { return; } onEvent(ev); };
    w.onclose = () => { if (my !== pgen) return; clearInterval(pping); onStatus(false); ptimer = setTimeout(() => openPublic(my, onEvent, onStatus), Math.min(15000, 1000 * 2 ** Math.min(pretry++, 4))); };
    w.onerror = () => { /* onclose follows */ };
  }

  return { api, connect, close, connectPublic, closePublic, session: (s) => { sess = s; }, authHeaders };
})();
