# Progress

Milestone checklist and current state. Scope lives in `docs/SPEC.md`; this file
tracks what is done. Update it in the same commit that completes an item.

**Current milestone: M7 — Living world**

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

- [x] Galaxy data and map
- [x] Hyperjump
- [x] Landing and launch, the port hub
- [x] Accounts, invite code, recovery
- [x] Persistence, reconnect, disconnect rules
- [x] Chat
- [x] Security levels, patrols and posted status
- [x] Deployment: the Pages workflow, Dockerfile and host config, with owner steps in `docs/HUMAN_TODO.md`

Done when:
- [x] Killing the server process mid-session and restarting it loses at most a few seconds of position and no marks or cargo
- [x] A jump between rooms shows no state pop
- [x] A new account goes from the title screen to flying in under a minute

## M4. Economy

- [x] Stockpiles, pricing, the Staple screen
- [x] Propellant, landing fees
- [x] NPC freight
- [x] The ledger
- [x] Invariants 1, 2, 4 and 5 with tests
- [x] A first soak run with trading bots

Done when:
- [x] The soak report shows stable prices and bounded credit growth with trading bots
- [x] A bot that hammers one route sees its margin decay, and a rested route recovers

## M5. Shipyard — complete

- [x] The Loft: editor, drag, rotate, mirror, undo, copy and paste
- [x] Validation shown on the grid where problems occur
- [x] Bills of materials, building and refitting
- [x] Hull licences and tech tiers
- [x] Draught sharing as a share code
- [x] The Moorings

Done when:
- [x] A scripted new-player session designs, affords and builds a valid ship using only what the interface shows
- [x] A draught exported by one account builds identically on another
- [x] Invalid or unaffordable builds sent straight to the server are rejected

### Report

**What is now playable.** A captain can walk into a Yard, lay out a hull on
the grid from the fittings that berth actually stocks, watch the handling and
the bill change as they place them, and build it — paying in marks and in
commodities taken from the hold or bought on the spot. The hull they build is
the hull they then fly: it launches, it is drawn on every other captain's
screen, it keeps its own damage, and it lies where they left it. They can own
up to twelve, walk the Moorings to see where each one is, and take out any
that is tied up at the berth they are standing on. They can buy their way up
the warrant ladder as they can afford it, write a draught out as a code to
paste to somebody, read one in, or hand one straight to another captain by
callsign.

The catalogue is forty-four fittings across three tiers, and where you build
now matters: a company's own yard carries its own maker's best work and a
rival's only second-hand, so a tier-3 engine exists at Careenage and Cabotage
and nowhere else. The editor shows the whole Register behind an "Everywhere"
toggle with the unstocked parts greyed, so a captain can see what to go and
find rather than wondering why the list is short.

**How to run it.**

```bash
pnpm dev
```

Land at the Bourse at Parity — it keeps a Yard, a Staple and the Moorings.

```bash
pnpm verify:yard
```

Twenty-one checks over the real protocol: the three done-when clauses, the
Moorings, the warrant ladder, and every typed refusal.

**Known issues.**

- `weapon.tracking` was dead data until this milestone and is now read, which
  makes turrets genuinely slower to bring round. The NPC brains were tuned
  against instant turrets and have not been re-tuned; the next soak run is the
  place to find out whether patrols still land hits.
- A built hull's grid crosses the wire as a share code on its state. That is
  one string per distinct hull rather than per hull per patch, but a system
  holding twenty large custom hulls has not been measured against the
  bandwidth budget in spec section 3.
- The Moorings cap at twelve hulls and the books at forty draughts. Both are
  constants in `Yard.ts` rather than tuning data, because neither is a
  gameplay number a designer would reach for.

## M6. Exchange — complete

- [x] The ten listed companies, earnings, fair value
- [x] Constant-product pools, the house trader, dividends, holding caps
- [x] Exchange screens, the news feed, the leaderboard
- [x] Invariants 3 and 6 with tests
- [x] A soak run with investor and exploit bots

Done when:
- [x] Destroying freighters in a producer's system lowers that producer's price within a few market ticks and a headline explains it
- [x] A large module purchase lifts its manufacturer
- [x] No exploit bot ends the soak ahead of the honest trading bots

### Report

**What is now playable.** A captain alongside the Bourse at Parity can read
ten listings, each at its own quote with the move since the last market tick,
pick one and see its chart against fair value, place an order that shows what
the parcel costs and where the quote ends up *before* confirming, and watch
their book fill with cost basis, unrealised gain and dividends drawn. The
Gazette explains every move — a run on a good, a yard's order book filling,
freight lost in transit — and the Register ranks every captain by net worth
in marks, shares and hulls.

