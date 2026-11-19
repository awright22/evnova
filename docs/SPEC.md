# Spec

## 1. What we're building

A persistent, browser-based multiplayer space trading and combat game for a private group of friends: 2 to 12 online at once, around 20 accounts in total.

It belongs to the tradition of Escape Velocity Nova: top-down 2D inertial flight, star systems joined by hyperlanes, landing on planets to trade, refit and pick up missions. Two things set it apart:

1. Players design their own ships module by module, and the design decides how the ship flies, fights and hauls.
2. The economy is real. Commodity prices come from supply and demand that players move, and a stock exchange prices companies on what is actually happening in the world.

Everything in the game is original: setting, names, factions, text, art, audio. EV Nova is a reference for genre and pacing only. Reference points for quality, not for copying: Starsector for combat feel and visual finish, Cosmoteer for the ship editor.

## 2. Pillars

Use these to settle anything the spec leaves open.

1. Flying feels good on its own. Responsive, weighty and satisfying before any other system exists.
2. Your ship is your design. Two players with the same budget should build visibly different ships that behave differently.
3. The economy is real and readable. Prices move because of events in the world, and a player can always find out why.
4. It's our world. Persistent, private, drop-in. A 30-minute session makes real progress. Friends compete on a net-worth leaderboard and can fly together.

## 3. Quality bar

The target is the production values of the best commercial 2D indie games: as close to a AAA finish as a browser game built from code and openly licensed assets can get. A feature that works but looks or feels like a prototype is not done.

- Nothing is a placeholder. No programmer art, unstyled controls, lorem ipsum or default fonts in anything marked done.
- Every player action gets feedback in at least two channels out of visual, audio and motion. Section 4 lists the minimums.
- Cohesion beats variety. One visual language, one icon set, one type system, one audio palette. A weaker asset that fits is better than a stronger one that clashes.
- Performance: 60 fps at 1080p on a laptop with integrated graphics, with 30 ships, 300 projectiles and 3,000 particles on screen. Frame-time spikes over 33 ms are bugs. Graphics quality settings scale effects down, never gameplay.
- Network feel: the local ship responds to input on the next frame. At 150 ms latency and 2% packet loss there is no visible rubber-banding in normal flight, and remote ships move smoothly.
- Server: average tick under 4 ms with 12 players and 40 NPCs in one system.
- Load: under 5 MB transferred before the title screen is interactive. Everything else streams in behind it.
- Robustness: no white screens or raw error text. Disconnects, server restarts, version mismatches and rejected actions all have designed states.
- Writing: all text is proofread, in one consistent voice, and specific to this world.
- Browsers: current Chrome, Firefox and Safari on desktop. Keyboard and gamepad.

You can't judge look or motion from code. Capture screenshots and frame sequences, look at them, and compare them against the art direction. You can't hear audio either, so check it by measurement: loudness-normalize every file, confirm every row in the feedback table has a sound mapped, and log which sound events fire during a scripted session.

## 4. Art and audio direction

Write `docs/ART_DIRECTION.md` in Milestone 0 by expanding this section into concrete tokens: colors, type scale, spacing, motion timings, effect recipes. It is the reference for every later visual decision.

**Direction: working spacecraft.** Industrial and instrument-like. The interface should feel like avionics and shipping manifests, and the ships like machines someone maintains.

