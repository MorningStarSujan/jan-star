/**
 * JAN STAR on Cloudflare: one Worker serves the web app (static files, free and unlimited) and the /api routes.
 * Rooms and realtime run in Durable Objects (see room.js / hub.js). No Redis, no Ably, no third-party services.
 */
import { Room } from './room.js';
import { Hub } from './hub.js';
import { GAMES, LIM, bad, failJson, json, newKey, normKey, fmtKey, roomIdOf, validRid, obj } from './util.js';

export { Room, Hub };

const ROOM_ACTIONS = new Set(['resume', 'send', 'leave', 'end', 'callJoin', 'callLeave', 'signal', 'score']);
const KEY_BAD = 'That access key is not valid, or the chat has ended.';

/* Best-effort flood guard per isolate (cheap, no extra Durable Object calls). Real limits live in the Hub and Rooms. */
const flood = new Map();
function floodGuard(ip) {
  const now = Date.now();
  let e = flood.get(ip);
  if (!e || e.exp < now) { e = { n: 0, exp: now + 10000 }; flood.set(ip, e); if (flood.size > 2000) for (const [k, v] of flood) if (v.exp < now) flood.delete(k); }
  if (++e.n > 600) throw bad('Too many requests. Please wait a little.', 429);
}

const sameOrigin = (request, url) => { const o = request.headers.get('origin'); if (!o) return true; try { return new URL(o).host === url.host; } catch { return false; } };
const roomStub = (env, id) => env.ROOM.get(env.ROOM.idFromName(id));
const hubStub = (env) => env.HUB.get(env.HUB.idFromName('main'));

async function readJson(request) {
  const text = await request.text();
  if (text.length > 100000) throw bad('Request too large.', 413);
  try { return obj(text ? JSON.parse(text) : {}); } catch { return {}; }
}

async function forwardJson(stub, request, action, id, body) {
  const headers = new Headers(request.headers);
  headers.set('x-rid', id);
  headers.set('content-type', 'application/json');
  const res = await stub.fetch(new Request(new URL('/api/' + action, request.url), { method: 'POST', headers, body: JSON.stringify(body) }));
  let out; try { out = await res.json(); } catch { out = { ok: false, error: 'Server error. Try again.' }; }
  return { out, status: res.status };
}

async function route(request, env, url) {
  const action = decodeURIComponent(url.pathname.slice('/api/'.length));
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  floodGuard(ip);

  // --- live connections (GET + Upgrade) ---
  if (action === 'ws') {
    if (!sameOrigin(request, url)) throw bad('Not allowed.', 403);
    const id = url.searchParams.get('rid');
    if (!validRid(id)) throw bad('Not found.', 404);
    return roomStub(env, id).fetch(request);
  }
  if (action === 'public-ws') {
    if (!sameOrigin(request, url)) throw bad('Not allowed.', 403);
    return hubStub(env).fetch(request);
  }

  // --- media: GET /api/media?fid=...  and  POST /api/upload ---
  if (action === 'media' || action === 'upload') {
    if (request.method !== (action === 'media' ? 'GET' : 'POST')) throw bad(action === 'media' ? 'GET only.' : 'POST only.', 405);
    const id = request.headers.get('x-rid');
    if (!validRid(id)) throw bad('Not allowed.', 401);
    return roomStub(env, id).fetch(request);
  }

  if (request.method !== 'POST') return json({ ok: false, error: 'POST only.' }, 405, { allow: 'POST' });

  if (action === 'config') return json({ ok: true, transport: 'ws', people: LIM.people, file: LIM.file });

  if (action === 'create') {
    if (!(await hubStub(env).limit('create', ip, 10, 3600))) throw bad('Too many requests. Please wait a little.', 429);
    const body = await readJson(request);
    const key = newKey(), id = await roomIdOf(key);
    const { out, status } = await forwardJson(roomStub(env, id), request, 'create', id, { name: body.name, chat: body.chat });
    return json(out.ok ? { ...out, key } : out, status);
  }

  if (action === 'join') {
    if (!(await hubStub(env).limit('join', ip, 20, 600))) throw bad('Too many requests. Please wait a little.', 429);
    const body = await readJson(request);
    if (normKey(body.key).length !== 16) throw bad(KEY_BAD, 404);
    const id = await roomIdOf(body.key);
    const { out, status } = await forwardJson(roomStub(env, id), request, 'join', id, { name: body.name });
    return json(out.ok ? { ...out, key: fmtKey(body.key) } : out, status);
  }

  if (action === 'publicBoard') {
    if (!(await hubStub(env).limit('pub', ip, 60, 60))) throw bad('Too many requests. Please wait a little.', 429);
    const body = await readJson(request);
    const game = GAMES.includes(String(body.game)) ? String(body.game) : GAMES[0];
    return json({ ok: true, game, board: await hubStub(env).board(game) });
  }

  if (ROOM_ACTIONS.has(action)) {
    const id = request.headers.get('x-rid');
    if (!validRid(id)) throw bad('Not allowed.', 401);
    return roomStub(env, id).fetch(request);
  }
  throw bad('Not found.', 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request); // static files (404 for unknown paths)
    try { return await route(request, env, url); } catch (e) { return failJson(e); }
  },
};
