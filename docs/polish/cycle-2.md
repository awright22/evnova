# Polish cycle 2 — 2026-11-20

Cycle 1 closed with two threads unpulled and one capture unfixed. This cycle
starts there, because both turned out to be the same kind of fault — a
harness that stops working and does not say so — and because the second of
them was about to be filed as a combat-balance problem it was not.

## What was run

| | Result |
|---|---|
| `pnpm check` | green — typecheck, lint, 617 unit tests |
| `pnpm sim -- --bots 12 --minutes 3 --fight` | p99 tick **2.12 ms**, no spike over 33 ms, 0 of 12 diverging, 0 grounded, drift EMA 0.0000 |
| `pnpm audio` | **passes outright** — every expected sound, the bed playing, all six voyage checks |
| `pnpm play:new` | 14 of 14 |
| `pnpm play:late` | 27 of 27 |

The soak's tick figure is the best of the project: 2.12 ms against a 4 ms
budget, with twelve clients fighting at 150 ms and 2% of their input frames
stalled. The catch-up cap below is most of why.

## The two threads

**A bot whose hull is written off goes quiet for ever.** `frame()` returns
early when there is no hull in the sky, so the brain is never called again.
The bot stays connected, stays in the client count, and does nothing. That
is what "the gunner's notes stop after a hundred seconds every run" was, and
from the outside it is indistinguishable from a bot that is working. It now
says it has lost its hull, says when it is flying again, and reports
`flying` in its telemetry — which the soak prints as *clients with no hull in
the sky*, because a run that does not read it reports numbers from fewer
clients than it thinks it has.

**A gunner with traffic around it never concentrated its fire.** The mark was
whatever was nearest *that instant*, so every pass re-aimed at whichever hull
had drifted closest. A Force Majeure is written off by about seven seconds of
a Short Measure's fire; what twelve runs of the write-off capture were
actually doing was spraying four hundred rounds across five hulls. Cycle 1
had this down as "a crippled captain survives four minutes of fire, which
means a fight between two whole hulls is very long indeed" — which would
have been a real finding if it had been true. `engageNearest` takes a
callsign now and holds it.

**A rebinding client carried a dead input queue.** Found while watching this
cycle's soak: the SDK warned that its replay buffer had overflowed. The bot
reused its input handle when it rebound to a new hull, and that handle's
pending queue holds every input the server has not acknowledged — which it
never will, for a hull it no longer has. The warning came back *because* of
cycle 1: making it lawful to fire on a posted captain produced more
write-offs, so more bots rebound. The browser never had this, because
remounting the flight view takes a new handle. The bot does the same now.

**The gunner's eyes were never switched on.** Fourteen runs of the write-off
capture, and the thing that settled it was watching the victim's own
structure: 717, and not moving. Nothing was hitting it at all — so no amount
of patrol tuning, stand-off distance or mark-holding was ever going to
matter. `openCompanion` opened its page without `harness=1`, so the client
published no room on `window`; a companion asked to find a mark, turn onto
it and hold the trigger read nothing, returned at once, and fired not one
round.

Every theory the previous runs produced — patrols that hold station, gunners
that die, rooms that do not match, hulls that take too long to lose — was
built on a gunner that had never been switched on. *The lesson is the one
cycle 2 keeps relearning: measure the thing itself before theorising about
what is acting on it.*

**A client coming back from the background replayed every missed step.**
Found in this cycle's soak and not living there. `predict.tick(now)` returns
every fixed step owed since the last call, and both clients sent an input for
each. A browser tab in the background gets no animation frames, so ten
seconds away is three hundred steps: the reconciler's replay buffer
overflows, and the client replays ten seconds of whatever key was last held
as though the captain had been holding it. Capped at twelve steps — four
hundred milliseconds, which covers a slow frame and nothing longer.

## The write-off capture, and what it was hiding

Twenty-three runs. Cycle 1 filed this as a known miss and moved on; pulling
it turned up one game fault that matters more than the capture ever did.

The runs failed, in order, because: the gunner's page was opened without
`harness=1` so it published no room and fired nothing; a killed run left a
server on the port and the next run ran against it; `engageNearest` asked
for its named mark once, and companions are brought up *before* the page a
screen is about, so it read an empty sky and returned without firing; `void`
on the watch loop's promise made an unhandled rejection and took Node down;
a named function inside `page.evaluate` compiled to `__name(look, 'look')`
and `__name` does not exist in the page; and finally the wait for the panel
was armed *after* the fight rather than before it, so the panel came and
went while the page was still shooting.

