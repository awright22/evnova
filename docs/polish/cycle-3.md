# Polish cycle 3 — 2026-11-20

Cycle 2 was large: five majors and seven minors, most of them found by
looking at pictures rather than by running tests. This cycle is the check on
that work — every screen recaptured against the fixes, every command run
again — and the first one with a fair chance of being clean.

## What was run

| | Result |
|---|---|
| `pnpm check` | green — typecheck, lint, 619 unit tests in 37 files |
| `pnpm shots` (full sweep) | **38 of 39** captured, up from 34 — one miss, `posted`, which this cycle caused and fixed |
| `pnpm play:new` | 14 of 14 |
| `pnpm play:late` | 27 of 27 |
| `pnpm audio` | passes — 6 voyage checks, 31 sound events, the lane check now reporting `parity -> fairlead` |
| `pnpm sim -- --bots 12 --minutes 3 --fight` | p99 tick **2.93 ms**, no spike over 33 ms, 0 of 12 diverging; worst drift EMA 0.0789, peak 0.1639 |
| `pnpm perf` | sim step **0.0075 ms** mean for 30 ships (0.25 µs a ship, p99 is 0.09% of a 60 fps frame); the browser capture timed out — see N8 |
| **CI** | ran for the first time; see B1 |

## Findings

Ranked by player impact.

### Blockers

**B1. CI has never passed.** Thirty-two runs on this branch, every one red,
each finishing in about twenty seconds — too fast to have run a test.
`pnpm install` was dying with `Permission denied (publickey)` before any job
reached `pnpm check`.

Colyseus pulls in `@colyseus/uwebsockets-transport` as an optional peer, and
that resolves `uWebSockets.js` straight from GitHub. The lockfile pins the
SSH form, `git@github.com:uNetworking/uWebSockets.js.git`, which a runner has
no key for. It works in this container because the container has git
credentials, so nothing local ever showed it. The server imports none of it:
it is an optional peer of a transport this project does not use, and it is
fetched only because it is in the graph. Git's config-through-environment
rewrites SSH to HTTPS for every job.

Filed as a blocker because `docs/PROGRESS.md` has had "CI that runs check
and build on every push" ticked since M0 and the claim was false: the
workflow existed, ran on every push, and had never once got as far as a
test. That also means `pnpm build` has never run anywhere but a developer's
hands, and the branch has had no independent check on any of this session's
work.

Found by asking, during this cycle, whether `pnpm build` had ever run — not
by anything that was watching.

**And behind it, a second fault the first had been hiding.** With the
install fixed, `Check and build` and `Netcode under latency` passed — the
first time `pnpm check` and `pnpm build` have run anywhere but here. The two
browser-driven jobs still failed, with `http://127.0.0.1:4186 never
answered`, which is the same sentence whether the preview could not find a
build, crashed on boot, or the port was taken.

So `startStack` now attaches what its processes actually said, and the next
run answered in one line: the preview was up and had printed `Local:
http://localhost:4186/`. Vite binds `localhost`, which resolves to
`127.0.0.1` in this container and to `::1` first on a GitHub runner — so the
harness spent a minute fetching an address nothing was listening on, while
the server it wanted ran on the other stack. Every preview in `tools/` is
bound to `127.0.0.1` explicitly now; four of the five had the same latent
bug and only ever ran where it does not bite.

That diagnostic was the rule this session added to `CLAUDE.md` after cycle 2
lost five runs to harnesses that failed in silence. It is the first time it
has been used on a failure I could not reproduce, and it turned a second
blind cycle into a one-line answer.

**And a third behind that.** With the preview reachable, three of four jobs
passed and the last said `Failed to launch chromium because executable
doesn't exist at /opt/pw-browsers/chromium`. That path is a fact about *this*
container, asserted unconditionally in two places —
`tools/verify/src/harness.ts` and `tools/perf/src/browser.ts` — while
`tools/shots` had a `findChromium()` next door that checks the path exists
and falls back to whatever Playwright installed. Both now do the same.

