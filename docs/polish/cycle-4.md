# Polish cycle 4

Run on 2026-11-20, against the branch at `The deploy path, read for the first
time`.

Everything in `CLAUDE.md`'s command list, every verifier in `tools/verify`,
the full screen sweep, and both scripted sessions.

## Blockers

**B1. `fly deploy` could not have built the image.** The Dockerfile's build
stage runs `pnpm install --frozen-lockfile` on `node:22-bookworm-slim`, which
apt-installs `python3 make g++ ca-certificates` — and no `git`. The lockfile
resolves `uWebSockets.js` from a git remote, so pnpm shells out to `git`
during install whether or not anything imports it. No git binary, and an SSH
remote it has no key for: two reasons the same command fails.

`docs/HUMAN_TODO.md` section 4 tells the owner to run `fly deploy` as the
first step of standing the server up, and already said the image had never
been built here, this machine having no usable Docker daemon. So the one
instruction in that document that costs money is also the one nothing had
ever exercised.

**And the same fault in a second place.** `.github/workflows/deploy-client.yml`
also runs `pnpm install --frozen-lockfile`, and the `GIT_CONFIG_*` environment
block cycle 3 added lives only in `ci.yml`. The client's Pages deploy would
have failed at install too, the first time the owner ran it.

Three places install: CI, the Pages deploy, and the image. Cycle 3 fixed one
of them, in the workflow's environment, and I wrote it up as the blocker
closed. It was closed for the job I was watching. The lockfile entry behind
all three went untouched, because the workaround made the symptom I could see
go away — which is the failure mode this project's own rules were already
written against, one cycle after they were written.

**Why it survived nine milestones.** This build container's own environment
carries the same rewrite I added to `ci.yml`:

```
GIT_CONFIG_COUNT=3
GIT_CONFIG_KEY_1=url.https://github.com/.insteadOf
GIT_CONFIG_VALUE_1=git@github.com:
```

So every `pnpm install` run during this project has silently resolved that
SSH remote over HTTPS. The container has no `ssh` binary at all — with the
rewrite disabled, `git ls-remote git@github.com:uNetworking/uWebSockets.js.git`
answers `ssh: not found` — so the pinned remote has never once been fetched
the way it is written, here or anywhere.

The lockfile has therefore been broken on every machine except this one since
the day it was generated, and the only two things that had ever tried to
install somewhere else were CI, which was red from M0 and unread until cycle
3, and the image, which had never been built. A dependency graph is not
verified by the machine that wrote it.

The fix belongs in the lockfile, not in three environments: a pnpm override
pinning `uWebSockets.js` to its HTTPS form, so no clone of this repository
needs a git rewrite to install. `pnpm licenses list` also fails on that entry
today — `ERR_PNPM_UNSUPPORTED_PACKAGE_TYPE` — which is a second thing nobody
could run.

**Proved, rather than argued.** CI gained a job that builds the production
image and boots it against `/health`, because the only thing that would
otherwise have exercised the Dockerfile was the owner's first `fly deploy`.
It earned itself immediately: run 43 is the first time this image has ever
been built, and it failed at

```
>>> RUN pnpm install --frozen-lockfile
ERROR: process "/bin/sh -c pnpm install --frozen-lockfile" did not complete
successfully: exit code: 1
```

which is B1, on the deploy path, from a machine that is not this one.

Run 44 builds it and boots it:

```
{"status":"ok","at":"2026-11-20T22:10:01.562Z","flushIntervalMs":2000}
the image serves /health
```

That is the base image, the native build of `better-sqlite3`, the copy into
the runtime stage, and the server's own boot and migration, all exercised
for the first time. The volume mount is still untested — CI runs the
container without one — and is noted as such in the human to-do.

**B2. `fly.toml` promised a shutdown window it never set.** `[deploy]
strategy = "immediate"` carried the comment *"Give the process time to flush
captains and close the database before the host kills it. The server handles
SIGINT and SIGTERM."* The server does handle both, and does flush — but
`strategy` governs none of that. The key that does is `kill_timeout`, and it
appeared nowhere in the file, so whatever the host's default is was the
window a captain's last writes had to land in.

Filed as a blocker rather than a minor because it is silent and it loses
player data: a deploy that cuts the flush short drops whatever had not been
written, and nothing anywhere would say so.

The fix set `kill_timeout` explicitly. Written where the misleading comment
was, it would have landed *inside* `[[http_service.checks]]` — a bare TOML key
belongs to the table above it — and become a setting on the health check
instead. Caught by parsing the file, not by rereading it.

