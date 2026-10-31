'use strict';
let pass = 0, fail = 0;
const t = (ok, msg) => { if (ok) pass++; else { fail++; process.exitCode = 1; } console.log((ok ? '  ✓ ' : '  ✗ ') + msg); };
const section = (s) => console.log('\n' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) { const t0 = Date.now(); for (;;) { let v; try { v = await fn(); } catch { v = false; } if (v) return v; if (Date.now() - t0 > ms) return false; await sleep(40); } }
let ipN = 0;
const freshIp = () => '10.1.' + Math.floor(++ipN / 250) + '.' + (ipN % 250 + 1); // the Worker trusts Cloudflare's cf-connecting-ip; locally the test sets it
const totals = () => ({ pass, fail });

function client(base) {
  const hdr = (c, ip, extra) => ({ 'cf-connecting-ip': ip || freshIp(), ...(c ? { 'x-rid': c.rid, 'x-pid': c.pid, 'x-token': c.token } : {}), ...extra });
  async function call(action, body, c, ip) {
    const r = await fetch(base + '/api/' + action, { method: 'POST', headers: hdr(c, ip, { 'content-type': 'application/json' }), body: JSON.stringify(body || {}) });
    let j; try { j = await r.json(); } catch { j = {}; } j.status = r.status; return j;
  }
  const creds = (r) => ({ rid: r.state.id, pid: r.pid, token: r.token });
  async function up(c, bytes, mime, name, voice) {
    const r = await fetch(base + '/api/upload', { method: 'POST', headers: hdr(c, null, { 'content-type': 'application/octet-stream', 'x-mime': mime, 'x-filename': encodeURIComponent(name || 'f'), 'x-voice': voice ? '1' : '0' }), body: bytes });
    const j = await r.json(); j.status = r.status; return j;
  }
  async function media(c, fid) { return fetch(base + '/api/media?fid=' + encodeURIComponent(fid), { headers: hdr(c) }); }
  function sock(c, path = '/api/ws?rid=') {
    return new Sock(base.replace(/^http/, 'ws') + path + (c ? encodeURIComponent(c.rid) : ''), c);
  }
  return { call, creds, up, media, sock, hdr };
}

class Sock {
  constructor(url, c) {
    this.ev = []; this.closed = false; this.code = null; this.ready = false; this.online = null;
    this.ws = new WebSocket(url);
    this.ws.onopen = () => { if (c) this.ws.send(JSON.stringify({ t: 'auth', pid: c.pid, token: c.token })); else this.ready = true; };
    this.ws.onmessage = (e) => {
      let ev; try { ev = JSON.parse(e.data); } catch { return; }
      if (ev.t === 'ready') this.ready = true; else if (ev.t === 'presence') { this.online = new Set(ev.online); this.ev.push(ev); } else this.ev.push(ev);
    };
    this.ws.onclose = (e) => { this.closed = true; this.code = e.code; };
  }
  find(pred) { return this.ev.find(pred); }
  wait(pred, ms = 4000) { return until(() => this.ev.find(pred), ms); }
  waitReady(ms = 5000) { return until(() => this.ready, ms); }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}
module.exports = { t, section, sleep, until, freshIp, totals, client };