Every one of those fails the same way from outside — nothing happens and
nothing says why. The run that broke it open was the one that printed what
the gunner could see rather than what the victim had left: range, bearing,
both hulls' structure, and what held the keyboard.

## Findings

Ranked by player impact.

### Blockers

*None.*

### Majors

**M1. Insurance handed back a hull that was already a third destroyed.**
The structure a berth quotes comes from `pilot.moduleHp`, the damage array
on the captain's row, not from the hull. `switchTo` clears it when a captain
changes hulls at the Moorings, with a comment saying why: the row still
describes the hull they just left. `writeOff` did not. So a captain shot to
pieces woke in a sound replacement that read as 32% structure, and the berth
offered to repair it — charging marks to mend damage the hull never took, on
the one hull the Hall had just paid for. Cleared inside `writeOff` rather
than at the call site, so the next caller cannot miss it the way this one
did. The test fails without the fix.

Found from the capture's first successful screenshot, which photographed the
berth instead of the panel and put the figure on screen. Worth saying
plainly: four milestones of tests, soaks and verification harnesses did not
find this, and one look at a picture did.

**M2. Five seconds to read what losing your ship cost.** The write-off panel
lived for exactly as long as the wreck — six seconds — because `respawn`
then stands the captain on their last berth and the flight view goes with
it. The claim figures arrive a moment *after* the panel, so the real reading
time was about five seconds for four sentences and four numbers, and then a
berth the captain did not walk into. Nothing about the loss is in doubt by
then: it is settled, paid and persisted. So only the view of it is held
back now, behind a "Go ashore" on the panel.

### Minors

**N1. The Bourse's panels cut their last visible row in half.** A scroller
whose content runs past its edge reads as a layout fault rather than as more
below. Cycle 1 tried a mask and reverted it, because CSS cannot tell an
overflowing scroller from a full one and the fade cut complete lists too.
The answer is to let the element say: a small hook watches scroll position,
the box and the content, and sets `data-more`; the stylesheet fades the
bottom edge only when there is in fact more there. Bottom only — every table
here keeps a sticky header, and fading that would dim the column names.
Applied to all four of the Bourse's scrollers.

**N2. The screen called `combat` was a photograph of no combat.** Two hulls
1090 units apart — beyond the gun's 850 reach — nothing in flight, speed
zero, and a landing prompt across the bottom. The fight had happened: the
mark's shield was down. But `untilHit` returned the instant a round told,
which can be at the very edge of reach, and with the link at about a second
under software rasterisation the screenshot arrives after the rounds have
gone and the hulls have parted. It now closes to well inside reach before
returning, and waits 120ms rather than 350 before the shutter. `beams` takes
the same path and the same fix.

**N3. A refusal stood under a panel about something else.** The flight view
keeps the last refusal on screen, which is right while a captain is flying.
The write-off capture photographed "The port declined that" sitting under
"Written off at Parity". A state that takes over the screen clears the
smaller notices it has made irrelevant; named on the avoid list.

**N4. The soak still logs one replay-buffer warning in three minutes.** Down
from one every run at ten seconds, and the drift telemetry shows nothing:
every client matched, worst EMA 0.0000. The remaining case looks like a
client whose hull is written off mid-burst. Noise rather than a fault, and
recorded so a cycle that sees it get worse knows it was once better.

## What this cycle cost, and what it bought

Twenty-four capture runs and five harness faults to reach one screenshot —
and that screenshot found the cycle's worst bug. The lesson is not that
captures are expensive. It is that the parts of this project no test looks
at are exactly the parts where a fault can sit for four milestones: the
insurance hull was wrong from the day write-offs were written, and 618 unit
tests, a soak, nine verification harnesses and two scripted play sessions
all passed over it.

The other lesson is about silence. Every one of the five harness faults
failed by doing nothing and saying nothing — a gunner with no eyes, a port
held by a dead process, a mark that had not arrived, a rejected promise, a
helper that does not exist in the page. A harness that cannot fail loudly is
a harness that reports the game's state incorrectly, and four of these were
originally written up as findings about the *game*.
