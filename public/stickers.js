/* Random sticker decoration. Each sticker is decoration only (aria-hidden, not clickable).
 * Stickers are placed at random edge spots, rotated and sized at random, and never repeat on the same screen. */
(() => {
  'use strict';
  let list = null, deck = [];
  const ZONES = [[0, 0], [100, 0], [0, 100], [100, 100], [50, 0], [50, 100], [0, 50], [100, 50]];
  const rnd = (a, b) => a + Math.random() * (b - a);
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

  async function load() {
    if (list) return list;
    try { const r = await fetch('/stickers/index.json'); list = r.ok ? await r.json() : []; } catch { list = []; }
    return list;
  }
  // Next sticker that is not already on this screen (refills the deck when it runs out).
  function take(onScreen) {
    let i = deck.findIndex((f) => !onScreen.has(f));
    if (i < 0) { deck = shuffle(list.slice()); i = deck.findIndex((f) => !onScreen.has(f)); }
    return i < 0 ? null : deck.splice(i, 1)[0];
  }

  async function scatter(host, count = 5) {
    if (!host) return;
    const items = await load();
    if (!items.length) return;
    host.querySelectorAll('img.sticker').forEach((n) => n.remove());
    const small = window.innerWidth < 600;
    const zones = shuffle(ZONES.slice()).slice(0, Math.min(small ? 4 : count, ZONES.length));
    const used = new Set();
    for (const [zx, zy] of zones) {
      const f = take(used);
      if (!f) break;
      used.add(f);
      const img = document.createElement('img');
      img.className = 'sticker'; img.alt = ''; img.decoding = 'async'; img.draggable = false;
      img.src = '/stickers/' + f;
      img.style.left = (zx + rnd(-5, 5)) + '%';
      img.style.top = (zy + rnd(-5, 5)) + '%';
      img.style.setProperty('--r', rnd(-16, 16).toFixed(1) + 'deg');
      img.style.setProperty('--s', Math.round(small ? rnd(56, 84) : rnd(80, 124)) + 'px');
      host.append(img);
    }
  }
  window.Stickers = { scatter };
})();