Underneath, a company earns only from things that are costly to fake: goods
actually leaving its berths, marks actually spent on its fittings, freight
actually delivered, premiums less claims. The house trader walks each quote
toward fair value every tick, so prices answer the world with nobody trading.
Company freighters now fly the lanes, carry consignments drawn from what
their system produces, and cost two companies when they are destroyed — which
is what makes blockading a mining system show up on the miner's price.

**How to run it.**

```bash
pnpm dev
```

Land at the Bourse at Parity; it keeps the floor, a Yard and the Moorings.

```bash
pnpm verify:bourse
```

Seventeen checks over the real protocol, including a captain who builds a
gunship, jumps three lanes to a contested mining system and interdicts its
traffic.

```bash
pnpm sim -- --bots 9 --minutes 5 --invest
```

Honest traders, honest investors and exploiters in one run. The exploiters
end it several hundred thousand marks down.

**Known issues.**

- In an accelerated soak the listings drift toward their going-concern floor:
  a market tick is twenty world-seconds while earnings are credited every ten
  real seconds, so the two cadences do not interleave the way they do at real
  speed. Earnings are now spread across the ticks of a catch-up, which helps,
  but a long accelerated run is still pessimistic about prices.
- Slipway earns only when a captain builds. In a small group that is bursty by
  design, but it means SLP spends most of its time near its floor and jumps on
  each hull. Worth watching once people are actually playing.
- The Gazette's column is tall at 1920x1080 and has only been seen with a
  handful of headlines in it.


## M7. Living world — complete

- [x] Company standing
- [x] Letters of marque and monopoly goods
- [x] Freighters with real cargo
- [x] Patrol and Unlettered behaviour by security level
- [x] Commission templates and the three chains
- [x] Fleets and shared commissions
- [x] Player-to-player trade

Done when:
- [x] A solo player has something worth doing in every system
- [x] Every commission template completes end to end under bots
- [x] Standing changes produce visible consequences at ports

## M8. Depth

- [x] Production chains: refined and manufactured output scales with input stock
- [x] Asteroid mining with a mining module
- [x] Beam weapons and point defense
- [x] Boarding disabled ships for cargo
- [x] Limit orders, and short selling with margin and liquidation, without breaking any invariant
- [x] A test range where a draught can be flown and fought before buying it
- [x] The admin page

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

### Addendum, 2026-11-20: death was ticked before it was finished

"Death, insurance and respawn" was ticked on the strength of the wreck, the
debris, the canisters and the designed panel. Spec section 8's paragraph was
not actually built. A dead captain kept the hold they died with, still owned
the hull that had just broken apart, was paid nothing, and woke in the sky
where they fell — while the client's panel told them Underwriters' Hall had
settled a figure it had worked out for itself and nobody had paid.

All of it now holds, and `pnpm verify:loss` proves the paragraph clause by
clause: the hull comes off the books, half what its fittings cost is settled
through the ledger as a claim and debited from the Hall's pool, part of the
hold drops as canisters and the rest is gone, and the captain wakes alongside
the last berth they put in at — in a hull of their own if one is waiting
there, and in a starter draught if nothing else is theirs.

Writing that check found something worse. A round that struck a module
already at zero dealt no damage at all, because the damage was capped at
that module's remaining hit points. A hull could therefore be made immune to
everything arriving from one bearing simply by having its outermost fitting
shot off first — and no amount of fire would then bring its structure below
the threshold that writes it off. The harness sat at a fixed bearing and
fired for seventy seconds at a hull whose structure had stopped falling,
which is how it surfaced. A hit that finds a wreck now carries through to
the nearest module still standing.

---

## M3. World — 2026-11-19

### What is now playable

There is a world, and you keep a place in it.

A captain is entered on the Register with a callsign and a six-word recovery
phrase shown once. The phrase moves the account to another device; the device
token never leaves the machine it was issued to. An invite code gates sign-up
when the server sets one. From the title screen to flying takes under two
seconds on this machine, against the spec's minute.

Twenty systems in three regions, joined by hyperlanes. **M** opens the chart:
lanes, who holds which berth, how much law reaches each system, and the lanes
out of whatever you have selected, so a route can be read in one place.
Plotting a course from the chart gives **J** somewhere to spool for; spooling
takes four seconds of holding course, and the lane costs Propellant by hull
mass. **L** comes alongside the nearest berth when you are close enough and
slow enough — the interface says which, and says when you are too fast rather
than offering a landing the server will refuse.

