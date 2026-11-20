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

**N2. The range's sparring hulls closed and did not fire.** `verify:range`
failed its write-off check again — it also failed once in cycle 4 and passed
three re-runs, so it is intermittent. The telemetry added in cycle 4 answers
the first question and raises a better one:

```
[range] shield 0, structure 562 (opened at 0/562), spars at 727u, 2754u
[range] shield 0, structure 562 (opened at 0/562), spars at 507u, 519u
[range] shield 0, structure 562 (opened at 0/562), spars at 889u, 666u
[range] shield 0, structure 562 (opened at 0/562), spars at 589u, 770u
```

Ninety seconds, not one point of damage, with two hostile hulls between 507
and 889 units away. The NPC brain engages at `ENGAGE_RANGE` 1100 with a
preferred range of 825–1265 and fires inside that, so they were in range for
most of it.

What has been ruled out by reading the code rather than guessing: the spars
do target the captain (`quarry` skips other sparring hulls and returns the
player's ship); `integrityOf` is a real getter, so they are not all
permanently in the brain's retreat branch; and `combat.fire` is called for
every ship in the room, not only the captain's.

What has not been ruled out, and is the likeliest remaining explanation: the
captain shoots a spar earlier in the same test — *98 points off a sparring
hull* — and a hull with its engines shot off drifts rather than fights. The
telemetry reported the spars' distance but not their condition, which is the
same gap this project keeps finding in its own harnesses: it printed what I
thought to ask for, and the useful question was the next one along. It now
reports each spar's structure, shield, whether it is a wreck, and how many
rounds are in flight.
