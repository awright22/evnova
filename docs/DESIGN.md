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

**2026-11-20 — The shared step rounds to float32 after each sub-step.** The
synchronised state carries position, velocity and angle as `float32`, while a
client's predicted mirror is an ordinary float64 object. Integrating at two
precisions drifts systematically — slowly at low speed, faster near top speed
where the thrust taper is steepest. `Math.fround` on the six body fields puts
both sides and the wire on one grid, for six calls per sub-step.

**2026-11-20 — Drift telemetry is only meaningful when the frame loop is fed.**
Two browser clients on a software rasteriser both reported `diverging` with a
correction EMA around 7, while a single client on the same machine reported
`matched` at 0.0000 and the derived profiles were identical to the server's.
The cause was neither simulation nor network: at two frames a second the
reconciler's corrections are large because the client barely runs. `pnpm
verify` therefore runs at 640x360, and any drift reading taken under a starved
loop is to be distrusted.

**2026-11-20 — World scale: one cell is 6 units, drawn at 3 pixels per unit.**
A six-cell shuttle is 36 units and reads as about 110px, and a hull at top
speed crosses a 1080p screen in just under three seconds. The star and port
radii in the system data are visual sizes rather than astronomy: a top-down
view draws them at a fixed scale, so a true-scale star would be wider than the
screen at any distance.

**2026-11-20 — Blueprints render once to a texture, anchored at the centre of
mass.** Every hull flying a draught shares one texture. The anchor is the
centre of mass because that is the point the simulation tracks and the hull
rotates about, so the sprite and the physics agree without a per-frame offset.

**2026-11-20 — World objects are culled against the view.** The star's corona
is larger than the viewport, and submitting it off screen cost more fill than
the rest of the scene together. The same list will carry asteroids and wrecks
later, so the cull is a property of the scene rather than a special case for
the star.

**2026-11-20 — `pnpm verify` is a separate tool from `pnpm shots`.** Captures
are for judging look; verification drives the real client to prove behaviour.
They need the same stack but answer different questions, and later milestones
add checks here — the scripted new-player build in M5, onboarding in M9.

**2026-11-20 — Audio is synthesised, not sampled.** Openly licensed audio
sources are unreachable from this environment, and the spec's stated fallback
is Web Audio synthesis. The engine is filtered brown noise plus a low
oscillator, with brightness and level following throttle over 80ms. The bus
structure (master, music, effects, interface) is in place so the M9 mix has
somewhere to land.

**2026-11-20 — Rounds are synchronised as a birth, not a path.** A gun round
travels a straight line from a known position at a known time, so its entry is
written once and clients reckon it forward. Three hundred rounds in flight cost
three hundred adds and three hundred removes rather than a stream of positions.
Missiles steer, so their entry is refreshed every four ticks, which is the only
place the wire carries a round's path.

**2026-11-20 — No lag compensation for travelling rounds.** `allowRewindState`
is for hitscan: rewinding a round that takes a second to arrive would be wrong,
because both sides can see it in flight. Travel time is the game — it is why
the lead indicator exists. Rewind arrives with beam weapons in M8, where it is
the right tool.

**2026-11-20 — The grid is the hitbox, and the sweep is a segment.** A round is
walked through the hull's local cell space at half-cell steps and resolves to
the module it struck. A point test at the end position tunnels straight through
a one-cell module at any plausible round speed, which a test now holds against.

**2026-11-20 — Unknown message types and failed validation must not
disconnect.** Colyseus disconnects with close code 4002 for both, by design. A
version skew or a stray message would then read to a player as a mysterious
drop. A `'*'` fallback handler counts and ignores unknown types, intents are
sent as requests so a refusal settles the promise with a typed reason, and
`onUncaughtException` keeps a handler bug from taking the process down.

**2026-11-20 — The intent channel is rate limited per connection.** The spec
asks for it, and the fallback handler makes it necessary: without a budget,
unknown messages would be a free way to make the server write logs.

**2026-11-20 — Gun rounds fire at 520 units a second, not 900.** At 900 a round
crossed the whole view between frames on a loaded machine: rounds were real but
unreadable, and leading a target meant nothing. Slower rounds are visible, and
the lead indicator earns its place.

**2026-11-20 — NPCs produce a flight command and two fire bits.** An Unlettered
pilot's output is the same shape a keyboard produces, so the simulation cannot
tell them apart and anything true of a captain's hull is true of theirs.

**2026-11-20 — Effects are pooled into two Graphics objects.** The budget is
three thousand particles; a container with three thousand children costs more in
transform maths than the drawing does. A fixed pool also bounds a long fight:
when it is exhausted the effect is dropped rather than the pool grown.

**2026-11-19 — Rooms are matched on `systemId`, and the client asks where it
is.** `joinOrCreate` matches by room name alone, so a captain bound for Parity
could be put into whichever room happened to be open, and persisting a captain
writes the room's system back to their row: the mismatch did not stay a
mismatch, it moved them. The matchmaker filters on the system, the client
looks up the captain's own row over HTTP before joining because only the
server can read it, and the room refuses a captain whose row names a different
system so no client can cause the move by leaving an option out.

**2026-11-19 — `onAuth` returns `true` for a client with no account.**
Colyseus reads `undefined`, `null` and `false` alike as a refusal, so
returning `undefined` for an anonymous tool silently failed every such join.
`true` is the "allowed, carrying nothing" answer, and `onJoin` reads that
marker rather than a cast.

**2026-11-19 — Reconciliation covers the six fields the shared step owns.**
The reconciler mirrors every scalar field of the schema by default, which
pulled in shield: the server regenerates it from the time since the last hit
and the hull's power state, neither of which the client simulates, so every
fight produced corrections the client could not have predicted. Shield,
module damage and the rest arrive as plain state.

**2026-11-19 — The global chat channel goes through Colyseus presence.** It
reaches every room in the process today and every process behind Redis
presence without a code change, which is the one thing a bespoke in-process
fan-out would have cost later. The system channel is a room broadcast.

**2026-11-19 — The opening kit is derived, not written down.** A new captain's
Propellant and shields come from the starting draught's own capacity rather
than from constants, because the two had already drifted: the grant was 60
into tanks that hold 30, and shields opened at nothing. Content load fails if
the starting draught or system is not real.

**2026-11-19 — Raider and patrol counts come from the system's security
level.** They were a literal 2 per room, so the Unlettered hunted the Home
Roads, where the lore says patrols answer. A tool can still ask for a set
number.

**2026-11-19 — The esbuild bundle externalises only third-party
dependencies.** `packages: 'external'` externalised the workspace package too,
so the production bundle imported `@marque/shared` as TypeScript from
`node_modules` and died on boot — it had never been run. The external list is
read from the manifest, so a new dependency cannot silently break it.

**2026-11-19 — The daily snapshot writes to a temporary name and renames.**
`VACUUM INTO` refuses to write over an existing file and the day already taken
was only held in memory, so a server restarted later the same day failed every
time and left that day's backup frozen at whatever the first boot held.

**2026-11-19 — Harnesses start a process group and signal the group.** Every
one started the server through `pnpm exec`, which makes the server a
grandchild: signalling the child left it listening, the next run's health
check found the orphan with its old database, and every assertion then ran
against the wrong process. The handling lives in `tools/harness`, used by all
four, and the persistence check refuses to start when something is already on
its port.

**2026-11-19 — The flush interval is 2 seconds and is reported on
`/health`.** It is exactly how much of a captain's position a hard kill can
cost, so the persistence check computes its bound from the running server's
own figure and the draught's top speed rather than from a number written out
separately, which had drifted past what the server actually guaranteed.

**2026-11-19 — `?harness=1` publishes the room on `window`.** A capture that
cannot read bearings cannot fly, and a screenshot of a staged state is not
evidence of anything. The flag is inert without it and grants nothing the
server would honour, since the server is authoritative.

**2026-11-19 — NPCs ask for the nearest candidate, not a list of them.**
Building and filtering an array of candidates for every NPC on every tick was
the server's largest source of short-lived garbage, and the collection that
eventually followed showed up as a single 54.8 ms tick against a 0.65 ms p99
— which the spec counts as a bug. The room now walks the ships once and keeps
the best, allocating nothing. Worst tick fell to 5.1 ms and the mean tick by
about a quarter.


**2026-11-20 — An order is priced by walking it a unit at a time.** A closed
form would be faster and would make invariant 2 an argument; summing the
ladder makes it true by construction, because splitting an order is literally
what the integration does. At the order sizes a hold can carry, the loop is
not worth optimising away.

**2026-11-20 — A berth's target stock, capacity and drift all follow from one
pair of rates.** What it makes and what it eats, in units an hour, are the
only numbers authored per berth; everything else is derived. Authoring four
numbers per commodity per berth would have been 1,280 figures nobody could
keep coherent.

**2026-11-20 — Freight is the floor under the economy, not its market
maker.** Holding every berth within a few per cent of target left a captain
nothing to carry, so freight only acts on an imbalance past a quarter and
moves slowly. The band it leaves open is the trade.

**2026-11-20 — Berths hold five days of throughput.** At eighteen hours a
berth emptied between freight runs and spent its life at the price ceiling,
which is not a market. The time constant has to be long enough that a
captain's hold is a nudge rather than a shock.

**2026-11-20 — The spread is six per cent and the landing fee twenty-five
marks.** At twelve and sixty, the costs of a leg exceeded the entire margin
on the starting draught's twenty-unit hold: the only possible trade was a
losing one, whatever route was flown. The soak measured it. Both numbers
scale against a hold rather than a purse, so the shipyard's larger holds are
what make trading properly profitable.

**2026-11-20 — The soak measures net worth, not marks.** A captain halfway
through a voyage is holding cargo they paid for; counting only the purse
called every trading bot a loss-maker for being mid-run, and turned a +89 a
captain into a -553.

**2026-11-20 — The economy runs on a scalable clock.** `ECONOMY_TIME_SCALE`
is 1 in production and high in the soak, scaling elapsed time rather than the
tick rate, so the world moves the same distance however often the timer
fires. Without it a soak proves only that a brand-new world sits at its
targets, which it does by construction.

**2026-11-20 — A push message may not share a name with a request.** They are
one name space, so a push called `staple` was delivered as the answer to the
`staple` request and the real answer never arrived. The push is `market`.

**2026-11-20 — One resolver decides what a captain flies.** The `ships` row
with nowhere parked beats the draught named on the captain's row. Before this,
`spawnHull` only knew content blueprints, so a built hull was stored and never
flown. Everything — the simulation, the purse, the Yard — goes through
`hullFor`, so the three cannot disagree.

**2026-11-20 — A built hull's grid travels as a share code.** Spec section 7
asks for export and import, so the encoding had to exist; using it for state
as well means one tested, deterministic format rather than a second nested
schema for module grids. The field never changes over a hull's life, so it
costs its bytes once on arrival. The client's `HullBook` reads like the
catalogue and learns a built hull the first time it sees one, which left every
existing lookup site unchanged.

**2026-11-20 — Share codes carry a dictionary, not catalogue indices.**
Placements refer to modules through ids carried in the code itself, so adding
a fitting to `modules.json` or reordering the file cannot silently turn one
captain's gun into another's cargo bay. Base64url and UTF-8 are hand-rolled
because this runs in both runtimes and they disagree about `btoa`, `Buffer`
and `atob`. A CRC-16 catches a mistyped paste.

**2026-11-20 — Yards stock by maker as well as by tier.** Spec section 7 asks
that higher tiers be sold only at certain ports; section 19 already gives the
three companies monopolies, so the gate follows from the setting rather than
being invented beside it. One rule, `stocksModule`, is read by the editor to
decide what to offer and by the Yard to decide what to fit, so the palette
cannot show something the counter will refuse.

**2026-11-20 — Turrets traverse.** `weapon.tracking` was declared in the
schema and read nowhere: `aimOf` snapped a turret to its mark in the same tick
it was given one. Rather than delete a stat spec section 8 describes, each
mount holds a bearing relative to the hull and comes round at its own rate,
whether or not the trigger is down. A mount with no traverse rate stays
instant, which is what every turret did before.

**2026-11-20 — `placeAll` throws; client messages must not.** Throwing on an
unknown module id is right for a programming error and wrong for a message
from a client, where it escaped the intent handler instead of refusing. Every
path that takes placements from a client checks them against the Register
first and refuses with `unknown-fitting`.

**2026-11-20 — The editor quotes on the basis the build will use.** It
credited the fittings on the hull being flown, but the starter draught is not
owned, so the server charged for a new hull outright — 29,680 marks against a
quoted 1,008. The quote and the build now read the same `flyingId`.

**2026-11-20 — Hit-testing goes through the SVG's own transform.** The grid
keeps its aspect and is centred in its column, so dividing the viewBox by the
bounding box was wrong by the letterbox whenever the two aspects differed.
`getScreenCTM` is the transform the browser drew with.

**2026-11-20 — Earnings are measured, not guessed.** Twice I valued the ten
companies from figures I estimated, and twice every listing decayed to its
floor within minutes: the first set was three orders of magnitude too small
and took a pool down to ten shares, where integer rounding froze the quote;
the second was forty times too large. The third set comes from a soak run
with the going-concern floor removed, which reports what the world actually
pays each company in a market tick. Floats follow from the earnings and a
target price, and are wide enough that a pool holds thousands of shares —
a pool of a few hundred cannot express a price move at all.

**2026-11-20 — Invariant 6 is a property of the tuning.** A captain who lifts
a company's earnings by a mark gains `holdingCap * smoothing * multiple` on
their own holding, whatever the float. Below one, self-dealing cannot pay
however it is attempted. The content loader computes it at startup and
refuses to boot above one, so the world cannot be tuned into a state where it
cannot hold its own invariant.

**2026-11-20 — The leaderboard is worked out on a cadence.** It walks every
captain on the books and re-derives the build cost of every hull they own.
Doing that on the room's tick path, every time the market moved, took the p99
over the 4ms budget in spec section 3. It is a board, so a few seconds stale
costs nothing.

**2026-11-20 — Stylesheets are global; block names are a shared namespace.**
The Bourse's chart called itself `chart` and took the galaxy map's overlay
rules. Named on the avoid list in `docs/ART_DIRECTION.md`.

**2026-11-20 — A chain ends at its charter's seat.** The three chains' last
beats deliver to neutral systems, so gating the ending on "a berth this
charter owns" meant the choice could be made anywhere except where the chain
had just finished. The seat — the berth that issues the company's letters —
is the one address where a captain makes a declaration in person.

**2026-11-20 — The Prize Money chain reads correctly as written.** The
evidence has two halves: the capture was of a Kessler subsidiary flying false
papers, and the letter was served after it. Both are true, so a captain who
perjures is not inventing a defence, only moving a date — which is why
Reprisal pays for it and why it is worth a captain's while.

**2026-11-20 — Screens that need a history get a seeded captain.** A capture
of a brand-new account can only ever photograph empty screens. The shot
harness writes captains before the server opens the database — standing, a
berth to be alongside, a chain already run — using the server's own services
in a process with the server's own environment, and puts their device token
in the page's storage. No seam in the shipped server, and the seeded world
is one the real code would have produced.

**2026-11-20 — Fleets are convoys.** Spec section 12 calls them fleets in the
plain terms; the player reads "convoy", which is what ships travelling
together for mutual protection are called in a setting where every loss is
somebody's insurance claim. Not a new institution and not a new proper noun:
spec section 19 is fixed, and this is a common noun in the register it
already uses.

**2026-11-20 — A shared commission is still one commission.** Any member of
the convoy may discharge it, it pays once, to whoever does, and the standing
moves for the captain who took it on — the house dealt with them and does not
know a convoy was involved. Copying it per member, which is the obvious
reading of "share a mission", multiplies the Factor's faucet by the size of
the convoy for the same work; a convoy of six would find that within an
afternoon.

**2026-11-20 — A trade offer is one-sided with a price.** "This cargo and
this draught, for these marks", negative to pay them instead. A swap is two
offers. The two-sided version needs both captains to lock a basket and then
both to confirm it, which is a great deal of screen and a great deal of
"somebody changed their half" for a case the common uses — paying for a hold
of Alloy, handing over a draught, settling a debt — do not need.

**2026-11-20 — A transfer is a third kind of ledger category.** Marks moving
between captains create and destroy nothing. Counting a transfer as a faucet
on one side and a sink on the other leaves invariant 4 true and makes the
admin page's totals meaningless: a convoy passing the same ten thousand marks
back and forth all afternoon would read as a tap running.

**2026-11-20 — A captain's hold capacity comes from the hull they fly.** It
was read straight off the blueprint table, which knows nothing about hulls
built in the Yard: a captain in one they built had the capacity of whatever
they flew last, or none at all. Every reader of a captain's hull now goes
through the same resolver the simulation does.