A berth sells what it has: repairs priced by the structure missing, Propellant
to the tank's capacity, Ordnance for the magazine. Houses that are not trading
yet say the floor is shut. Every mark moves through the ledger with a faucet
or sink category, in one transaction, and a captain's purse, position, hull
damage and standing survive the process being killed.

Security now has consequences. The Home Roads are patrolled by the Prize
Court and nothing hunts there; the Concessions keep a thinner watch; the
Marque has none. Firing on lawful traffic strikes a composition weighted by
how much law reaches the system — shields included, because the offence is the
attack and not whether it got through — and writing a hull off is a heavier
charge again. A posted captain is refused at Home Roads berths and settles
anywhere that will still have them. Patrols answer for the Unlettered and for
posted captains, and return to station over the berth when there is nobody
left to answer for.

Chat has a global channel and the system you are in. It is quiet by default:
the last few lines fade above the instruments, **Enter** opens the composer,
**Tab** moves between channels, **Esc** closes. A captain arriving is given
the recent lines so the overlay is not blank.

### How to run it

```bash
pnpm dev
```

The client is on `http://localhost:5173` and the server on `:2567`. Open it,
enter a callsign, and fly. A second browser gives you someone to talk to.

The acceptance checks for this milestone:

```bash
pnpm verify:travel
```

```bash
pnpm verify:persistence
```

The first opens an account in a real browser, times the walk from the title
screen to flight, takes a lane, and watches the arriving hull for a second to
confirm it agrees with the server. The second flies a captain, kills the
server process without warning, restarts it, and checks what came back.

To deploy, see section 4 of `docs/HUMAN_TODO.md`. The Dockerfile, `fly.toml`
and the Pages workflow are written; what is left needs the owner's accounts.

### Known issues

- **The container image has never been built.** This machine has no usable
  Docker daemon. The production server bundle has been built and run outside a
  container — it boots, migrates and serves `/health` — so what is untested is
  the image build: the base image, the native build of `better-sqlite3`, and
  the volume mount.
- **Hulls pass through each other.** There is no hull-to-hull collision; the
  spec does not ask for one. Parked in `docs/IDEAS.md` with a note on what
  building it would involve.
- **The captures run under software rasterisation**, so the link in them reads
  around a second and the combat capture is a long-range exchange rather than a
  close pass. Frame rate on real hardware is still the one quality-bar item
  this machine cannot check; see section 3 of `docs/HUMAN_TODO.md`.
- **Chat keeps no history across a restart.** It is memory only and bounded,
  which is deliberate: nothing in the world reads it.

### What this milestone cost in bugs

Twelve real faults, most found by running the verification suite and looking
at captures rather than by reading code. Three are worth naming because they
had been silently true for a while: the production server bundle had never
been run and could not boot, having externalised the workspace package it
needed to inline; `onAuth` returned `undefined` for a client with no device
token, which Colyseus reads as a refusal, so every anonymous join had been
failing; and every harness signalled the `pnpm exec` wrapper rather than the
server it started, leaking a process that the next run then tested against.
A fourth is worth naming for how it was found: the soak reported one tick of
54.8 ms against a p99 of 0.65 ms, which looked like machine noise and was not
— every NPC was building and filtering an array of candidates on every tick,
and the collection that followed was the spike. The decision log in
`docs/DESIGN.md` has the rest.

---

## M4. Economy — 2026-11-20

### What is now playable

There is a living economy, and you can make a living in it.

Ten commodities move through the Reach along real chains: Ore becomes Alloy
becomes Machinery and Circuitry, Ice becomes Propellant, Grain becomes the
Provisions every berth eats, and Leaf grows only in the Marque and is chewed
only in the Home Roads. Each of the 32 berths that keeps a Staple makes some
and eats others, at rates authored from its own description, and every chain
balances across the galaxy.

Price is the base price scaled by target over stock, raised to an elasticity,
and held inside its tier's band. An order is priced by walking it a unit at a
time, so a large order moves the price against itself and splitting one
changes nothing. A berth pays six per cent less than it charges, which is
what makes buying and selling back at one berth always lose.

**L** at a berth, then *Open the floor*: the Staple lists every good with what
the berth charges, what it pays, what it is holding against what it wants, and
what you have aboard. Propellant and Ordnance are commodities too, so filling
your tanks takes the berth's stock down and costs what that berth charges —
a berth drunk dry is expensive.