Three faults, each hidden behind the one in front of it, and none of them
findable from here: a dependency pinned to SSH, a preview on the wrong IP
stack, and a browser path that only exists on this machine. Every one is the
same shape — something true of this container written down as if it were
true everywhere.

### Majors

*None so far.*

### Minors

**N1. The combat capture photographed its own captain's death.** The sweep
caught `combat` showing the write-off panel: at point-blank the gunner
clipped a lawful hull, the Prize Court posted it, the sky came after it, and
a bot called Due Process finished the job. Cycle 2 gave both this screen and
`beams` a crippled, posted mark so there would be something to fight; the
traffic around them was left in, and a beam or a burst sweeping at close
quarters hits whatever else is nearby. Both run with no traffic now — the
mark is the subject, and everything else is only something to hit by
accident.

It is the one good thing about the failure: the screen is proof that the
write-off panel now outlives the six seconds cycle 2 found it had.

**Where this screen has got to, and where it stops.** With the traffic gone
and the mark posted, the capture is clean: no refusal across the middle, the
mark bracketed and its panel showing structure in red, the player's own
readouts intact. What has resisted six attempts across two cycles is getting
*both* hulls framed together at the moment of the shutter — at a link of a
second and a half, where the mark is when the picture is taken is not where
the capture last saw it. One run in three catches the pair.

That is enough to judge what the screen is for: hull art, the HUD, the mark
panel, damage reading through it. It is not a poster. Recorded as the limit
rather than attempted a seventh time, because every further attempt has cost
a capture run and bought a different framing of the same information.

**N2. The Yard's fittings palette still cut its last row.** Cycle 2 moved the
overflow fade into `base.css` so any scroller could use it, and wired the
Bourse and the admin page. The Yard's catalogue — forty-odd fittings in a
panel that shows eighteen — was not wired, and the `yard-code` capture shows
it cut through "Mk II Fixed Gun". Wired now. The fade is cheap; finding the
scrollers is the work, and a capture of each screen is what finds them.

**N3. One still was a photograph of the stamp. The other two were
photographs of a placement bug, and I filed all three as the same thing.**
Cycle 2 found `board` and `staple` photographing the seal mid-strike and
gave both 2.4 seconds. This sweep showed the impression still crossing
"Take it on" on the board and "Leave the order: 300 DPR" on
`bourse-orders`, so I wrote all three up as bad waits and replaced the waits
with one that holds until every stamp is back at rest.

That helper then hung for twenty-five seconds on the board and on the
Bourse ticket and on nothing else, which is what it took to go and read the
component. `Stamp.tsx` ends its phase machine with `if (size < 40)`, under
the comment *a mark on a line lifts; a mark on a document stays*. The
Staple's marks are 30px and lift. The board's, the Yard editor's and the
Bourse ticket's are the default 72px and are **designed** to stay struck —
they are the record that the thing was signed. Only the Staple was ever
mid-animation. The other two stills were the resting state, photographed
correctly, and my fix was asking two screens to undo something they are
built to keep.

What those two stills actually show is a different fault. `.stamp--above`
placed the impression at `bottom: calc(100% - 18px)`, so a document mark
overlapped the top eighteen pixels of its own control — at full size that
is the ring's lower arc and the seal's micro-text printed across the
button's label, permanently, on a control that stays live. The rule's own
comment said the mark was "mostly clear of the control". It was not, and
nobody had looked at a struck document mark at native resolution before.
The mark now sits at `calc(100% + 4px)`, wholly on the paper above.

So: one timing fault, one placement fault, and a harness that could not
tell them apart because it was built on what I assumed the stamp did. The
helper waits for the moving phases to end now — `press`, `strike`,
`settle`, `lifting` — which is true of a mark that lifts and of a mark that
stays.

**N4. The chat capture was one captain talking to themselves.** The log
behind the composer held three lines, all said by the captain whose screen
it is — which is what the act was written to do, so the composer is
photographed and the conversation is not. A captain's own line is not drawn
the way a line from somebody else is, so the thing this screen exists for
had never been captured in three milestones. It gets a companion who says
one line now.