- Color: a deep, desaturated navy-charcoal base. Amber is the one signal color for the player and for interactive elements. Cool white for data. Red only for danger and hostiles. Green and red for gain and loss only inside market screens. Each faction gets one livery color and each region of space one nebula hue, so a screenshot tells you where you are.
- Type: one technical sans for interface text, one condensed face for headings and ship names, tabular figures for every number. Openly licensed fonts, self-hosted.
- Shape: squared panels with small chamfered corners, 1px rules, dense layouts on an 8px grid. Information density is a feature.
- Framing: in flight, the HUD is a cockpit overlay. Landed, every screen is the ship's terminal connected to the port. One icon set throughout.
- Motion: interface transitions of 120 to 200 ms with easing. Nothing appears or disappears without a transition. A reduced-motion setting disables shake and large movements.
- Space: near-black, with at least three parallax star layers, dust, and a shader nebula per region. Each system's star tints the lighting. Bloom on engines, weapons and shields.
- Ships: every module tile is drawn by one procedural system in one style, so any player design looks intentional: panel lines, edge shading, livery accents, lit windows, glowing nozzles. Players pick two paint colors. Render each blueprint to a texture once and draw damage as overlays.
- Planets and port vistas: procedural shader planets with atmosphere and night-side lights, not photographs.
- Effects: additive particles with real textures, not plain circles. Engine plumes scale with thrust. Shield hits ripple at the impact point. Explosions have stages: flash, fireball, sparks, tumbling debris, shockwave, smoke. Projectiles leave trails. A hyperjump stretches and distorts the scene.
- Camera: smooth follow with velocity look-ahead, a slight zoom-out at speed, restrained shake on impacts.

Looks to avoid, by name: purple or indigo gradient backgrounds; cyan-on-black "hacker terminal" styling; glassmorphism blur panels; pill-shaped buttons; large rounded cards with soft drop shadows; emoji as icons; monospace type for labels or body text; default browser form controls or scrollbars; sprites from mixed sources with clashing styles. Once the first screens exist, look at which generic defaults crept in and add them to this list in `docs/ART_DIRECTION.md`.

**Audio.** Use the Web Audio API with positional panning and distance falloff.

- An engine loop whose pitch and volume follow throttle. Distinct sounds per weapon type, for shield hits versus hull hits, and for explosions by ship size.
- Interface sounds for hover, select, confirm, error, purchase and sale, kept quiet and consistent.
- Jump spool-up and release, landing, launch, alerts.
- Music: an ambient bed per region and a combat layer that crossfades in and out. Music ducks under alerts.
- Separate volume controls for master, music, effects and interface.

**Sourcing.** Ship and module art is procedural, for cohesion. Use openly licensed assets where they fit the direction: audio, fonts, the icon set, particle textures. License rules are in `CLAUDE.md`. If a suitable asset can't be found or reached, make it in code: Web Audio synthesis for sounds, shaders and canvas for textures.

**Feedback table.** Keep a table in `docs/ART_DIRECTION.md` listing every player action and world event with its visual, audio and motion response. Minimum rows: thrust, turn, fire each weapon type, hit dealt, hit taken on shields, hit taken on hull, module disabled, ship destroyed, target acquired, jump spool, jump, arrival, land, launch, buy, sell, insufficient funds, order filled, dividend received, mission accepted, mission complete, chat message, player enters system.

## 5. Platform and architecture

- A pnpm monorepo in strict TypeScript: `packages/client`, `packages/server`, `packages/shared`, `tools/`.
- Client: Vite, PixiJS for the flight view, React for interface screens layered over it. Built to static files and deployed to GitHub Pages by a GitHub Action, with the server URL as build configuration.
- Server: Node with Colyseus, in one process. One room per star system, created when a player enters and disposed when empty. A world service in the same process owns the economy, exchange, missions and news on its own injected clock, and keeps running whether or not any room exists.
- Netcode: use Colyseus's built-in stack. Version 0.18 (August 2026) added client-side prediction and reconciliation, fixed-timestep rooms, typed input buffers with sanitizers, rewind-based lag compensation, quantized schema fields, and awaitable request/response messages. These are probably newer than your training data. Read the netcode section of the Colyseus docs and the open-source Prediction Playground before writing networking code, and use a later stable release if one exists.
- The ship physics step is one function in `packages/shared`, called by the server's fixed-step loop and by the client's reconciler.
- Persistence: SQLite through Drizzle, with migrations. Economic actions are single transactions. Positions and other fast-changing state flush every few seconds and on shutdown. Colyseus's own database package is an option if its docs show it fits.
- Accounts: a callsign plus a device token, gated by a shared invite code from server configuration. A recovery phrase, shown once, moves an account to another device. Admin rights come from server configuration.
- Operations: a Dockerfile, a health endpoint, an origin allowlist, per-connection rate limits, graceful shutdown, a daily SQLite snapshot keeping seven days, and a config for a small always-on host with a persistent volume (Fly.io by default).
- A client whose build version doesn't match the server's is asked to refresh.

