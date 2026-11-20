# Polish cycle 2 — 2026-11-20

Cycle 1 closed with two threads unpulled and one capture unfixed. This cycle
started there, because both turned out to be the same kind of fault — a
harness that stops working and does not say so — and because the second of
them was about to be filed as a combat-balance problem it was not.

It did not stay there. Pulling the unfixed capture produced a screenshot
nobody had ever seen, and that screenshot found a bug in what insurance
pays. Running the first full sweep since M9 found five more screens that had
quietly stopped being photographed, and behind them the first screen a
player sees, the first screen a player types into, and the control that
places an order on the Bourse — all three wrong, all three in ways only a
picture shows.

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
had drifted closest — spraying rounds across five hulls instead of putting
them through one. The gunner's own telemetry, added later in this cycle,
measured what concentrated fire actually costs: a Force Majeure's 885
structure takes a Short Measure roughly forty to sixty seconds at point-blank
range with two guns, or about twenty damage a second. An earlier draft of
this document said seven seconds. That was a guess, and it was wrong by most
of a minute. Cycle 1
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

**M0. The order ticket's confirm was below its own fold.** The page grid
gives row two a 400px cap for the company panel and row three whatever is
left for the order ticket — about 200px at a 900px-tall screen. The
`bourse-ticket` capture, with 500 shares entered and a parcel costed at
2,145 marks, shows the amber confirm as a six-pixel sliver at the panel's
bottom edge. It was reachable: `.ticket__body` does scroll. But a captain
who has filled in a parcel and cannot see the control that places it has no
reason to think there is one, and the panel gives no sign it scrolls. The
confirm is pinned under the body now, in a row of its own, so it is on
screen whatever height the panel is given.

Filed as a blocker first, on the reading that `.bourse > .panel` is
`overflow: hidden` and the button was therefore unreachable. The body inside
it is `overflow-y: auto`, so that was wrong — checked before the claim went
any further than this document.

The same squeeze slices the company panel's price chart through its *fair
value* label, which is the next thing to size.

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

**M3. Five screens had quietly stopped being photographed.** The first full
sweep of the cycle found them — 34 captured, 5 missed, and every miss the
same family of fault:

- **`register` and `register-phrase`** wait for `.register` on `/`. Since M9
  put a title screen in front of everything, `/` is the *title* — so both
  timed out every sweep, and the one screen a player sees before flying had
  not been looked at for two milestones. The sign-up act was broken twice
  over: it also clicked `button[type="submit"]`, and every control on the
  Register is a `type="button"`.
- **`register-refused`** had both faults as well.
- **`boot-unreachable`** waits for `.boot__failure` on the same `/`. A
  captain with an account is offered "Back to the Reach" rather than the
  Register, and the link fails behind that door, not in front of it.
- **`yard-code`** clicks `.yard__tools button:text("Code")`. The control is
  called *Draughts*, and the code lives behind its "Write one out" tab. The
  selector has been naming a button that does not exist.

All five now take the path a player takes, using the selectors
`pnpm play:new` already proves work.

The wider point: a screen that cannot be captured is a screen nobody is
judging, and the quality bar in spec section 3 is explicitly a bar on how
things look. A capture that fails is not a harness inconvenience — it is a
hole in the only review that catches what tests cannot. The `-stuck.png`
the harness writes on a miss is what made all three legible in minutes.

**M4. Neither of the first two screens was centred.** Both came out of the
same hole as M3: nobody had looked at them.

- **The title plate sat in the corner.** `.title` centred its plate
  vertically and left it against the page padding horizontally. At 1280 that
  reads as a deliberate editorial setting; at the sweep's viewport it is a
  card in the bottom-left of an otherwise empty field, and it is the first
  thing a player sees. The plate keeps its left-aligned text and amber rule;
  it sits in the middle of the page now rather than against its edge.
- **The Register sat at the top**, with sixty per cent of the viewport empty
  under it — in a file that says `place-items: center` and means it. The
  cause was not in that file. The Bourse's ranking list also called itself
  `.register`, with `align-content: start`, and every stylesheet in this
  client is global, so the sign-up screen silently took the Bourse's rule.
  That list is `.ranking` now.

