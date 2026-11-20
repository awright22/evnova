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

*To be written when the suite finishes.*

## Minors

*To be written when the suite finishes.*
