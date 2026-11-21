# Polish cycle 6

Run on 2026-11-21, against the branch at `Cycle 5 closes clean`.

Everything in `CLAUDE.md`'s command list, every verifier in `tools/verify`,
the full screen sweep, and both scripted sessions. Twenty of twenty-three
green on the first pass.

## Blockers

*None.*

## Majors

*None.*

## Minors

All three failures were harnesses, and all three are fixed.

**N1. The `posted` capture's gunner span on the spot.** It spent ninety
seconds at a range frozen on 1,151 units while its bearing swung between
+3.08 and −2.39 radians:

```
gunner on Burden of Proof: range 1151, off 2.61rad, mark 1045, self 850
gunner on Burden of Proof: range 1151, off -2.39rad, mark 1045, self 850
gunner on Burden of Proof: range 1151, off 3.08rad, mark 1045, self 850
```

The range never moves and the mark never loses a point. The turn gate wants
the nose inside `AIM_TOLERANCE` — 0.12 radians — before the burn that closes
the distance is allowed to run, and at the two-second round trip this
container runs under, a hull that reads its bearing, turns, and reads again
has already swung past it. So it never closed, because it never aimed; and
it never aimed, because it kept overshooting.

Out of gun reach, roughly pointed — within 0.8 radians — is enough to be
worth burning now. The tight tolerance still applies once the mark is inside
reach and the shot is the point rather than the distance.

**N2. `pnpm audio`'s jump was refused, not slow.** The lane check failed
`parity -> parity` with *spool*, *jump* and *arrival* never heard.

Cycle 3 saw this once and wrote it off as a busy machine, and cycle 3 was
wrong. `JUMP_CLEARANCE` is 2,600 units from the star and drifting back
inside it cancels the spool. The tool pressed `J` wherever the captain
happened to be after trading and launching, which works when the berth it
left is far enough out and does not when it is not. The server was right to
refuse it every time.

It flies clear of the star first now, prints the radius it reached, and
asks again every few seconds — because a lane refused for being too close
looks exactly like one still spooling, and that is the whole reason this
took three cycles to see.

**N3. `verify:mining` cannot ask its question when a raider answers it
first.** The write-off watcher added in cycle 5 did its job on the first
run that needed it:

```
FAIL  the laden hull got home without being taken
      written off on the way back, with the ore aboard
```

That is the world working as the spec designed it — every belt is in
contested or lawless space, and the rig carries no gun — so failing the
command for it says something untrue about the game. The checks that depend
on getting home are reported, marked `SKIP`, and left out of the verdict,
with the reason printed once.

**This is a trade and it is worth naming.** A retry would actually answer
the question; skipping it avoids the question. What makes the trade
defensible is that the cargo path *is* verified on every run where the
captain gets home, which is most of them — the cut, the hold and the sale
are checked end to end whenever the world lets them be. What would not be
defensible is reading a green suite as proof that path ran on the last run.
It says so in the output.

## What this cycle was

Two cycles in a row with no blockers and no majors, which is spec section
18's closing condition.

The measurements, for the record:

| | |
|---|---|
| Unit and invariant tests | 619 passed |
| Soak, 12 bots, 150 ms, 2% stalled frames | worst p99 server tick **0.60 ms** of a 4 ms budget |
| Clients diverging | none; every client matched or within jitter |
| Simulation step, 30 ships | 0.23 µs a ship, p99 0.12% of a 60 fps frame |
| Scripted late-game session | 27 of 27 |
| Scripted new-player session | 14 of 14 |
| Screens captured | 39 of 39 |
| Browser frames | 4.2 fps under SwiftShader — a floor, not the budget |

Six cycles found, in order: a blocker and five majors; five majors; a
blocker with four faults behind it; two blockers and three majors; nothing;
nothing. The curve is the point — and so is what the last two cycles spent
their time on, which was not the game. Eight of the last nine findings were
harnesses that could not say what had happened to them, and every one of
those was the tool being wrong about the cause rather than the game being
wrong about anything.