Fly's documented default is still unverified. `fly.io` does not resolve
through this container's network policy, and rather than fill the number in
from memory the file states the value it wants. The host is recorded in the
human to-do's table of what this environment cannot reach.

## Majors

**M1. Every seal in the game was a ship's wheel.** Looked at a struck seal at
native resolution for the first time: an outer ring, an inner ring, a hub at
the middle and six arms radiating out of it. `docs/ART_DIRECTION.md` section
8 bans the compass rose and the ship's wheel in the same line — *the 1600s
are in the institutions, not the props* — and the signature interaction of
the whole project had been striking one since M6.

The geometry caused it. A lozenge's base sat at 0.16 of its reach and a
bar's inner end at 0.22, so three or six repeats all ran back to within a
tenth of the centre and met there; the inner ring around them completed the
wheel. Every device is floored outside both 0.46 of its reach and the inner
ring now, so it sits in the band between ring and rim and the middle of the
seal is empty. Rendered every issuer to a sheet and looked: lozenges around
a ring, chevrons closing into a star, rings and bars. No hub, no spokes.

**And the test that was supposed to prevent it passed throughout.** It is
called *leaves the centre clear, because a seal carries no monogram*, and it
asserted that the nearest point of any device was more than **0.02** from
dead centre. A base at 0.096 clears that fifty times over and clears nothing
a person would see. The rule was broken for four milestones while a test
named after it stayed green. It asks for 0.2 now.

That is the cycle's lesson and it is worth more than the fix: a test can
enshrine a weaker property than the rule it is named after, and then its
passing is evidence of nothing. The seal tests check structure — how many
repeats, how far out, nothing at dead centre — and none of them could have
told anyone what the mark looked like. Only looking at it could.

**M2. The refusal is back under the write-off panel, on the screen the rule
was written about.** `docs/ART_DIRECTION.md` has carried this entry since
cycle 2:

> A refusal left standing under a panel about something else... the
> write-off capture photographed "The port declined that" sitting under
> "Written off at Parity". A state that takes over the screen clears the
> smaller notices it has made irrelevant.

Cycle 3 fixed it by clearing `session.lastRefusal` when the hull goes. This
sweep's `written-off` capture shows "REFUSED The port declined that." under
"Written off at Parity" again.

Clearing once was the wrong shape of fix. It takes down the refusal that
happened to be there at the moment of the write-off and does nothing about
the next one: the frame loop sets the refusal line from `lastRefusal` every
frame, and the capture's own act tries to land while the panel is up, which
is refused, which puts the line straight back. The panel now suppresses the
refusal line for as long as it is up, rather than clearing it once.

Worth stating plainly: cycle 3 recorded this as fixed on the strength of the
change, not on the strength of a capture. The screen it is about is captured
by name in every sweep, and nobody looked at it.

**M3. `pnpm perf`'s browser capture had been broken for three cycles, and
the GPU was blamed for it.** The capture failed again this sweep with "the
flight view never came up". With the diagnostic restored (N3 below) it said
what was actually on screen:

```
Marque
THE REGISTER
OPEN AN ACCOUNT
CALLSIGN
INVITE CODE
```

It was sitting on the Register. `tools/perf` is the only harness in this
repository that does not give its server a scratch database — it takes the
default `DATABASE_URL`, which is `packages/server/data/marque.db`, the world
`pnpm dev` uses. So the first run opened an account called **Rate Card** in
the real world, and every run after it asked for a callsign that was already
taken, was refused, and waited two minutes on the Register. The account is
still in that database, which is where this was confirmed rather than
guessed.

Three cycles read that timeout as the GPU, because this container has no GPU
and a starved renderer times out the same way. It is not the GPU. It is a
name clash in a database the tool should never have opened. `docs/HUMAN_TODO.md`
section 3 has been telling the owner that the frame figures need a real
machine — true, and unrelated to why the tool exited non-zero.

Fixed by giving the capture its own throwaway world and a callsign unique to
the run. `pnpm perf` exits 0 and reports:

```
4.1 fps  p50 243.9ms  p95 292.2ms  p99 308.0ms
renderer: ANGLE (... SwiftShader driver)
NOTE: software rasterisation, no GPU. These numbers are a floor, not the budget.
```

Which is the honest answer this box can give, and the note that keeps it from
being read as a budget result was already there.

## Minors

**N1. `verify:bourse` built a draught with no propellant tank.** Refused
`no-tank` under every licence, and four checks depended on that build —
including invariant 6's self-dealing test, which had therefore not been run.
The fixture gained a tank, and all 17 checks now hold.

