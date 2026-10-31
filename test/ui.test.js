'use strict';
// UI test: runs the real index.html + app.js + game page in jsdom windows against the real Worker (workerd) over HTTP + WebSocket.
// (jsdom has no layout, camera or microphone, so calls/recording/photo-shrinking are covered by the API tests only.)
const { JSDOM, VirtualConsole, CookieJar } = require('jsdom');
const { t, sleep, until, freshIp } = require('./lib');

module.exports = async function uiTests(U) {
  const errors = [];
  async function open(url, jar) {
    const vc = new VirtualConsole(); vc.on('jsdomError', (e) => { if (!/Not implemented|Could not parse CSS/i.test(String(e.message) + String(e.stack))) errors.push(e.message); });
    const dom = await JSDOM.fromURL(url, {
      runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc, cookieJar: jar,
      beforeParse(w) {
        const ip = freshIp(); // each browser window gets its own address, like real visitors do
        w.fetch = (u, o = {}) => fetch(new URL(u, url), { ...o, headers: { ...(o.headers || {}), 'cf-connecting-ip': ip } });
        w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
        w.confirm = () => true;
        w.HTMLElement.prototype.scrollIntoView = () => {};
      },
    });
    const w = dom.window; await until(() => w.document.readyState === 'complete' && w.Net); return w;
  }
  const $ = (w, s) => w.document.querySelector(s);
  const submit = (w, form) => form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
  const typeInto = (w, el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };

  console.log('\nTerms, cookies and the public leaderboard');
  const jar = new CookieJar();
  const T = await open(U + '/', jar);
  t(!$(T, '#cookies').hidden, 'cookie notice is shown on a first visit');
  t(await until(() => T.document.querySelectorAll('#landing img.sticker').length >= 3), 'landing page is decorated with random stickers');
  const stk = [...T.document.querySelectorAll('#landing img.sticker')].map((i) => i.getAttribute('src'));
  t(new Set(stk).size === stk.length, 'no sticker appears twice on the same screen');
  t([...T.document.querySelectorAll('img.sticker')].every((i) => i.alt === '' && i.getAttribute('aria-hidden') !== 'false'), 'stickers are decoration only (empty alt text)');
  t(/Artwork, stickers and characters/.test(T.document.querySelector('#terms').textContent) && /TERMS|Terms/.test(T.document.querySelector('#termsTitle').textContent), 'Terms cover the artwork and characters');
  t($(T, '#hostForm').elements.terms.required && $(T, '#joinForm').elements.terms.required, 'both forms require agreeing to the Terms');
  $(T, '[data-open="terms"]').click();
  t(!$(T, '#terms').hidden && /Terms/.test($(T, '#termsTitle').textContent) && /public leaderboard/i.test($(T, '#terms').textContent), 'Terms & Conditions open and describe the public leaderboard and cookies');
  T.document.dispatchEvent(new T.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  t($(T, '#terms').hidden, 'Escape closes the Terms');
  typeInto(T, $(T, '#hostForm').elements.name, 'Dana'); typeInto(T, $(T, '#hostForm').elements.chat, 'Cookie Room');
  submit(T, $(T, '#hostForm'));
  await sleep(300);
  t($(T, '#chat').hidden, 'without ticking the Terms box the chat is not created');
  $(T, '#cookieYes').click();
  $(T, '#hostForm').elements.terms.checked = true; submit(T, $(T, '#hostForm'));
  t(await until(() => !$(T, '#chat').hidden), 'chat is created once the Terms are accepted');
  t(/js_name=Dana/.test(jar.getCookieStringSync(U + '/')) && /js_terms=/.test(jar.getCookieStringSync(U + '/')), 'name and Terms acceptance saved in cookies');
  const T2 = await open(U + '/', jar);
  t($(T2, '#cookies').hidden, 'cookie notice is not shown again after a choice');
  t($(T2, '#hostForm').elements.name.value === 'Dana' && $(T2, '#joinForm').elements.name.value === 'Dana', 'saved name pre-fills both forms');
  t($(T2, '#hostForm').elements.terms.checked, 'Terms box is already ticked for a returning visitor');
  $(T2, '[data-open="terms"]').click(); $(T2, '#forgetMe').click();
  t(!/js_name=Dana/.test(jar.getCookieStringSync(U + '/')) && !$(T2, '#cookies').hidden, '"Forget my saved name" deletes the cookies');
  const T3 = await open(U + '/', new CookieJar());
  $(T3, '#cookieNo').click(); typeInto(T3, $(T3, '#hostForm').elements.name, 'Nope');
  $(T3, '#hostForm').elements.terms.checked = true; typeInto(T3, $(T3, '#hostForm').elements.chat, 'No Cookies'); submit(T3, $(T3, '#hostForm'));
  t(await until(() => !$(T3, '#chat').hidden), 'declining cookies still lets you use the app');
  t(!/js_name/.test(T3.document.cookie), 'declined cookies: the name is never saved');
  // Public leaderboard: a visitor with no chat can open it and watches it live
  const V = await open(U + '/', new CookieJar());
  t(!$(V, '#pubLbBtn') && !/leaderboard/i.test(($(V, '#landing').querySelector('.form') || {}).textContent || ''), 'landing page has no leaderboard button (it lives inside the game screen)');
  const tf = $(T, '#gamesBtn'); tf.click(); $(T, '#gList .gcard').click();
  await until(() => $(T, '#gFrame').contentDocument && $(T, '#gFrame').contentDocument.querySelectorAll('.cell').length === 42);
  T.dispatchEvent(new T.MessageEvent('message', { data: { type: 'js:score', game: 'harbor', stars: 3, coins: 90 }, source: $(T, '#gFrame').contentWindow }));
  $(T, '#openPub').click();
  t(!$(T, '#pub').hidden, '"Open public leaderboard" opens from inside the game screen');
  t(await until(() => /Dana/.test($(T, '#pubList').textContent) && /⭐ 3/.test($(T, '#pubList').textContent)), "the public board shows Dana's score, live");
  $(T, '#pubToggle').click();
  t(await until(() => /No scores yet/.test($(T, '#pubList').textContent)), 'turning off "Show my score" removes it from the public board live');
  $(T, '[data-close="pub"]').click();
  t($(T, '#pub').hidden, 'public leaderboard closes');
  V.close();
  const tg = await open(U + '/games/harbor-merge.html');
  t(await until(() => tg.document.querySelectorAll('.cell').length === 42), 'compact game still has the full 42-cell board');
  t(/max-width:\s*340px/.test(tg.document.querySelector('style').textContent) && /grid-template-rows:repeat\(6,1fr\)/.test(tg.document.querySelector('style').textContent), 'game board is 7×6 and fills the window (no scrolling)');
  $(T, '#gClose').click(); $(T, '#stopBtn').click(); $(T3, '#stopBtn').click();
  await sleep(300);
  [T, T2, T3, tg].forEach((w) => w.close());

  console.log('\nHosting and joining');
  const A = await open(U + '/');
  t(!$(A, '#landing').hidden && $(A, '#chat').hidden, 'landing page shows; chat hidden');
  t(/Play games/.test($(A, '#gamesBtn').textContent), '"Play games" button exists in the chat bar');
  t((await Promise.all([...A.document.scripts].map((s) => s.src))).every((s) => !s || new URL(s).origin === U), 'page only loads its own scripts (no external hosts)');
  typeInto(A, $(A, '#hostForm').elements.name, 'Alice'); typeInto(A, $(A, '#hostForm').elements.chat, 'Game Night');
  $(A, '#hostForm').elements.terms.checked = true; submit(A, $(A, '#hostForm'));
  t(await until(() => !$(A, '#chat').hidden), 'host creates the chat and enters it');
  const key = $(A, '#keyText').textContent;
  t(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/.test(key), 'access key shown: ' + key);
  t($(A, '#roomName').textContent === 'Game Night' && !$(A, '#stopBtn').hidden && $(A, '#leaveBtn').hidden, 'host sees "Stop hosting", not "Leave"');

  const B = await open(U + '/#join=' + encodeURIComponent(key));
  t($(B, '#joinForm').elements.key.value === key && !$(B, '#joinForm').hidden, 'invite link pre-fills the key and opens the Join tab');
  t(B.location.hash === '', 'key is removed from the address bar');
  typeInto(B, $(B, '#joinForm').elements.name, 'Bob'); $(B, '#joinForm').elements.terms.checked = true; submit(B, $(B, '#joinForm'));
  t(await until(() => !$(B, '#chat').hidden), 'guest joins via invite link');
  t($(B, '#stopBtn').hidden && !$(B, '#leaveBtn').hidden, 'guest sees "Leave", not "Stop hosting"');
  t(await until(() => A.document.querySelectorAll('#people li').length === 2), 'host sees both people listed live');
  t(await until(() => [...B.document.querySelectorAll('#people .presence')].every((d) => d.classList.contains('on'))), 'both shown online (presence)');

  console.log('\nChat');
  typeInto(A, $(A, '#text'), 'hello <i>Bob</i>'); submit(A, $(A, '#composer'));
  t(await until(() => /hello <i>Bob<\/i>/.test($(B, '#messages').textContent)), 'guest receives the message live');
  t($(B, '#messages i') === null, 'message is rendered as text, never HTML');
  t(/Bob joined/.test($(A, '#messages').textContent), 'system "joined" notice shown');

  console.log('\nPlay games + live leaderboard');
  $(A, '#gamesBtn').click();
  t(!$(A, '#games').hidden, '"Play games" opens the games screen');
  const card = $(A, '#gList .gcard');
  t(card && /Harbor Merge/.test(card.textContent), 'game list shows Harbor Merge');
  card.click();
  const frameA = $(A, '#gFrame');
  t(frameA.src.endsWith('/games/harbor-merge.html') && frameA.getAttribute('sandbox') === 'allow-scripts', 'game opens in a sandboxed frame (scripts only: no same-origin, no storage)');
  t(await until(() => frameA.contentDocument && frameA.contentDocument.querySelectorAll('.cell').length === 42), 'game loads: 42-cell board');
  t(await until(() => $(A, '#lbList li')), 'leaderboard lists chat members');
  t([...A.document.querySelectorAll('#lbList .nm')].map((x) => x.textContent).sort().join() === 'Alice (you),Bob', 'leaderboard shows everyone in the chat (Alice, Bob), you marked');

  // The game talks to the chat page only via postMessage; capture what it sends.
  const sent = []; A.addEventListener('message', (e) => e.data && sent.push(e.data));
  const gdoc = frameA.contentDocument;
  gdoc.querySelector('.cell.gen').click();      // tap the basket -> an item appears
  t(await until(() => sent.some((m) => m.type === 'js:score' && m.game === 'harbor')), 'game reports its score to the chat after a move');
  t(sent.some((m) => m.type === 'js:state' && m.state && Array.isArray(m.state.board)), 'game also hands its saved progress to the chat page');
  t(await until(() => gdoc.querySelectorAll('.cell').length === 42 && [...gdoc.querySelectorAll('.cell')].some((c) => c.textContent.trim() && !c.classList.contains('gen'))), 'a basket tap produced an item on the board');

  // jsdom doesn't set MessageEvent.source, so forward the game's own report with the right source (as real browsers do).
  const fwd = (w, frame, data) => w.dispatchEvent(new w.MessageEvent('message', { data, source: frame.contentWindow }));
  fwd(A, frameA, { type: 'js:score', game: 'harbor', stars: 2, coins: 60 });
  t(await until(() => /⭐ 2/.test($(A, '#lbList .me').textContent)), 'your own row updates instantly');

  $(B, '#gamesBtn').click(); $(B, '#gList .gcard').click();
  const frameB = $(B, '#gFrame');
  t(await until(() => /Alice/.test($(B, '#lbList').textContent) && /⭐ 2/.test($(B, '#lbList').textContent)), "guest's leaderboard shows Alice's score from the server (live)");
  t(await until(() => /🥇/.test($(B, '#lbList li').textContent) && /Alice/.test($(B, '#lbList li').textContent)), 'Alice is ranked #1 with a medal');
  await sleep(300);
  fwd(B, frameB, { type: 'js:score', game: 'harbor', stars: 4, coins: 120 });
  t(await until(() => { const r = [...A.document.querySelectorAll('#lbList li')]; return r[0] && /Bob/.test(r[0].textContent) && /⭐ 4/.test(r[0].textContent) && /Alice/.test(r[1].textContent); }), "Bob overtakes Alice: host's board re-ranks live");
  t(await until(() => /Bob leads with ⭐ 4/.test((() => { A.document.querySelector('#gBack').click(); return $(A, '#gList').textContent; })())), 'game list shows the current leader');
  fwd(B, frameB, { type: 'js:score', game: 'harbor', stars: 999, coins: 1 });
  t(await until(() => /not accepted/.test($(B, '#toast').textContent)), 'an impossible score is rejected and the player is told');
  const sA = JSON.parse(A.sessionStorage.getItem('jan-star-session'));
  const post = (action, b, extra) => fetch(U + '/api/' + action, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': freshIp(), ...(extra || {}) }, body: JSON.stringify(b || {}) });
  const authA = { 'x-rid': sA.rid, 'x-pid': sA.pid, 'x-token': sA.token };
  const rows = ((await (await post('resume', {}, authA)).json()).lb || {}).harbor || [];
  t(rows.length === 2 && Math.max(...rows.map((r) => r.stars)) === 4, 'server leaderboard holds exactly the accepted scores (Alice 2, Bob 4)');

  console.log('\nSaved progress');
  A.document.querySelector('#gList .gcard').click();
  const frameA2 = $(A, '#gFrame');
  await until(() => frameA2.contentDocument && frameA2.contentDocument.querySelectorAll('.cell').length === 42);
  fwd(A, frameA2, sent.filter((m) => m.type === 'js:state').pop());
  const savedKey = [...Object.keys(A.sessionStorage)].find((k) => k.startsWith('jan-star-game-'));
  t(!!savedKey, 'game progress is kept for this tab (sessionStorage), so a refresh does not lose it');
  const saved = JSON.parse(A.sessionStorage.getItem(savedKey)); saved.stars = 7; saved.coins = 321;
  frameA2.contentWindow.dispatchEvent(new frameA2.contentWindow.MessageEvent('message', { data: { type: 'js:load', state: saved }, source: A }));
  t(await until(() => /7/.test(frameA2.contentDocument.querySelector('#bar').textContent) && /321/.test(frameA2.contentDocument.querySelector('#bar').textContent)), 'the game restores saved progress sent by the chat page (stars 7, coins 321)');
  frameA2.contentWindow.dispatchEvent(new frameA2.contentWindow.MessageEvent('message', { data: { type: 'js:load', state: { board: 'junk', stars: 'x' } }, source: null }));
  t(/321/.test(frameA2.contentDocument.querySelector('#bar').textContent), 'messages from anything other than the chat page are ignored by the game');
  A.document.querySelector('#gBack').click();

  console.log('\nLeave / Stop hosting');
  $(B, '#gClose').click();
  $(B, '#leaveBtn').click();
  t(await until(() => !$(B, '#landing').hidden && /You left the chat/.test($(B, '#notice').textContent)), 'guest leaves; returns to landing');
  t(await until(() => A.document.querySelectorAll('#people li').length === 1), 'host sees the guest disappear');
  t(await until(() => A.document.querySelectorAll('#gList .gcard').length === 1 && !/Bob/.test($(A, '#gList').textContent)), 'game list no longer counts the guest who left');
  $(A, '#gList .gcard').click();
  t(await until(() => A.document.querySelectorAll('#lbList li').length === 1), 'leaderboard drops the guest who left');
  t(!Object.keys(B.sessionStorage).some((k) => k.startsWith('jan-star-')), "leaver's session and game data cleared from the browser");
  const C = await open(U + '/#join=' + encodeURIComponent(key));
  typeInto(C, $(C, '#joinForm').elements.name, 'Cleo'); $(C, '#joinForm').elements.terms.checked = true; submit(C, $(C, '#joinForm'));
  t(await until(() => !$(C, '#chat').hidden), 'a third person joins the same room');
  t(await until(() => A.document.querySelectorAll('#people li').length === 2 && [...A.document.querySelectorAll('#people .presence')].every((d) => d.classList.contains('on'))), 'the third person is connected and shown online');
  const m8 = Date.now();
  $(A, '#gClose').click(); $(A, '#stopBtn').click();
  t(await until(() => !$(A, '#landing').hidden && /stopped hosting/.test($(A, '#notice').textContent)), 'host stops hosting; returns to landing');
  t(await until(() => !$(C, '#landing').hidden && /host stopped hosting/.test($(C, '#notice').textContent)), 'remaining guest is disconnected instantly with an explanation');
  t((await post('resume', {}, authA)).status === 410 && (await post('join', { name: 'Zed', key })).status === 404, 'server no longer knows the chat: the key and the host credentials are dead (everything deleted)');

  t(errors.length === 0, 'no script errors in any window' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  [A, B, C].forEach((w) => w.close());
};
