# Progress

Milestone checklist and current state. Scope lives in `docs/SPEC.md`; this file
tracks what is done. Update it in the same commit that completes an item.

**Current milestone: M1 — Flight**

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

## M1. Flight

- [ ] Blueprint format, stat derivation and procedural ship rendering, with the starter ship and two contrasting designs
- [ ] One system with a star, two ports, the full space backdrop and the camera
- [ ] Predicted local flight and interpolated remote ships
- [ ] Engine effects and audio
- [ ] A first HUD with speed, heading and radar

Done when:
- [ ] Two browser clients fly together within the network-feel targets
- [ ] The two contrasting designs handle noticeably differently
- [ ] The flight view matches the art direction in captures
- [ ] The performance scene holds 60 fps with bot ships

## M2. Combat

- [ ] Guns, turrets and missiles
- [ ] Shields, module damage, brownout, destruction, debris and canisters
- [ ] Targeting interface
- [ ] Unlettered AI
- [ ] Death, insurance and respawn
- [ ] All combat effects and audio from the feedback table

Done when:
- [ ] A client sending forged positions, hits or stats has no effect on outcomes
- [ ] A six-ship fight holds the performance and tick budgets
- [ ] Where armor, reactors and engines are placed measurably changes fight outcomes between otherwise equal designs

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
