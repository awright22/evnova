# Design

Architecture, data model, message protocol, risks, and a dated log of decisions.
Scope lives in `docs/SPEC.md`; this file records *how* and *why*.

---

## 1. Architecture

### Processes

Two deployables, because they have different hosting needs:

```
┌─────────────────────────────┐        ┌──────────────────────────────────┐
│ Static client               │  wss   │ Game server (one Node process)   │
│ GitHub Pages                │ <────> │ container on an always-on host   │
│ Vite build, server URL      │        │ with a persistent volume          │
│ baked in at build time      │   https│                                   │
└─────────────────────────────┘        │  ┌────────────────────────────┐  │
                                       │  │ Colyseus                   │  │
                                       │  │  SystemRoom (one per       │  │
                                       │  │  occupied star system)     │  │
                                       │  └────────────────────────────┘  │
                                       │  ┌────────────────────────────┐  │
                                       │  │ World service              │  │
                                       │  │  economy, exchange,        │  │
                                       │  │  missions, news, on its    │  │
                                       │  │  own injected clock        │  │
                                       │  └────────────────────────────┘  │
                                       │  ┌────────────────────────────┐  │
                                       │  │ SQLite (Drizzle)           │  │
                                       │  └────────────────────────────┘  │
                                       └──────────────────────────────────┘
```

Rooms come and go with players. The world service does not: it owns the economy
and keeps ticking whether or not anyone is online, which is what makes prices
move overnight and NPC freight redistribute goods.

### Packages

| Package | Owns |
|---|---|
| `packages/shared` | Simulation, formulas, message types, content data and schemas. Deterministic, imported by both sides. |
| `packages/server` | Rooms, world services, persistence. Authoritative. |
| `packages/client` | Rendering, interface, audio, input. |
| `tools/bot` | Headless client over the real protocol. |
| `tools/soak` | Accelerated soak run with a written report. |
| `tools/shots` | Scripted browser capture of every screen. |
| `tools/perf` | Frame-time percentiles for the reference scene. |

`shared` is consumed as TypeScript source through its `exports` map, so there is
no build-order dependency: Vite bundles it for the client, esbuild bundles it
into the server, and `tsx`/Vitest load it directly. One source of truth, no
stale `dist`.

### The authority rule

Clients send **inputs and intents only** — never state, never results. The
server owns position, damage, balances and prices. Every inbound message is
validated for type, range and state, and rejected with a typed reason. Input
packets are additionally range-sanitised in place by Colyseus before the
simulation reads them, so a client cannot widen its own control authority by
encoding an out-of-range axis.

---

## 2. Netcode

Built on the Colyseus 0.18 prediction stack rather than a hand-rolled one. The
relevant primitives, and how this project uses them:

| Primitive | Side | Use here |
|---|---|---|
| `defineInput(ShipInput, { sanitize, idle })` | server | One buffered input per client per tick, range-clamped |
| `setFixedTimestep(step, 30, { subSteps: 2 })` | server | Authoritative loop; advertises the rate to clients |
| `room.input({ type: ShipInput })` | client | The only thing that stages and sends input |
| `predict.reconciler(self, { input, step })` | client | Local ship: predict, roll back, replay |
| `predict.attachAll('ships', { mode: 'lerp' })` | client | Remote ships, interpolated ~100ms in the past |
| `allowRewindState` + `rewind.lastSeenBy` | server | Hit registration against what the shooter saw (M2) |
| `predict.spawns` | client | Predicted projectiles handed off to authoritative ones (M2) |
| `ctx.predict` / `ctx.memo` / `ctx.isReplay` | both | One-shot events, frozen values, presentation-only effects |

### The contract we have to keep

One input per fixed step; everything the step reads lives on the input schema;
send before you read; no raw side effects inside the step; inputs stay flat
primitives; input rate equals step rate equals tick rate.

`stepFlight` in `packages/shared/src/sim/flight.ts` is the single step function.
The server calls it from its fixed loop against the authoritative `ShipState`;
the client calls the same function from the reconciler against its predicted
mirror. There is no second copy.

### Rates

| Rate | Value | Why |
|---|---|---|
| Tick / input rate | 30 Hz | One input per step. Enough for inertial flight; keeps input bandwidth modest. |
| Physics sub-steps | 2 (60 Hz) | Integration accuracy for turning and thrust taper without doubling wire traffic. |
| State patch rate | 20 Hz | The correction cadence clients reconcile against. |
| Remote interpolation delay | 100 ms | Two patch intervals, per the netcode guidance on buffer underruns. |

### How we know it works

The bot runner reports the SDK's own drift telemetry and classifies it with the
SDK's own `classifyDrift`, so our verdict and the dev panel can never disagree.
A persistent correction EMA means the simulations genuinely diverge; spikes that
decay are network jitter.

