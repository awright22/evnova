# Polish cycle 3 — 2026-11-20

Cycle 2 was large: five majors and seven minors, most of them found by
looking at pictures rather than by running tests. This cycle is the check on
that work — every screen recaptured against the fixes, every command run
again — and the first one with a fair chance of being clean.

## What was run

*Filled in when the suite finishes.*

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

**N2. The Yard's fittings palette still cut its last row.** Cycle 2 moved the
overflow fade into `base.css` so any scroller could use it, and wired the
Bourse and the admin page. The Yard's catalogue — forty-odd fittings in a
panel that shows eighteen — was not wired, and the `yard-code` capture shows
it cut through "Mk II Fixed Gun". Wired now. The fade is cheap; finding the
scrollers is the work, and a capture of each screen is what finds them.

**N3. Three stills were photographs of the stamp, and timing it did not
fix them.** Cycle 2 found `board` and `staple` photographing the seal
mid-strike and gave both 2.4 seconds, which is well past the 1.5 seconds the
stamp's phases add up to. This sweep shows the impression still crossing
"Take it on" on the board, and crossing "Leave the order: 300 DPR" on
`bourse-orders`, which had a 700ms guess of its own.

The number was never the problem. Under software rasterisation the main
thread is busy enough that the stamp's own timers run long, so no fixed wait
is right. All three wait for the seal to return to rest now — and because a
screen like the Staple has a stamp on every row, that means waiting for one
to leave rest and then for all of them to be back in it.

Three screens, three wrong guesses. The lesson is cycle 2's, arrived at
again from the other end: a harness that times a thing instead of waiting
for it is making an assumption about a machine it does not control.

**N4. The chat capture was one captain talking to themselves.** The log
behind the composer held three lines, all said by the captain whose screen
it is — which is what the act was written to do, so the composer is
photographed and the conversation is not. A captain's own line is not drawn
the way a line from somebody else is, so the thing this screen exists for
had never been captured in three milestones. It gets a companion who says
one line now.

**N5. Two of the three required browsers have never been run.** Spec section
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
