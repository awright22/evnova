# Progress

Milestone checklist and current state. Scope lives in `docs/SPEC.md`; this file
tracks what is done. Update it in the same commit that completes an item.

**Current milestone: M3 — World**

Legend: `[ ]` open · `[x]` done · `[~]` in progress

---

## M0. Foundations — complete

- [x] Monorepo, commands, and CI that runs check and build on every push
- [x] `docs/DESIGN.md` with architecture, data model, message protocol and a risk list
- [x] `docs/ART_DIRECTION.md`
- [x] `docs/LORE.md`
- [x] A networking spike, after reading the Colyseus docs: two bot clients moving a predicted entity in one room
- [x] Skeletons of the bot client and the screenshot harness

Done when:
- [x] A clean clone runs every command green
- [x] The spike stays smooth under 150 ms of simulated latency

## M1. Flight — complete, with one item unverifiable here

- [x] Blueprint format, stat derivation and procedural ship rendering, with the starter ship and two contrasting designs
- [x] One system with a star, two ports, the full space backdrop and the camera
- [x] Predicted local flight and interpolated remote ships
- [x] Engine effects and audio
- [x] A first HUD with speed, heading and radar

Done when:
- [x] Two browser clients fly together within the network-feel targets
- [x] The two contrasting designs handle noticeably differently
- [x] The flight view matches the art direction in captures
- [~] The performance scene holds 60 fps with bot ships — **cannot be measured
  on this machine, which has no GPU.** See the M1 report and
  `docs/HUMAN_TODO.md`.

## M2. Combat — complete

- [x] Guns, turrets and missiles
- [x] Shields, module damage, brownout, destruction, debris and canisters
- [x] Targeting interface
- [x] Unlettered AI
- [x] Death, insurance and respawn
- [x] All combat effects and audio from the feedback table

Done when:
- [x] A client sending forged positions, hits or stats has no effect on outcomes
- [x] A six-ship fight holds the tick budget (client frame rate still needs a GPU)
- [x] Where armour, reactors and engines are placed measurably changes fight outcomes between otherwise equal designs

## M3. World

- [ ] Galaxy data and map
- [ ] Hyperjump
- [ ] Landing and launch, the port hub
- [ ] Accounts, invite code, recovery
- [ ] Persistence, reconnect, disconnect rules
- [ ] Chat
- [ ] Security levels, patrols and posted status
- [ ] Deployment: the Pages workflow, Dockerfile and host config, with owner steps in `docs/HUMAN_TODO.md`

Done when:
- [ ] Killing the server process mid-session and restarting it loses at most a few seconds of position and no marks or cargo
- [ ] A jump between rooms shows no state pop
- [ ] A new account goes from the title screen to flying in under a minute

## M4. Economy

- [ ] Stockpiles, pricing, the Staple screen
- [ ] Propellant, landing fees
- [ ] NPC freight
- [ ] The ledger
- [ ] Invariants 1, 2, 4 and 5 with tests
- [ ] A first soak run with trading bots

Done when:
- [ ] The soak report shows stable prices and bounded credit growth with trading bots
- [ ] A bot that hammers one route sees its margin decay, and a rested route recovers

## M5. Shipyard

- [ ] The Loft: editor, drag, rotate, mirror, undo, copy and paste
- [ ] Validation shown on the grid where problems occur
- [ ] Bills of materials, building and refitting
- [ ] Hull licences and tech tiers
- [ ] Draught sharing as a share code
- [ ] The Moorings

Done when:
- [ ] A scripted new-player session designs, affords and builds a valid ship using only what the interface shows
- [ ] A draught exported by one account builds identically on another
- [ ] Invalid or unaffordable builds sent straight to the server are rejected

## M6. Exchange

- [ ] The ten listed companies, earnings, fair value
- [ ] Pools, the house trader
- [ ] Dividends, holding caps
- [ ] Bourse screens, the Gazette, the Register
- [ ] Invariants 3 and 6 with tests
- [ ] A soak run with investor and exploit bots

Done when:
- [ ] Destroying freighters in a producer's system lowers that producer's price within a few market ticks and a headline explains it
- [ ] A large module purchase lifts its manufacturer
- [ ] No exploit bot ends the soak ahead of the honest trading bots

## M7. Living world

