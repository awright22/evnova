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

*None so far.*

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