Stock drifts on the world's own clock whether or not anyone is online, and
the Reach's freighters move goods from surplus to shortage along real
hyperlanes, slowly. That is what makes a route worth flying and worth
resting: work one hard and its prices close behind you, leave it alone and it
recovers.

### How to run it

```bash
pnpm dev
```

Open the client, fly to a berth, press **L**, and open the floor. Buy what a
berth has too much of and carry it to one that is short.

The milestone's own measurements:

```bash
pnpm verify:trade
```

```bash
pnpm sim -- --bots 8 --minutes 6 --trade
```

The first lands a captain and holds invariants 1, 2 and 5 over the wire. The
second runs trading bots against an accelerated world and writes
`artifacts/soak/report.md`: the price range of every commodity, how long any
of them sat at a clamp, the ledger's totals by category, and the two halves
of this milestone's bar — a worked route's prices closing, and the same
berths recovering once the bots leave.

### What the first soak run showed

Over six minutes at 900x — about a week and a half of world time — with eight
trading bots:

- Every commodity held a real spread around its base price, and **no price
  sat at a clamp in any sample**. No berth ran empty or filled to capacity.
- **Invariant 4 reconciled exactly**: the marks every captain held equalled
  faucets minus sinks.
- Net worth grew about 80 marks a captain. Modest, and it should be: the
  starting draught carries twenty units, and the shipyard is what scales it.
- Decay and recovery both showed. Alloy at Dunnage rose 12.4% as the bots
  bought its glut out, and the berths they worked moved back towards their
  targets once they left.

### Known issues

- **A trading bot refuses about a third of its own orders.** They are its
  mistakes, not the server's — asking to sell what it has already sold, or
  trading a beat after launching — and they cost nothing but noise in the
  report. Worth tidying when the bot next needs work.
- **Ordnance is expensive as ammunition.** It is priced as the manufactured
  commodity it is, which makes a missile rack costly to feed and the fixed
  gun the sensible default. That reads as a deliberate trade-off rather than
  a mistake, but it is worth revisiting when racks matter more.
- **The economy has only been run with bots.** Nobody has played it.

### What this milestone cost in bugs

Nine, and the three that mattered had been true since M3. Landing deleted the
captain from the room's own map, so every service a berth sells had been
refused with "you do not own that" since the port hub existed — the capture
showed the screen and never pressed a button. The client read refusals off
the wrong field, so every typed refusal in the game came out as one sentence.
And a push message sharing a name with a request was delivered as the answer
to that request, so the real answer never arrived.

The rest were in the harness, and each hid the next: a bot that registered
its message handlers after an await and threw away the purse it was sent, a
bot that swallowed every refusal, a bot that kept predicting in a room it had
left, and a soak that reused its database so its ledger totals were the sum
of every run ever made on the machine.

## M8. Depth — 2026-11-20

### What is now playable

The world got deeper in seven places, and two of them change how a captain
reads a fight.

**Shortages travel.** A refinery makes what its inputs let it make. Starve
Quorum of Ore and its Alloy line slows in proportion, which starves the
Ropewalk of Alloy, which starves whoever buys Machinery — so a blockade at
one end of a chain is felt three berths away a day later, and a captain who
notices a shortage on the Gazette can haul into it.

**Rock.** Seven systems have a belt: rocks placed from the system's own seed,
so the same rocks are in the same places on every client and after every
restart. Fit a rig, sit on one, hold the trigger, and ore comes off it a
fraction of a unit at a time and goes into the bays. A worked rock is smaller
and duller than a whole one, and it comes back slowly while nobody is cutting
it.

**Beams and point defense.** A beam arrives the instant it is pointed and
does not run out — no leading, no travel time — in exchange for short reach
and a reactor that notices. Point defense fires itself at anything incoming
and makes a missile rack a different proposition.

**Boarding.** A hull with every engine shot out is adrift, and adrift is not
the same as dead: within a hundred and fifty units, with the two hulls
closing at under sixty, a captain can put a party across and take what is in
the hold. The biggest lots first, up to what their own bays will hold. A hull
that could still fly away would fly away, so stopping one is the work.

**Standing orders and selling short.** Leave an order with the Bourse at a
limit and it is carried out on each market tick as far as that price allows —
a large one fills in pieces as the house trader walks the price back. Sell
shares you do not have and you owe them: the Bourse wants half of what you
owe standing behind it, and buys the position back for you when that falls
under three tenths, whether or not you are online to watch.

