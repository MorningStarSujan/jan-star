# JAN STAR (JS)

Temporary, accountless, privacy-focused chat with **text, images, video, files, voice messages, voice/video calls and multiplayer games with a live leaderboard**. No sign-up, no email, no phone number. When the host stops hosting, everything is deleted.

This version runs **entirely on Cloudflare's free plan**. There is no Redis, no Ably and no other third-party service to sign up for.

## How it works

One Cloudflare **Worker** serves the web app (static files) and the `/api` routes. Chats and live events run in **Durable Objects**, Cloudflare's built-in way to keep a small piece of state and its WebSocket connections together.

| Piece | Job |
|---|---|
| **Worker** (`src/worker.js`) | Serves the app, routes `/api/*`, creates access keys, applies per-IP limits |
| **Room** Durable Object (`src/room.js`) | One per chat: members, messages, photos/video/files, call state, scores, and the live WebSockets. Stored in its own SQLite database and wiped when the chat ends |
| **Hub** Durable Object (`src/hub.js`) | One shared object: the public leaderboard (and its live feed) and the create/join rate limits |

```
Browser --HTTPS--> Worker /api --> Room (one per chat) <--WebSocket--> Browser
                         \--> Hub (public leaderboard, rate limits)
```

- A chat's private address is a **hash of its access key**, so no key lookup table exists anywhere. Nobody can find a chat without the key.
- Browsers sign in on the WebSocket with their member token; all writes go through the API, which checks the token first.
- A chat that sits idle is **deleted by itself** (an alarm fires after 3 hours idle, 12 hours maximum), even if nobody visits again.

## Run it on your computer

```bash
npm install
npm run dev        # http://localhost:8787  (runs the real Cloudflare runtime locally)
```

Camera/mic calls work on `localhost`; on other devices they need HTTPS (Cloudflare provides it).

## Deploy to Cloudflare (free, permanent `*.workers.dev` address)

You need a free Cloudflare account (no card). 

**Option A: automatic deploys from GitHub (recommended)**

1. Push this folder to a GitHub repository.
2. Cloudflare dashboard -> **Workers & Pages** -> **Create application** -> **Import a repository** -> pick your repo.
3. Leave the **Worker name as `jan-star`** (it must match `name` in `wrangler.jsonc`, or the build fails). Build command: leave empty. Deploy command: `npx wrangler deploy`.
4. **Save and Deploy.** Your app is live at `https://jan-star.<your-subdomain>.workers.dev`. Every `git push` redeploys it.

**Option B: from your computer**

```bash
npm install
npx wrangler login
npx wrangler deploy
```

The first deploy creates the Durable Objects automatically (`migrations` in `wrangler.jsonc`). No other setup is needed. To change the Worker name (and so the address), edit `name` in `wrangler.jsonc`.

**Custom domain (optional, not free):** buy any domain (Cloudflare Registrar sells at cost) and attach it under the Worker's **Settings -> Domains & Routes**. The free `*.workers.dev` address keeps working without it.

Optional: set an `ICE_SERVERS` variable (JSON array, for example a TURN relay) under **Settings -> Variables** so calls work on mobile data and strict networks. Without it the app uses a public STUN server only.

## Free-plan limits (checked October 2026; they can change)

Static files (the app itself) are free and unlimited. Chat traffic uses Durable Objects, whose free plan allows per day (reset 00:00 UTC):

- **100,000 requests** (an API call is 1, a WebSocket connect is 1, and incoming WebSocket messages count 1 per 20; messages the server sends are free)
- **100,000 database row writes** (a chat message uses a few; the daily total is the limit that matters most)
- 13,000 GB-seconds of compute (sleeping rooms cost nothing), 5 GB storage

Rough guide: a few thousand chat messages a day plus games, comfortably, for friends-and-family use. If a daily limit is reached, chat actions fail until midnight UTC and then work again. **Nothing is ever billed** on the free plan; Cloudflare just stops until the next day. Workers Paid ($5/month) removes the limits if you ever need it.

## Games

Tap **Play games** inside a chat. Each game opens in a compact, sandboxed window and reports its score to the chat; the **live leaderboard** shows everyone currently in the chat, updated in real time.

### Public leaderboard (anyone can see it)
Open it from the games screen with **Open public leaderboard**. It needs no key or account and updates live. It shows only display name, stars and coins (never chat names, keys or ids). Players can switch **Show my score** off at any time; a player's entry is removed when they leave or the chat ends.

**Harbor Merge** is included: ranked by stars, ties broken by coins.

Scores are reported by the player's browser, so a determined cheater could fake them. The server rejects impossible values and jumps, but this is a friendly-game board, not a competitive one.

### Add another game
1. Put a self-contained HTML file in `public/games/` (no external scripts or fonts).
2. In the game, post messages to the chat page: `parent.postMessage({type:'js:ready'},'*')` on start, `{type:'js:score',game:'<id>',stars:N,coins:N}` and `{type:'js:state',state:{...}}` when progress changes, and listen for `js:load`.
3. Add it to `GAMES` in `public/app.js` and its id to `GAMES` in `src/util.js` (server allow-list).

## Look and stickers

Light, playful, minimal style. Decorative stickers come from `public/stickers/`.

**Copyright:** several stickers show third-party characters (for example Hello Kitty, Spider-Man, Miffy and anime characters). They belong to their owners. Before a public launch, replace them with your own artwork or licensed ones.

## Terms & Conditions and cookies

- Both the **Host** and **Join** forms require agreeing to the Terms (text in `public/index.html`, section `#terms`; edit it for your situation and have it reviewed).
- A cookie notice asks permission to save the **display name** and the **terms acceptance** (`js_name`, `js_terms`, `js_consent`; 12 months). Declining still lets people use the app.
- To make everyone accept updated terms again, change `TERMS_V` in `public/app.js`.

## Privacy and security

- No accounts. Access keys are random (about 79 bits). The server never stores the key itself, only a hash that addresses the chat.
- Everything for a chat is deleted when the host stops hosting, or automatically when it idles out.
- Uploaded files are never rendered by the browser (HTML/SVG are downloads only) and are blocked from anyone who joined after they were sent.
- Strict Content-Security-Policy (set in `public/_headers`), no third-party scripts, games are sandboxed, WebSocket connections from other websites are refused.
- Rate limits on creating chats, joining, messages, uploads and scores. IP-based limits use Cloudflare's `cf-connecting-ip`.

## Limits

8 people per chat · 3 MB per file/photo/video (photos are shrunk automatically) · 24 MB of media per chat · voice messages up to 2.5 minutes · calls are peer-to-peer mesh (3-4 people is comfortable).

If the host closes their browser, the chat stays alive until it idles out or the host returns and stops it.

## Tests

```bash
npm install
npm test
```

The tests start the **real Worker and Durable Objects locally** (the same Cloudflare runtime, `workerd`) and use real HTTP and WebSocket connections:

- `test/api.test.js`: rooms, keys, live messages, uploads (multi-chunk, byte-exact), access control, call signalling, leaderboard rules, the public leaderboard, deletion, **sleep/wake of live connections**, **automatic deletion of idle chats**, rate limits, security headers.
- `test/ui.test.js`: the real page and game in two simulated browsers (host + guest via invite link): chat, games, live leaderboard, Terms, cookies, public leaderboard, leaving and stopping.

**Not covered by automated tests:** a live deployment on your Cloudflare account, Cloudflare's real daily quotas, and real camera/microphone calls between devices. Please try a chat with two phones after deploying.
