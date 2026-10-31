(() => {
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const icon = (id) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('class', 'ic'); const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#i-' + id); s.append(u); return s; };
const fmtSize = (b) => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const initial = (n) => (n || '?').trim().charAt(0).toUpperCase();
const coarse = matchMedia('(pointer: coarse)').matches;
const MAXF = 3 * 1024 * 1024;
const SS = 'jan-star-session';
const api = (a, b) => Net.api(a, b);

const GAMES = [
  { id: 'harbor', title: 'Harbor Merge', emoji: '⚓', desc: 'Merge treats, serve guests and earn stars. Race everyone in your chat.', src: '/games/harbor-merge.html' },
];

const S = { pub: sessionStorage.getItem('jan-star-pub') !== '0', rid: null, pid: null, token: null, key: null, room: null, urls: new Set(), seen: new Set(), last: null, online: new Set(), lb: {}, game: null, down: false };

/* ---------- small UI helpers ---------- */
let toastT;
function toast(t, ms = 3600) { const n = $('#toast'); n.textContent = t; n.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (n.hidden = true), ms); }
function showErr(form, msg) { const p = $('.err', form); p.textContent = msg || ''; p.hidden = !msg; }
function notice(msg) { const n = $('#notice'); n.textContent = msg || ''; n.hidden = !msg; }
const saveSession = () => sessionStorage.setItem(SS, JSON.stringify({ rid: S.rid, pid: S.pid, token: S.token, key: S.key }));
const isHost = () => S.room && S.room.hostPid === S.pid;
const toLb = (all) => { const o = {}; for (const g of Object.keys(all || {})) { o[g] = {}; for (const r of all[g]) o[g][r.pid] = { stars: r.stars, coins: r.coins }; } return o; };

/* ---------- session / network ---------- */
function startNet() {
  S.down = true; // so the first live connection also re-syncs anything sent while it was attaching
  Net.session({ rid: S.rid, pid: S.pid, token: S.token });
  Net.connect({ event: onEvent, presence: (set) => { S.online = set; renderRoom(); renderLb(); }, status: onStatus });
}
function onStatus(ok) {
  $('#conn').hidden = ok;
  if (!ok) { S.down = true; return; }
  if (S.down) { S.down = false; resync(); }
}
function onEvent(ev) {
  if (!S.rid || !ev) return;
  if (ev.t === 'msg') addMsg(ev.m);
  else if (ev.t === 'state') { S.room = ev.state; renderRoom(); syncCall(); renderLb(); }
  else if (ev.t === 'lb') { S.lb[ev.game] = toLb({ [ev.game]: ev.board })[ev.game]; renderLb(); }
  else if (ev.t === 'ended') endLocal(ev.reason || 'This chat has ended.');
  else if (ev.t === 'signal') onSignal(ev);
}
async function resync() {
  if (!S.rid) return;
  const r = await api('resume');
  if (!r.ok) { if (r.status === 401 || r.status === 410 || r.status === 404) endLocal(r.error || 'You are no longer in this chat.'); return; }
  S.room = r.state; S.lb = toLb(r.lb);
  r.messages.forEach(addMsg);
  renderRoom(); renderLb(); syncCall();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.rid) resync(); });

function enter(r) {
  S.rid = r.state.id; S.pid = r.pid; S.token = r.token; S.key = r.key || S.key; S.room = r.state; S.lb = toLb(r.lb);
  S.online = new Set([S.pid]);
  saveSession(); showChat(); resetMsgs(r.messages || []); renderRoom(); startNet();
}
function showChat() { $('#landing').hidden = true; $('#chat').hidden = false; }
function endLocal(msg) {
  stopCall(false); closeGames();
  Net.close(); Net.session(null);
  S.urls.forEach((u) => URL.revokeObjectURL(u)); S.urls.clear(); S.seen.clear();
  for (const k of Object.keys(sessionStorage)) if (k.startsWith('jan-star-')) sessionStorage.removeItem(k);
  Object.assign(S, { rid: null, pid: null, token: null, key: null, room: null, lb: {}, online: new Set(), down: false });
  $('#messages').replaceChildren(); $('#chat').hidden = true; $('#side').classList.remove('open'); $('#backdrop').classList.remove('show');
  $('#landing').hidden = false; $('#conn').hidden = true;
  notice(msg);
}