- [ ] Company standing
- [ ] Letters of marque and monopoly goods
- [ ] Freighters with real cargo
- [ ] Patrol and Unlettered behaviour by security level
- [ ] Commission templates and the three chains
- [ ] Fleets and shared commissions
- [ ] Player-to-player trade

Done when:
- [ ] A solo player has something worth doing in every system
- [ ] Every commission template completes end to end under bots
- [ ] Standing changes produce visible consequences at ports

## M8. Depth

- [ ] Production chains: refined and manufactured output scales with input stock
- [ ] Asteroid mining with a mining module
- [ ] Beam weapons and point defense
- [ ] Boarding disabled ships for cargo
- [ ] Limit orders, and short selling with margin and liquidation, without breaking any invariant
- [ ] A test range where a draught can be flown and fought before buying it
- [ ] The admin page

Done when:
- [ ] Each addition meets the quality bar
- [ ] The soak run stays within its bands with all of them enabled

## M9. Shell and onboarding

- [ ] Title, menus, settings, credits
- [ ] Onboarding, contextual hints
- [ ] Gamepad, accessibility options
- [ ] The final audio mix and music
- [ ] A performance pass against every budget in section 3

Done when:
- [ ] A scripted new-player session completes onboarding without getting stuck
- [ ] Every settings option demonstrably works
- [ ] All budgets pass

## M10. Polish cycles

- [ ] Cycle 1: `docs/polish/cycle-1.md`, every blocker and major fixed
- [ ] Cycle 2: `docs/polish/cycle-2.md`, every blocker and major fixed
- [ ] Cycle 3: `docs/polish/cycle-3.md`, every blocker and major fixed
- [ ] Two cycles in a row find no blockers or majors
- [ ] Final report

---

# Reports

## M0. Foundations — 2026-11-19

### What is now playable

Nothing yet: M0 is the foundation, and the first thing you can fly is M1. What
exists is the machinery everything else is built on, and it is all verifiable
from the command line.

A ship already flies correctly — it just has no renderer. `stepFlight` is the
one physics step both the server's fixed loop and the client's reconciler call.
Flight is inertial with no drag; thrust tapers on the velocity component along
the ship's facing, so there is no hard speed clamp and a retrograde burn keeps
full authority; the brake turns the ship retrograde and burns to a stop.

### How to run it

```bash
pnpm install
pnpm check
```

To see two clients fly against a live server under the latency the spec
targets, in two terminals:

```bash
COLYSEUS_LATENCY=150 pnpm --filter @marque/server dev
```

```bash
pnpm bot --bots 4 --seconds 25 --brain wander
```

Other commands, all green from a clean clone:

| Command | What it does |
|---|---|
| `pnpm dev` | Server and client with hot reload |
| `pnpm check` | Typecheck, lint, unit tests |
| `pnpm test` | 22 unit and invariant tests |
| `pnpm sim` | Soak run against a live server, report to `artifacts/soak/` |
| `pnpm shots` | Builds, serves, captures every screen to `artifacts/shots/` |
| `pnpm perf` | Simulation step percentiles, report to `artifacts/perf/` |
| `pnpm build` | Static client and a standalone server bundle |

### Measurements

The spike's done-when criterion is "smooth under 150 ms of simulated latency".
Measured with four clients against a server started with
`COLYSEUS_LATENCY=150`, using the SDK's own reconcile-drift telemetry and its
own `classifyDrift`, so the verdict cannot disagree with the dev panel:

| Measure | Result |
|---|---|
| Prediction status, every client | `matched` |
| Drift EMA / peak | `0.0000` / `0.0000` |
| Measured round trip | 188–210 ms |
| Inputs in flight | 6 — exactly what 200 ms at 30 inputs/s predicts |

Soak, 10 bots for a minute at 150 ms: worst p99 server tick **0.27 ms** against
a 4 ms budget, no tick over 33 ms, no client diverged.

Simulation cost, 30 ships: **0.26 µs per ship**, p99 **0.16%** of a 60 fps
frame. The simulation has room; rendering will be the constraint.

Client transfer: ~220 kB (124 kB of JavaScript gzipped, 2.5 kB CSS, ~95 kB of
Latin-subset fonts) against a 5 MB budget.

### Known issues

