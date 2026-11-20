# Ideas

Parked ideas that are outside `docs/SPEC.md`. Nothing here gets built without a
scope decision from the owner; the spec as written comes first. Ideas that would
add a faction, an institution, a currency or a tonal register are not parked —
they are out, because section 19 fixes those.

Each entry says what it is, why it is tempting, and what it would cost.

---

## Economy and the Bourse

**Underwriters' Hall prices risk per captain.** The insurer currently charges a
flat premium baked into the hull cost. It could rate on your actual loss history
and the security of the regions you fly in, so the Marque feels expensive in the
wallet rather than in a tooltip. Fits the setting exactly: the insurer is a
listed company that would obviously do this.
*Cost: a rating table and a premium recalculation on each build. Small.*

**Bottomry loans.** Borrow against a hull for a voyage, repay on return, lose
nothing but the hull if you are written off. The word is already in the spec's
port-name bank, and it is the period-accurate financing instrument for exactly
this game.
*Cost: medium. A loan ledger, a default path, and care that it cannot be used
to launder marks past invariant 4.*

**Published company accounts.** A periodic statement per listed company, in the
Gazette's voice, itemising the earning events the exchange already tracks. Pure
presentation over data that exists, and very much the setting's register.
*Cost: small. Mostly writing.*

---

## World and content

**Demurrage.** Ports charge by the hour for a berth held too long. A small sink
that rewards decisiveness and is named for a port already in the bank.
*Cost: small, but it risks punishing a player who walks away mid-session.
Would need a generous free window.*

**Salvage rights as paper.** A wreck is not just cargo: the right to salvage it
could be a document, issued by the Prize Court and tradeable between captains.
Leans hard into "paper is power".
*Cost: medium. Needs the wreck persistence below, plus a transfer path.*

**Wrecks that persist.** A written-off ship leaves a scannable hulk for a while,
with a chance of salvage. Reinforces that violence here is an insurance event
with a paper trail.
*Cost: small on top of M2's debris work, but it needs a scanning verb.*

---

## Ships and combat

**Module wear.** Modules degrade with use and need servicing, not only repair
after damage. Would make the Yard a routine stop rather than an emergency one.
*Cost: medium. Risks feeling like a chore; would need to be cheap and batched.*

**Draught versioning.** Keep a history per draught so a captain can diff and roll
back a refit.
*Cost: small, once draughts are stored.*

---

## Social

**A fleet's common purse.** Fleets could hold a shared account with per-member
draw limits, for groups saving toward a Capital Charter.
*Cost: medium, and it needs care to stay inside invariant 4.*

**Commissions posted between captains.** Post a haul, another captain fills it,
the Factor escrows the payment. A real player-to-player economy that does not
need both online.
*Cost: medium-large. Escrow, expiry and abuse handling.*

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

## Hulls pass through each other

Two ships at the same point occupy the same space: there is no hull-to-hull
collision, so a close fight can draw one ship inside another. The spec does not
ask for collision and adding it is a real decision, not an oversight — it
changes how a fight is flown, makes the Unlettered's closing passes dangerous
to them, and needs a resolution rule that two clients predicting the same
contact can agree on.

If it is ever built: resolve it in `stepFlight` from the module grid both
sides already derive, as an impulse rather than a hard stop, and keep the
damage proportional to closing speed so a drift into a berth is not fatal.
Seen while looking at the M3 captures, where a capture that closed to 30 units
drew its mark overlapping its own hull.

## Ship systems the catalogue wants but the model cannot express

Found while authoring the forty-four-module catalogue for M5. Each of these is
a stat a module could plausibly sell that nothing in the simulation reads, so
no module claims it and no description hints at it. None is in the spec; they
are parked here rather than built.

- **A bridge with a stat of its own.** Mass, hit points and draw are all a
  bridge contributes, so a better bridge can only be tougher, lighter or
  smaller. Sensor range, target locks, a shorter jump spool or crew stations
  would each give the type something to trade.
- **Damage reduction on armour.** Armour is currently hit points per cell per
  tonne, which makes it a hull section with different ratios. "Plate stops a
  round a hull section would not" is unsayable.
- **Range falloff, and damage types.** Damage is flat from muzzle to maximum
  range, and a round does not distinguish shields from structure. A long gun
  is therefore strictly better at reach, held back only by rate of fire, hull
  length and price.
- **Fractional ammunition.** `ammoPerShot` is a positive integer, so no rack
  can be gentler on the magazine than one unit per shot.
- **Blended shield delay.** `deriveStats` takes the maximum delay over all
  generators, so pairing a short-delay generator with a large one throws the
  short delay away. That is defensible — the slowest system gates the rest —
  but it is invisible on the grid, and the editor's shield panel is the place
  it would have to be said.
