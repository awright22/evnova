# Marque: project rules

Persistent multiplayer space trading and combat game for a small private group. TypeScript monorepo: static web client, authoritative game server, shared simulation code.

## Where things live
- `docs/SPEC.md`: what to build, the quality bar, the milestones. Source of truth for scope.
- `docs/PROGRESS.md`: milestone checklist and current state. Update it in the same commit that completes an item.
- `docs/DESIGN.md`: architecture and a dated decision log, one or two lines per decision.
- `docs/ART_DIRECTION.md`: palette, type, motion, effects and audio rules, the feedback table, and the running list of looks to avoid.
- `docs/LORE.md`: the setting from spec section 19, extended as content is authored.
- `docs/HUMAN_TODO.md`: things only the owner can do, with exact steps.
- `docs/IDEAS.md`: ideas outside the spec. Park them here instead of building them.
- `CREDITS.md`: every third-party asset and its license.
- `packages/shared`: simulation, formulas, message types, content data and schemas.
- `packages/server`: rooms, world services, persistence.
- `packages/client`: rendering, interface, audio, input.
- `tools/`: bot client, soak sim, screenshot harness, performance capture.

## Starting or resuming
After any restart or context compaction:
1. Read `docs/PROGRESS.md`, then the `docs/SPEC.md` section for the current milestone.
2. Run `git status` and `git log --oneline -15` to see where the last session stopped.
3. Run `pnpm check` and fix anything red before starting new work.

## Commands
These keep working from Milestone 0 onward.
- `pnpm dev`: server and client with hot reload
- `pnpm check`: typecheck, lint, unit tests
- `pnpm test`: unit and invariant tests
- `pnpm sim`: headless bot soak with a written report
- `pnpm shots`: screenshots and frame sequences of every screen into `artifacts/shots/`
- `pnpm build`: production client and server builds

Run servers as background processes and stop them when you're done with them. A foreground server blocks the turn.

## Architecture rules
- The server is authoritative. Clients send inputs and intents, never state or results.
- Code that runs on both sides lives in `packages/shared` and is deterministic. Time arrives as `dt` or an injected clock and randomness comes from a seeded generator. No `Date.now()` or `Math.random()` in simulation or economy code, so the soak sim can run the world at high speed.
- Gameplay numbers and content are data in `packages/shared/data/`, validated by schema at server start. No tunable constants in logic files.
- Credits, cargo, fuel and share quantities are integers. Every change goes through the ledger module, which tags it with a faucet or sink category. Never write a balance directly.
- Every economic action is one database transaction. It fully applies or it doesn't happen.
- The server validates every client message for type, range and state (landed, in range, can afford, owns it) and rejects with a typed reason.
- Ships are always module grids. Player ships, the starter ship and NPC ships share one blueprint format and one stat derivation.

## Libraries
- Use current stable releases. Colyseus, PixiJS and Drizzle have all shipped versions that may be newer than your training data, so read the current docs before first use and whenever an API doesn't behave as expected.
- Use Colyseus's built-in prediction, reconciliation, fixed timestep and rewind instead of writing your own. Use its request/response messages for trades and other intents that need a result.
- Add a dependency only when it earns its place, and note it in the decision log.

## Quality
- The bar is section 3 of `docs/SPEC.md`. Working is not the same as finished.
- A milestone marked done contains no placeholder art, lorem ipsum, stub handlers, or TODO comments for anything the spec requires.
- Look and motion can't be judged from code. For anything visible, run `pnpm shots`, look at the output, and compare it against `docs/ART_DIRECTION.md`.
- When a look you didn't intend shows up, add it by name to the avoid list in `docs/ART_DIRECTION.md` and fix it.
- Keep written docs as long as their content needs. No filler sections or repeated summaries.

## Assets
- Allowed licenses: CC0, CC-BY, OFL, MIT, Apache-2.0, BSD.
- Not allowed: non-commercial, no-derivatives, share-alike, "free for personal use", unclear or missing licenses, and anything extracted from a commercial game.
- Add the `CREDITS.md` entry (title, author, source URL, license) in the same commit as the asset.
- Vendor assets into the repo. Nothing loads from third-party URLs at runtime.
- Nothing from Escape Velocity Nova or any other commercial game: no names, text, art or audio.
- If an asset source can't be reached, generate the asset in code and move on.

## Scope
- Build what `docs/SPEC.md` describes, in milestone order. Routine judgment calls are yours.
- If you see a better way to implement something, take it and log why.
- If you want to change the game design or add a system, write it in `docs/IDEAS.md` and build the spec as written.
- The spec lists non-goals. Don't build them.
- Taste is fixed by spec sections 4 and 19: setting, names, vocabulary, voice, palette, typefaces. Extend them in the same voice. Don't replace them or add factions or institutions.
- Player-facing text uses the in-world vocabulary. Code, data keys and docs use the plain terms.

## Subagents
- Delegate only large, independent tracks that can run in parallel: authoring a content data set, sourcing and processing audio, building an interface screen while you work on the server.
- Do small tasks yourself. Don't use subagents to re-check your own work.
- Give each one the relevant spec section, the rules in this file that apply, and the files it owns.

## Git
- Commit each working increment with a message that says what changed and why. Commit before risky refactors.
- Never commit secrets. Never rewrite pushed history.
- Push after each milestone if a remote is configured.

## Keep working
This run is long and mostly unattended. A message with no tool call ends your turn, and work stops until someone notices. While `docs/PROGRESS.md` has open items, don't end a turn in any of these ways:
- a summary that announces the next step instead of starting it
- an offer to continue, or a question about whether to continue
- a list of decisions for the owner that don't block the remaining work (decide, log it in `docs/DESIGN.md`, move on)
- stopping because a milestone just finished or the turn has been long

Put status notes in the same message as your next tool call. End a turn only when everything left needs the owner (accounts, credentials, payment) or the completion condition in `docs/SPEC.md` is met. Destructive or irreversible actions outside this repo still need the owner's confirmation.

## Reporting
- Before a milestone: one sentence on what you're about to build.
- During: a short note only when you find something important or change direction.
- After a milestone: add a report to `docs/PROGRESS.md` that leads with what is now playable, then how to run it, then known issues.

## Maintaining this file
Add a rule here when the same mistake happens twice. Keep the file under 200 lines and remove rules that stop being true.