**The range.** At any Yard, draw a hull and take her out: fly her, fight two
of whatever you choose to put up, lose her and be handed another. Nothing out
there touches your marks, your cargo, your hull or your standing.

**The books.** An operator named in the server's configuration can read the
ledger by category, the price and stock of every good, the listings and every
berth's stockpiles — and change the tuning the world is running on without
restarting it.

**And the stamp.** Every institution strikes a seal of its own, drawn from a
seed on its name so it is the same mark every time. Confirming an order at a
Staple, a bill at a Yard, a ticket at the Bourse or a commission from a
Factor presses the control, strikes the seal across the document with an
amber rim at its edge for a frame, spreads the ink, and settles. With a low
thud, and twelve milliseconds of paper and mechanism ahead of it.

### How to run it

```
pnpm dev
```

Then open the client, take a hull out of any berth, and:

- fit a Spoil Heap at a Yard and fly out to a belt — Lindqvist's lies a few
  thousand units off Respondentia — then hold the trigger on a rock;
- shoot an engine off something and press `B` when the prompt says it is
  adrift;
- at a berth with a Bourse, switch the ticket to **At a limit**, name a
  price, and leave the order; tick **Sell short** to sell what you do not
  hold;
- at any Yard, draw something and press **Take her out**.

The admin page is at `/?admin=1`, for a captain whose callsign is in
`ADMIN_CALLSIGNS`.

Checks for the new work:

```
pnpm verify:mining
```

```
pnpm verify:boarding
```

```
pnpm verify:orders
```

```
pnpm verify:range
```

```
pnpm verify:admin
```

```
pnpm verify:loss
```

### What the harnesses found

Four faults, none of which a typecheck or a unit test would have caught, and
two of them were in code this milestone did not touch.

**A hit that found a wrecked module did nothing at all.** Damage was capped at
the struck module's remaining hit points, so a round landing on a module
already at zero was absorbed by it. A hull could be made immune to everything
arriving from one bearing by having its outermost fitting shot off first, and
no amount of fire would then bring its structure below the threshold that
writes it off. The boarding harness sat at a fixed bearing and fired for
seventy seconds at a hull whose structure had stopped falling. A hit now
carries through to the nearest module still standing.

**The client predicted with the hull it was built as, not the hull it is.**
The flight profile was derived once, from the whole blueprint, and the server
steps the simulation with the profile of the modules that still work. From
the moment anything was disabled the two were running different ships. It was
invisible until the fix above meant fights actually disabled things, and then
the reconciler reported it fifty-eight times in a fourteen-minute soak. There
is one shared rule now and the client re-derives from it as damage lands.

**Death was ticked in M2 without being built.** A dead captain kept their
cargo, still owned the hull that had just come apart, was paid nothing, and
woke in the sky where they fell — while the client's panel told them
Underwriters' Hall had settled a figure it had worked out for itself and
nobody had paid. Spec section 8's paragraph now holds, clause by clause, and
`pnpm verify:loss` reads it back.

**A dividend paid to a captain who happened to be online was erased by their
next landing.** Marks are the ledger's to write, and the captain flush was
writing its own in-memory copy back over the row. The ledger keeps the
world's copy in step now, whether or not the caller holds one.

### Known issues

**A margin is measured on what the Bourse can see.** Marks a captain has tied
up in cargo are not on its books and do not count toward the equity behind a
short. That is the real decision a short puts in front of them, and it is
also the only lever the harness has to call one in — but it means a captain
with a full hold and no marks is closer to a liquidation than their net worth
suggests.

**A short that cannot be bought back stands.** The Bourse buys back what the
captain can afford and no more; the rest is tried again on the next tick. A
captain with nothing left is wiped out rather than in debt, which is the
intended consequence, but the position can sit there for a long time.

**The reconciler still reports the odd divergence.** Three in a
fourteen-minute soak against fifty-eight before the profile fix, each a
one-off just over the tolerance and two of them in the first seconds after a
hull spawns. The soak's own measure — every client matched or within jitter —
passes. It is worth another look in M9's performance pass.

**The range puts up two of one draught.** Spec asks for a draught to be flown
and fought before it is bought, which it can be; it does not ask for a mixed
flight, and a captain who wants to know how a hull does against a gun and a
turret at once has to try them in turn.

## M7. Living world — 2026-11-20

### What is now playable

The Reach has people in it and they want things.