/* ---------- landing ---------- */
function setTab(t) {
  const host = t === 'host';
  $('#tabHost').setAttribute('aria-selected', host); $('#tabJoin').setAttribute('aria-selected', !host);
  $('#hostForm').hidden = !host; $('#joinForm').hidden = host;
}
document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
const fmtKeyInput = (v) => (v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16).match(/.{1,4}/g) || []).join('-');
$('#joinForm').elements.key.addEventListener('input', (e) => { e.target.value = fmtKeyInput(e.target.value); });

async function submit(form, action, payload) {
  const btn = $('button[type=submit]', form); btn.disabled = true; showErr(form, ''); notice('');
  const r = await api(action, payload);
  btn.disabled = false;
  if (!r.ok) return showErr(form, r.error || 'Could not continue.');
  rememberMe(form.elements.name.value.trim());
  enter(r);
}
$('#hostForm').addEventListener('submit', (e) => { e.preventDefault(); const f = e.target; submit(f, 'create', { name: f.elements.name.value, chat: f.elements.chat.value }); });
$('#joinForm').addEventListener('submit', (e) => { e.preventDefault(); const f = e.target; submit(f, 'join', { name: f.elements.name.value, key: f.elements.key.value }); });

/* ---------- room panel ---------- */
const inviteLink = () => location.origin + '/#join=' + encodeURIComponent(S.key || '');
function renderRoom() {
  const r = S.room; if (!r) return;
  $('#roomName').textContent = r.name; $('#paneTitle').textContent = r.name;
  $('#keyText').textContent = S.key || '—';
  $('#paneSub').textContent = r.members.length + (r.members.length === 1 ? ' person' : ' people');
  $('#count').textContent = `(${r.members.length}/${r.max})`;
  $('#stopBtn').hidden = !isHost(); $('#leaveBtn').hidden = isHost();
  $('#shareLink').hidden = !navigator.share;
  const ul = $('#people'); ul.replaceChildren();
  r.members.forEach((m) => {
    const li = el('li'); li.append(el('span', 'avatar', initial(m.name)), el('span', 'pname', m.name));
    const tag = [m.pid === r.hostPid ? 'host' : '', m.pid === S.pid ? 'you' : ''].filter(Boolean).join(', ');
    if (tag) li.append(el('span', 'tag', tag));
    li.append(el('span', 'presence' + (S.online.has(m.pid) || m.pid === S.pid ? ' on' : '')));
    ul.append(li);
  });
  $('#callBanner').hidden = !(r.call.length && !call.active);
  $('#callBannerText').textContent = `${r.call.length} in a call`;
}
async function copy(text, ok) { try { await navigator.clipboard.writeText(text); toast(ok); } catch { toast('Copy failed. Select the text and copy it manually.'); } }
$('#copyKey').onclick = () => copy(S.key, 'Access key copied');
$('#copyLink').onclick = () => copy(inviteLink(), 'Invite link copied');
$('#shareLink').onclick = () => navigator.share({ title: 'Join my JAN STAR chat', text: 'Join my chat on JAN STAR', url: inviteLink() }).catch(() => {});
const openSide = (v) => { $('#side').classList.toggle('open', v); $('#backdrop').classList.toggle('show', v); };
$('#menuBtn').onclick = () => openSide(true); $('#sideClose').onclick = () => openSide(false); $('#backdrop').onclick = () => openSide(false);
$('#leaveBtn').onclick = async () => { if (!confirm('Leave this chat? You will need the access key to come back.')) return; await api('leave'); endLocal('You left the chat.'); };
$('#stopBtn').onclick = async () => {
  if (!confirm('Stop hosting? Everyone is disconnected and all messages, files and scores are deleted.')) return;
  const r = await api('end'); if (!r.ok) toast(r.error || 'Could not stop hosting.'); else endLocal('You stopped hosting. Everything was deleted.');
};