**N5. My own fix for the combat capture stopped `posted` being captured.**
The sweep captured 38 of 39, up from 34 — the one miss is `posted`, which
fires on lawful traffic for sixty seconds and waits to be posted for it. It
timed out because the shorter closing pulses I gave `engageNearest` earlier
in this cycle, to stop it overshooting to point-blank, also made it slower
to arrive from a long way off. The burn is proportional to the gap now:
long while the mark is far, short once it is near enough to overshoot. The
engagement gets ninety seconds rather than sixty.

A fix that trades one failure for another is worth naming as such. The only
reason this one was caught in the same cycle is that the sweep runs every
screen, not the ones I happened to be thinking about.

**N6. A screen that fails while being driven left no picture.** The capture
harness photographs a screen that never settles — which is what made cycle
2's five missing screens legible in minutes. It did not photograph one that
settled and then failed inside its `act`, which is where most of the
interesting failures are: the screen is up, and something it was asked to do
did not happen. `posted` failed that way in this sweep and left nothing to
look at. It does both now.

**N7. The soak's drift is no longer zero.** Cycle 2 measured a worst drift
EMA of 0.0000 across twelve clients; this run measured 0.0789, peak 0.1639.
Nothing diverged — 0 of 12, which is the budget spec section 3 actually sets
— and a client correcting by less than the tolerance is a client whose hull
is where the server says it is. But it is not zero any more, and the honest
thing is to write the number down rather than copy the one from last time.

The likely cause is this machine rather than the game: this soak ran with a
CI install, a capture sweep and four browsers having been through the box in
the preceding hour. Cycle 4 runs it on a quieter machine and will say
whether it comes back to zero.

**N8. The performance capture gave up after thirty seconds and said only
the selector.** `pnpm perf` reported its simulation figures — 0.0075 ms a
step for thirty ships, inside every budget — and then failed bringing up a
browser client: `page.waitForSelector: Timeout 30000ms exceeded`. Thirty
seconds is enough on an idle box and not while two dozen bots are already
in the system under software rasterisation. Two minutes now, and it says
what is on the screen if the flight view never comes.

The load figures from the last clean run still stand — 1.56 MB to the title
screen, interactive in 249 ms — and will be re-measured in cycle 4.

**N9. Two of the three required browsers have never been run.** Spec section
3 asks for current Chrome, Firefox and Safari on desktop. This container has
Chromium and only Chromium: `/opt/pw-browsers` holds no Firefox or WebKit
build, and `playwright install` needs a host the network policy refuses. So
every screenshot, every play session and every verification harness in this
project — all three milestones of them — has run on one engine, and nothing
said so.

Nothing in the client is knowingly Chromium-only, and the three things most
likely to differ are used in their standard form; the scroller mask is
prefixed for Safari now as a cheap hedge. But "we have never looked" is
worth writing down rather than leaving as an assumption, which is the same
lesson cycle 2 kept learning about screens nobody had captured.
`docs/HUMAN_TODO.md` has the steps.

## What this cycle was

Cycle 2 was about things you can only see. This one was about things nothing
was watching.

The blocker was not in the game at all: a continuous integration workflow
that had run on every push since M0, failed on every one of them, and was
ticked as done in `docs/PROGRESS.md` the whole time. Four jobs — the check
and build, the netcode under latency, the server's authority, two browser
clients — none of which had ever executed. Thirty-two red runs that nobody,
including me across three milestones, had looked at.

Nine of the ten findings are in the harnesses rather than the game, and
that is the shape of a cycle that follows one like cycle 2: with the screens
fixed, what is left is the machinery that looks at them. Four of the nine
are failures my own fixes caused or uncovered — a closing burn that stopped
one capture to save another, a write-off panel that now outlives its six
seconds and so takes over a screen it should not, a stamp wait that was
right about the problem and wrong about the fix twice.

The pattern worth keeping: every one of those was found because the sweep
runs all thirty-nine screens and the suite runs all seven commands, not
because I thought to check the thing I had just changed. A cycle that only
re-ran what it had touched would have found none of them.
