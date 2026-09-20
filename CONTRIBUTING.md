# Contributing to JEV — The Fish Game

Thanks for your interest! The whole game is designed to be *inspectable*: click
any fish, read its Jev Q&A panel, and you already know what the AI is doing.
PRs and issues are welcome.

## Ways to contribute

- **New decision criteria** — add a question to `buildPayload()` in `server.js`
  (keep one narrow judgment per question; put policy in code, not prompts).
- **Game mechanics** — spikes, food spawning, mass/speed curves live in the
  physics section of `server.js`.
- **Visuals** — fish faces, spike art, and the Q&A panel live in `index.html`.
- **Client networking** — the dead-reckoning renderer in `index.html` is a
  self-contained example of smoothing a 10 Hz stream to 60 fps.

## Ground rules

1. **The server is authoritative.** Never trust or implement gameplay on the
   client; the browser only renders and sends intent.
2. **Jev decides, code governs.** The model returns typed judgments
   (choice/noul/score); thresholds and game policy stay in plain code.
3. **No secrets.** Never commit `.env`, `key.json`, or any API key. Everything
   sensitive is read from the environment.
4. **Keep the fallback working.** If you touch the decision engine, make sure
   the game still runs with no API key (local fallback brain).

## Development

```bash
npm install
cp .env.example .env      # optional — game works without a key
npm start                 # http://localhost:8787
```

`server.js` hot-swaps `index.html` on every request; clients detect the change
and reload themselves. Restart the server only when `server.js` changes.

## Submitting

1. Fork → branch (`feat/my-thing`) → commit.
2. Make sure `node --check server.js` passes and the game runs.
3. Open a PR describing what changed and how to test it.
