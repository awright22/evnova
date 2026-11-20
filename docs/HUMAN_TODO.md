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
in software, so `pnpm perf` reports about 4 fps at 1080p and that number says
nothing about the spec's budget of 60 fps on integrated graphics.

Everything else in section 3's budget is measured and passes, most with an
order of magnitude in hand (figures from 2026-11-20, in the M9 report):

| Budget | Result |
|---|---|
| Server tick under 4 ms, 12 clients, a fight | 2.78 ms p99 |
| No rubber-banding at 150 ms and 2% loss | 0 of 12 diverging, drift EMA 0.0000 |
| Under 5 MB before the title screen | 1.56 MB, interactive in 249 ms |
| Simulation step, 30 ships | 0.0073 ms mean, 0.24 µs a ship |

When you have the repository on a machine with a GPU:

```bash
pnpm install
pnpm perf
```

The report lands in `artifacts/perf/report.md` and names the renderer it used.
If it says SwiftShader or llvmpipe, it ran in software again and the numbers
should be ignored. Tell me what it reports and I will tune against real
figures.

Run it with enough traffic to reach the spec's scene, which is 30 ships, 300
projectiles and 3,000 particles:

```bash
pnpm perf -- --ships 30 --bots 29 --seconds 20 --width 1920 --height 1080
```

The report says how close the capture actually got to that scene, so a run
that holds 60 fps with six ships in the sky is not mistaken for one that
meets the budget.

The same applies to `pnpm verify`, which flies two browser clients. It passes
here at its default 640x360 viewport — 17 fps, a 350ms round trip across a
300ms link, and a correction EMA of zero — but a GitHub runner, with two
shared cores for two Chromium instances plus a server and a preview,
measures 463ms and 604ms and reads as diverging. The check now says NOT
JUDGED and exits clean when the machine adds more delay than the link it was
asked to test, rather than blaming the netcode for the renderer. On a machine
with a GPU it will judge it properly:

```bash
pnpm verify -- --latency 150 --seconds 12
```

Tell me what it says and I will act on a real verdict.

---

## 3b. Only you can check: Firefox and Safari

**Status: not blocking, but it is the second quality-bar item I cannot
verify.**

Spec section 3 asks for current Chrome, Firefox and Safari on desktop. This
container has Chromium and only Chromium: `/opt/pw-browsers` holds no Firefox
or WebKit build, and `playwright install firefox webkit` needs
`playwright.azureedge.net`, which the network policy refuses. So every
screenshot, every play session and every verification harness in this project
has run on one engine.

Nothing in the client is knowingly Chromium-only — no prefixed APIs, no
`chrome.*`, and the three things most likely to differ are all used in their
standard form:

| What | Where | Risk |
|---|---|---|
| `mask-image` on scrollers | `packages/client/src/styles/base.css` | Safari wants `-webkit-mask-image` on older versions |
| Web Audio | `packages/client/src/audio/` | Safari requires a user gesture before the context starts; the mix already waits for one |
| WebGL through PixiJS | the flight view | Pixi picks its own path per browser |

On a machine with the other two:

```bash
pnpm --filter @marque/shots exec playwright install firefox webkit
```

```bash
pnpm shots -- --only title,register,port-hub,bourse,yard,flight-at-rest
```

Then open the client in Safari and Firefox by hand, fly for a minute, land,
and open the Bourse. Tell me anything that looks wrong and I will fix it.

---

## 4. Deployment

Everything that can be built is built: `Dockerfile`, `fly.toml` and
`.github/workflows/deploy-client.yml` are in the repository and the production
server bundle has been run and checked here. What is left needs your accounts.

The client is free to host. The server is the one item that **costs money**:
expect a few dollars a month for the smallest always-on machine plus a 1 GB
volume.

Do the server first, because the client build needs the server's URL.

### 4a. The server, on Fly.io

1. Install `flyctl` and sign in:

   ```bash
   curl -L https://fly.io/install.sh | sh
   ```

   ```bash
   fly auth signup
   ```

2. From the repository root, create the app without deploying. Pick your own
   name — `marque` is almost certainly taken — and a region near your group
   (`fly platform regions` lists them):

   ```bash
   fly launch --no-deploy --copy-config --name YOUR-APP-NAME --region iad
   ```

   Answer no if it offers to add a database or Redis: the world is a SQLite
   file on the volume.

3. Create the volume the world lives on. It must be in the same region:

   ```bash
   fly volumes create marque_data --size 1 --region iad
   ```

4. Set the invite code. Anyone with it can open an account, and an empty value
   means no gate at all, so set one before the first deploy:

   ```bash
   fly secrets set INVITE_CODE="pick-a-phrase-your-group-will-share"
   ```

5. Tell the server which origin may connect. Use your Pages URL, with no
   trailing slash. For a project page that is
   `https://YOUR-GITHUB-USERNAME.github.io`:

   ```bash
   fly secrets set ALLOWED_ORIGINS="https://YOUR-GITHUB-USERNAME.github.io"
   ```

   Name yourself as the operator while you are here, with the callsign you
   will be entering on the Register. Only a callsign on this list can open
   the admin page at `/?admin=1`, which shows the ledger by category, every
   price and stockpile, and lets you change the tuning the world is running
   on without a restart. Several names go in comma-separated.

   ```bash
   fly secrets set ADMIN_CALLSIGNS="Your Callsign"
   ```

   Tuning changed there is in memory only: a restart goes back to what is
   committed, which is deliberate — a live rebalance is an experiment, and an
   experiment that rewrote the repository would not be one you could undo.
   When you settle on a figure, change `packages/shared/data/tuning.json` and
   deploy it.

6. Deploy, and check it answers:

   ```bash
   fly deploy
   ```

   ```bash
   curl https://YOUR-APP-NAME.fly.dev/health
   ```

   That should print `{"status":"ok",...}`. If it does not, `fly logs` says
   why.

Your server URL for the next part is `wss://YOUR-APP-NAME.fly.dev` — note
`wss`, not `https`.

### 4b. The client, on GitHub Pages

1. In the repository on GitHub: **Settings → Pages → Build and deployment →
   Source**, choose **GitHub Actions**.

2. In **Settings → Secrets and variables → Actions → Variables**, add a
   repository variable:

   - Name: `MARQUE_SERVER_URL`
   - Value: `wss://YOUR-APP-NAME.fly.dev`

   The deploy workflow fails with that instruction if the variable is missing,
   rather than publishing a client that cannot reach anything.

3. Push to `main`, or run **Actions → Deploy client → Run workflow**. The run
   prints the published URL.

If you serve the client from your own domain or a user page rather than a
project page, also set a `MARQUE_BASE` variable to the path it is served from
(`/` for a user page or a custom domain). The default is `/<repository-name>/`,
which is right for a project page.

### 4c. Afterwards

- Give your group the invite code and the Pages URL. Nothing else is needed:
  an account is a callsign plus the device they open it on.
- `fly ssh console -C "ls /data/snapshots"` lists the daily snapshots. The
  server keeps seven.
- To restore one: `fly ssh console`, stop the process, copy the snapshot over
  `/data/marque.db`, and restart the machine.

### What I could not verify here

- **The container image has never been built.** This machine has no usable
  Docker daemon. The production server bundle has been built and run outside a
  container — it boots, migrates the database and serves `/health` — so what
  is untested is the image build itself: the base image, the native build of
  `better-sqlite3`, and the volume mount. If `fly deploy` fails, send me the
  output and I will fix it.
- **No deploy has run**, since both need your accounts.

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
