# ethora-demo-qa

**A self-driving demo + QA harness for the [Ethora](https://github.com/dappros/ethora) chat SDKs.**

It provisions a themed test world on an Ethora server, then drives the
**React.js** ([`ethora-chat-component`](https://github.com/dappros/ethora-chat-component))
and **React Native** ([`ethora-chat-component-rn`](https://github.com/dappros/ethora-chat-component-rn))
chat components through scripted scenarios — side by side, one user on the web
and one on a mobile simulator — capturing screenshots (and, later, video) for
both **marketing** and **QA**.

The goal: never again hand-assemble a chat demo with throwaway names and a flat
conversation. Run one command, get a polished, repeatable, cross-platform
showcase that also doubles as an end-to-end regression check.

> **No credentials are ever committed.** The harness provisions a throwaway
> tenant account, app, and test users via the Ethora API and stores them only
> in `secrets/` (gitignored). See [Security](#security).

## What it does

**Once per scenario (provisioning):**
1. Creates a throwaway owner account + a fresh app on the target server.
2. Creates themed test users with real display names and generated avatars
   (the reference scenario casts *A Midsummer Night's Dream*).

**Every run:**
1. Tears down the previous chat room and creates a fresh group chat (over XMPP).
2. Subscribes the whole cast and seeds backstory history.
3. Drives the **web** component (Playwright) and the **iOS** RN component
   (Maestro + `simctl`) through one scripted scenario: sending messages and
   media, typing indicators, read receipts, editing and deleting messages, and
   loading older history.
4. Captures screenshots from both surfaces into `artifacts/`.

## Quick start

```bash
npm install
cp .env.example .env          # defaults target the QA cluster
npm run doctor                # check tooling (node, playwright, simulator, maestro)
npm run provision             # create account + app + cast on the server (once)
npm run run                   # reset the room and run the scenario on web + iOS
```

| Command | What it does |
|---------|--------------|
| `npm run doctor` | Verify local tooling and the target server. |
| `npm run provision` | Create the owner/app/cast (idempotent; `-- --fresh` to recreate). |
| `npm run reset` | Destroy + recreate the room, re-seed history. |
| `npm run run` | Full scenario across web + iOS (`run:web` / `run:ios` for one surface). |

Scenario selection: append `-- --scenario midsummer` (default) to any command.

## Architecture

```
src/
  config.ts            Env + server presets (QA / prod)
  cli.ts               Command entry (provision / reset / run / doctor)
  provision/
    ethora-api.ts      REST client (account, app, user, avatar)
    avatar.ts          Dependency-free themed SVG avatars
    provision.ts       Account + app + cast (REST)
    room-setup.ts      Room create + subscribe + seed (XMPP)
    state.ts           Gitignored world.<env>.<scenario>.json
  xmpp/client.ts       Node XMPP client (mirrors the SDK stanzas; SASL PLAIN)
  scenarios/           Scenario schema + themed casts/scripts (pure data)
  web/                 Playwright runner (React.js component)
  mobile/              Maestro + simctl runner (React Native component, iOS)
```

New scenarios are **pure data** — add a cast and a script in `src/scenarios/`,
no engine changes. See `src/scenarios/midsummer.ts` for the reference.

## Security

- `secrets/` and `.env` are gitignored and never committed.
- The harness provisions a **throwaway** account on the QA server; the
  resulting credentials live only in `secrets/world.<env>.<scenario>.json`.
- Test emails use `@mailinator.com` so they never reach a real inbox.
- This repo is public; treat the QA server as the only place demo state lives.

## License

MIT