/* ---------- messages ---------- */
function resetMsgs(list) {
  $('#messages').replaceChildren(); S.last = null; S.seen.clear();
  S.urls.forEach((u) => URL.revokeObjectURL(u)); S.urls.clear();
  (list || []).forEach(addMsg);
}
function loadBlob(f) {
  return fetch('/api/media?fid=' + encodeURIComponent(f.id), { headers: Net.authHeaders() })
    .then((r) => { if (!r.ok) throw new Error('gone'); return r.blob(); })
    .then((b) => { const u = URL.createObjectURL(b); S.urls.add(u); return u; });
}
function addMsg(m) {
  if (!m || S.seen.has(m.id)) return; S.seen.add(m.id);
  const box = $('#messages');
  const stick = m.pid === S.pid || box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  const toEnd = () => { if (stick) box.scrollTop = box.scrollHeight; };
  if (m.kind === 'system') { box.append(el('div', 'sys', m.text)); S.last = null; toEnd(); return; }
  const me = m.pid === S.pid;
  const row = el('div', 'msg ' + (me ? 'me' : 'them'));
  if (!me && S.last !== m.pid) row.append(el('div', 'who', m.name));
  const b = el('div', 'bubble');
  if (m.kind === 'text') b.append(el('p', 'txt', m.text));
  else if (m.kind === 'image') {
    const im = el('img', 'media'); im.alt = m.file.name; im.onload = toEnd;
    loadBlob(m.file).then((u) => { im.src = u; im.onclick = () => window.open(u, '_blank', 'noopener'); }).catch(() => im.replaceWith(el('p', 'pulse', 'Image unavailable')));
    b.append(im);
  } else if (m.kind === 'audio') {
    if (m.voice) b.append(el('p', 'vlabel', 'Voice message'));
    const a = el('audio'); a.controls = true; a.preload = 'metadata';
    loadBlob(m.file).then((u) => (a.src = u)).catch(() => a.replaceWith(el('p', 'pulse', 'Audio unavailable')));
    b.append(a);
  } else if (m.kind === 'video') {
    const btn = el('button', 'card'); btn.type = 'button';
    const meta = el('span', 'meta'); meta.append(el('b', '', m.file.name), el('small', '', 'Tap to play · ' + fmtSize(m.file.size)));
    btn.append(icon('play'), meta);
    btn.onclick = async () => {
      meta.lastChild.textContent = 'Loading…';
      try { const u = await loadBlob(m.file); const v = el('video', 'media'); v.src = u; v.controls = true; v.playsInline = true; btn.replaceWith(v); v.play().catch(() => {}); } catch { meta.lastChild.textContent = 'Video unavailable'; }
    };
    b.append(btn);
  } else {
    const btn = el('button', 'card'); btn.type = 'button';
    const meta = el('span', 'meta'); meta.append(el('b', '', m.file.name), el('small', '', 'Download · ' + fmtSize(m.file.size)));
    btn.append(icon('file'), meta);
    btn.onclick = async () => {
      try { const u = await loadBlob(m.file); const a = el('a'); a.href = u; a.download = m.file.name; document.body.append(a); a.click(); a.remove(); } catch { toast('File unavailable.'); }
    };
    b.append(btn);
  }
  b.append(el('time', '', fmtTime(m.ts)));
  row.append(b); box.append(row); S.last = m.pid; toEnd();
}

/* composer */
const ta = $('#text');
const autosize = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; };
ta.addEventListener('input', autosize);
ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !coarse && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); } });
$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = ta.value.trim(); if (!text) return;
  ta.value = ''; autosize();
  const r = await api('send', { text });
  if (!r.ok) { ta.value = text; autosize(); toast(r.error || 'Message not sent.'); }
});

