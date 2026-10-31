/**
 * Room: one Durable Object per chat. Its name is derived from the access key, so no lookup table is needed.
 * It owns everything about the chat: members, messages, media, call state, scores, and the live WebSockets.
 * All data lives in the object's own SQLite storage and is erased with deleteAll() when the chat ends.
 */
import { DurableObject } from 'cloudflare:workers';
import { LIM, G, GAMES, bad, rid, sha256hex, safeEq, clean, cleanText, obj, json, failJson } from './util.js';

const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
const KIND = {
  image: /^image\/(png|jpe?g|gif|webp)$/,
  video: /^video\/(mp4|webm|quicktime)$/,
  audio: /^audio\/(webm|ogg|mp4|mpeg|wav|x-wav|aac|x-m4a)$/,
};
const NOT_FOUND_KEY = 'That access key is not valid, or the chat has ended.';

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.ready = null; // null = not checked yet, true = chat exists, false = no chat here
    this.rl = new Map();
    // Optional owner settings (wrangler vars). Defaults are the normal limits; tests use short values.
    this.idleMs = Math.max(1000, Number(env.IDLE_MS) || LIM.idleMs);
    this.lifeMs = Math.max(1000, Number(env.MAX_LIFE_MS) || LIM.maxLifeMs);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /* ---------- small helpers ---------- */
  hub() { return this.env.HUB.get(this.env.HUB.idFromName('main')); }
  exists() {
    if (this.ready === null) this.ready = this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length > 0;
    return this.ready;
  }
  initSchema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id = 1), rid TEXT, name TEXT, host TEXT, created INTEGER, last INTEGER);
      CREATE TABLE IF NOT EXISTS members (pid TEXT PRIMARY KEY, name TEXT, th TEXT, joined INTEGER);
      CREATE TABLE IF NOT EXISTS msgs (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, body TEXT);
      CREATE TABLE IF NOT EXISTS files (fid TEXT PRIMARY KEY, mime TEXT, kind TEXT, name TEXT, size INTEGER, ts INTEGER, n INTEGER);
      CREATE TABLE IF NOT EXISTS chunks (fid TEXT, i INTEGER, data BLOB, PRIMARY KEY (fid, i));
      CREATE TABLE IF NOT EXISTS incall (pid TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS lb (g TEXT, pid TEXT, stars INTEGER, coins INTEGER, t INTEGER, pub INTEGER, PRIMARY KEY (g, pid));
    `);
    this.ready = true;
  }
  meta() { return this.sql.exec('SELECT rid, name, host, created, last FROM meta WHERE id = 1').toArray()[0] || null; }
  expired(meta, now = Date.now()) { return now - meta.last > this.idleMs || now - meta.created > this.lifeMs; }
  deadline(meta) { return Math.min(meta.last + this.idleMs, meta.created + this.lifeMs) + 1000; }
  limit(bucket, id, max, windowSec) {
    const now = Date.now(), k = bucket + ':' + id;
    let e = this.rl.get(k);
    if (!e || e.exp < now) { e = { n: 0, exp: now + windowSec * 1000 }; this.rl.set(k, e); if (this.rl.size > 2000) for (const [kk, v] of this.rl) if (v.exp < now) this.rl.delete(kk); }
    if (++e.n > max) throw bad('Too many requests. Please wait a little.', 429);
  }

  /* ---------- live connections ---------- */
  broadcast(ev) {
    const s = JSON.stringify(ev);
    for (const ws of this.ctx.getWebSockets()) { const a = ws.deserializeAttachment(); if (a && a.auth) { try { ws.send(s); } catch { /* closing */ } } }
  }
  sendTo(pid, ev) {
    const s = JSON.stringify(ev);
    for (const ws of this.ctx.getWebSockets()) { const a = ws.deserializeAttachment(); if (a && a.auth && a.pid === pid) { try { ws.send(s); } catch { /* closing */ } } }
  }
  closeSockets(pid) {
    for (const ws of this.ctx.getWebSockets()) { const a = ws.deserializeAttachment(); if (a && a.pid === pid) { try { ws.close(1000, 'left'); } catch { /* closing */ } } }
  }
  sendPresence(except = {}) {
    const online = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except.ws) continue;
      const a = ws.deserializeAttachment();
      if (a && a.auth && a.pid !== except.pid) online.add(a.pid);
    }
    this.broadcast({ t: 'presence', online: [...online] });
  }

  /* ---------- rooms ---------- */
  async touch(meta) { // activity stamp for idle expiry; written at most once a minute to save database writes
    const now = Date.now();
    if (now - meta.last < 60000) return;
    meta.last = now;
    this.sql.exec('UPDATE meta SET last = ? WHERE id = 1', now);
    await this.ctx.storage.setAlarm(this.deadline(meta));
  }
  async endRoom(reason) {
    const meta = this.meta();
    const bye = JSON.stringify({ t: 'ended', reason });
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(bye); } catch { /* closing */ } } // also people whose connection has not signed in yet
    if (meta && this.sql.exec('SELECT 1 FROM lb WHERE pub = 1 LIMIT 1').toArray().length) { try { await this.hub().pubDropRoom(meta.rid); } catch (e) { console.error('pubDropRoom failed', e && e.message); } }
    for (const ws of this.ctx.getWebSockets()) { try { ws.close(1000, 'ended'); } catch { /* closing */ } }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.ready = false;
  }
  async alarm() {
    if (!this.exists()) return;
    const meta = this.meta();
    if (!meta) return;
    if (this.expired(meta)) await this.endRoom('This chat expired and was deleted.');
    else await this.ctx.storage.setAlarm(this.deadline(meta));
  }

  async authIds(pid, token) {
    pid = String(pid || ''); token = String(token || '');
    if (!pid || !token) throw bad('Not allowed.', 401);
    if (!this.exists()) throw bad('This chat has ended.', 410);
    const meta = this.meta();
    if (!meta) throw bad('This chat has ended.', 410);
    if (this.expired(meta)) { await this.endRoom('This chat expired and was deleted.'); throw bad('This chat has ended.', 410); }
    const m = this.sql.exec('SELECT pid, name, th, joined FROM members WHERE pid = ?', pid).toArray()[0];
    if (!m) throw bad('You are no longer in this chat.', 401);
    if (!safeEq(m.th, await sha256hex(token))) throw bad('Not allowed.', 401);
    return { meta, m };
  }
  authHeaders(h) { return this.authIds(h.get('x-pid'), h.get('x-token')); }

  stateOf(meta) {
    const members = this.sql.exec('SELECT pid, name FROM members ORDER BY joined, pid').toArray().map((x) => ({ pid: x.pid, name: x.name }));
    const call = this.sql.exec('SELECT pid FROM incall').toArray().map((x) => x.pid);
    return { id: meta.rid, name: meta.name, hostPid: meta.host, members, call, max: LIM.people };
  }
  publishState(meta) { this.broadcast({ t: 'state', state: this.stateOf(meta) }); }
  async addMember(name) {
    const token = rid(24), pid = rid(6);
    this.sql.exec('INSERT INTO members (pid, name, th, joined) VALUES (?, ?, ?, ?)', pid, name, await sha256hex(token), Date.now());
    return { pid, name, token };
  }
  async pushMsg(meta, m) {
    m.id = rid(8); m.ts = Date.now();
    this.sql.exec('INSERT INTO msgs (ts, body) VALUES (?, ?)', m.ts, JSON.stringify(m));
    this.sql.exec('DELETE FROM msgs WHERE seq <= (SELECT MAX(seq) FROM msgs) - ?', LIM.msgs);
    this.broadcast({ t: 'msg', m });
    await this.touch(meta);
    return m;
  }
  sys(meta, text) { return this.pushMsg(meta, { kind: 'system', text }); }
  history(m) { return this.sql.exec('SELECT body FROM msgs WHERE ts >= ? ORDER BY seq', m.joined).toArray().map((x) => JSON.parse(x.body)); }
  lbBoard(game) { return this.sql.exec('SELECT pid, stars, coins FROM lb WHERE g = ?', game).toArray().map((x) => ({ pid: x.pid, stars: x.stars, coins: x.coins })); }
  lbAll() { const out = {}; for (const g of GAMES) out[g] = this.lbBoard(g); return out; }

  /* ---------- HTTP entry (the Worker forwards /api/* here) ---------- */
  async fetch(request) {
    const path = new URL(request.url).pathname;
    try {
      if (path === '/api/ws') return await this.openSocket(request);
      if (path === '/api/upload') return json(await this.upload(request));
      if (path === '/api/media') return await this.media(request);
      if (request.method !== 'POST') throw bad('POST only.', 405);
      const text = await request.text();
      if (text.length > 100000) throw bad('Request too large.', 413);
      let body = {}; try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
      const action = path.slice('/api/'.length);
      if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) throw bad('Not found.', 404);
      return json(await this[ACTIONS[action]](obj(body), request.headers));
    } catch (e) { return failJson(e); }
  }

  /* ---------- WebSocket (hibernation API: the object sleeps while nobody talks) ---------- */
  async openSocket(request) {
    if (request.headers.get('upgrade') !== 'websocket') throw bad('Expected a WebSocket.', 426);
    const socks = this.ctx.getWebSockets();
    if (socks.length >= LIM.people * 4 || socks.filter((w) => !(w.deserializeAttachment() || {}).auth).length >= 16) throw bad('Busy. Try again.', 503);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    if (!this.exists()) {
      server.serializeAttachment({ auth: false });
      server.send(JSON.stringify({ t: 'ended', reason: 'This chat has ended.' }));
      server.close(4410, 'ended');
    } else server.serializeAttachment({ auth: false });
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, message) {
    const a = ws.deserializeAttachment() || {};
    if (a.auth) return; // after sign-in the browser only sends "ping" (answered automatically); everything else goes through the API
    if (typeof message !== 'string' || message.length > 2000) { ws.close(1009, 'too big'); return; }
    let d; try { d = JSON.parse(message); } catch { ws.close(1003, 'bad message'); return; }
    if (!d || d.t !== 'auth') { ws.close(4401, 'sign in first'); return; }
    try {
      const { m } = await this.authIds(d.pid, d.token);
      ws.serializeAttachment({ auth: true, pid: m.pid });
      ws.send(JSON.stringify({ t: 'ready' }));
      this.sendPresence();
    } catch (e) {
      try { ws.send(JSON.stringify({ t: 'ended', reason: e && e.status === 410 ? 'This chat has ended.' : 'You are no longer in this chat.' })); ws.close(e && e.status === 410 ? 4410 : 4401, 'not allowed'); } catch { /* closing */ }
    }
  }
  webSocketClose(ws) {
    const a = ws.deserializeAttachment();
    try { ws.close(1000, 'bye'); } catch { /* already closed */ }
    if (a && a.auth && this.exists()) this.sendPresence({ ws });
  }
  webSocketError(ws) { this.webSocketClose(ws); }

  /* ---------- actions ---------- */
  async create(b, h) {
    const name = clean(b.name, 32), chat = clean(b.chat, 48), id = h.get('x-rid');
    if (!name || !chat) throw bad('Enter a display name and a chat name.');
    if (this.exists()) throw bad('Could not create the chat. Try again.', 409);
    this.initSchema();
    const now = Date.now();
    this.sql.exec('INSERT INTO meta (id, rid, name, host, created, last) VALUES (1, ?, ?, NULL, ?, ?)', id, chat, now, now);
    const mem = await this.addMember(name);
    this.sql.exec('UPDATE meta SET host = ? WHERE id = 1', mem.pid);
    const meta = this.meta();
    await this.ctx.storage.setAlarm(this.deadline(meta));
    return { ok: true, pid: mem.pid, token: mem.token, state: this.stateOf(meta), messages: [], lb: this.lbAll() };
  }

  async join(b) {
    const name = clean(b.name, 32);
    if (!name) throw bad('Enter a display name.');
    if (!this.exists()) throw bad(NOT_FOUND_KEY, 404);
    const meta = this.meta();
    if (!meta) throw bad(NOT_FOUND_KEY, 404);
    if (this.expired(meta)) { await this.endRoom('This chat expired and was deleted.'); throw bad(NOT_FOUND_KEY, 404); }
    if (this.sql.exec('SELECT COUNT(*) AS c FROM members').one().c >= LIM.people) throw bad(`This chat is full (${LIM.people} people).`, 409);
    const mem = await this.addMember(name);
    await this.sys(meta, `${mem.name} joined`);
    this.publishState(meta);
    return { ok: true, pid: mem.pid, token: mem.token, state: this.stateOf(meta), messages: [], lb: this.lbAll() };
  }

  async resume(b, h) {
    const { meta, m } = await this.authHeaders(h);
    return { ok: true, state: this.stateOf(meta), messages: this.history(m), lb: this.lbAll() };
  }

  async send(b, h) {
    const { meta, m } = await this.authHeaders(h);
    this.limit('msg', m.pid, 40, 10);
    const text = cleanText(b.text, LIM.text);
    if (!text) throw bad('Empty message.');
    await this.pushMsg(meta, { kind: 'text', pid: m.pid, name: m.name, text });
    return { ok: true };
  }

  async leave(b, h) {
    const { meta, m } = await this.authHeaders(h);
    if (m.pid === meta.host) throw bad('The host must stop hosting to end the chat.', 403);
    const pf = `${meta.rid}.${m.pid}`;
    const onPublic = this.sql.exec('SELECT 1 FROM lb WHERE pid = ? AND pub = 1 LIMIT 1', m.pid).toArray().length > 0;
    this.sql.exec('DELETE FROM members WHERE pid = ?', m.pid);
    this.sql.exec('DELETE FROM incall WHERE pid = ?', m.pid);
    this.sql.exec('DELETE FROM lb WHERE pid = ?', m.pid);
    if (onPublic) for (const g of GAMES) await this.hub().pubDel(g, [pf]);
    this.closeSockets(m.pid);
    await this.sys(meta, `${m.name} left`);
    this.publishState(meta);
    for (const g of GAMES) this.broadcast({ t: 'lb', game: g, board: this.lbBoard(g) });
    this.sendPresence({ pid: m.pid });
    return { ok: true };
  }

  async end(b, h) {
    const { meta, m } = await this.authHeaders(h);
    if (m.pid !== meta.host) throw bad('Only the host can stop hosting.', 403);
    await this.endRoom('The host stopped hosting. This chat was ended and everything was deleted.');
    return { ok: true };
  }

  async callJoin(b, h) {
    const { meta, m } = await this.authHeaders(h);
    const cur = this.sql.exec('SELECT pid FROM incall').toArray().map((x) => x.pid);
    const peers = cur.filter((p) => p !== m.pid);
    if (cur.length === 0) await this.sys(meta, `${m.name} started a ${b.video ? 'video' : 'voice'} call`);
    this.sql.exec('INSERT OR IGNORE INTO incall (pid) VALUES (?)', m.pid);
    this.publishState(meta);
    let ice = DEFAULT_ICE; try { const x = JSON.parse(this.env.ICE_SERVERS || ''); if (Array.isArray(x) && x.length) ice = x; } catch { /* use default */ }
    return { ok: true, peers, ice };
  }

  async callLeave(b, h) {
    const { meta, m } = await this.authHeaders(h);
    this.sql.exec('DELETE FROM incall WHERE pid = ?', m.pid);
    this.publishState(meta);
    return { ok: true };
  }

  async signal(b, h) {
    const { m } = await this.authHeaders(h);
    this.limit('sig', m.pid, 400, 10);
    const to = String(b.to || '');
    const inCall = this.sql.exec('SELECT pid FROM incall').toArray().map((x) => x.pid);
    if (!inCall.includes(m.pid) || !inCall.includes(to)) throw bad('Not in a call with that person.', 403);
    if (JSON.stringify(b.data || '').length > 30000) throw bad('Signal too large.', 413);
    this.sendTo(to, { t: 'signal', from: m.pid, data: b.data });
    return { ok: true };
  }

  /** Games: client-reported scores, bounded by plausibility checks (a friendly leaderboard, not cheat-proof). */
  async score(b, h) {
    const { meta, m } = await this.authHeaders(h);
    const game = String(b.game || '');
    if (!GAMES.includes(game)) throw bad('Unknown game.');
    const stars = Math.floor(+b.stars), coins = Math.floor(+b.coins);
    if (!Number.isFinite(stars) || !Number.isFinite(coins) || stars < 0 || coins < 0 || stars > G.maxStars || coins > G.maxCoins) throw bad('Score rejected.');
    const prev = this.sql.exec('SELECT stars, coins, t, pub FROM lb WHERE g = ? AND pid = ?', game, m.pid).toArray()[0] || null;
    const now = Date.now(), show = b.pub !== false, pf = `${meta.rid}.${m.pid}`;
    if (prev) {
      if (now - prev.t < 500) {
        // Throttled, but a change to the public-board opt-out must always take effect.
        if (show !== !!prev.pub) {
          this.sql.exec('UPDATE lb SET pub = ? WHERE g = ? AND pid = ?', show ? 1 : 0, game, m.pid);
          if (show) await this.hub().pubSet(game, pf, m.name, prev.stars, prev.coins); else await this.hub().pubDel(game, [pf]);
        }
        return { ok: true, skipped: true };
      }
      const dt = Math.min(120, (now - prev.t) / 1000);
      if (stars > prev.stars + G.starsPerSec * dt + 2 || coins > prev.coins + G.coinsPerSec * dt + 600) throw bad('Score rejected.');
    } else if (stars > G.firstStars || coins > G.firstCoins) throw bad('Score rejected.');
    this.sql.exec('INSERT OR REPLACE INTO lb (g, pid, stars, coins, t, pub) VALUES (?, ?, ?, ?, ?, ?)', game, m.pid, stars, coins, now, show ? 1 : 0);
    this.broadcast({ t: 'lb', game, board: this.lbBoard(game) });
    if (show) await this.hub().pubSet(game, pf, m.name, stars, coins);
    else if (prev && prev.pub) await this.hub().pubDel(game, [pf]);
    await this.touch(meta);
    return { ok: true };
  }

  /* ---------- media (stored in the room's own SQLite, deleted with the room) ---------- */
  async upload(request) {
    if (request.method !== 'POST') throw bad('POST only.', 405);
    const h = request.headers;
    const { meta, m } = await this.authHeaders(h);
    if ((+h.get('content-length') || 0) > LIM.file) throw bad('File is larger than 3 MB.', 413);
    const buf = await request.arrayBuffer();
    if (!buf.byteLength) throw bad('No file.');
    if (buf.byteLength > LIM.file) throw bad('File is larger than 3 MB.', 413);
    this.limit('up', m.pid, 20, 600);
    const total = this.sql.exec('SELECT COALESCE(SUM(size), 0) AS s FROM files').one().s;
    if (total + buf.byteLength > LIM.roomMedia) throw bad('This chat has reached its media limit.', 413);
    const mime = String(h.get('x-mime') || '').split(';')[0].toLowerCase().slice(0, 100);
    const kind = KIND.image.test(mime) ? 'image' : KIND.video.test(mime) ? 'video' : KIND.audio.test(mime) ? 'audio' : 'file';
    let name = 'file'; try { name = clean(decodeURIComponent(String(h.get('x-filename') || 'file')), 120) || 'file'; } catch { /* keep default */ }
    const fid = rid(12);
    let n = 0;
    for (let i = 0; i < buf.byteLength; i += LIM.chunk, n++) this.sql.exec('INSERT INTO chunks (fid, i, data) VALUES (?, ?, ?)', fid, n, buf.slice(i, i + LIM.chunk));
    this.sql.exec('INSERT INTO files (fid, mime, kind, name, size, ts, n) VALUES (?, ?, ?, ?, ?, ?, ?)', fid, mime, kind, name, buf.byteLength, Date.now(), n);
    await this.pushMsg(meta, { kind, pid: m.pid, name: m.name, voice: kind === 'audio' && h.get('x-voice') === '1', file: { id: fid, name, mime, size: buf.byteLength } });
    return { ok: true };
  }

  async media(request) {
    if (request.method !== 'GET') throw bad('GET only.', 405);
    const { m } = await this.authHeaders(request.headers);
    const fid = String(new URL(request.url).searchParams.get('fid') || '');
    const f = this.sql.exec('SELECT mime, kind, name, ts, n FROM files WHERE fid = ?', fid).toArray()[0];
    if (!f || f.ts < m.joined) throw bad('Not found.', 404);
    const parts = this.sql.exec('SELECT data FROM chunks WHERE fid = ? ORDER BY i', fid).toArray().map((x) => new Uint8Array(x.data));
    if (parts.length !== f.n) throw bad('Not found.', 404);
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let off = 0; for (const p of parts) { out.set(p, off); off += p.length; }
    return new Response(out, { status: 200, headers: {
      'Content-Type': f.kind === 'file' ? 'application/octet-stream' : f.mime,
      'Content-Disposition': f.kind === 'file' ? `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}` : 'inline',
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': 'sandbox',
    } });
  }
}

const ACTIONS = { create: 'create', join: 'join', resume: 'resume', send: 'send', leave: 'leave', end: 'end', callJoin: 'callJoin', callLeave: 'callLeave', signal: 'signal', score: 'score' };