## 6. Flight, travel and the world

- Flight is inertial: turn left and right, thrust forward, no drag. Thrust tapers off as speed approaches the ship's top speed, so there is no hard clamp. A brake key turns the ship retrograde and burns to a stop.
- Default controls: arrows or WASD to fly, Space for primary weapons, Shift for secondary, Tab to cycle targets, L to land, J to jump, M for the map, Enter for chat, Esc for the menu. All rebindable. Gamepad supported.
- Landing: be close to a planet or station and below a speed threshold, press land, watch a short approach, arrive at the port screen. A landed ship leaves the simulation and can't be attacked.
- Hyperjump: pick a linked system on the map, move clear of the system's center, and spool for about four seconds while still flying and vulnerable. A jump burns fuel in proportion to ship mass. Arrival is at the edge of the destination system with two seconds of protection.
- Leaving: a ship in space persists for 15 seconds after its player disconnects, or 30 if it was damaged recently. Reconnecting within that window resumes control.
- The galaxy has about 20 systems in three regions. Core systems are secured: attacking players or lawful ships there makes you wanted, patrols engage, and ports refuse you until you pay a fine. Middle systems are contested, with thin patrols. Frontier systems are lawless, with the best margins and the most pirates.

## 7. Ships and the shipyard

**Model.** A ship is a blueprint: modules placed on a square grid. The starter ship, every player ship and every NPC ship use this format and the same stat derivation.

- Module types: bridge, hull, armor, engine, maneuvering thruster, reactor, shield generator, fixed weapon mount, turret, missile rack, cargo bay, fuel tank. Later tiers add variants and specials.
- Each module has a footprint, mass, hit points, credit cost, a bill of materials in commodities, power output or draw, its stats, a tech tier, and a manufacturer, which is one of the listed corporations.
- Derived stats, as a starting model to tune:
  - Mass is modules plus cargo plus fuel, so a full hold flies worse than an empty one.
  - Acceleration is total thrust over mass. Top speed follows from thrust-to-mass on a tunable curve.
  - Turn rate is total turning torque over moment of inertia about the center of mass. Long ships turn slowly and compact ones snap around.
  - Reactor output must cover total draw.
  - Shield capacity and regeneration come from generators. Cargo and fuel capacity come from bays and tanks.
  - The hitbox is the module grid itself.
- A valid design has exactly one bridge, at least one engine, every module connected edge to edge, power covered, a clear lane behind each engine and in front of each fixed weapon, and a size within the player's hull license.
- Hull licenses (shuttle, frigate, cruiser, capital) cap module count and grid extent and are bought with credits. Higher-tier modules are sold only at certain ports.

**Editor.** Available at any port with a shipyard.

- Drag to place, rotate, a mirror mode for symmetric builds, undo and redo, copy and paste of selections.
- Live stats with deltas against the current ship, and validation problems shown on the grid where they occur.
- A cost panel with credits and the bill of materials, showing what's in the player's hold, what this port's market can supply and at what price, and what's missing.
- Save, name, duplicate and delete blueprints. Export and import as a share code. Give a blueprint to another player.

**Building.** A build costs credits plus the bill of materials, taken from the player's hold or bought from the local market in the same transaction at current prices. Part of the credit cost is a hull insurance premium. Refitting charges for added modules and refunds half the credit cost of removed ones. Shipbuilding is the economy's main sink and the reason commodities matter. Players can own several ships, each parked at the port where it was left, and fly one at a time.

## 8. Combat