/* uploads (files are capped at 3 MB; big photos are shrunk first) */
async function shrinkImage(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 700 * 1024 || !window.createImageBitmap) return file;
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1920 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
    return blob && blob.size < file.size ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
  } catch { return file; }
}
$('#attachBtn').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = (e) => { [...e.target.files].forEach((f) => upload(f, false)); e.target.value = ''; };
async function upload(file, voice) {
  file = await shrinkImage(file);
  if (file.size > MAXF) return toast(`${file.name} is larger than 3 MB.`);
  const row = el('div', '', `Sending ${file.name}…`); $('#uploads').append(row);
  try {
    const res = await fetch('/api/upload', { method: 'POST', headers: { ...Net.authHeaders(), 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(file.name), 'x-mime': file.type || 'application/octet-stream', 'x-voice': voice ? '1' : '0' }, body: file });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) toast(j.error || 'Upload failed.');
  } catch { toast('Upload failed. Check your connection.'); }
  row.remove();
}

/* voice messages */
let rec = null;
const recMime = () => ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
async function startRec() {
  if (rec) return;
  if (call.active) return toast('Leave the call to record a voice message.');
  if (!window.MediaRecorder) return toast('Voice messages are not supported in this browser.');
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return toast('Allow microphone access to record.'); }
  const mime = recMime();
  const r = rec = { chunks: [], stream, cancel: false, t0: Date.now(), mr: new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 24000 } : undefined) };
  r.mr.ondataavailable = (e) => e.data.size && r.chunks.push(e.data);
  r.mr.onstop = () => {
    stream.getTracks().forEach((t) => t.stop()); clearInterval(r.timer);
    $('#recBar').hidden = true; $('#composer').hidden = false; rec = null;
    if (r.cancel || !r.chunks.length) return;
    const type = (r.mr.mimeType || 'audio/webm').split(';')[0];
    const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
    upload(new File([new Blob(r.chunks, { type })], 'voice-message.' + ext, { type }), true);
  };
  r.mr.start();
  $('#composer').hidden = true; $('#recBar').hidden = false; $('#recTime').textContent = '0:00';
  r.timer = setInterval(() => {
    const s = Math.floor((Date.now() - r.t0) / 1000);
    $('#recTime').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    if (s >= 150) r.mr.stop(); // ~2.5 min keeps a voice note under the 3 MB limit
  }, 250);
}
$('#micBtn').onclick = startRec;
$('#recSend').onclick = () => rec && rec.mr.stop();
$('#recCancel').onclick = () => { if (rec) { rec.cancel = true; rec.mr.stop(); } };

/* ---------- calls (WebRTC mesh; signaling goes through the server) ---------- */
const call = { active: false, video: false, local: null, peers: new Map(), ice: [], muted: false, camOff: false };
const sig = (to, data) => { api('signal', { to, data }); };
const nameOf = (pid) => { const m = S.room && S.room.members.find((x) => x.pid === pid); return m ? m.name : 'Guest'; };

