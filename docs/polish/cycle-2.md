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

## Findings

Ranked by player impact.

### Blockers

*None.*

### Majors

*None.*

### Minors

**N1. The Bourse's listings panel cuts its last visible row in half.** It is a
scroller and nothing is lost, but a row cut mid-text reads as a layout fault
rather than as more below. A mask-based fade was tried and reverted: CSS
cannot tell whether a scroller is actually overflowing, so the fade would
also cut a complete list. It needs either whole-row sizing or a
scroll-driven fade, and neither is worth a wrong answer now.

**N2. The soak still logs one replay-buffer warning in three minutes.** Down
from one every run at ten seconds, and the drift telemetry shows nothing:
every client matched, worst EMA 0.0000. The remaining case looks like a
client whose hull is written off mid-burst. Noise rather than a fault, and
recorded so a cycle that sees it get worse knows it was once better.