- Weapons: fixed guns fire along the ship's facing, turrets track the selected target within their arc, and missiles home and consume ammunition bought as a commodity.
- Shields absorb damage first and regenerate after a delay without being hit. Once shields are down, a hit damages the module it lands on.
- A module at zero hit points is disabled, not removed, and its contribution to the ship's stats is lost. Losing reactors causes a brownout that degrades weapons first, then shields, then engines.
- A ship is destroyed when its bridge is destroyed or its total structure falls below a threshold. A destroyed ship breaks apart and drops part of its cargo as canisters anyone can scoop.
- Targeting shows range, shield and structure state, and a lead indicator for fixed guns.
- Death: the ship and its cargo are lost. Credits, blueprints, shares and other parked ships are kept. Insurance pays back half the ship's credit cost. The player wakes at the last port they landed at, with a free starter ship if they own nothing else.
- Repairs happen at ports for a fee.
- Player-versus-player follows the security rules in section 6.

## 9. Commodity economy

- About 10 commodities spanning raw, refined, manufactured and consumer goods. Every commodity is used by something: planetary consumption, module bills of materials, ammunition or fuel.
- Each port holds a stockpile of each commodity it trades, with a target level, a production or consumption rate, and a capacity.
- Price is the base price scaled by target over stock, raised to an elasticity, and clamped to a band. An order's cost is the price integrated across the units traded, so large orders move the price and splitting an order changes nothing.
- Ports buy at a small discount to the price they sell at. A landing fee applies per visit.
- Fuel is a commodity bought at ports.
- NPC freight moves goods from surplus to shortage along hyperlanes at a slow rate, so an overused route decays and a neglected one recovers. In systems with players present, part of that freight flies as real ships carrying real cargo. A destroyed freighter's cargo never arrives.
- The world service ticks the economy on its injected clock, including when nobody is online.

## 10. Stock exchange

- About 10 corporations, each tied to a sector (mining, refining, shipyards, arms, freight, fuel, agriculture, insurance) and to home systems. Each module's manufacturer is one of them.
- Earnings come only from events that are costly to fake:
  - Producers earn when goods actually leave their ports' stockpiles to buyers.
  - Manufacturers earn the credits players spend on their modules, net of refunds.
  - Carriers earn on freight delivered and lose on freight destroyed.
  - The insurer earns premiums and pays claims.
- Gross trade volume never counts toward earnings, because wash trading can inflate it for free.
- Fair value is smoothed earnings times a multiple, with a floor above zero.
- Each stock trades against a constant-product pool of shares and credits, so a quote always exists however few players are online. Each trade pays a fee that is destroyed.
- Each market tick, a house trader moves each pool's price a fraction of the way toward fair value by trading along the pool's curve. This is what makes prices respond to the world when no player is trading. Player trades push the price away from fair value and it drifts back.
- Dividends are paid periodically on player-held shares out of earnings. A player's holding in any one corporation is capped at a share of the float.
- Every event class that moves earnings can publish a headline to a news feed shown beside the charts, so a player can always answer "why did this move?"
- Interface: a market overview, a detail view per stock with price history and news, an order ticket that shows price impact before confirming, and a portfolio with cost basis, gains and dividend history.
- Intended play: blockade a mining system and watch its producer fall. Buy a shipyard's shares before a friend's big build. Notice a shortage on the news feed and haul into it.

## 11. NPCs, factions and missions

- NPC roles: freighters, pirates, patrols. They fly designed blueprints, steer and aim with lead, pick targets by role, and retreat when badly damaged. Rooms simulate NPCs only while a player is present.
- Three factions plus pirates and independents. Each player has a standing with each faction that responds to their actions and affects port access, prices and mission offers.
- Procedural missions from templates: timed cargo delivery, passenger transport, a bounty on a named pirate, freighter escort, and smuggling a commodity that is illegal in secured space.
- Three short hand-written mission chains, one per faction, that introduce the world.
- Missions can be shared with fleet members.

## 12. Players and social

- Progression runs from the starter shuttle through trade, missions and bounties, into larger licenses and better modules, and on to investing. There are no levels or experience points. Wealth, ships and standing are the progression.
- A leaderboard ranked by net worth: credits, ship value, cargo and shares at current prices.
- Chat with a global channel and a system channel.
- Fleets: invite friends, see each other on the radar and map, share missions.
- Player-to-player trade of credits, cargo and blueprints when landed at the same port.
- An admin page behind server configuration: ledger totals by category, price and stockpile views, and hot reload of tuning data.