async function startCall(video) {
  if (call.active) return;
  if (rec) return toast('Finish your voice message first.');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return toast('Calls need a secure (HTTPS) connection and a modern browser.');
  let local;
  try { local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: video ? { facingMode: 'user' } : false }); }
  catch { return toast(video ? 'Allow microphone and camera access to join.' : 'Allow microphone access to join.'); }
  const r = await api('callJoin', { video });
  if (!r.ok) { local.getTracks().forEach((t) => t.stop()); return toast(r.error || 'Could not join the call.'); }
  Object.assign(call, { active: true, video, local, ice: r.ice || [], muted: false, camOff: false });
  $('#call').hidden = false; openSide(false); closeGames();
  $('#camBtn').hidden = !video; setBtns();
  renderTile(S.pid);
  for (const pid of r.peers) await offerTo(pid);
  renderRoom();
}
function getPeer(pid) {
  let p = call.peers.get(pid); if (p) return p;
  const pc = new RTCPeerConnection({ iceServers: call.ice });
  p = { pid, pc, stream: new MediaStream(), pending: [] };
  call.local.getTracks().forEach((t) => pc.addTrack(t, call.local));
  pc.onicecandidate = (e) => e.candidate && sig(pid, { ice: e.candidate });
  pc.ontrack = (e) => { e.streams[0].getTracks().forEach((t) => p.stream.addTrack(t)); renderTile(pid); e.track.onunmute = () => renderTile(pid); };
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') dropPeer(pid); };
  call.peers.set(pid, p); renderTile(pid);
  return p;
}
async function offerTo(pid) {
  const p = getPeer(pid);
  await p.pc.setLocalDescription(await p.pc.createOffer());
  sig(pid, { sdp: p.pc.localDescription });
}
async function onSignal({ from, data }) {
  if (!call.active || !data) return;
  const p = getPeer(from);
  try {
    if (data.sdp) {
      await p.pc.setRemoteDescription(data.sdp);
      for (const c of p.pending.splice(0)) await p.pc.addIceCandidate(c).catch(() => {});
      if (data.sdp.type === 'offer') { await p.pc.setLocalDescription(await p.pc.createAnswer()); sig(from, { sdp: p.pc.localDescription }); }
    } else if (data.ice) {
      if (p.pc.remoteDescription) await p.pc.addIceCandidate(data.ice).catch(() => {}); else p.pending.push(data.ice);
    }
  } catch { /* ignore a bad signal */ }
}
function dropPeer(pid) {
  const p = call.peers.get(pid); if (!p) return;
  p.pc.close(); call.peers.delete(pid);
  const t = $(`.tile[data-pid="${pid}"]`); if (t) t.remove();
}
function renderTile(pid) {
  const self = pid === S.pid;
  let t = $(`.tile[data-pid="${pid}"]`);
  if (!t) {
    t = el('div', 'tile' + (self ? ' self' : '')); t.dataset.pid = pid;
    const v = el('video'); v.autoplay = true; v.playsInline = true; v.muted = self;
    const ph = el('div', 'ph'); ph.append(el('span', 'avatar', initial(nameOf(pid))));
    t.append(v, ph, el('span', 'nm', self ? 'You' : nameOf(pid)));
    $('#grid').append(t);
  }
  const stream = self ? call.local : (call.peers.get(pid) || {}).stream;
  const v = $('video', t);
  if (stream && v.srcObject !== stream) { v.srcObject = stream; v.play().catch(() => {}); }
  const hasVideo = !!stream && stream.getVideoTracks().some((x) => x.readyState === 'live' && x.enabled && (self || !x.muted));
  $('.ph', t).hidden = hasVideo;
}
function syncCall() {
  if (!call.active || !S.room) return;
  const inCall = new Set(S.room.call);
  for (const pid of [...call.peers.keys()]) if (!inCall.has(pid)) dropPeer(pid);
}
function stopCall(notify = true) {
  if (!call.active && !call.local) return;
  if (notify) api('callLeave');
  for (const pid of [...call.peers.keys()]) dropPeer(pid);
  if (call.local) call.local.getTracks().forEach((t) => t.stop());
  Object.assign(call, { active: false, local: null });
  $('#grid').replaceChildren(); $('#call').hidden = true;
  if (S.room) renderRoom();
}
function setBtns() {
  const mb = $('#muteBtn'), cb = $('#camBtn');
  mb.classList.toggle('off', call.muted); mb.replaceChildren(icon(call.muted ? 'mic-off' : 'mic')); mb.setAttribute('aria-label', call.muted ? 'Unmute microphone' : 'Mute microphone');
  cb.classList.toggle('off', call.camOff); cb.replaceChildren(icon(call.camOff ? 'video-off' : 'video')); cb.setAttribute('aria-label', call.camOff ? 'Turn camera on' : 'Turn camera off');
}
$('#muteBtn').onclick = () => { call.muted = !call.muted; call.local.getAudioTracks().forEach((t) => (t.enabled = !call.muted)); setBtns(); };
$('#camBtn').onclick = () => { call.camOff = !call.camOff; call.local.getVideoTracks().forEach((t) => (t.enabled = !call.camOff)); setBtns(); renderTile(S.pid); };
$('#hangBtn').onclick = () => stopCall(true);
$('#voiceCallBtn').onclick = () => startCall(false);
$('#videoCallBtn').onclick = () => startCall(true);
$('#joinVoice').onclick = () => startCall(false);
$('#joinVideo').onclick = () => startCall(true);
window.addEventListener('pagehide', () => {
  if (call.active && S.rid) fetch('/api/callLeave', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json', ...Net.authHeaders() }, body: '{}' }).catch(() => {});
});

/* ---------- games + live leaderboard ---------- */
const gameKey = (id) => `jan-star-game-${S.pid}-${id}`;
function lbRows(game) {
  const b = S.lb[game] || {};
  return (S.room ? S.room.members : []).map((m) => ({ pid: m.pid, name: m.name, played: !!b[m.pid], stars: (b[m.pid] || {}).stars || 0, coins: (b[m.pid] || {}).coins || 0 }))
    .sort((a, c) => c.stars - a.stars || c.coins - a.coins || a.name.localeCompare(c.name));
}
function renderLb() {
  if ($('#games').hidden) return;
  if (S.game) {
    const ol = $('#lbList'); ol.replaceChildren();
    lbRows(S.game.id).forEach((r, i) => {
      const li = el('li', r.pid === S.pid ? 'me' : '');
      const medal = r.stars > 0 ? ['🥇', '🥈', '🥉'][i] : null;
      li.append(el('span', 'rank', medal || String(i + 1)));
      li.append(el('span', 'presence' + (S.online.has(r.pid) || r.pid === S.pid ? ' on' : '')));
      li.append(el('span', 'nm', r.name + (r.pid === S.pid ? ' (you)' : '')));
      const sc = el('span', 'sc', '⭐ ' + r.stars); sc.append(el('span', 'sub', '🪙 ' + r.coins)); li.append(sc);
      ol.append(li);
    });
  } else renderGameList();
}
function renderGameList() {
  const list = $('#gList'); list.replaceChildren();
  GAMES.forEach((g) => {
    const rows = lbRows(g.id).filter((r) => r.played);
    const c = el('button', 'gcard'); c.type = 'button';
    c.append(el('span', 'emoji', g.emoji), el('b', '', g.title), el('p', '', g.desc));
    c.append(el('span', 'lead', rows.length ? `🏆 ${rows[0].name} leads with ⭐ ${rows[0].stars} · ${rows.length} playing` : 'Be the first on the leaderboard'));
    c.onclick = () => playGame(g);
    list.append(c);
  });
}
function openGames() { if (!S.rid) return; $('#games').hidden = false; showList(); }
function showList() {
  S.game = null; $('#gFrame').src = 'about:blank';
  $('#gPlay').hidden = true; $('#gList').hidden = false; $('#gBack').hidden = true; $('#gTitle').textContent = 'Play games';
  renderGameList();
}
function playGame(g) {
  S.game = g; $('#gList').hidden = true; $('#gPlay').hidden = false; $('#gBack').hidden = false; $('#gTitle').textContent = g.title;
  $('#gFrame').src = g.src; renderLb();
}
function closeGames() { $('#games').hidden = true; S.game = null; $('#gFrame').src = 'about:blank'; }
$('#gamesBtn').onclick = openGames; $('#gClose').onclick = closeGames; $('#gBack').onclick = showList;

// Score reporting (throttled to one update every 2 s, latest value wins; keeps free-tier usage low)
const sc = { timer: null, pending: null };
async function sendScore(game, stars, coins) {
  const r = await api('score', { game, stars, coins, pub: S.pub });
  if (!r.ok && r.status === 400) toast('That score was not accepted.');
}
function queueScore(game, stars, coins) {
  S.lb[game] = S.lb[game] || {}; S.lb[game][S.pid] = { stars, coins }; renderLb();
  if (sc.timer) { sc.pending = { game, stars, coins }; return; }
  sendScore(game, stars, coins);
  sc.timer = setTimeout(() => { sc.timer = null; if (sc.pending) { const p = sc.pending; sc.pending = null; queueScore(p.game, p.stars, p.coins); } }, 2000);
}
// The game runs in a sandboxed frame; it can only talk to us through postMessage.
window.addEventListener('message', (e) => {
  const f = $('#gFrame');
  if (!S.game || e.source !== f.contentWindow || !e.data || typeof e.data !== 'object') return;
  const d = e.data;
  if (d.type === 'js:ready') {
    let st = null; try { st = JSON.parse(sessionStorage.getItem(gameKey(S.game.id)) || 'null'); } catch { /* ignore */ }
    f.contentWindow.postMessage({ type: 'js:load', state: st }, '*');
  } else if (d.type === 'js:state' && d.state) {
    try { sessionStorage.setItem(gameKey(S.game.id), JSON.stringify(d.state)); } catch { /* ignore */ }
  } else if (d.type === 'js:score' && d.game === S.game.id) {
    queueScore(d.game, Math.max(0, Math.floor(+d.stars) || 0), Math.max(0, Math.floor(+d.coins) || 0));
  }
});

/* ---------- modals (terms, public leaderboard) ---------- */
let modalFrom = null;
function openModal(id) {
  modalFrom = document.activeElement; const m = $('#' + id); m.hidden = false;
  const c = $('button, [href], input', m); if (c) c.focus();
}
function closeModal(id) {
  $('#' + id).hidden = true; if (id === 'pub') stopPub();
  if (modalFrom && document.contains(modalFrom)) modalFrom.focus(); modalFrom = null;
}
document.addEventListener('click', (e) => {
  const o = e.target.closest('[data-open]'); if (o) { e.preventDefault(); openModal(o.dataset.open); return; }
  const c = e.target.closest('[data-close]'); if (c) { closeModal(c.dataset.close); return; }
  if (e.target.classList && e.target.classList.contains('modal')) closeModal(e.target.id);   // click on the dim backdrop
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = [...document.querySelectorAll('.modal')].filter((m) => !m.hidden).pop();
  if (open) closeModal(open.id);
});

/* ---------- cookies: remember display name + accepted terms (only if the visitor agrees) ---------- */
const CK = { consent: 'js_consent', name: 'js_name', terms: 'js_terms' }, TERMS_V = '2026-10-27-v3';
const ck = {
  get(n) { const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); try { return m ? decodeURIComponent(m[1]) : null; } catch { return null; } },
  set(n, v) { document.cookie = `${n}=${encodeURIComponent(v)}; Max-Age=31536000; Path=/; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`; },
  del(n) { document.cookie = `${n}=; Max-Age=0; Path=/; SameSite=Lax`; },
};
const cookiesOk = () => ck.get(CK.consent) === '1';
function applySaved() {
  const name = cookiesOk() ? ck.get(CK.name) : null, termsOk = cookiesOk() && ck.get(CK.terms) === TERMS_V;
  for (const f of [$('#hostForm'), $('#joinForm')]) {
    if (name && !f.elements.name.value) f.elements.name.value = name.slice(0, 32);
    if (termsOk) f.elements.terms.checked = true;
  }
}
function rememberMe(name) {
  if (!cookiesOk()) return;
  if (name) ck.set(CK.name, name.slice(0, 32));
  ck.set(CK.terms, TERMS_V);
}
function showCookieBar(v) { $('#cookies').hidden = !v; }
$('#cookieYes').onclick = () => { ck.set(CK.consent, '1'); showCookieBar(false); applySaved(); toast('Saved. We will remember your name on this device.'); };
$('#cookieNo').onclick = () => { ck.set(CK.consent, '0'); ck.del(CK.name); ck.del(CK.terms); showCookieBar(false); };
$('#cookieSettings').onclick = () => showCookieBar(true);
$('#forgetMe').onclick = () => { ck.del(CK.name); ck.del(CK.terms); ck.del(CK.consent); for (const f of [$('#hostForm'), $('#joinForm')]) f.elements.terms.checked = false; closeModal('terms'); showCookieBar(true); toast('Saved name and terms acceptance removed from this device.'); };
// Keep the two "I agree" boxes in step with each other
for (const f of [$('#hostForm'), $('#joinForm')]) f.elements.terms.addEventListener('change', (e) => { for (const o of [$('#hostForm'), $('#joinForm')]) o.elements.terms.checked = e.target.checked; });