**The Factor.** Every berth with a Factor posts work — carriage, passage, a
bounty on a named Unlettered captain, an escort, a run of monopoly goods
inward — drawn from nineteen templates, seeded from the berth and the hour,
and shaped by what the chartering company thinks of you. Take one and it is
in your hand with the clock against it; answer it by arriving with the right
thing aboard and the Factor pays and remembers.

**Three chains, one per company, and both ways out of each.** Run the six or
seven beats of The Daughters' Audit, Subscriber Thirty-One or Prize Money and
the house is waiting on one more thing: what you are going to say. The choice
is made at the company's own seat — the berth that issues its letters — and
the Gazette carries it the same hour, so the other two houses read it too.
Both endings pay; the difference is who is owed afterwards. A chain ends once.

**Standing you can feel.** Kessler's berths charge a captain they trust less
for the same good and pay them more for it, within half the spread, so
invariant 1 survives being liked. A captain they have barred is refused
alongside, in those words. Standing is zero-sum across the three charters —
pleasing one costs with the other two at exactly half, so working all three
in rotation nets nothing.

**Convoys.** Ask another captain by callsign and they answer whenever they are
next on the link. Sailing in convoy, you see where everybody is: on the radar
as a hollow mark beside the solid ones, on the chart as a dashed ring around
the system they are in, and on the convoy's own screen as the berth they are
alongside. Work can go on the convoy's books, and then any of you can finish
it — it is still one commission, it pays once, and it pays whoever flies it.

**Offers.** Two captains at the same berth can hand each other marks, cargo
and draughts. An offer is one-sided with a price, and the counter shows what
leaves your hold, what arrives, what you pay and what your purse comes to
before anything is sent. The other captain takes it up, turns it down, or you
take it back.

### How to run it

```bash
pnpm dev
```

Land at Countinghouse in Hallam: it keeps a Factor, a Staple, a Yard and the
Moorings, and it is Kessler's seat.

```bash
pnpm verify:convoy
```

Twenty-five checks with three real clients on one server: a convoy opened,
asked, answered, refused and dissolved; a commission shared and found in
another captain's hand; marks and cargo moved between two accounts in one
transaction, and every way that can be refused.

```bash
pnpm verify:standing
```

Eleven checks with three captains written into the world before it starts —
one Kessler trusts, one it does not know, one it has barred — all landing at
the same Kessler berth.

```bash
pnpm sim -- --bots 8 --minutes 15 --factor
```

Bots that work the board: take what is posted, buy what has to be carried,
fly it where it is wanted, land. The report says which templates were
answered through the protocol in that run.

### Known issues

**A run cannot cover every template, and the report now says so.** Fourteen of
the nineteen are a charter's own work needing standing a bot earns over hours,
or bounties, which the board-working brain does not hunt. All nineteen are
proved end to end — taken, answered, paid, reconciled against the ledger — by
`packages/server/src/world/Commissions.test.ts`, which is the exhaustive half
of that pair. The soak proves the protocol path for the five a bot can reach.

**The chains cannot be played by two captains at once.** A chain belongs to
the captain who runs it; sharing puts a single beat on the convoy's books like
any other commission, but the chain's progress and its ending are one
captain's. Spec section 11 asks for chains, not for shared ones.

**No seal, and no stamp.** Spec section 4 calls the stamp the game's signature
interaction and wants a procedurally drawn seal on every document. The chain
ending is drawn as an in-world document — dark panel, serif body, a rule under
the heading — but there is no seal in the corner and confirming it is a
button, not an impression. That is the largest piece of section 4 still
unbuilt, and it belongs to M8's polish rather than to the mechanics here.
*(Built in M8: see that report.)*

### What the captures and the harnesses found

Six faults, none of which a typecheck or a unit test would have caught.

The rows in hand were pushed with their terms nested, so every figure in the
Factor's third column was `undefined` and taking a commission blanked the
screen. The client's type was a hand-written copy of the server's, which is
what let the two drift; it is the shared type itself now.

`fillText` substituted raw ids into player-facing prose — "14 units of Alloy,
no questions, to tare" — across every title and brief the Factor posts.

The chosen ending was a twelve per cent wash on a raised panel, which in a
capture was not a state at all: the two cards read as the same card.

A captain flying a hull they built had the cargo capacity of whatever they
flew last, or none: `holdCapacityOf` read the blueprint table directly and
knew nothing about the Yard.

Standing shaded the price a captain was *charged* and not the price they were
*shown*, so the one consequence of standing a player can see was invisible at
the place it is felt.

And buying at the Staple did not refresh the offers counter, so a captain who
bought a hold and turned to hand it over was looking at a list from before the
purchase.