Measured at M0 with four clients and `COLYSEUS_LATENCY=150`: drift EMA and peak
both `0.0000`, status `matched`, six inputs in flight — exactly what 200 ms
round trip at 30 inputs/second predicts.

---

## 3. Data model

SQLite through Drizzle. Economic actions are single transactions: they fully
apply or they do not happen. Credits, cargo, fuel and share quantities are
integers, and every change goes through the ledger module tagged with a faucet
or sink category — balances are never written directly.

Tables, as planned per milestone (authored when each lands):

| Table | Milestone | Notes |
|---|---|---|
| `accounts` | M3 | callsign, device token hash, recovery phrase hash, admin flag |
| `captains` | M3 | marks, current system, current ship, last port, licence |
| `ships` | M3/M5 | owned hulls, parked port, blueprint ref, damage state |
| `blueprints` | M5 | module grid, name, owner, share code |
| `ledger` | M4 | append-only: captain, delta (marks), category, reason, timestamp |
| `stockpiles` | M4 | port × commodity: stock, target, rate, capacity |
| `holdings` | M6 | captain × listed company: shares, cost basis |
| `pools` | M6 | listed company: share reserve, marks reserve, fee accrual |
| `earnings` | M6 | listed company: per-period earning events by class |
| `standings` | M7 | captain × chartered company; letters of marque held |
| `missions` | M7 | commission template, parameters, state, deadline |
| `news` | M6 | Gazette headline, class, system, timestamp |

Fast-changing state (positions) is not a transaction: it flushes every few
seconds and on shutdown, which bounds loss to the few seconds the spec allows.

---

## 4. Message protocol

Three channels, each with a different guarantee:

1. **Input** — `ShipInput`, 30/s, via `room.input()`. Flat primitives, buffered,
   sanitised. Flight only.
2. **Intents** — request/response messages that need a result: buy, sell, build,
   refit, place an order, accept a mission, trade with a player. Declared on the
   room's `messages` map, validated with a Zod schema via `validate()`, and
   rejected with `ctx.reject('typed-reason')`. The client awaits the reply.
3. **State** — synchronised schema, server to client, 20/s patches.

Rejection reasons are a closed set shared from `packages/shared`, so the client
can render a designed state for each rather than printing raw error text.

---

## 5. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Cross-engine trig differences (`Math.sin`/`atan2` are not bit-identical across JS engines) | Small persistent prediction drift between a browser and the server | Measured at 0.0000 so far. The reconciler smooths sub-visible error by design. If drift appears, replace trig in the step with a deterministic polynomial implementation. |
| `drizzle-orm` 1.0 is a release candidate, required by `@colyseus/database` | A breaking change mid-build | Pin exactly. The ledger and economy sit behind a repository layer so the ORM is replaceable. |
| TypeScript 7 (native port) is current, but `typescript-eslint` only supports `<6.1` | Lose type-aware lint rules, or lose the newest compiler | Pinned to TypeScript 6.0.3 to keep type-aware linting. Revisit when the lint toolchain catches up. |
| Economy exploits (wash trading, self-dealing, order splitting) | A friend group's economy dies in a weekend | Invariants 1–6 are automated tests, and the soak run includes bots that deliberately try to exploit. |
| Procedural ship art looks like programmer art | Fails the quality bar on the project's second pillar | One renderer, one style, driven by `ART_DIRECTION.md`; judged from captures, not from code. |
| Performance budget with 30 ships / 300 projectiles / 3000 particles | Below 60 fps on integrated graphics | Blueprints render once to a texture; particles are pooled and drawn in batches; `tools/perf` reports percentiles against the reference scene every milestone. |
| Context resets across a long build | Lost decisions, repeated mistakes | This file plus `docs/PROGRESS.md` are the memory. Every decision gets a dated line below. |

---

## 6. Decision log

**2026-11-19 — Package scope `@marque/*`.** Named after the game, which spec
section 19 fixes. Short enough to read well in imports.

**2026-11-19 — Two deployables, not one.** The Colyseus Vite plugin can host the
server inside Vite and emit a single deployable, and its dev HMR for room code
is genuinely nice. Rejected for the foundation because the spec deploys the
client to GitHub Pages and the server to a container host: one process in dev
and two in production would mean the dev topology never exercises the real one.
`pnpm dev` runs both in parallel instead — Vite HMR for the client, `tsx watch`
for the server.

**2026-11-19 — `shared` is consumed as TypeScript source.** Its `exports` map
points at `./src/index.ts`. Removes build ordering entirely and guarantees the
client, server, tests and tools all compile the same source. Relative imports
carry explicit `.ts` extensions so Node, tsx, Vite, esbuild and Vitest all
resolve them identically.

**2026-11-19 — TypeScript 6.0.3, not 7.** TypeScript 7 is current stable but
`typescript-eslint` 8.73 requires `<6.1.0`. Type-aware lint rules
(`no-floating-promises`, `no-misused-promises`) catch real bugs and are worth
more over a long build than the newest compiler. Logged as a risk to revisit.