/* ---------- public live leaderboard (anyone can open it, no chat needed) ---------- */
const PUB = { board: [] };
function renderPub() {
  const ol = $('#pubList'); ol.replaceChildren();
  if (!PUB.board.length) { ol.append(el('li', 'empty', 'No scores yet. Be the first to play!')); return; }
  PUB.board.forEach((r, i) => {
    const li = el('li');
    li.append(el('span', 'rank', (r.stars > 0 && ['🥇', '🥈', '🥉'][i]) || String(i + 1)), el('span', 'nm', r.name));
    const sc = el('span', 'sc', '⭐ ' + r.stars); sc.append(el('span', 'sub', '🪙 ' + r.coins)); li.append(sc);
    ol.append(li);
  });
}
async function loadPub() { const r = await api('publicBoard', { game: 'harbor' }); if (r.ok) { PUB.board = r.board; renderPub(); } else $('#pubList').replaceChildren(el('li', 'empty', r.error || 'Could not load the leaderboard.')); }
function startPub() {
  $('#pubList').replaceChildren(el('li', 'empty', 'Loading…'));
  openModal('pub'); loadPub();
  Net.connectPublic((ev) => { if (ev && ev.t === 'plb' && ev.game === 'harbor') { PUB.board = ev.board; renderPub(); } }, (ok) => { $('#pubConn').hidden = ok; if (ok) loadPub(); });
}
function stopPub() { Net.closePublic(); $('#pubConn').hidden = true; }
$('#openPub').onclick = startPub;
$('#pubToggle').checked = S.pub;
$('#pubToggle').onchange = (e) => {
  S.pub = e.target.checked; sessionStorage.setItem('jan-star-pub', S.pub ? '1' : '0');
  const mine = S.game && (S.lb[S.game.id] || {})[S.pid];
  if (mine) sendScore(S.game.id, mine.stars, mine.coins); else if (!S.pub && S.game) sendScore(S.game.id, 0, 0);
  toast(S.pub ? 'Your score is shown on the public leaderboard.' : 'Your score is hidden from the public leaderboard.');
};

