# Marque: final report

Written at the end of M10, against the branch `claude/trusting-planck-jet8il`.

---

## 1. What exists

A persistent multiplayer space trading and combat game that runs in a
browser, with an authoritative server, for a small private group.

**The world.** 20 star systems across three regions — the Home Roads, the
Concessions and the Marque — holding 33 ports. Security runs from secured
through contested to lawless, and it is not decoration: it sets what the
Prize Court charges for firing on lawful traffic, whether a berth will take
a posted captain, and where raiders and patrols fly. Seven systems carry
asteroid belts, all of them in contested or lawless space.

**Flight and combat.** A fixed-timestep simulation shared by client and
server, with client prediction, server reconciliation and rewind. Ships are
module grids: 50 modules across three tech tiers, 6 stock blueprints, and
one blueprint format and one stat derivation shared by player ships, the
starter ship and every NPC. Guns, turrets, missile racks, beams and point
defence, with modules that can be shot off a hull individually.

**The economy.** 10 commodities on a tiered production chain, priced per
berth against stockpiles that produce and consume. Every credit, cargo unit,
share and litre of propellant is an integer, every change goes through a
ledger module that tags it as a faucet or a sink, and every economic action
is one database transaction. Six invariants are automated tests, and the
soak flies bots that try to break them.

**The Bourse.** 10 listed companies with pools, earnings, dividends and a
house trader that walks each quote toward fair value. Limit orders, short
selling with margin and liquidation by the exchange itself, a per-captain
holding cap, and the Gazette printing a line whenever something moves a
company's earnings.

**Work and standing.** 19 commission templates across the five kinds the
spec names — delivery, passengers, bounty, escort and smuggling, against a
floor of eight — and three multi-stage chains with their own endings, a letters-of-marque system with monopoly goods,
company standing that changes prices and access at a berth, fleets with
shared commissions, player-to-player trade, convoys, mining, boarding a
disabled hull for its cargo, and a test range where a draught can be flown
and fought before it is bought.

**The interface.** A full shell — title, settings, credits, onboarding and
contextual hints, gamepad and accessibility options — and an admin page
showing the ledger by category, every price and stockpile, and the live
tuning, editable without a restart. Audio is synthesised in Web Audio, music
included. The seal and the stamp are spec section 4's signature interaction
and are built as described.

**What stands behind it.** 619 unit and invariant tests, 15 scripted
verifiers covering authority, persistence, travel, trade, the Yard, the
Bourse, convoys, standing, mining, boarding, loss, orders, the range and the
admin page, two scripted play sessions, a headless soak, a 39-screen capture
sweep and a performance capture. CI runs the checks, the netcode under
latency, two browser clients, server authority with a six-ship fight, and
builds and boots the production container image on every push.

---

## 2. How to run it

```bash
pnpm install
```

```bash
pnpm dev
```

That brings up the server and the client with hot reload. The other commands
keep working from M0 onward:

| Command | What it does |
|---|---|
| `pnpm check` | typecheck, lint and unit tests |
| `pnpm test` | unit and invariant tests |
| `pnpm sim` | headless bot soak with a written report |
| `pnpm shots` | every screen and motion sequence into `artifacts/shots/` |
| `pnpm perf` | frame times and simulation cost into `artifacts/perf/` |
| `pnpm play:new` / `pnpm play:late` | the two scripted sessions |
| `pnpm audio` | drives a voyage and logs every sound heard |
| `pnpm verify*` | the fifteen acceptance harnesses |
| `pnpm build` | production client and server builds |

One setting is needed on a machine that has no GitHub SSH keys, because the
lockfile pins one dependency to an SSH remote:

```bash
git config --global url."https://github.com/".insteadOf "git@github.com:"
```

`docs/HUMAN_TODO.md` section 1b explains why, and why it is not fixed in the
lockfile instead.

## How to deploy it

The full steps, with the exact commands, are in `docs/HUMAN_TODO.md` section
4. In outline: the server goes to Fly.io from the `Dockerfile` and
`fly.toml` in this repository, with a 1 GB volume for the SQLite world and
secrets for the invite code, the allowed origin and the admin callsigns; the
client goes to GitHub Pages from `.github/workflows/deploy-client.yml`, which
needs a `MARQUE_SERVER_URL` repository variable. Do the server first, because
the client build bakes its URL in.

The server is the only part that costs money — a few dollars a month for the
smallest always-on machine and the volume.

---

## 3. What is waiting for you

`docs/HUMAN_TODO.md` has the detail. In order of how much it matters:

1. **Deploy it** (section 4). Needs your accounts and your money. Everything
   that can be built and tested without them has been: the image builds and
   serves `/health` in CI on every push. What has never run is a real deploy,
   and the volume mount is the one part of the container the CI job does not
   exercise.
