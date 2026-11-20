# Polish cycle 5

Run on 2026-11-20, against the branch at `Cycle 4 closes`.

Everything in `CLAUDE.md`'s command list, every verifier in `tools/verify`,
the full screen sweep, and both scripted sessions. Twenty-one of
twenty-three green on the first pass.

## Blockers

*None.*

## Majors

*Under investigation: see the two notes below. Neither is yet shown to be a
fault in the game rather than in the harness that watches it.*

## Minors

**N1. `verify:mining` was written off before it could cut.** The run failed
five checks, all of them downstream of one event:

```
FAIL  the hull survived long enough to cut anything
      written off: a mining draught carries no gun
```

The mining verifier seeds an unarmed rig in **Lindqvist**, and every belt in
the Reach is in contested or lawless space — `narrows`, `ostrand` and
`lindqvist` in the Concessions, `okonjo`, `bitter-end`, `satos-error` and
`last-entry` in the Marque. That is the spec's design: rock is on the
frontier. So there is no safe belt to mine in, and an unarmed hull sitting
still on a rock is what a raider is looking for.

It passed in cycle 4 and failed here, so it was measured rather than
guessed at: three more runs, and in all three the hull **survived the
cutting**. Two of them still failed, and the detail is what matters:

```
run 1: 74770 units from Respondentia, which takes a hull at 508 — and the
       flight timed out
run 2: -1 units from Respondentia ... refused: not-owned
       rock lost 3, hold gained 0
run 3: 21/21 checks passed
```

A distance of 74,770 units, a distance of −1, a landing refused as
`not-owned`, and ore that came out of a rock and never reached a hold. Those
are four descriptions of one event: the captain was killed on the **run
home**, laden, and respawned elsewhere. The check that passes — *the hull
survived long enough to cut anything* — only covers the cutting, so the
harness went on to report the consequences of a write-off as four unrelated
failures and never named it.

So this is not a fault in mining, and it is not a balance finding either: an
unarmed rig with a full hold being taken in contested space is the risk the
spec puts on the frontier, and the one run in three that got home proves the
mechanism works end to end. It is a harness that could not say what had
happened to it. It watches for a write-off across the whole run home now and
says so plainly, ahead of every check that is really about the same event.

**N2. The range's sparring hulls sometimes stop fighting. Unresolved.**
`verify:range` fails its write-off check about one run in three — once in
cycle 4, once in cycle 5's suite, and once in four re-runs after that. The
other runs write the hull off in under twenty seconds.

Three rounds of telemetry, each answering the question before it:

```
cycle 4: spars at 727u, 2754u / 507u, 519u / 889u, 666u / 589u, 770u
         structure 562 to 562 over 90s
cycle 5: rounds 7; spars: 248u hp 740 | 697u hp 1045
         rounds 6; spars: 248u hp 514 | 926u hp 1045
cycle 5: rounds 0 (0 the captain's, 0 the spars'); spars: 248u hp 935 | 203u hp 1031
         ... the same line again twenty seconds later, byte for byte
```

The last one is the whole of what is known: two hostile hulls at point-blank
range, nobody firing, no hull losing a point, and two samples twenty seconds
apart that are identical. Everything is stopped.

What has been ruled out by reading the code:

- The spars do target the captain. `quarry` skips other sparring hulls and
  returns the player's ship, and `candidate` agrees.
- They are not stuck in the brain's retreat branch. `integrityOf` is a real
  getter over module hit points, not a stub returning zero.
- `combat.fire` is called for every ship in the room, not only the
  captain's.
- Firing is not gated on ordnance. Nothing in `combat.ts` or `RangeRoom`
  mentions ammunition for guns.
- The command the brain returns at that range is right: inside
  `BREAK_OFF_RANGE` it brakes, keeps `turnToward` on the mark, and fires as
  soon as `isAimedAt` is satisfied. A stopped hull pointed at a stopped
  target should fire within a second.

So a spar that never fires over eighty seconds, at 248 units, against a
stationary target, is a spar whose **angle is not changing** — which means
those ships are not being stepped at all. `commandFor` falls back to
`this.inputs.get(id).next()` when `this.pilots.get(id)` is undefined, and
that queue is the player's; it returns nothing, and the ship gets no
command. Why a spar's pilot entry would go missing is not established, and
guessing at it is how the last four of these findings went wrong.

**Why this is a minor and not a major.** The feature works in the majority
of runs: the hull is written off on the range, which is what the range is
for. What is wrong is that it sometimes is not, and the project cannot yet
say why. It is written down here in full so that whoever picks it up starts
from measurements rather than from the three wrong theories this one went
through — the hull being too tough, the spars retreating, and the player
still firing.

## What this cycle was

No blockers and no majors, which is the first time in five cycles.

Both findings were harnesses that could not say what had happened to them,
and that is now the fourth and fifth time running:

| Cycle | The harness said | It was |
|---|---|---|
| 4 | the flight view never came up | a captain called Rate Card already existed |
| 5 | written off: a mining draught carries no gun | killed on the run home, not at the rock |
| 5 | rock lost 5, hold gained 0 | the hold is read off a berth the hull never reached |
| 5 | survived, which this check needed it not to | two spars at point blank, not being stepped |

The game was innocent in every one. That is worth saying because it is not a
reassuring finding: it means the verifiers are the least trustworthy part of
this project, and a failing verifier here has been more likely to be wrong
about the cause than right. The fix each time was to make the harness report
what it could see rather than what it assumed, and each time that turned a
day of theorising into one line of output.
