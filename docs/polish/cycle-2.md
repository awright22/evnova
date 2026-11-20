# Polish cycle 2 — 2026-11-20

Cycle 1 closed with two threads unpulled and one capture unfixed. This cycle
starts there, because both turned out to be the same kind of fault — a
harness that stops working and does not say so — and because the second of
them was about to be filed as a combat-balance problem it was not.

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

**N2. The write-off capture is still unproduced.** Thirteen runs. The gunner
now holds one mark, which should settle it; if the run that is in flight
produces the screen, this is closed.
