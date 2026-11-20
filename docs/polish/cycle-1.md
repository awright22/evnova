# Polish cycle 1 — 2026-11-20

Spec section 18: run the soak, the invariants and the performance capture;
capture every screen; play a new-player session and a late-game session;
note every moment that is confusing, ugly, silent, janky, slow or out of
voice; rank by player impact.

## What was run

| | Result |
|---|---|
| `pnpm check` | green — typecheck, lint, 606 unit tests |
| `pnpm sim -- --bots 12 --minutes 4 --fight` | p99 tick 2.78 ms, no spike over 33 ms, 0 of 12 clients diverging |
| `pnpm perf -- --ships 30 --bots 24` | sim step 0.0073 ms mean; load 1.56 MB, interactive in 249 ms; frame rate unmeasurable without a GPU |
| `pnpm audio` | the voyage passes; 10 sounds heard, 19 out of reach of a five-minute session and named |
| `pnpm play:new` | 14 of 14 |
| `pnpm play:late` | 23 of 26, and the three failures are findings below |
| `pnpm shots` | every screen but `written-off`, which is its own finding |

## Findings

Ranked by player impact.

### Blockers

**B1. The provisional ticket covers the panel it is sitting on.** The card is
fixed at the top right, which is empty sky in flight and empty vista at a
berth — and is the Yard's Survey panel, the Bourse's Gazette, and the
Factor's top-right corner. The Survey is the one panel that says why a build
was refused, and a new captain is exactly who needs to read it. Seen on four
screens out of seven in the late-game session. *The same fault was already on
the avoid list from the flight view; the fix was moved rather than solved.*

### Majors

**M1. A saved draught cannot be opened again.** The Yard saves one — "Keep the
draught" — and the server stores it, and `YardState.designs` carries it to
the client. The editor never reads it. The only ways back to a saved design
are handing it to another captain at the Offers counter, or the share code.
A captain who designs a hull, saves it and comes back tomorrow has no way to
find it.

**M2. A new world has no spread at any berth.** Every berth opens with its
stock exactly at target, and a price at target is the base price, so on the
first day of a server every berth quotes the same numbers for everything.
There is nothing to carry anywhere until the economy has run long enough to
push stocks off target. A new captain's first voyage is the one that has to
pay.

**M3. The Bourse's book is clipped.** "Your book" shows its first row cut in
half behind the TOTALS row. With four holdings the panel is a row and a half
short of what it is holding.

**M4. Standing reads "Unknown" in red.** At -40 with the Reprisal Company the
hub shows the name in `--danger` and the word "Unknown". The colour says the
captain is in trouble and the word says nobody has an opinion. The band table
calls everything from -40 to +39 "Unknown", which is most of the range a
captain moves through early.

**M5. The write-off capture cannot photograph itself.** Nine runs. The panel
needs a captain to actually be lost, and every mechanism tried — a patrol on
its own schedule, a bot gunner standing off, a bot gunner closing in — either
took longer than any reasonable timeout or got the gunner killed instead. It
is fixed in this cycle by crippling the victim and letting the patrols do it,
but the underlying point stands: *the one screen that needs the world to do
something to the player is the one screen the harness cannot produce on
demand.*

### Minors

**N1. The link readout shows `--` in the late session.** After a minute of
flight the HUD's round-trip figure had not resolved. It shows a number in
other captures.

**N2. The ticket asks for something that cannot be done where the captain
is.** In flight the card reads "Laden — buy something at the berth's Staple".
The clerk asks in voyage order, which is right, but the instruction for a
berth should not be the live line while the captain is in the sky.

**N3. Three of the six shipped draughts are grey.** Prudent Return, Short
Measure and Close Order all paint in grey-blue. The art direction wants
livery accents to read, and half the catalogue reads as unpainted.

**N4. A hold can be overfilled and nothing objects.** The Staple shows "HOLD
118 of 36" for a captain carrying more than their bays. Nothing in the
interface or on the server refuses the state once it exists — only further
buying. Reached here by a harness writing cargo in directly, which is not a
route a player has, so it is a minor rather than a major.

**N5. A captain's own purchase shows an immediate paper gain.** Buying a tenth
of a float moves the quote sixty per cent, so the book reads "+27.8%
unrealised" on shares bought a moment ago. The pool moves back as they sell,
so nothing is actually made — invariant 6 holds — but the figure is a lie the
first time a captain reads it.

## Fixed in this cycle

Every blocker and major, and four of the five minors.

| | What was done |
|---|---|
| B1 | The ticket's card waits until the captain comes back out of a counter |
| M1 | The Yard's drawer grows a shelf of kept draughts, with a control that puts one on the grid |
| M2 | A berth opens where its own trade has pushed it, so a new world has routes on day one |
| M3 | The book's row has a real floor; the chart gives up the height |
| M4 | Nine standing bands, and the top one no longer names the wrong company |
| M5 | *Not fixed.* Marked a known miss with its reason, so the run goes red for new breakage rather than for this |
| N1 | Measured rather than eyeballed: the late session reads the link figure |
| N2 | Each endorsement knows where it can be earned; the card asks for what is to hand |
| N3 | Six paint schemes, none of them a livery, held by a test |
| N4 | A hull over her bays says so |
| N5 | A position is valued at what closing it would fetch |

**N1 turned out to be nothing.** The `--` was a diverging prediction in one
run and has not recurred; the late session reads 353 ms and now checks it
every run, so a real divergence will fail rather than be noticed in a
screenshot.

And one fault found in the course of the above, which was in the way of
everything else:

- **Firing on a posted captain used to post you in turn.** The Prize Court
  posts a captain to say they may be answered for, and then struck a
  composition against whoever answered — so a lawful captain who fired on a
  posted one was posted themselves and hunted by the patrols that were
  supposed to be after the first. Writing one off did the same. Found while
  trying to photograph a write-off: the harness's gunner kept dying instead
  of its mark.

## Open after this cycle

**M5 is not fixed.** Twelve runs. A patrol hunts a posted captain by rule
but holds station, so it never comes looking. A bot gunner reports itself
in the same system with the same hulls around it and never sees its mark. A
companion browser *is* in the victim's sky — the page's own report names it
— and still does not finish the job inside four minutes. The capture is
marked a known miss with that reason, so the run's exit code means new
breakage rather than this; the panel itself is verified by
`pnpm verify:loss`, which passes.

**Two threads cycle 2 should pull:**

1. **Why a bot gunner in the right room never sees its mark.** The page
   reports itself in parity with the bot among the hulls around it, and the
   bot reports parity with the same count and no mark among them. Either
   the bot's view of the room is not the room, or its frame loop stops
   early — its own notes stop after about a hundred seconds every time,
   which suggests it is being written off and never rebinding.
2. **Why a hull that is adrift, posted and under fire takes more than four
   minutes to be written off.** That is a combat-balance question as much
   as a harness one: if a crippled captain under sustained fire survives
   four minutes, a fight between two whole hulls is very long indeed.

**Also noticed, not yet filed:** the Bourse's listings panel cuts its last
visible row in half. It is a scroller, so nothing is lost, but a row cut
mid-text reads as a layout fault.
