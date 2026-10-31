/* Shared helpers. Only Web APIs are used (no Node modules), so it runs on Cloudflare Workers as-is. */
export class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
export const bad = (m, s = 400) => new HttpError(s, m);

const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 31 characters, no look-alikes
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
export function b64url(bytes) {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export const rid = (n = 9) => b64url(randomBytes(n));

/** Unbiased random character from ALPHA (rejection sampling). */
function randChar() { for (;;) { const b = randomBytes(1)[0]; if (b < 248) return ALPHA[b % 31]; } } // 248 = 31 * 8
export const newKey = () => { let s = ''; for (let i = 0; i < 16; i++) s += randChar(); return s.match(/.{4}/g).join('-'); };
export const normKey = (k) => String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const fmtKey = (k) => (normKey(k).match(/.{1,4}/g) || []).join('-');

export const sha256hex = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(String(s))));
/** The room's private address is derived from its access key, so no key -> room table is needed. */
export const roomIdOf = async (key) => (await sha256hex('js-room:' + normKey(key))).slice(0, 32);
export const validRid = (r) => /^[0-9a-f]{32}$/.test(String(r || ''));
/** Constant-time string compare (both sides are fixed-length hex digests here). */
export function safeEq(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f\u202a-\u202e]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
export const cleanText = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e]/g, '').trim().slice(0, max);
export const obj = (b) => (b && typeof b === 'object' && !Array.isArray(b) ? b : {});

export const GAMES = ['harbor'];
export const LIM = {
  file: 3 * 1024 * 1024,       // per upload
  roomMedia: 24 * 1024 * 1024, // total media kept per room
  people: 8,
  msgs: 300,
  text: 4000,
  idleMs: 3 * 3600e3,          // room is deleted after this long with no activity
  maxLifeMs: 12 * 3600e3,      // hard cap on a room's lifetime
  chunk: 1000000,              // bytes per SQLite BLOB row (limit is 2 MB)
  pubMax: 50,
  pubConns: 200,
};
export const G = { maxStars: 500, maxCoins: 200000, firstStars: 50, firstCoins: 5000, starsPerSec: 2, coinsPerSec: 600 };

export const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra } });
export const failJson = (e) => {
  if (!e || !e.status) console.error('JAN STAR error:', e && (e.stack || e.message || e));
  return json({ ok: false, error: e && e.status ? e.message : 'Something went wrong.' }, e && e.status ? e.status : 500);
};
