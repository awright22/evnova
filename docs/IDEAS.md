# Ideas

Parked ideas that are outside `docs/SPEC.md`. Nothing here gets built without a
scope decision from the owner; the spec as written comes first.

Each entry says what it is, why it is tempting, and what it would cost.

---

## Economy and exchange

**Insurance that prices risk per pilot.** The insurer currently charges a flat
premium baked into the hull cost. It could price on your actual loss history and
the security level you fly in, which would make the Tailings feel expensive in a
way players feel in their wallet rather than read in a tooltip.
*Cost: a rating table and a premium recalculation on each build. Small.*

**Commodity futures.** Lock a price now for delivery later. Would give traders
something to do with capital other than shares, and would let a player hedge a
long haul.
*Cost: a new order type, settlement logic, and a sixth invariant family. Medium,
and a real exploit surface — it needs the soak bots before it ships.*

**Published corporate reports.** A quarterly statement per corporation, in the
Registry's procedural voice, listing the earning events the exchange already
tracks. Pure presentation over data that exists, and very much the setting's
register.
*Cost: small. Mostly writing.*

---

## World and content

**Lane maintenance as a visible system.** The beacons have a maintenance
backlog in the lore. Lanes could degrade, raising fuel cost or jump spool time
until someone funds repairs — a credit sink with a visible consequence.
*Cost: per-lane state, a funding mechanism, and tuning so it never strands a
new player. Medium.*

**Derelicts.** A destroyed ship's wreck persists as a scannable hulk for a
while, with a chance of salvage. Reinforces that the Reach is full of
half-finished and abandoned infrastructure.
*Cost: small on top of the debris work in M2, but it needs a scanning verb.*

**Crew as a consumable.** Hiring crew to raise a ship's effective stats, paid
per jump. A recurring sink that scales with ship size.
*Cost: medium, and it competes with modules for the same design space.*

---

## Ships and combat

**Module wear.** Modules degrade with use and need servicing, not just repair
after damage. Would make the dock a routine stop rather than an emergency one.
*Cost: per-module durability state and a service UI. Medium. Risks feeling like
a chore — would need to be cheap and batched.*

**Blueprint versioning.** Keep a history per blueprint so a player can diff and
roll back a refit. A small quality-of-life win for the editor.
*Cost: small, once blueprints are stored.*

---

## Social

**A shared fleet ledger.** Fleets could hold a common purse with per-member
draw limits, for groups saving toward a capital hull.
*Cost: medium, and it needs care to stay inside the ledger invariant.*

**Asynchronous contracts between players.** Post a haul, another player fills
it, the Manifest escrows the payment. Real player-to-player economy without
needing both online.
*Cost: medium-large. Escrow plus expiry plus abuse handling.*

---

## Tooling

**Colyseus Vite plugin for development.** Would give hot module replacement for
room code instead of a process restart. Rejected for the foundation because it
would make the dev topology differ from production (see `docs/DESIGN.md`), but
it could be a dev-only option later if server restarts become annoying.
*Cost: small, with a config risk.*

**A replay recorder.** The input stream is already deterministic and buffered,
so recording inputs plus a seed would replay a whole session — useful for bug
reports and for capturing combat footage for the art-direction review.
*Cost: small, and it would pay for itself in debugging.*