The loop that built it caught the refusal with `catch { break; }` and
reported "0 marks of Slipway fittings". The Yard had already said exactly
what was wrong and sends the survey's problems alongside the refusal; the
harness threw both away. It reports them now. This is the rule `CLAUDE.md`
gained in cycle 2, broken in a file written before it.

**N2. `verify:orders` failed seven checks and none of them were the game.**

- It compared a purse against an order's settled total while the Bourse was
  paying dividends on the shares that order had just bought: 58 marks gone
  against 68 settled, the 10 being income the check was not watching.
- It compared an average fill price against the limit. Marks are whole:
  eight shares at 8.36 is 66.88, the pool charges 67, the fee is another
  mark, and 8.5 a share reads as a violation of a limit that was never
  broken. It now compares what was settled against what the limit permits
  once every fill has been rounded up.
- It read the live quote to decide whether the limit had held. At six
  hundred times the world's clock that is a different market by the time it
  is read — KSC opens at 8.20, eight shares fill at the limit, and the house
  trader walks the quote to 19.95 on its own. The harness was reporting the
  house trader's work as a limit violation.
- It sized a short at a fixed 30% of the holding cap, which at that drifted
  price wants 2,992 marks of margin against a purse of 2,975 and is refused
  by seventeen marks. It is sized from the margin state the Bourse reports
  now.
- And the clock: at 600x a short was opened, carried, margin-called and
  bought back inside one fifteen-second window, so the harness looked for a
  position that had already been closed and reported one that was never
  carried. Sixty still gives dozens of ticks a check.

24 of 24 pass. Every figure that bears on a failure is printed now, because
"58 against 68" cannot tell you whether you are looking at a ledger fault or
a reading taken at the wrong instant.

**N3. `pnpm perf` printed the first line of its own diagnostic.**
`browser.ts` puts the on-screen text into the error precisely so a failure
can be diagnosed, and `main.ts` took `message.split('\n')[0]` and dropped
the rest — so the run reported "the flight view never came up" and nothing
about why, from a harness built to answer exactly that. Cycle 3 raised that
wait from thirty seconds to two minutes and added the diagnostic; the line
that discarded it was three files away and went unread.

**N4. The range's write-off check said "survived" and nothing else.** Two
armed hulls against a stationary one for ninety seconds, and when it failed
the detail was *survived, which this check needed it not to* — which does
not distinguish a hull that is too tough from sparring partners that never
close. It reports the hull's shield and structure over the window and how
far off the spars are now. It passed on both re-runs, so the original
failure was intermittent; the telemetry is there for when it is not.

## What this cycle was

Three of the four things worth fixing here were already true when cycle 3
closed, and cycle 3 ran the same sweep and the same commands.

| Found | Had been true since | What said it was fine |
|---|---|---|
| Every seal is a ship's wheel | M6 | A test called *leaves the centre clear*, asking for 0.02 |
| `fly deploy` cannot build the image | M0 | Nothing — the image had never been built |
| `pnpm perf` cannot reach the flight view | ~M9 | "No GPU", which was true and not the cause |
| A refusal under the write-off panel | cycle 3's fix | The fix, recorded without a capture |

The common shape is not carelessness about testing. There are 619 unit
tests, fourteen verifiers, a soak, two scripted sessions and a
thirty-nine-screen sweep, and all of them were passing. It is that **a check
that passes is only evidence if you know what it checks.**

- The seal test checked that no point of a device sat at dead centre. The
  rule it is named after is about a seal having an empty middle. Those are
  different statements, and the weaker one held for four milestones while
  the stronger one was false.
- The deploy path had no check at all, and that was invisible because
  everything *around* it was checked. A green CI badge over a Dockerfile
  nothing builds reads exactly like a green CI badge over one that works.
- `pnpm perf` failed with a timeout, on a box with no GPU, in a tool that
  measures frame rate. Every part of that sentence invites the wrong
  conclusion, and I drew it three times. The actual cause — a captain called
  Rate Card already existing in a database the tool should not have opened —
  was one diagnostic line away, and that line was being truncated by a
  `.split('\n')[0]` three files from where the error was raised.
- The refusal fix was recorded as done because the change was right in
  principle. It cleared the refusal that was there; it could not clear the
  one that arrived next.

Two of these were found by looking at a picture. One was found by making a
harness print what it could see. One was found by writing a CI job for the
only thing in `docs/HUMAN_TODO.md` that costs the owner money, and watching
it fail on its first run.

None were found by running the tests again.