/* ---------- boot ---------- */
(async function boot() {
  applySaved(); showCookieBar(ck.get(CK.consent) === null);
  Stickers.scatter($('#landing'), 6); Stickers.scatter($('#side'), 3);
  const m = location.hash.match(/join=([^&]+)/);
  if (m) {
    setTab('join');
    $('#joinForm').elements.key.value = fmtKeyInput(decodeURIComponent(m[1]));
    if (!$('#joinForm').elements.name.value) $('#joinForm').elements.name.focus();
    history.replaceState(null, '', location.pathname + location.search); // keep the key out of the address bar
    return;
  }
  try {
    const s = JSON.parse(sessionStorage.getItem(SS) || 'null');
    if (!s || !s.rid || !s.pid || !s.token) return;
    Object.assign(S, { rid: s.rid, pid: s.pid, token: s.token, key: s.key });
    Net.session({ rid: s.rid, pid: s.pid, token: s.token });
    const r = await api('resume');
    if (!r.ok) return endLocal(r.status === 0 ? '' : (r.error || 'That chat has ended.'));
    S.room = r.state; S.lb = toLb(r.lb); S.online = new Set([S.pid]);
    showChat(); resetMsgs(r.messages); renderRoom(); startNet();
  } catch { sessionStorage.removeItem(SS); }
})();
})();
