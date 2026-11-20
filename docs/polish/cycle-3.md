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

**N1. Two of the three required browsers have never been run.** Spec section
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
