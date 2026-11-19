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
- **Fonts:** the `@fontsource` npm packages ship the three faces the spec fixes
  (IBM Plex Sans, IBM Plex Sans Condensed, EB Garamond) under OFL 1.1,
  self-hosted, which is what the spec requires anyway. No loss.
- **Audio:** synthesised with Web Audio, which is the spec's stated fallback.
  This is the one real compromise — hand-authored recordings of an engine loop
  or an explosion would likely beat synthesis.
- **Icons:** drawn in code as SVG. Better for cohesion than a sourced set.

The spec asks for music that is "sparse and patient: ambient electronics with
bowed strings and low piano". That is the hardest thing to synthesise
convincingly, so it is the clearest reason to open a source.

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
pnpm --filter @marque/shots exec playwright install chromium
```

---

## 3. Only you can check: frame rate on real hardware

**Status: not blocking, but it is the one quality-bar item I cannot verify.**

This container has no GPU. Chromium falls back to SwiftShader, which rasterises
in software, so `pnpm perf` reports about 5 fps at 1080p and that number says
nothing about the spec's budget of 60 fps on integrated graphics. Everything
else in the budget I can measure: the simulation step costs 0.29 microseconds
per ship, the server tick holds well inside 4 ms, and the client transfers
about 420 kB.

When you have the repository on a machine with a GPU:

```bash
pnpm install
pnpm perf
```

The report lands in `artifacts/perf/report.md` and names the renderer it used.
If it says SwiftShader or llvmpipe, it ran in software again and the numbers
should be ignored. Tell me what it reports and I will tune against real
figures.

The same applies to `pnpm verify`, which flies two browser clients: it passes
here, but only at a small viewport, because two software-rendered clients
starve each other's frame loops.

---

## 4. Coming at M3: deployment

Not needed yet. I will write the exact steps here when the deployment work
lands, and build everything up to the point that needs your accounts. It will
involve:

- A GitHub Pages source setting for the client (free).
- A small always-on host with a persistent volume for the server. Fly.io is the
  default in the spec; this is the one item that **costs money** (expect a few
  dollars a month for the smallest instance plus a 1 GB volume).
- A shared invite code and an admin callsign, set as server configuration.

---

## 5. For you to decide, whenever you like

Not blocking: I have picked a defensible default and logged it in
`docs/DESIGN.md`. Tell me if you disagree.

- **Two palette values were lightened for contrast.** Spec section 4 says to
  adjust lightness for AA while keeping the hues. Text muted `#5C6777` reached
  only 2.95:1 on a raised panel and danger `#E5484D` only 4.33:1, both failing
  AA for text. They are now `#788597` and `#E64F54`, with the hues held to
  within one degree. Every other value in the spec passes as given.
- **Invite-only, about twenty accounts.** Accounts are a callsign plus a device
  token behind a shared invite code, with a recovery phrase shown once.