## 13. Interface

- Screens: title and sign-in, flight HUD, galaxy map, port hub with vista and description, commodity market, shipyard editor, hangar, exchange, mission board, news, profile and leaderboard, chat overlay, settings, credits.
- Onboarding: a skippable guided first session that covers flying, landing, buying cargo, jumping, selling, visiting the shipyard and opening the exchange. After that, a contextual hint appears the first time each system is used.
- Settings: key and gamepad bindings, the four volume controls, graphics quality, interface scale, reduced motion, and a color-vision-safe palette option.
- Every screen works by keyboard alone. Every interactive element has hover, focus, pressed and disabled states, and a tooltip where its meaning isn't obvious.

## 14. Content to author

Write `docs/LORE.md` first, covering the setting, factions, naming rules, writing voice and the game's title. Author everything else against it, as validated data.

- About 20 systems and 30 landable ports, each with a description, services, faction and security level.
- About 10 commodities, 10 corporations and 3 factions.
- About 40 modules across three tech tiers.
- About 18 NPC blueprints across roles, factions and sizes, plus the starter ship.
- At least 8 mission templates with varied text, plus the three chains.
- News headline templates with enough variety that the feed doesn't visibly repeat.

## 15. Economic invariants and tooling

These hold at all times and each has an automated test.

1. Buying and immediately selling at one port never makes money.
2. Splitting an order costs the same as placing it whole, with rounding against the player.
3. A round trip through a stock pool loses at least the fees. The pool invariant never falls.
4. Every credit created or destroyed passes through the ledger with a category. The change in total player credits always equals faucets minus sinks.
5. No balance, cargo count or share count goes negative. Malformed, replayed, out-of-state or out-of-range messages are rejected by the server.
6. Self-dealing loses money: buying shares, spending to raise that corporation's earnings, then selling must net a loss after refunds. Wash trading does not move earnings.

Tools, built early and kept current:

- A headless bot client that signs in, flies, trades, fights, builds and invests through the real protocol.
- `pnpm sim`: a soak run at accelerated time with at least 10 bots using greedy strategies, including bots that try to exploit the economy. Its report covers tick time, bandwidth per client, total credits over time by ledger category, the price range of every commodity and stock, and time spent at clamp limits. Over a simulated month, credit growth stays inside a band you set and justify, no price sits at a clamp for long, and no stock runs to zero or without bound.
- `pnpm shots`: a scripted browser session that captures every screen, plus frame sequences of flight, combat, jump and landing.
- A performance capture that reports frame-time percentiles for the reference scene in section 3.

## 16. Non-goals

Don't build these. Put related ideas in `docs/IDEAS.md`.

- Mobile or touch support.
- More than one server process, sharding or matchmaking.
- Ships that split into separate pieces when modules are destroyed.
- Player-owned stations, territory control, or player-founded corporations.
- Capturing and flying other players' ships.
- Voice chat.
- Real-money features of any kind.
- 3D rendering.

## 17. Milestones

Each milestone ships at the quality bar for everything it touches. Record a short report in `docs/PROGRESS.md` when one finishes, then start the next.

**M0. Foundations**
- Monorepo, commands, and CI that runs check and build on every push.
- `docs/DESIGN.md` with architecture, data model, message protocol and a risk list. `docs/ART_DIRECTION.md` and `docs/LORE.md`.
- A networking spike, after reading the Colyseus docs: two bot clients moving a predicted entity in one room.
- Skeletons of the bot client and the screenshot harness.
- Done when: a clean clone runs every command green, and the spike stays smooth under 150 ms of simulated latency.

**M1. Flight**
- Blueprint format, stat derivation and procedural ship rendering, with the starter ship and two contrasting designs.
- One system with a star, two ports, the full space backdrop and the camera.
- Predicted local flight and interpolated remote ships. Engine effects and audio. A first HUD with speed, heading and radar.
- Done when: two browser clients fly together within the network-feel targets; the two contrasting designs handle noticeably differently; the flight view matches the art direction in captures; the performance scene holds 60 fps with bot ships.

