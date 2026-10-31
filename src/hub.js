/**
 * Hub: one shared Durable Object (named "main") that holds the things that must be shared between rooms:
 *  - the PUBLIC leaderboard (display name + score only), including its live read-only WebSocket feed
 *  - per-IP rate limits for creating/joining chats (best effort, kept in memory)
 */
import { DurableObject } from 'cloudflare:workers';
import { GAMES, LIM } from './util.js';

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.rl = new Map();
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec('CREATE TABLE IF NOT EXISTS pub (g TEXT, f TEXT, name TEXT, stars INTEGER, coins INTEGER, t INTEGER, PRIMARY KEY (g, f))');
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /* ---- rate limiting (fixed window, in memory) ---- */
  limit(bucket, id, max, windowSec) {
    const now = Date.now(), k = bucket + ':' + id;
    let e = this.rl.get(k);
    if (!e || e.exp < now) {
      e = { n: 0, exp: now + windowSec * 1000 };
      this.rl.set(k, e);
      if (this.rl.size > 5000) for (const [kk, v] of this.rl) if (v.exp < now) this.rl.delete(kk);
    }
    e.n++;
    return e.n <= max;
  }

  /* ---- public leaderboard ---- */
  board(game) {
    const now = Date.now();
    const all = this.sql.exec('SELECT f, name, stars, coins, t FROM pub WHERE g = ?', game).toArray();
    const rows = [], stale = [];
    for (const x of all) { if (now - x.t > LIM.idleMs) stale.push(x.f); else rows.push({ name: x.name, stars: x.stars, coins: x.coins }); }
    for (const f of stale) this.sql.exec('DELETE FROM pub WHERE g = ? AND f = ?', game, f); // abandoned rooms drop off on their own
    rows.sort((a, b) => b.stars - a.stars || b.coins - a.coins || a.name.localeCompare(b.name));
    return rows.slice(0, LIM.pubMax);
  }
  push(game) {
    const msg = JSON.stringify({ t: 'plb', game, board: this.board(game) });
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(msg); } catch { /* socket is closing */ } }
  }
  pubHas(game, f) { return this.sql.exec('SELECT 1 FROM pub WHERE g = ? AND f = ?', game, f).toArray().length > 0; }
  pubSet(game, f, name, stars, coins) {
    if (!GAMES.includes(game)) return;
    this.sql.exec('INSERT OR REPLACE INTO pub (g, f, name, stars, coins, t) VALUES (?, ?, ?, ?, ?, ?)', game, f, String(name).slice(0, 32), stars | 0, coins | 0, Date.now());
    this.push(game);
  }
  pubDel(game, fields) {
    let changed = false;
    for (const f of fields) if (this.pubHas(game, f)) { this.sql.exec('DELETE FROM pub WHERE g = ? AND f = ?', game, f); changed = true; }
    if (changed) this.push(game);
  }
  /** Remove everything a finished room put on the public board. `roomId` is 32 hex chars, so LIKE is safe. */
  pubDropRoom(roomId) {
    for (const g of GAMES) {
      const hit = this.sql.exec("SELECT 1 FROM pub WHERE g = ? AND f LIKE ? || '.%' LIMIT 1", g, roomId).toArray().length > 0;
      if (hit) { this.sql.exec("DELETE FROM pub WHERE g = ? AND f LIKE ? || '.%'", g, roomId); this.push(g); }
    }
  }

  /* ---- live read-only feed for the public leaderboard (no login needed) ---- */
  async fetch(request) {
    if (request.headers.get('upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    if (this.ctx.getWebSockets().length >= LIM.pubConns) return new Response('Busy', { status: 503 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  webSocketMessage() { /* read-only feed: anything the client sends is ignored */ }
  webSocketClose(ws) { try { ws.close(1000, 'bye'); } catch { /* already closed */ } }
  webSocketError(ws) { try { ws.close(1011, 'error'); } catch { /* already closed */ } }
}