2. **One git setting** (section 1b) before your first `pnpm install`.
3. **Frame rate on real hardware** (section 3). This container has no GPU,
   so `pnpm perf` reports about 4 fps under software rasterisation and that
   number says nothing about the spec's 60 fps budget. Every other budget in
   spec section 3 is measured and passes, most with an order of magnitude in
   hand.
4. **Firefox and Safari** (section 3b). Only Chromium exists here, so every
   screenshot and every harness in this project has run on one engine.
5. **Optional: sourced audio** (section 1). Everything is synthesised,
   because the network policy refuses the asset hosts. The spec's "sparse
   and patient ambient electronics with bowed strings and low piano" is the
   hardest thing to synthesise convincingly and the clearest reason to open
   a source.

---

## 4. Known minor issues

Everything below is minor by the spec's own ranking: nothing here blocks
play, and no blocker or major is outstanding.

- **The range's sparring hulls sometimes stop fighting.** About one run in
  three, two hostile hulls sit at point-blank range and neither fires. The
  feature works in the other two — the hull is written off, which is what the
  range is for. `docs/polish/cycle-5.md` N2 has every measurement taken and
  every theory ruled out; it is the one open item I could not get to the
  bottom of.
- **The soak logs one replay-buffer warning in three minutes** at 150 ms
  simulated latency and 2% stalled input frames. Every client still stays
  matched. `docs/polish/cycle-3.md` N7.
- **Two of the three required browsers have never been run**, as above.
- **Hulls pass through each other.** There is no hull-to-hull collision. The
  spec does not ask for it; adding it is a design decision, not a fix, and
  it is written up in `docs/IDEAS.md`.
- **`pnpm verify` reports NOT JUDGED on a slow machine** rather than passing
  or failing, when the box adds more delay than the link it was asked to
  test. That is deliberate, and CI exercises it on every push.

---

## 5. The best of `docs/IDEAS.md`

Nothing here is built. These are the five I would build first.

1. **Bottomry loans.** Borrow against a hull for a voyage, repay on return,
   lose nothing but the hull if you are written off. The word is already in
   the spec's port-name bank and it is the period-accurate financing
   instrument for exactly this game. It gives a new captain a way to take a
   risk they cannot yet afford, which is the thing the early game is short
   of.
2. **A replay recorder.** The input stream is already deterministic and
   buffered, so recording inputs plus a seed replays a whole session. Small,
   and it would have paid for itself several times over in this project
   alone — four of the last five findings were harnesses that could not say
   what had happened to them.
3. **Underwriters' Hall prices risk per captain.** Rate the premium on a
   captain's actual loss history and the security of the regions they fly
   in, so the Marque is expensive in the wallet rather than in a tooltip.
   The insurer is already a listed company that would obviously do this.
4. **Published company accounts.** A periodic statement per listed company
   in the Gazette's voice, itemising earning events the exchange already
   tracks. Pure presentation over data that exists, and very much the
   setting's register.
5. **Commissions posted between captains**, with the Factor holding the
   payment in escrow. A real player-to-player economy that does not need
   both captains online — the right shape for a group that plays at
   different hours.

---

## 6. What I would tell the next person

The thing this project kept teaching, in every polish cycle, is that **a
check that passes is only evidence if you know what it checks.**

There is a test called *leaves the centre clear, because a seal carries no
monogram*. It asserted that no part of a device sat more than 0.02 from dead
centre. Every seal in the game was a ship's wheel for four milestones, which
is a thing the art direction bans by name, and that test was green the whole
time. It was green because it tested a weaker property than its own name
claimed.

The same shape appeared four more times in the harnesses: `pnpm perf`
blaming a missing GPU for a name clash in a database it should not have
opened; the mining verifier blaming raiders for a flight it lost, and then
blaming the ore transfer for a berth it never reached; the range verifier
blaming a hull's toughness for ships that were not being stepped. In every
one the game was innocent and the tool was wrong about why it had failed.

Two habits fixed more than anything else did. The first is to make a harness
print what it can actually see before theorising about what is acting on it —
it turned a day of guessing into one line of output, repeatedly. The second
is to look at the picture. Both visible majors in cycle 4 had passed every
automated check and were found by cropping a screenshot to native resolution
and looking at it.

The deploy path is worth one specific warning. It was broken from M0 and
nothing caught it, because everything *around* it was checked and a green CI
badge over a Dockerfile nobody builds looks exactly like a green one over a
Dockerfile that works. The CI job that builds and boots the image found it
on its first run. If you add a path that only a human ever walks, add
something that walks it too.