**M2. Combat**
- Guns, turrets and missiles. Shields, module damage, brownout, destruction, debris and canisters.
- Targeting interface. Pirate AI. Death, insurance and respawn.
- All combat effects and audio from the feedback table.
- Done when: a client sending forged positions, hits or stats has no effect on outcomes; a six-ship fight holds the performance and tick budgets; where armor, reactors and engines are placed measurably changes fight outcomes between otherwise equal designs.

**M3. World**
- Galaxy data and map, hyperjump, landing and launch, the port hub.
- Accounts, invite code, recovery, persistence, reconnect, disconnect rules, chat.
- Security levels, patrols and wanted status.
- Deployment: the Pages workflow, Dockerfile and host config, with my steps in `docs/HUMAN_TODO.md`.
- Done when: killing the server process mid-session and restarting it loses at most a few seconds of position and no credits or cargo; a jump between rooms shows no state pop; a new account goes from the title screen to flying in under a minute.

**M4. Economy**
- Stockpiles, pricing, the market screen, fuel, landing fees, NPC freight, the ledger.
- Invariants 1, 2, 4 and 5 with tests. A first soak run.
- Done when: the soak report shows stable prices and bounded credit growth with trading bots; a bot that hammers one route sees its margin decay, and a rested route recovers.

**M5. Shipyard**
- The editor, validation, bills of materials, building and refitting, licenses and tech tiers, blueprint sharing, the hangar.
- Done when: a scripted new-player session designs, affords and builds a valid ship using only what the interface shows; a blueprint exported by one account builds identically on another; invalid or unaffordable builds sent straight to the server are rejected.

**M6. Exchange**
- Corporations, earnings, fair value, pools, the house trader, dividends, holding caps.
- Exchange screens, the news feed, the leaderboard.
- Invariants 3 and 6 with tests. A soak run with investor and exploit bots.
- Done when: destroying freighters in a producer's system lowers that producer's price within a few market ticks and a headline explains it; a large module purchase lifts its manufacturer; no exploit bot ends the soak ahead of the honest trading bots.

**M7. Living world**
- Faction standing. Freighters with real cargo. Patrol and pirate behavior by security level.
- Mission templates and the three chains. Fleets and shared missions. Player-to-player trade.
- Done when: a solo player has something worth doing in every system; every mission template completes end to end under bots; standing changes produce visible consequences at ports.

**M8. Depth**
- Production chains: refined and manufactured output scales with input stock, so shortages propagate.
- Asteroid mining with a mining module.
- Beam weapons and point defense.
- Boarding disabled ships for cargo.
- Limit orders, and short selling with margin and liquidation, without breaking any invariant.
- A test range where a blueprint can be flown and fought before buying it.
- The admin page.
- Done when: each addition meets the quality bar, and the soak run stays within its bands with all of them enabled.

**M9. Shell and onboarding**
- Title, menus, settings, credits, onboarding, contextual hints.
- Gamepad, accessibility options, the final audio mix and music.
- A performance pass against every budget in section 3.
- Done when: a scripted new-player session completes onboarding without getting stuck; every settings option demonstrably works; all budgets pass.

**M10. Polish cycles**
Described in section 18.

## 18. Polish cycles and completion

After M9, repeat this cycle:

1. Run the soak, the invariant tests and the performance capture. Capture every screen and all motion sequences.
2. Play the first 30 minutes as a new player through a scripted browser session, and separately a late-game session with a large ship and a portfolio. Note every moment that is confusing, ugly, silent, janky, slow or out of voice.
3. Write `docs/polish/cycle-N.md` with the issues ranked by player impact and marked blocker, major or minor.
4. Fix every blocker and major, and the minors that are cheap.

The project is complete when all milestones are checked off, every command is green, at least three polish cycles have run, and two cycles in a row found no blockers or majors. Then write a final report: what exists, how to run and deploy it, what's waiting in `docs/HUMAN_TODO.md`, known minor issues, and the best entries in `docs/IDEAS.md`.
