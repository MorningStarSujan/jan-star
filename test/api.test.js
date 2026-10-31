'use strict';
// End-to-end API test against the real Worker + Durable Objects running locally in workerd (the Cloudflare runtime).
const { t, section, sleep, until, freshIp, client } = require('./lib');

module.exports = async function apiTests(base, fastBase) {
  const C = client(base);
  const { call, creds, up, media, sock } = C;
  const KEYRE = /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/;

  section('Basics');
  const cfg = await call('config');
  t(cfg.ok && cfg.transport === 'ws' && cfg.people === 8, 'config: realtime transport is WebSocket (Durable Objects), 8 people');
  const g = await fetch(base + '/api/create'); t(g.status === 405, 'GET on an action is rejected (405)');
  t((await call('nope')).status === 404, 'unknown action is 404');
  t((await call('create', { name: '', chat: '' })).status === 400, 'create requires names');
  t((await call('create', { name: 'Al', chat: '' })).status === 400, 'create requires a chat name');

  const ipA = freshIp();
  const h = await call('create', { name: 'Alice', chat: 'Game Night' }, null, ipA);
  t(h.ok && KEYRE.test(h.key) && h.state.members.length === 1 && h.state.hostPid === h.pid && h.state.name === 'Game Night', 'host created a chat; key looks like ' + h.key);
  t(/^[0-9a-f]{32}$/.test(h.state.id) && !h.key.replace(/-/g, '').includes(h.state.id) && JSON.stringify(h).indexOf(h.state.id.slice(0, 8)) >= 0, 'room id is a hash, never the access key');
  const hc = creds(h);
  t((await call('join', { name: 'Zed', key: 'AAAA-BBBB-CCCC-DDDD' })).status === 404, 'wrong key rejected');
  t((await call('join', { name: 'Zed', key: 'short' })).status === 404, 'malformed key rejected');

  const dead = sock({ rid: 'a'.repeat(32), pid: 'x', token: 'y' });
  t(await dead.wait((e) => e.t === 'ended') && await until(() => dead.closed), 'a WebSocket to a chat that does not exist is told it ended, then closed');
  const ws0 = await fetch(base + '/api/ws?rid=' + hc.rid, { headers: { origin: 'https://evil.example' } });
  t(ws0.status === 403, 'a WebSocket from another website (wrong Origin) is refused');

  const hs = sock(hc);
  t(await hs.waitReady(), 'host WebSocket signs in and is ready');
  t(await until(() => hs.online && hs.online.has(hc.pid)), 'presence: host sees itself online');
  const bad = sock({ ...hc, token: 'wrong-token' });
  t(await bad.wait((e) => e.t === 'ended') && await until(() => bad.closed && bad.code === 4401) && !bad.ready, 'a WebSocket with a wrong token is refused and closed (4401)');

  const j = await call('join', { name: 'Bob', key: h.key.toLowerCase().replace(/-/g, '') });
  t(j.ok && j.key === h.key && j.state.members.length === 2, 'guest joined with a lowercase key typed without dashes');
  const gc = creds(j);
  t(await hs.wait((e) => e.t === 'state' && e.state.members.length === 2), 'host got the live member-list update');
  t(!!hs.find((e) => e.t === 'msg' && /Bob joined/.test(e.m.text)), 'system "joined" notice delivered live');
  const gs = sock(gc);
  t(await gs.waitReady(), 'guest WebSocket ready');
  t(await until(() => hs.online && hs.online.has(gc.pid) && hs.online.size === 2), 'presence: host sees guest online');
  const gs2 = sock(gc); await gs2.waitReady(); gs2.close();
  t(await until(() => hs.online && hs.online.has(gc.pid)), 'presence: a second tab closing does not mark the guest offline');

  t((await call('send', { text: 'x' }, { ...gc, token: 'nope' })).status === 401, 'bad token rejected');
  t((await call('send', { text: 'x' }, { rid: gc.rid, pid: '', token: '' })).status === 401, 'no credentials rejected');
  t((await call('send', { text: 'x' }, { rid: 'b'.repeat(32), pid: gc.pid, token: gc.token })).status === 410, 'unknown room id gives 410');
  t((await call('send', { text: 'x' }, { rid: 'not-a-room', pid: gc.pid, token: gc.token })).status === 401, 'malformed room id rejected');

  section('Chat');
  const txt = 'hello <i>Bob</i> & "quotes" \u{1F600}';
  t((await call('send', { text: txt }, hc)).ok, 'host sends a message');
  t(!!(await gs.wait((e) => e.t === 'msg' && e.m.kind === 'text' && e.m.text === txt && e.m.name === 'Alice')), 'guest receives it live, text preserved verbatim');
  t((await call('send', { text: '   ' }, hc)).status === 400, 'empty message rejected');
  const rs = await call('resume', {}, gc);
  t(rs.ok && rs.messages.some((m) => m.text === txt) && rs.state.members.length === 2, 'resume returns history and state');
  t((await call('send', { text: 'a\u202eb\u0000c' }, hc)).ok && !!(await gs.wait((e) => e.t === 'msg' && e.m.text === 'abc')), 'control and bidi-override characters are stripped');
  const spam = []; for (let i = 0; i < 45; i++) spam.push(call('send', { text: 'spam ' + i }, gc));
  t((await Promise.all(spam)).some((r) => r.status === 429), 'message flooding is rate limited (429)');

  section('Photos, video, files and voice messages');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const u1 = await up(hc, png, 'image/png', 'dot.png');
  t(u1.ok, 'image upload');
  const m1 = await gs.wait((e) => e.t === 'msg' && e.m.kind === 'image');
  t(!!m1 && m1.m.file.name === 'dot.png', 'guest is notified live (kind image)');
  const vid = Buffer.alloc(2.9 * 1024 * 1024); for (let i = 0; i < vid.length; i++) vid[i] = (i * 31 + 7) & 255;
  t((await up(hc, vid, 'video/mp4', 'clip.mp4')).ok, '2.9 MB video upload (multi-chunk)');
  t((await up(hc, Buffer.alloc(3 * 1024 * 1024 + 1, 1), 'video/mp4', 'big.mp4')).status === 413, 'over 3 MB rejected (413)');
  t((await up(hc, Buffer.from('<script>alert(1)</script>'), 'text/html', 'evil.html')).ok, 'html file upload');
  t((await up(hc, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml', 'x.svg')).ok, 'svg upload');
  t((await up({ ...hc, token: 'nope' }, png, 'image/png', 'dot.png')).status === 401, 'upload with bad token rejected');
  const r1 = await media(gc, m1.m.file.id); const b1 = Buffer.from(await r1.arrayBuffer());
  t(r1.status === 200 && b1.equals(png) && /^image\/png/.test(r1.headers.get('content-type')), 'image downloads byte-exact');
  const mv = await gs.wait((e) => e.t === 'msg' && e.m.kind === 'video'); const rv = await media(gc, mv.m.file.id);
  t(Buffer.from(await rv.arrayBuffer()).equals(vid), '2.9 MB video round-trips byte-exact');
  const mh = await gs.wait((e) => e.t === 'msg' && e.m.file && e.m.file.name === 'evil.html'); const rh = await media(gc, mh.m.file.id);
  t(mh.m.kind === 'file' && rh.headers.get('content-type') === 'application/octet-stream' && /^attachment/.test(rh.headers.get('content-disposition')) && /sandbox/.test(rh.headers.get('content-security-policy')), 'html is served as a download, never rendered');
  const ms = await gs.wait((e) => e.t === 'msg' && e.m.file && e.m.file.name === 'x.svg'); const rsv = await media(gc, ms.m.file.id);
  t(ms.m.kind === 'file' && rsv.headers.get('content-type') === 'application/octet-stream', 'svg is treated as a plain file (no inline render)');
  t((await media({ ...gc, token: 'nope' }, m1.m.file.id)).status === 401 && (await media({ rid: gc.rid, pid: '', token: '' }, m1.m.file.id)).status === 401, 'media without credentials rejected');
  t((await media(gc, 'does-not-exist')).status === 404, 'unknown file id is 404');
  await sleep(30);
  const late = await call('join', { name: 'Late', key: h.key });
  const lc = creds(late);
  t((await media(lc, m1.m.file.id)).status === 404, 'a late joiner cannot fetch media sent before they joined');
  const lrs = await call('resume', {}, lc);
  t(lrs.messages.every((m) => !/hello/.test(m.text || '') && m.kind !== 'image'), 'a late joiner does not see earlier messages/media');
  await call('leave', {}, lc);
  const vm = await up(hc, Buffer.from('OggS-voice-bytes'), 'audio/webm;codecs=opus', 'voice.webm', true);
  const mvm = await gs.wait((e) => e.t === 'msg' && e.m.kind === 'audio');
  t(vm.ok && mvm.m.voice === true, 'voice message delivered live, flagged as voice');
  const fresh = await up(hc, png, 'image/png', 'after.png'); const mf = await gs.wait((e) => e.t === 'msg' && e.m.file && e.m.file.name === 'after.png');
  t(fresh.ok && (await media(gc, mf.m.file.id)).status === 200, 'guest can fetch media sent after they joined');
  const quota = await call('create', { name: 'Q', chat: 'Quota' }); const qc = creds(quota); const qk = Buffer.alloc(3 * 1024 * 1024 - 10, 2);
  let lastQ; for (let i = 0; i < 9; i++) lastQ = await up(qc, qk, 'application/zip', 'z' + i + '.zip');
  t(lastQ.status === 413 && /media limit/.test(lastQ.error), 'a chat stops accepting media at its 24 MB limit');
  await call('end', {}, qc);

  section('Voice and video calls (signalling)');
  t((await call('callJoin', { video: false }, hc)).ok, 'host starts a call');
  t(!!(await gs.wait((e) => e.t === 'state' && e.state.call.includes(hc.pid))), 'guest is told a call is live');
  t((await call('signal', { to: gc.pid, data: { x: 1 } }, hc)).status === 403, 'cannot signal someone who is not in the call');
  const cj = await call('callJoin', { video: true }, gc);
  t(cj.ok && cj.peers.length === 1 && cj.peers[0] === hc.pid && Array.isArray(cj.ice) && cj.ice.length > 0, 'guest joins the call and sees the host (+ ICE servers)');
  const sdp = { type: 'offer', sdp: 'v=0 fake' };
  t((await call('signal', { to: hc.pid, data: sdp }, gc)).ok, 'signal sent');
  const sig = await hs.wait((e) => e.t === 'signal');
  t(sig && sig.from === gc.pid && sig.data.sdp === sdp.sdp, 'signal delivered to the target');
  await sleep(150);
  t(!gs.find((e) => e.t === 'signal'), 'the sender did not receive its own signal');
  t((await call('signal', { to: hc.pid, data: 'x'.repeat(31000) }, gc)).status === 413, 'oversized signal rejected');
  t((await call('callLeave', {}, gc)).ok && (await call('callLeave', {}, hc)).ok, 'both leave the call');

  section('Games and the live leaderboard');
  t((await call('score', { game: 'harbor', stars: 3, coins: 90 }, gc)).ok, 'guest reports a score');
  t(!!(await hs.wait((e) => e.t === 'lb' && e.board.some((r) => r.pid === gc.pid && r.stars === 3))), 'host sees the leaderboard update live');
  t((await call('score', { game: 'harbor', stars: 4, coins: 100 }, gc)).skipped === true, 'rapid updates are throttled');
  t((await call('score', { game: 'harbor', stars: 1, coins: 10 }, hc)).ok, 'host reports a score');
  await sleep(600);
  t((await call('score', { game: 'harbor', stars: 400, coins: 1 }, hc)).status === 400, 'implausible jump rejected');
  t((await call('score', { game: 'harbor', stars: 99, coins: 1 }, gc)).status === 400, 'implausible jump rejected (guest)');
  t((await call('score', { game: 'chess', stars: 1, coins: 1 }, hc)).status === 400, 'unknown game rejected');
  t((await call('score', { game: 'harbor', stars: -1, coins: 1 }, hc)).status === 400, 'negative score rejected');
  const nf = await call('create', { name: 'F', chat: 'First' }); const nfc = creds(nf);
  t((await call('score', { game: 'harbor', stars: 51, coins: 1 }, nfc)).status === 400, 'a first score far above the starting range is rejected');
  await call('end', {}, nfc);
  const cleo = creds(await call('join', { name: 'Cleo', key: h.key }));
  const rs2 = await call('resume', {}, cleo);
  t(rs2.lb.harbor.length === 2 && rs2.lb.harbor.some((r) => r.stars === 3), 'resume returns the full leaderboard (late joiners see it)');
  await call('leave', {}, cleo);
  await call('leave', {}, creds(await call('join', { name: 'tmp', key: h.key })));

  section('Public leaderboard');
  const pb = await fetch(base + '/api/publicBoard', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': freshIp() }, body: '{"game":"harbor"}' }).then((r) => r.json());
  t(pb.ok && pb.board.some((r) => r.name === 'Bob' && r.stars === 3), 'anyone can read the public board without joining or any credentials');
  t(pb.board.every((r) => Object.keys(r).sort().join() === 'coins,name,stars'), 'public board exposes only name, stars and coins (no room id, key or member id)');
  t(!JSON.stringify(pb).includes(hc.rid) && !JSON.stringify(pb).includes(gc.pid) && !JSON.stringify(pb).includes('Game Night'), 'room id, member id and chat name never appear on the public board');
  const ps = sock(null, '/api/public-ws');
  t(await until(() => ps.ready), 'public live stream needs no login');
  await sleep(600);
  t((await call('score', { game: 'harbor', stars: 2, coins: 50 }, hc)).ok, 'host scores again');
  t(!!(await ps.wait((e) => e.t === 'plb' && e.board.some((r) => r.name === 'Alice' && r.stars === 2))), 'public viewers receive the new score live');
  t(Object.keys(ps.find((e) => e.t === 'plb').board[0]).sort().join() === 'coins,name,stars', 'live public events carry only name, stars and coins');
  t((await call('score', { game: 'harbor', stars: 2, coins: 50, pub: false }, hc)).skipped === true, 'opt-out sent inside the throttle window is still accepted');
  t(!!(await ps.wait((e) => e.t === 'plb' && !e.board.some((r) => r.name === 'Alice'))), 'opted-out player disappears from the public board live');
  const pb2 = await call('publicBoard', { game: 'harbor' }); t(!pb2.board.some((r) => r.name === 'Alice'), 'opted-out player is hidden from the public board');
  t((await call('publicBoard', { game: 'bogus' })).game === 'harbor', 'unknown game name falls back safely');
  await sleep(600); await call('score', { game: 'harbor', stars: 2, coins: 60, pub: true }, hc);
  t(!!(await ps.wait((e) => e.t === 'plb' && e.board.some((r) => r.name === 'Alice' && r.coins === 60))), 'opting back in shows the player again');
  const manyPs = []; try { for (let i = 0; i < 3; i++) manyPs.push(sock(null, '/api/public-ws')); } finally { await sleep(200); manyPs.forEach((s) => s.close()); }

  section('Leaving and stopping');
  t((await call('leave', {}, hc)).status === 403, 'host cannot "leave" (must stop hosting)');
  t((await call('end', {}, gc)).status === 403, 'guest cannot stop hosting');
  const gsClosed = until(() => gs.closed);
  t((await call('leave', {}, gc)).ok, 'guest leaves');
  t(await gsClosed, "the guest's live connection is closed");
  t(!!(await hs.wait((e) => e.t === 'state' && e.state.members.length === 1)), 'room continues for the host');
  t(!!(await hs.wait((e) => e.t === 'lb' && !e.board.some((r) => r.pid === gc.pid))), 'guest removed from the leaderboard on leave');
  t(!!(await ps.wait((e) => e.t === 'plb' && !e.board.some((r) => r.name === 'Bob'))), 'player who leaves disappears from the public board');
  t((await call('send', { text: 'x' }, gc)).status === 401, 'former guest can no longer send');
  const ended = hs.wait((e) => e.t === 'ended');
  const ex = await call('join', { name: 'Eve', key: h.key }); const ec = creds(ex); const es = sock(ec); await es.waitReady();
  t((await call('end', {}, hc)).ok, 'host stops hosting');
  t(!!(await ended) && !!(await es.wait((e) => e.t === 'ended' && /host stopped/.test(e.reason))), 'everyone connected is notified the chat ended');
  t(await until(() => hs.closed && es.closed), 'all live connections are closed');
  t((await call('join', { name: 'Zed', key: h.key })).status === 404, 'access key no longer works');
  t((await call('resume', {}, hc)).status === 410 && (await call('send', { text: 'x' }, ec)).status === 410, 'old credentials get 410 Gone');
  t(!!(await ps.wait((e) => e.t === 'plb' && e.board.length === 0)) || !(await call('publicBoard', { game: 'harbor' })).board.some((r) => ['Alice', 'Eve'].includes(r.name)), 'public board is cleared when the chat ends');
  t((await up(hc, png, 'image/png', 'x.png')).status === 410, 'uploads to an ended chat are refused');
  ps.close();

  section('Limits and abuse protection');
  const full = await call('create', { name: 'H', chat: 'Full' }); const fc = creds(full);
  const joiners = []; for (let i = 0; i < 7; i++) joiners.push(await call('join', { name: 'P' + i, key: full.key }));
  t(joiners.every((x) => x.ok), 'room fills to 8 people');
  const ninth = await call('join', { name: 'P9', key: full.key });
  t(ninth.status === 409 && /full/.test(ninth.error), '9th person is refused (room full)');
  await call('end', {}, fc);
  const ipB = freshIp(); let r429 = false;
  for (let i = 0; i < 25; i++) { const x = await call('join', { name: 'Z', key: 'AAAA-BBBB-CCCC-DD' + String(10 + i) }, null, ipB); if (x.status === 429) { r429 = true; break; } }
  t(r429, 'brute-force key guessing is rate limited (429)');
  const ipC = freshIp(); let c429 = false;
  for (let i = 0; i < 12; i++) { const x = await call('create', { name: 'S', chat: 'Spam' + i }, null, ipC); if (x.status === 429) { c429 = true; break; } else await call('end', {}, creds(x)); }
  t(c429, 'creating chats in bulk is rate limited (429)');

  section('Security headers');
  const page = await fetch(base + '/'); const csp = page.headers.get('content-security-policy') || '';
  t(/default-src 'self'/.test(csp) && /script-src 'self'/.test(csp) && !/unsafe-inline/.test(csp) && /object-src 'none'/.test(csp), 'app page: strict CSP (own scripts only, no inline code)');
  t(/connect-src 'self' wss:/.test(csp) && !/ably|vercel|upstash/i.test(csp), 'CSP allows only this site and WebSockets (no third-party services)');
  t(page.headers.get('x-frame-options') === 'DENY' && /frame-ancestors 'none'/.test(csp) && page.headers.get('x-content-type-options') === 'nosniff' && page.headers.get('referrer-policy') === 'no-referrer', 'app page: no framing, nosniff, no referrer');
  const game = await fetch(base + '/games/harbor-merge.html'); const gcsp = game.headers.get('content-security-policy') || '';
  t(game.status === 200 && /default-src 'none'/.test(gcsp) && /frame-ancestors 'self'/.test(gcsp) && game.headers.get('x-frame-options') === 'SAMEORIGIN' && gcsp.indexOf('default-src') === gcsp.lastIndexOf('default-src'), 'game page: one locked-down CSP, frameable by the app only');
  const api = await fetch(base + '/api/config', { method: 'POST' });
  t(api.headers.get('cache-control') === 'no-store', 'API responses are never cached');
  const html = await page.text();
  t(!/<script[^>]+src="https?:/i.test(html) && !/ably|vercel|upstash/i.test(html), 'page loads no third-party scripts');
  t((await fetch(base + '/vendor/ably.min.js')).status === 404, 'the old Ably library is gone');

  section('Live connections survive sleep (Durable Object hibernation)');
  const sl = await call('create', { name: 'Sleepy', chat: 'Nap' }); const slc = creds(sl);
  const slj = await call('join', { name: 'Peer', key: sl.key }); const sjc = creds(slj);
  const s1 = sock(slc), s2 = sock(sjc); await s1.waitReady(); await s2.waitReady();
  console.log('    (idle for 14 s so the room object goes to sleep...)');
  await sleep(14000);
  t((await call('send', { text: 'wake up' }, slc)).ok && !!(await s2.wait((e) => e.t === 'msg' && e.m.text === 'wake up')), 'after sleeping, a message still reaches the connected guest');
  t((await call('send', { text: 'and back' }, sjc)).ok && !!(await s1.wait((e) => e.t === 'msg' && e.m.text === 'and back')), 'and the other way around (sign-in survived the sleep)');
  s2.close();
  t(await until(() => s1.online && !s1.online.has(sjc.pid) && s1.online.has(slc.pid)), 'presence still works after waking up');
  await call('end', {}, slc); s1.close();

  if (fastBase) {
    section('Automatic deletion of idle chats (alarm)');
    const F = client(fastBase);
    const fr = await F.call('create', { name: 'Idle', chat: 'Short lived' }); const fcc = F.creds(fr);
    const fs = F.sock(fcc); await fs.waitReady();
    t((await F.call('send', { text: 'hi' }, fcc)).ok, 'chat works while it is active');
    t(await fs.wait((e) => e.t === 'ended' && /expired/.test(e.reason), 15000), 'an idle chat is deleted by itself, and connected people are told');
    t((await F.call('join', { name: 'Late', key: fr.key })).status === 404 && (await F.call('resume', {}, fcc)).status === 410, 'its key and credentials stop working');
  }
};