Between them that is the first screen a player sees and the first screen a
player types into.

This is the second time the Bourse has taken a block name another screen
owns. The first was `chart`, which the galaxy map owns: it drew a
full-screen overlay across the Bourse's own figures, and the avoid list in
`docs/ART_DIRECTION.md` has named the fault ever since. Naming it was not
enough, because a collision does not fail loudly — the element takes the
other screen's rules and the symptom turns up somewhere else entirely. Both
instances cost a capture to notice and a while to find, so there is a test
for it now: every block name in the client's stylesheets must have one
owner. It fails with both file names when it does not.

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

**N2. "Also at this berth" headed an empty box.** The heading means "and
these as well", and it filters out everything with a row of its own above —
so at a berth that keeps the lot, it listed nothing and left a labelled
empty box, which reads as content that failed to load. The section is not
drawn when it has nothing to say.

**N3. Two stills were photographs of an animation.** `board` takes a
commission and `staple` buys a lot, and both wait 900ms, which is about right for the stamp's strike at
full speed and much too short under software rasterisation: the capture
caught the seal mid-strike, across the control it had been pressed on and
across the commission's own terms. The stamp has six frames of its own; this
screen is the board, and the other is the floor; both wait for the
impression to settle now.

**N4. The screen called `combat` was a photograph of no combat.** Two hulls
1090 units apart — beyond the gun's 850 reach — nothing in flight, speed
zero, and a landing prompt across the bottom. Four faults, found in order,
each one hiding the next:

1. I read it as `untilHit` returning at the very edge of reach and added a
   "close in to 520 units first" gate. That made it *worse* — range 1414,
   mark off screen — because the `untilHit` check is only reached from
   inside the already-on-the-mark-and-in-range branch, so it had never
   returned out of range at all. The gate simply stopped it returning, and
   the capture ran its full forty-five seconds and photographed the sky.
2. **No fixed mark.** `engageNearest` takes whatever is nearest *this
   instant* unless the caller names one. The write-off capture was given an
   explicit mark earlier in this same cycle and the fix was left there, so
   every other caller went on re-aiming at whichever hull had drifted
   closest and closing with none of them. It latches onto its first mark now
   and keeps it.
3. **Nothing a starter can catch.** Traffic under way outruns it, and with
   the link over two seconds under software rasterisation the control loop
   cannot close a gap it has to steer across. Both captures get a mark with
   its engines gone, which is what the write-off capture already does — and
   the fight came down to 324 units.
4. **The mark had to be posted.** Firing on a lawful captain got the
   capture's own captain posted, and the screen carried "the Prize Court has
   posted you" across the middle of it. True, and not what the screen is
   about.

And then a fifth, in the fix itself: `untilHit` compared the mark's *shield*
against its value at the start, and a crippled mark's shields are already
down — `0 < 0 - 1` is never true, so the check could not fire against
exactly the kind of mark the fix had just introduced. It answers for
structure too now.

What is still true: rounds are discrete, and whether any are in the gap at
the instant of the shutter is luck at this latency. The screen's description
says so rather than claiming otherwise. `beams` holds a continuous beam and
does not have that problem.

**N5. A refusal stood under a panel about something else.** The flight view
keeps the last refusal on screen, which is right while a captain is flying.
The write-off capture photographed "The port declined that" sitting under
"Written off at Parity". A state that takes over the screen clears the
smaller notices it has made irrelevant; named on the avoid list.

**N6. The soak still logs one replay-buffer warning in three minutes.** Down
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

And one about process. Five screens had stopped being captured, three of
them since M9 — which means no full `pnpm shots` sweep had been run and read
since M9, through the whole of cycle 1. Spec section 18 puts "capture every
screen and all motion sequences" first in the cycle for a reason: it is the
only step that looks at the thing a player looks at. Cycle 1 ran the soak,
the tests, the budgets and both play sessions, and found five majors. The
first sweep of cycle 2 found four more in an afternoon, including the two
worst in the cycle, and every one of them was a thing you can only see.

The sweep is not the slow optional step at the end. It is the step that
finds what the others cannot.
