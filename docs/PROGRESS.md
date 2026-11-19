# Progress

Milestone checklist and current state. Scope lives in `docs/SPEC.md`; this file
tracks what is done. Update it in the same commit that completes an item.

**Current milestone: M0 — Foundations**

Legend: `[ ]` open · `[x]` done · `[~]` in progress

---

## M0. Foundations

- [ ] Monorepo, commands, and CI that runs check and build on every push
- [ ] `docs/DESIGN.md` with architecture, data model, message protocol and a risk list
- [ ] `docs/ART_DIRECTION.md`
- [ ] `docs/LORE.md`
- [ ] A networking spike, after reading the Colyseus docs: two bot clients moving a predicted entity in one room
- [ ] Skeletons of the bot client and the screenshot harness

Done when:
- [ ] A clean clone runs every command green
- [ ] The spike stays smooth under 150 ms of simulated latency

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
- [ ] Pirate AI
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
- [ ] Security levels, patrols and wanted status
- [ ] Deployment: the Pages workflow, Dockerfile and host config, with owner steps in `docs/HUMAN_TODO.md`

Done when:
- [ ] Killing the server process mid-session and restarting it loses at most a few seconds of position and no credits or cargo
- [ ] A jump between rooms shows no state pop
- [ ] A new account goes from the title screen to flying in under a minute

## M4. Economy

- [ ] Stockpiles, pricing, the market screen
- [ ] Fuel, landing fees
- [ ] NPC freight
- [ ] The ledger
- [ ] Invariants 1, 2, 4 and 5 with tests
- [ ] A first soak run

Done when:
- [ ] The soak report shows stable prices and bounded credit growth with trading bots
- [ ] A bot that hammers one route sees its margin decay, and a rested route recovers

## M5. Shipyard

- [ ] The editor
- [ ] Validation
- [ ] Bills of materials, building and refitting
- [ ] Licenses and tech tiers
- [ ] Blueprint sharing
- [ ] The hangar

Done when:
- [ ] A scripted new-player session designs, affords and builds a valid ship using only what the interface shows
- [ ] A blueprint exported by one account builds identically on another
- [ ] Invalid or unaffordable builds sent straight to the server are rejected

## M6. Exchange

- [ ] Corporations, earnings, fair value
- [ ] Pools, the house trader
- [ ] Dividends, holding caps
- [ ] Exchange screens, the news feed, the leaderboard
- [ ] Invariants 3 and 6 with tests
- [ ] A soak run with investor and exploit bots

Done when:
- [ ] Destroying freighters in a producer's system lowers that producer's price within a few market ticks and a headline explains it
- [ ] A large module purchase lifts its manufacturer
- [ ] No exploit bot ends the soak ahead of the honest trading bots

## M7. Living world

- [ ] Faction standing
- [ ] Freighters with real cargo
- [ ] Patrol and pirate behavior by security level
- [ ] Mission templates and the three chains
- [ ] Fleets and shared missions
- [ ] Player-to-player trade

Done when:
- [ ] A solo player has something worth doing in every system
- [ ] Every mission template completes end to end under bots
- [ ] Standing changes produce visible consequences at ports

## M8. Depth

- [ ] Production chains: refined and manufactured output scales with input stock
- [ ] Asteroid mining with a mining module
- [ ] Beam weapons and point defense
- [ ] Boarding disabled ships for cargo
- [ ] Limit orders, and short selling with margin and liquidation, without breaking any invariant
- [ ] A test range where a blueprint can be flown and fought before buying it
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

## Reports

Milestone reports are appended here as each one finishes: what is now playable,
how to run it, known issues.