- **The boot screen is a centred card in a void.** It has no backdrop, because
  the star layers and nebula are M1 work. It is named in the avoid list in
  `docs/ART_DIRECTION.md` and gets fixed when the backdrop lands.
- **Only two screens exist to capture.** `pnpm shots` captures the boot screen
  linked and unreachable. It grows with each milestone.
- **Position and velocity ship as `float32`, not quantised.** `t.angle()` and
  `t.quantized()` would roughly halve the bytes, but quantisation interacts with
  the client's predicted mirror in a way that needs measuring first. Deferred to
  M1 where bandwidth can actually be measured.
- **Bandwidth per client is not yet in the soak report.** There is no realistic
  patch payload until the flight view exists. The report lists it as not yet
  measured rather than omitting it.
- **TypeScript is pinned to 6.0.3, not 7.** `typescript-eslint` does not support
  TypeScript 7 yet, and the type-aware lint rules are worth more over a long
  build than the newest compiler. Logged as a risk in `docs/DESIGN.md`.

### Note on the direction change

The setting was replaced partway through M0: the game is **Marque**, and spec
section 19 now fixes the setting, companies, vocabulary, voice, palette and
typefaces. The architecture was unaffected — netcode, the shared flight step,
the bot, the harness and CI all carried over unchanged — so the change was
confined to naming, palette, type and copy. Two palette values were lightened
to pass AA with their hues held; both are logged in `docs/DESIGN.md` and
`docs/HUMAN_TODO.md`.

## M1. Flight — 2026-11-20

### What is now playable

You can fly. Open the client and you are a free captain in Parity, in the Home
Roads, holding station off the Bourse with the system's other traffic on the
scope. Arrows or WASD: thrust, turn, and a brake that swings the hull
retrograde and burns off your velocity. Flight is inertial, so turning does not
change where you are going until you burn.

Three draughts exist and fly differently, built from the same parts catalogue:

| Draught | Accel | Top speed | Turn rate | Hold |
|---|---:|---:|---:|---:|
| Prudent Return (starter) | 129 | 245 | 2.63 | 20 |
| Force Majeure | 218 | 319 | 3.43 | 0 |
| Fair Wear and Tear | 107 | 224 | 0.94 | 100 |

Loaded, the hauler drops to 33 accel, 125 top speed and 0.60 turn: carried
cargo rides in the bays that hold it, so a full hold raises rotational inertia
as well as mass.

### How to run it

```bash
pnpm install
pnpm dev
```

Then open <http://127.0.0.1:5173>. To fly one of the other designs, add
`?draught=force-majeure` or `?draught=fair-wear-and-tear`.

For traffic to fly against, in another terminal:

```bash
pnpm bot --bots 4 --seconds 300 --brain wander
```

| Command | What it does |
|---|---|
| `pnpm verify` | Flies two real browser clients and holds them to the network-feel targets |
| `pnpm shots` | Captures six screens to `artifacts/shots/` |
| `pnpm sim` | Soak run, report to `artifacts/soak/` |
| `pnpm perf` | Simulation and browser frame-time percentiles |

### Measurements

**Two browser clients, 150 ms simulated latency** (`pnpm verify`): both read
`matched` with a reconcile-correction EMA of `0.0000`, each saw the other hull
move, no console errors.

**Soak, ten bots across all three draughts, 150 ms** (`pnpm sim`): worst p99
server tick **0.33 ms** against a 4 ms budget, no tick over 33 ms, no client
diverged.

**Simulation cost**: 0.29 µs per ship, p99 0.12% of a 60 fps frame.

**Client transfer**: ~420 kB (259 kB of JavaScript gzipped, Pixi included).

### Known issues

- **Frame rate on real hardware is unverified.** This container has no GPU, so
  Chromium falls back to software rasterisation and reports ~5 fps at 1080p,
  which says nothing about the spec's budget. Exact steps for you are in
  `docs/HUMAN_TODO.md`. It is the only M1 criterion I cannot close.
- **The HUD's link readout is noisy in captures.** Under software rendering the
  client's loop runs at a few frames a second, which inflates measured round
  trip and occasionally blanks the readout. It reads correctly at ~300 ms when
  the loop is fed.
- **Remote hulls infer their throttle from speed.** Throttle is not
  synchronised, so a remote plume is an approximation. Putting a field on the
  wire for every ship every tick is not worth an exactly right flame.
