# Human to-do

Things only you can do: accounts, credentials, anything that costs money, and
decisions about this machine's network access. Everything here is optional
unless marked **blocking**; nothing in this list is holding up current work.

Each item has exact steps. When one is done, delete it.

---

## 1. Optional: widen network access for asset sourcing

**Status: not blocking.** The build has a working path without it.

This container's network policy allows package registries and GitHub, and
refuses everything else at the proxy. Checked on 2026-11-19:

| Host | Result | What it would have been for |
|---|---|---|
| `registry.npmjs.org` | reachable | Dependencies |
| `github.com`, `raw.githubusercontent.com` | reachable | Library source and docs |
| `codeload.github.com` | **403** | Repository tarballs |
| `docs.colyseus.io` | **403** | Colyseus documentation |
| `orm.drizzle.team`, `pixijs.download` | **403** | Library documentation |
| `fonts.google.com`, `api.fontsource.org` | **403** | Fonts |
| `freesound.org`, `opengameart.org` | **403** | Openly licensed audio and icons |

**What I am doing instead**, all of which the spec permits:

- **Docs:** read from the library's own GitHub repository source. The Colyseus
  docs are `.mdx` files in `colyseus/docs`, so `raw.githubusercontent.com` gives
  the same content the website renders. This works well and needs nothing from
  you.
- **Fonts:** the `@fontsource` npm packages ship the same OFL fonts as Google
  Fonts, self-hosted, which is what the spec requires anyway. No loss.
- **Audio:** synthesised with Web Audio, which is the spec's stated fallback.
  This is the one real compromise — hand-authored recordings of an engine loop
  or an explosion would likely beat synthesis.
- **Icons:** drawn in code as SVG. Better for cohesion than a sourced set.

**If you want sourced audio instead of synthesis**, allow these hosts:

1. Open <https://claude.ai/settings/environments> and pick the environment this
   session runs in (currently **Default**).
2. Add to the allowed-hosts list: `freesound.org`, `cdn.freesound.org`,
   `opengameart.org`, `opengameart.org.s3.amazonaws.com`.
3. Freesound's API also needs a key: register at
   <https://freesound.org/apiv2/apply/>, then tell me and I will ask for it
   through the secure credential form. **Never paste a key into the chat.**

Everything sourced this way still has to pass the licence rules in `CLAUDE.md`,
and lands in `CREDITS.md` in the same commit as the asset.

---

## 2. Optional: Playwright browser on your own machine

**Status: not blocking.** Already working in this container.

`pnpm shots` drives a headless Chromium. This container has one pre-installed,
and the harness finds it automatically. On your own machine, run once:

```bash
pnpm --filter @manifest/shots exec playwright install chromium
```

---

## 3. Coming at M3: deployment

Not needed yet. I will write the exact steps here when the deployment work
lands, and build everything up to the point that needs your accounts. It will
involve:

- A GitHub Pages source setting for the client (free).
- A small always-on host with a persistent volume for the server. Fly.io is the
  default in the spec; this is the one item that **costs money** (expect a few
  dollars a month for the smallest instance plus a 1 GB volume).
- A shared invite code and an admin callsign, set as server configuration.

---

## 4. For you to decide, whenever you like

Not blocking: I have picked a defensible default for each and logged it in
`docs/DESIGN.md`. Tell me if you disagree.

- **The game is called _Manifest_.** Named for the cargo register that is also
  this setting's administrative spine, and for the leaderboard hook: your net
  worth is your entry in it. Renaming later is cheap while the repository is
  private.
- **Invite-only, about twenty accounts.** Accounts are a callsign plus a device
  token behind a shared invite code, with a recovery phrase shown once.