**2026-11-19 — 30 Hz tick with 2 physics sub-steps.** Input bandwidth stays at
30 frames/second while integration runs at 60 Hz. Colyseus cascades `subSteps`
to the client so replay reproduces the sub-stepped trajectory exactly. Chosen
now because changing the tick rate later would invalidate every tuned number.

**2026-11-19 — Thrust tapers on velocity along the facing, not on raw speed.**
`taper = clamp(1 - (v · facing) / topSpeed, 0, 1)`. Gives the spec's "no hard
clamp" asymptote, and burning against your own momentum keeps full authority,
which is what makes the brake feel like a real retrograde burn.

**2026-11-19 — The brake nulls residual velocity below one step's authority.**
Braking below `thrustAccel × dt` would overshoot through zero and oscillate — it
did, and a test caught it. The threshold scales with thrust and `dt`, so it is
step-rate independent and identical on both sides of the wire.

**2026-11-19 — Angular damping uses the closed form `exp(-rate × dt)`.** Rather
than `angVel -= angVel × rate × dt`, so the result does not depend on how the
step was subdivided. Keeps sub-stepping consistent with a single large step.

**2026-11-19 — Steering lives in `shared`, not in the bot.** `turnToward` and
`seekPoint` produce the same `FlightCommand` a human holds on the keyboard, so
NPC pilots in M2/M7 fly through exactly the same physics as players, and the
bots exercise the real path.

**2026-11-19 — Position and velocity ship as `float32`, not quantised.**
`t.angle()` and `t.quantized()` would roughly halve the bytes, but quantisation
applies on the schema field while the client's predicted mirror is a plain
float, so introducing it without measuring risks a systematic prediction
mismatch. Deferred to M1, where bandwidth can be measured and the dev panel can
confirm prediction behaviour.

**2026-11-19 — Drift tolerance of 2 units/s, with a 50-unit snap.** The
reconciler mirrors every scalar field, so corrections are measured across
velocity too, where values run to a few hundred. 2 units/s is 0.6% of top speed
(~0.07 units of position error per step — invisible), while a real determinism
break grows without bound and crosses it immediately. `snap` absorbs
spawn-scale jumps so they are excluded from the telemetry rather than reading as
divergence.

**2026-11-19 — `@colyseus/database` for persistence.** It is Drizzle underneath
(which the spec requires), handles migrations, supports SQLite, extends with our
own tables through its table factory, and unlocks `@colyseus/admin` for M8's
admin page plus `db.configs` for the spec's hot-reloadable tuning data. The cost
is a `drizzle-orm@rc` pin, logged as a risk.

**2026-11-19 — `noUncheckedIndexedAccess` on, `exactOptionalPropertyTypes`
off.** The first catches real undefined bugs in the grid and array code this
game is full of. The second mostly generates noise against third-party option
objects.

**2026-11-19 — Setting replaced: the game is Marque.** The owner supplied a
revised spec whose section 19 fixes the setting, companies, vocabulary, voice,
palette and typefaces. The architecture was unaffected — the netcode, the
shared flight step, the bot, the harness and CI all carried over unchanged —
so the change was confined to naming, palette, type and copy. Packages renamed
`@manifest/*` to `@marque/*`.

**2026-11-19 — Two palette values lightened for AA, hues held.** The spec fixes
the hues and says to adjust lightness for contrast. `--text-muted` `#5C6777`
reached only 2.95:1 on a raised panel and `--danger` `#E5484D` only 4.33:1,
both failing AA for text. Raised to `#788597` and `#E64F54`: 4.51:1 and 4.52:1
on raised, with hue held to within 1° and saturation unchanged. Every other
specified value passes as given. Livery cobalt (3.58:1) is never used for type.

**2026-11-19 — EB Garamond is loaded only where documents render.** The third
face is reserved for in-world paper, so it is not imported in the client entry
point alongside the two Plex faces. Seeing a serif should mean you are reading
something an institution issued, and the bytes should not be spent before one
is on screen.

**2026-11-19 — The stamp is specified before it is built.** Confirming a
purchase, build, trade or commission is the game's signature interaction, so
its four-phase sequence, timings and reduced-motion behaviour are written into
`docs/ART_DIRECTION.md` now rather than being improvised at M4. It is the one
interaction the spec singles out for the most care.

**2026-11-19 — Tool CLIs strip the forwarded `--`.** `pnpm run x -- --flag`
forwards the bare separator into `process.argv`, and Node's `parseArgs` reads
it as end-of-options and then rejects the real flags as positionals. All four
tool CLIs filter it out.

**2026-11-19 — Metrics sources expose counts as functions.** The metrics
registry holds `() => number` rather than numbers, so `/metrics` reports each
room as it is now instead of as it was when it registered, and the room needs
no `this` alias.