- **No landing, no map, no combat yet.** Ports render and sit on the scope but
  cannot be landed on; that is M3.
- **One system.** Parity only, with two ports. The other nineteen are M3.

### Two findings worth recording

Both are in `docs/DESIGN.md` in full.

The shared step now rounds to float32 after each sub-step. The server's state
is `float32` while a client's predicted mirror is float64, and integrating at
two precisions drifts systematically — worst near top speed, where the thrust
taper is steepest.

Drift telemetry only means something when the frame loop is fed. Two browser
clients on a software rasteriser both reported `diverging`, while a single
client on the same machine reported `matched` at 0.0000 with identical derived
profiles. The clients were not diverging; they were not running. `pnpm verify`
runs at 640x360 for that reason.

## M2. Combat — 2026-11-20

### What is now playable

You can fight. Space fires fixed guns and turrets, Shift fires missile racks,
and Tab cycles the mark. Unlettered raiders appear while captains are in the
system, close to weapons range, shoot, and run once badly hurt.

Shields take a hit first and pass through only what they could not absorb.
What gets through strikes a specific module, because the module grid is the
hitbox: a round is swept as a segment through the hull's cells and resolves to
whatever is in the way. A module at zero is disabled rather than removed — it
keeps its cells and blocks rounds, but its contribution is gone, so losing an
engine costs thrust and losing an outboard plate moves the balance point and
changes how the hull turns.

Losing reactors browns the hull out, starving weapons first, then shields,
then engines, so a hull that cannot shoot can still run. A hull is written off
when its bridge goes or its structure falls past a quarter, and it spills part
of its cargo as canisters anyone can scoop.

### How to run it

```bash
pnpm dev
```

Then open <http://127.0.0.1:5173>. Raiders arrive on their own. For more
company:

```bash
pnpm bot --bots 4 --seconds 300 --brain fighter
```

| Command | What it does |
|---|---|
| `pnpm verify:authority` | Misbehaves in every way the protocol allows and checks nothing changed |
| `pnpm sim -- --fight` | Soaks a fight and holds the tick to its budget |
| `pnpm shots` | Captures seven screens, including a fight |

### Measurements

**Server authority** (`pnpm verify:authority`), six checks, all holding. The
input sanitiser is exact: an `int8` turn axis arriving as `127` clamps to the
hull's own ceiling of 2.004 rad/s, and an out-of-range thrust axis cannot
drive the hull past its top speed. Messages claiming to set position, damage
or stats change nothing. Marking a hull that does not exist, marking its own
hull, and scooping something that is not there are each refused with a typed
reason.

**A six-ship fight** (`pnpm sim -- --bots 6 --minutes 1.5 --fight`): worst p99
server tick **1.18 ms** against a 4 ms budget, no tick over 33 ms, no client
diverged.

**Placement decides outcomes**: a test pours identical rounds in from dead
ahead at two hulls built from the same parts. The one plated at the nose
survives the burst that writes off the one plated at the tail.

### Known issues

- **Client frame rate is still unverified.** Unchanged from M1: this container
  has no GPU. The server side of the six-ship budget is measured and passes.
- **Turrets do not visually traverse.** They track and lead correctly in the
  simulation, and their rounds come out aimed, but the mount is drawn fixed.
- **A wreck vanishes after six seconds** rather than leaving a hulk. Salvage is
  parked in `docs/IDEAS.md`.
- **Ordnance is the only cargo that exists**, so it is the only thing a wreck
  spills. Real holds arrive with the Staple in M4.
- **Insurance is quoted, not paid.** The written-off panel states the claim the
  Hall settles, computed from the draught, but there is nowhere to pay it until
  accounts land in M3 and marks in M4.

### What writing the authority check found

Colyseus disconnects a client with close code 4002 both for a message type it
has no handler for and for a send whose payload fails validation. That is
reasonable as a default and wrong for this game: a version skew would read to a
captain as a mysterious drop rather than a designed state. Intents are now sent
as requests, so a refusal settles with one of the protocol's typed reasons; a
fallback handler absorbs unknown types; `onUncaughtException` keeps a handler
bug from taking the process down with everyone on it; and the intent channel is
rate limited per connection.
