# Art direction

**Direction: working spacecraft.** Industrial and instrument-like. The interface
reads as avionics and shipping manifests; the ships read as machines somebody
maintains. Information density is a feature.

The setting is *Marque*: paper is power. Ledgers, share certificates, court
rulings and letters of marque matter more than guns. The interface is the
instrument panel of a working hull, and the documents it displays are the
instruments of the institutions that own everything.

Palette and typefaces are **fixed by spec section 4**. The hues below are the
spec's. Where a value failed AA contrast as text, lightness was raised and the
hue held; each such change is logged in the table. Tokens here are mirrored as
CSS custom properties in `packages/client/src/styles/tokens.css`. Never
hard-code a colour or a duration in a component.

---

## 1. Colour

A deep, desaturated navy-charcoal base. **Amber is the one signal colour** for
the player and for interactive elements. Cool white carries data. Red is danger
and loss. Green is gain.

### Base and text

| Token | Value | Spec value | Use |
|---|---|---|---|
| `--void` | `#070A10` | as specified | Space itself; the backdrop behind every screen |
| `--panel` | `#0E131B` | as specified | Panel background |
| `--raised` | `#161D28` | as specified | Raised panel, table header, active row |
| `--rule` | `#273244` | as specified | 1px rules and panel borders |
| `--text-primary` | `#DDE3EC` | as specified | Headings, primary data |
| `--text-secondary` | `#8D98A9` | as specified | Body copy, descriptions |
| `--text-muted` | `#788597` | **raised from `#5C6777`** | Labels, units, annotation |

`#5C6777` reaches only 2.95:1 on a raised panel, which fails AA for text. It is
lightened to `#788597` (4.51:1 on raised, 5.28:1 on void) with the hue held at
215° and saturation unchanged.

### Signal

| Token | Value | Spec value | Use |
|---|---|---|---|
| `--amber` | `#F2A33A` | as specified | Player ship, focus ring, primary action, interactive |
| `--danger` | `#E64F54` | **raised from `#E5484D`** | Hostiles, posted status, alerts, market loss |
| `--gain` | `#62C462` | as specified | Market gain |

`#E5484D` reaches 4.33:1 on a raised panel. It is lightened to `#E64F54`
(4.52:1) with hue held at 358°. Danger and loss share one red, as the spec
specifies: a falling price and an incoming missile are both bad news, and the
game does not need two vocabularies for it.

Derived shades, for fills and de-emphasis only — never for text:

| Token | Value | Use |
|---|---|---|
| `--amber-bright` | `#FFBE63` | Hover, engine core, bloom source |
| `--amber-dim` | `#A06A1E` | Available-but-inactive, chart axis emphasis |
| `--amber-wash` | `rgb(242 163 58 / 12%)` | Selected row, active tab |
| `--danger-dim` | `#8E2E32` | Damaged-module overlay, depleted bar track |
| `--danger-wash` | `rgb(230 79 84 / 14%)` | Alert banner, negative candle body |
| `--gain-wash` | `rgb(98 196 98 / 14%)` | Positive candle body, positive row |
| `--hover` | `#1D2838` | Row and control hover |
| `--active` | `#243141` | Pressed |
| `--inset` | `#05080D` | Wells: fields, grids, charts |
| `--rule-strong` | `#3A4961` | Section divisions, table head rules |
| `--rule-faint` | `#1A2230` | Interior grid lines in dense tables |
| `--text-disabled` | `#4E5A6B` | Disabled controls (never carries meaning alone) |
| `--text-on-amber` | `#140E03` | Text on an amber fill |

### Status

| Token | Value | Use |
|---|---|---|
| `--shield` | `#5E9FD4` | Shield bars and impact ripples |
| `--hull` | `#C3CCD6` | Structure bars |
| `--caution` | `#D9A441` | Non-critical warnings |

### Livery

One colour per chartered company, used on hull bands, seals and port chrome.
The Unlettered carry no markings at all, which is how you recognise them.

| Company | Token | Value |
|---|---|---|
| Kessler & Daughters | `--livery-kessler` | `#E9E2D0` ivory |
| The Thirty | `--livery-thirty` | `#3A6FD8` cobalt |
| The Reprisal Company | `--livery-reprisal` | `#2FA596` verdigris |
| The Unlettered | `--livery-unlettered` | `#4A525E` bare gunmetal, no markings |

Cobalt reaches 3.58:1 on a raised panel: enough for a hull band, a seal or a
3px livery stripe, not enough for text. Livery colours never set type.

### Region nebulae

Always dark and low in saturation, so they never compete with the signal
colours. One hue per region: a screenshot says where you are.

| Region | Token | Value |
|---|---|---|
| The Home Roads | `--nebula-home-roads` | `#5E86B8` |
| The Concessions | `--nebula-concessions` | `#96586C` |
| The Marque | `--nebula-marque` | `#2F7F76` |

### Colour-vision-safe option

A settings toggle that replaces the gain/loss pair with blue `#5AA9D6` for gain
and orange `#D8853A` for loss, adds a direction glyph to every colour-coded
market cell, and switches hostile markers from colour alone to a filled triangle
against the player's hollow diamond. Colour never carries meaning by itself.

---

## 2. Type

Three roles, all self-hosted from `@fontsource` packages, all OFL 1.1. Licences
confirmed at the registry on 2026-11-19 and recorded in `CREDITS.md`.

| Role | Face | Package |
|---|---|---|
| Interface text and data | **IBM Plex Sans** | `@fontsource/ibm-plex-sans` |
| Headings, labels, ship names | **IBM Plex Sans Condensed** | `@fontsource/ibm-plex-sans-condensed` |
| In-world documents only | **EB Garamond** | `@fontsource/eb-garamond` |

EB Garamond is reserved for in-world paper: the Gazette, commissions, charters,
court notices, share certificates. It never appears in chrome, controls or
instrument readouts. Seeing a serif means you are reading a document somebody
issued.

Tabular figures are mandatory on anything numeric: `font-variant-numeric:
tabular-nums`. A price column that reflows as digits change is a bug. IBM Plex
Sans carries tabular figures; EB Garamond's are used only in document body text,
where columns do not align.

### Scale

Sizes in px / line-height in px. 8px grid, dense by intent.

| Token | Face | Size/Leading | Weight | Treatment |
|---|---|---|---|---|
| `--type-display` | Plex Condensed | 32/36 | 600 | Title, port name |
| `--type-h1` | Plex Condensed | 24/28 | 600 | Screen heading |
| `--type-h2` | Plex Condensed | 19/24 | 600 | Panel heading |
| `--type-h3` | Plex Condensed | 16/20 | 600 | uppercase, `0.06em` |
| `--type-body` | Plex Sans | 14/20 | 400 | Descriptions, prose |
| `--type-body-sm` | Plex Sans | 13/18 | 400 | Dense tables, tooltips |
| `--type-label` | Plex Condensed | 12/16 | 500 | uppercase, `0.08em`, muted |
| `--type-data` | Plex Sans | 14/20 | 500 | tabular, primary |
| `--type-data-lg` | Plex Sans | 20/24 | 600 | tabular, headline figures |
| `--type-micro` | Plex Condensed | 11/14 | 500 | uppercase, `0.1em`, units and stamps |
| `--type-doc` | EB Garamond | 16/26 | 400 | In-world document body |
| `--type-doc-head` | EB Garamond | 21/28 | 600 | Document title, issuer line |

Interface scale multiplies every size by 0.875, 1, 1.125 or 1.25, rounded to the
nearest whole pixel.

---

## 3. Space and shape

**Spacing.** An 8px grid with 4px and 12px as permitted half-steps:
`--space-0-5: 4px`, `--space-1: 8px`, `--space-1-5: 12px`, `--space-2: 16px`,
`--space-3: 24px`, `--space-4: 32px`, `--space-6: 48px`, `--space-8: 64px`.

**Panels.** Squared, with a small chamfer cut from the corners — an actual
diagonal cut via `clip-path`, never a border radius. At 6px the cut was
invisible in capture; `--chamfer-lg` is `10px` and `--chamfer-sm` is `4px`.
Border width is 1px throughout.

**Elevation.** No soft drop shadows. Depth is the surface ramp plus a 1px
lighter top edge. The only shadow in the game is the hard 1px offset behind the
focus ring.

**Controls.** Minimum 28px tall, 24px in dense tables. Rectangular with
`--chamfer-sm`. Every interactive element has hover, focus, pressed and disabled
states; focus is a 2px amber ring at 1px offset, on keyboard focus only.

**Framing.** In flight the HUD is a cockpit overlay: readouts anchored to the
screen edges, nothing floating in the middle. Landed, every screen is the ship's
terminal connected to the port, with one persistent header carrying port name,
marks, Propellant and standing.

**Icons.** One set, drawn in code as 16px and 24px SVG on a 2px stroke grid,
square caps, no filled glyphs except status dots. Emoji are never icons.

### Seals

Every company and institution has a seal: procedurally drawn, geometric and
heraldic, struck rather than illustrated. One construction system so they read
as a set:

- A circular rim, 1.5px, in the issuer's livery colour.
- An inner geometric device on a 6-point radial grid — lozenge, chevron, bar,
  ring — unique per issuer and derived from a seed on the issuer's id, so the
  same institution always strikes the same mark.
- A letter-less centre. No glyphs, no monograms, no text inside the rim.
- At document size the rim carries the issuer's name in `--type-micro` set on a
  circular path, in the livery colour at 70% alpha.

Seals appear on port chrome, hull decals and documents. Ships also carry a
livery band along the hull and a registry number in `--type-micro`.

### Documents

In-world paper renders as a dark panel — `--panel`, 1px `--rule-strong` border,
no texture — with EB Garamond body text at `--type-doc`, the issuer's seal in
the top-right, and a rule under the heading. Never parchment, never a paper
texture, never a cream background. The paper is dark because it is on a screen
on a ship.

### The stamp

Confirming a purchase, a build, a trade or a commission **stamps the document**.
This is the game's signature interaction and gets the most care of anything in
the interface.

The sequence, 260ms total:

1. **Press** (0–70ms) — the stamp control depresses 2px and darkens to
   `--active`; the document shifts 1px down. `--ease-exit`.
2. **Strike** (70–120ms) — the seal impression appears at 108% scale and 0
   alpha, settling to 100% and full alpha over 50ms on `--ease-emphasis`. A 1px
   amber rim flashes for one frame at the impression's edge.
3. **Settle** (120–200ms) — the document rises back 1px; the impression's edge
   softens by 1px as the ink spreads. A faint debossed shadow, 1px, appears
   under the impression.
4. **Rest** (200–260ms) — the confirmed row or line fades from `--amber-wash` to
   its resting surface.

Audio: a low thud on the strike frame, with 12ms of paper-and-mechanism noise
ahead of it, on the interface bus. Under reduced motion the press and the 1px
document shift are dropped; the impression still appears, as a 120ms fade, and
the thud still plays. The stamp is never skipped: it is the confirmation.

---

## 4. Motion

| Token | Duration | Use |
|---|---|---|
| `--motion-instant` | 80ms | Hover, focus |
| `--motion-quick` | 120ms | Button press, chip toggle, tooltip |
| `--motion-base` | 160ms | Panel open, row expand, tab change |
| `--motion-slow` | 200ms | Screen transition, modal |

| Token | Curve | Use |
|---|---|---|
| `--ease-standard` | `cubic-bezier(0.2, 0, 0.2, 1)` | Most transitions |
| `--ease-exit` | `cubic-bezier(0.4, 0, 1, 1)` | Leaving the screen |
| `--ease-emphasis` | `cubic-bezier(0.2, 0, 0, 1)` | Arriving content, the stamp strike |

Nothing appears or disappears without a transition. Screens cross-fade with a
4px vertical offset; panels wipe open from their header edge.

**Reduced motion.** No camera shake, no screen offset, no scaling entrances, no
parallax response. Opacity fades remain at `--motion-instant`. Gameplay motion —
ships, projectiles — is never reduced.

---

## 5. Space, ships and effects

### Backdrop

`--void` with, back to front:

1. **Star layer 3** — 1px points, 0.08 parallax, opacity 0.35, ~900 per screen.
2. **Star layer 2** — 1–2px points, 0.18 parallax, opacity 0.6, ~400.
3. **Star layer 1** — 2px points with a faint cross flare, 0.35 parallax,
   opacity 0.9, ~120.
4. **Dust** — drifting 1px motes, 0.65 parallax, opacity 0.25, additive.
5. **Nebula** — a shader field in the region hue: two octaves of value noise,
   domain-warped, 0.5 parallax, screen-blended at 0.22. Never a linear gradient.

The system's star tints all scene lighting and casts a directional rim on every
hull from the star's actual position.

### Ships

Every module tile is drawn by one procedural system so any player design looks
intentional: a 2px darker outline, interior panel lines on a 4px grid, a 1px
top-left highlight and bottom-right shade, lit windows on habitable modules, and
glowing nozzles on engines. Players pick two paint colours; the renderer derives
a third shade for panel lines. Company hulls add a livery band and a seal decal;
every hull carries a registry number.

Each blueprint renders once to a texture; damage draws as overlays — scorch at
50% module health, a blown-panel overlay plus venting at 0%.

### Effect recipes

**Engine plume.** Length `18 + 46 × throttle` px, additive, core
`--amber-bright` to edge at 35% alpha, 2px turbulence at 12Hz, 1px bloom pass.
Cuts to a 6px idle glow over 90ms.

**Projectile trail.** 8-segment ribbon fading to zero over 140ms, width 3px →
0.5px, additive in the weapon's colour.

**Shield hit.** A ripple centred on the impact point: an expanding arc clipped to
the shield ellipse, 180ms, `--shield` at 0.8 alpha fading out, with a 6px
chromatic smear along the contact normal.

**Hull hit.** 10 radial sparks over 220ms, a 2px white flash for one frame, and a
persistent 4px scorch decal.

**Explosion, by stages.** Flash (one frame, white, 1.6× hull radius) → fireball
(220ms, `--amber-bright` → `--danger` → smoke, additive) → sparks (30 particles,
500ms) → tumbling debris (4–9 module-shaped pieces with angular velocity, 2.5s)
→ shockwave (1px expanding ring with refraction, 320ms) → smoke (1.8s, 0.3
alpha). Scale durations by `0.8 + 0.4 × hullSize`.

**Beam.** A line from the muzzle along the mount's bearing for as long as the
trigger is down. A core of 1.9px at full level in the weapon's colour mixed
toward white, over three surround passes of 8px/6%, 4.5px/11% and 2.6px/28% —
drawn, not blurred, because a blur pass per beam costs a render target. Energy
runs along it as a ±9% wander in width and ±27% in alpha, travelling at about
one length a second. Where it lands, two brighter discs. It rises over
`--motion-instant` on `--ease-emphasis` and falls over `--motion-quick` on
`--ease-exit`, in alpha and width only: **the length is never animated**, since
a growing line reads as a round travelling, which is the one thing a beam must
not look like. Colour follows allegiance and adds red for a hostile, unlike a
round — a round is on screen for a tenth of a second, and a beam held on you is
the most important thing in the view. Under reduced motion the wander freezes
and the standing shape remains.

**Point-defense intercept.** Where a round is shot down: an 80ms flash and five
radial sparks at 0.35–0.8px over 80–120ms, in `--shield`. Blue because blue
already means "something stopped it", and because it must never be mistaken for
damage landing — it is shorter, smaller and radial where a hull hit is fanned
along a normal, and **it never shakes the camera**, since a shake is precisely
what says the hull took it.

**Hyperjump.** Spool: a rising ring and radial streaks building over 4s.
Release: the scene stretches along the jump axis over 260ms with chromatic
separation, then a white wipe. Arrival: the reverse over 320ms.

### Camera

Smooth follow, 120ms time constant. Velocity look-ahead of `velocity × 0.35s`,
clamped to 220px. Zoom eases 1.0 at rest → 0.82 at top speed. Impact shake peaks
at 6px decaying over 220ms, and is disabled under reduced motion.

### Planets and port vistas

Procedural shader planets: a lit sphere with a terminator softened by an
atmosphere shell, two-octave surface noise, night-side lights where the port is
inhabited, and a thin atmospheric rim lit by the system star. Never a
photograph.

---

## 6. Audio

Web Audio throughout, with positional panning and distance falloff. Every file
is loudness-normalised to **-23 LUFS** with a -1 dBTP ceiling.

**Buses.** master → {music, effects, interface}, each with its own volume
setting. Music ducks 6 dB under alerts over 120ms, recovering over 400ms.

**Engine.** A loop whose playback rate follows throttle 0.82 → 1.18 and whose
gain follows it 0.15 → 0.7, both smoothed over 80ms.

**Distance model.** Inverse falloff, reference 400 units, max 6000, rolloff 1.1.
Stereo pan from the camera-relative x offset, clamped to ±0.85.

**Music.** Sparse and patient: ambient electronics with bowed strings and low
piano. One bed per region, plus a combat layer crossfading in over 1.5s when a
hostile is within 2500 units and out over 4s once clear. No orchestral bombast
and no sea shanties.

A bed is four layers, generated rather than looped so it never arrives at the
same bar twice:

- **Drone.** Four detuned sawtooths on the root, the fifth and the octave,
  through a lowpass breathing on a 23-second LFO. Continuous, and most of what
  a captain hears.
- **Bowed strings.** A sawtooth pair six to seven cents apart through a
  bandpass, two seconds of attack, five to nine seconds long, one note at a
  time from the region's scale, two or three octaves above the drone. They do
  not resolve.
- **Low piano.** A sine fundamental with two quiet partials and a filtered
  noise hammer, struck an octave above the drone, rarely, and never in a
  rhythm.
- **Combat layer.** A minor second held against the root, a low pulse at 76
  beats a minute, and the drone's own filter opened to 2.2× its cutoff. No
  drum kit: a fight reads as pressure, not as percussion arriving.

| Region | Root | Scale | Cutoff | A bow every | A strike every |
|---|---|---|---|---|---|
| The Home Roads | A1, 55 Hz | minor with a major sixth | 460 Hz | 9–17s | 11–26s |
| The Concessions | G1, 49 Hz | Dorian | 380 Hz | 10–20s | 14–32s |
| The Marque | F1, 44 Hz | Phrygian | 300 Hz | 13–26s | 18–44s |

The Home Roads are settled and solvent and get the warmest of the three; the
Concessions are contested and arithmetical, with open fifths and nothing warm
in them; the Marque is darker, and its strings are further apart because there
is less out there. Arriving somewhere glides the drone and the filter over
four seconds rather than cutting: a region is a change of character, not a
change of track.

Audio sources are not reachable from the build environment (see
`docs/HUMAN_TODO.md`), so sounds are synthesised in Web Audio, which the spec
permits. That leaves nothing to loudness-normalise, so the measurement the
spec asks for is the other two: `packages/client/src/audio/log.test.ts` reads
the feedback table out of this document and fails if a row has no sound
mapped, and `pnpm audio` drives a scripted session in a real browser and logs
what the client actually played to `artifacts/audio.json`.

---

## 7. Feedback table

Every player action and world event, with its response in each channel. A blank
cell is unfinished work. Minimum two channels per row.

| Event | Visual | Audio | Motion |
|---|---|---|---|
| Thrust | Plume extends, engine glow blooms | Engine loop rate and gain rise | Camera zooms toward 0.82, look-ahead extends |
| Turn | Maneuvering jets puff on the outboard side | Short thruster hiss, panned to the jet | Hull rolls 4° into the turn |
| Fire gun | Muzzle flash, tracer with trail | Dry mechanical report | 2px recoil along the barrel axis |
| Fire turret | Barrel swings to lead, muzzle flash | Softer report, slight pitch variance | Turret rotation eased over 120ms |
| Fire missile | Rack door, launch bloom, thick trail | Rail clunk then a receding roar | 3px launch shove, rack count decrements |
| Hit dealt | Impact spark on the target, damage ticks | Confirming thud, pitched by damage | Crosshair pips flare outward 120ms |
| Hold a beam | Line from the muzzle, energy running along it, brighter where it lands | Continuous hum, gaining a rasp while it is on something | Rises over `--motion-instant`, falls over `--motion-quick`; length never animates |
| Cut into rock | The same line, ending on a rock; the rock dulls and shrinks as it goes | The held hum with its rasp open, as on any hull | Hold ring round the rock being worked |
| Point defense intercepts | 80ms `--shield` flash and five small radial sparks where the round was | Short dry snap, quieter than a gun | No shake: a shake says the hull took it |
| Hit taken on shields | Shield ripple at the impact point | Resonant shield ring | 2px shake, shield bar pulses |
| Hit taken on hull | Sparks, white flash, scorch decal | Dull structural bang | 5px shake, hull bar pulses `--danger` |
| Module disabled | Module greys, vents, status tile darkens | Power-down whine, warning chirp | Tile flips to its disabled face, 160ms |
| Ship written off | Full staged explosion, debris, canisters | Layered boom by hull size, debris patter | 6px shake, 180ms slow-motion dip |
| Target acquired | Bracket snaps on, range and bars appear | Soft two-tone lock | Bracket scales 1.3 → 1.0 over 120ms |
| Jump spool | Rising ring, radial streaks, countdown | Rising harmonic spool, 4s | Ring rotates, HUD edges pull inward |
| Jump | Scene stretches, chromatic split, white wipe | Spool releases into a deep whump | 260ms stretch along the jump axis |
| Arrival | Reverse wipe, lane beacon flares | Arrival chime, ambience crossfades | 320ms settle, 2px overshoot |
| Land | Approach vista, berth lights, iris to port | Docking clamps, hull creak, ambience shift | 200ms iris, HUD retracts upward |
| Launch | Berth recedes, HUD deploys | Clamps release, engine spins up | 200ms iris out, HUD slides down |
| Buy at the Staple | **The stamp** on the order; marks tick down | Paper, mechanism, low thud | Stamp sequence, 260ms; counter rolls |
| Sell at the Staple | **The stamp** on the order; marks tick up | Paper, mechanism, low thud | Stamp sequence; hold indicator shrinks |
| Insufficient funds | Marks readout flashes `--danger`, field outlines | Flat error buzz, no thud | Stamp control shakes 3px twice, 160ms |
| Order filled at the Bourse | Ticket collapses to a filled row; Gazette line | Crisp fill click | Row slides into the ledger, 160ms |
| Dividend received | Marks tick up; portfolio row shows a `+` badge | Soft three-note chime | Badge fades in 200ms, then out |
| Commission accepted | **The stamp** on the commission; objective docks | Paper, mechanism, low thud | Stamp sequence; objective slides in |
| Commission complete | Objective ticks; payment itemised, less the fee | Resolving two-note chime | Objective lifts out, marks roll |
| Chat message | Line appears in the overlay, tab marks unread | Quiet tick, interface bus | Line fades up 4px over 120ms |
| Player enters system | Radar contact appears, Register line added | Distant beacon ping | Contact scales in over 120ms |
| Posted by the Prize Court | Status chip turns `--danger`; composition shown | Low two-tone alert; music ducks | Chip wipes in from the HUD edge, 160ms |
| Cutting rock | Held beam on the rock, dust at the cut, rock wears | Low grinding hum, held | Rock shrinks and dulls as it is worked |
| Hold filled while cutting | The line says the bays are full; the beam runs on | The rig's hum, unchanged | Notice fades up 120ms |
| Boarding a prize | Prompt names the hull; lots listed as they come across | Hatch, boots, a crate landing, interface bus | Prompt wipes out, 160ms; cargo bar grows |
| Standing order left | Order enters the book below, marked waiting | **The stamp**: paper, mechanism, thud | Stamp sequence; row slides into the book |
| Standing order filled | Row shows what filled and what is still wanted | Crisp fill click | Figures roll; the row settles from the wash |
| Short sold | Position carried against the captain; margin line appears | **The stamp** | Stamp sequence; margin line fades up 120ms |
| Position closed out by the Bourse | Notice naming the listing and what it cost | Low two-tone alert, no thud | Row flashes `--danger` once, 200ms |
| Taken out on the range | Banner across the top; nothing is real | Nothing: the range makes no ceremony | Banner fades up 160ms |
| A claim settled | Panel with what the Hall paid and what went with her | Paper, a single low tone | Panel rises 160ms; figures roll |
| Hover any control | Surface lifts to `--hover`, 1px edge brightens | Very quiet hover tick | 80ms fade |
| Press any control | Surface holds `--hover`; focus ring stays | A tick with a note under it, quieter than the stamp | 80ms hold |
| Confirm a destructive action | Dialog stating the consequence plainly | Lower, heavier confirm | 160ms modal rise |

---

## 8. Looks to avoid

Named so they do not get reintroduced as improvements. Add to this list by name
whenever an unintended look appears, then fix it.

**From the spec, never allowed:**

- Purple or indigo gradient backgrounds
- Cyan-on-black "hacker terminal" styling
- Glassmorphism blur panels
- Pill-shaped buttons
- Large rounded cards with soft drop shadows
- Emoji as icons
- Monospace type for labels or body text
- Default browser form controls or scrollbars
- Sprites from mixed sources with clashing styles
- Parchment or aged-paper textures
- Nautical or pirate props of any kind
- Skull motifs
- Ornate fantasy frames

**Also avoided in this project:**

- Border radius above 0 anywhere; corners are chamfered or square
- Centre-floating HUD elements that obscure the flight view
- Neon glow on text; bloom belongs to engines, weapons and shields only
- Amber used decoratively, which dilutes it as the player's signal colour
- Livery colours setting type; they are for hull bands, seals and stripes
- EB Garamond anywhere outside an in-world document
- Sails, rigging, tricorns, compass roses, rope borders, wax-drip seals — the
  1600s are in the institutions, not the props
- A seal with a single device off the centre, which reads as an accident
  rather than as a die somebody cut. A device repeats two, three or six times
  on the grid, never once
- A seal struck small with its strokes scaled down with it: at thirty pixels a
  1.5px rim drawn in viewBox units is a quarter of a pixel and reads as a
  smudge. Strokes are in device pixels, whatever the size
- A seal whose device runs back to the middle. Three or six of them meet
  there, an inner ring goes round them, and the mark reads as a hub with
  spokes inside a rim: a ship's wheel, which is a prop and is already
  forbidden. The device sits between the inner ring and the rim, and the
  middle of a seal is empty
- An impression struck under the control beside it. A mark is on the paper,
  not behind it
- Animated gradients, shimmer or pulsing idle states on static elements
- A refusal left standing under a panel about something else. The flight
  view keeps the last refusal on screen, which is right while a captain is
  flying and wrong the moment something larger happens to them: the
  write-off capture photographed "The port declined that" sitting under
  "Written off at Parity". A state that takes over the screen clears the
  smaller notices it has made irrelevant
- Drop-shadowed text for contrast; fix the surface instead
- Icon-only buttons without a tooltip and an accessible label
- Tooltips that restate the visible label instead of explaining the value
- A block name another screen already owns. Every stylesheet in the client is
  global, so `chart`, `panel`, `card` and the like are one shared namespace. A
  collision does not fail loudly: the element silently takes the other
  screen's rules. It has happened twice, both times from the Bourse. Its
  ranking list called itself `register`, which the sign-up screen owns, and
  handed that screen `align-content: start` — so the Register sat at the top
  of the viewport with two thirds of the screen empty under it. There is a
  test for this now: `packages/client/src/styles/namespace.test.ts` fails
  with both file names. And its price chart called itself `chart`, which is
  the galaxy map's overlay — `position: absolute; inset: 0` with a 78% `--void`
  wash — so it left its column, drew itself over the figures, and hung a sheet
  over the whole panel that read as a colour problem. It cost a day. Name a
  block after its screen.
- A row action repeated down a list in amber. One amber button is the primary
  action of a screen; one per row is a column of amber, which is the same
  dilution as using it decoratively. Row actions are plain buttons, and the
  fill is kept for the single thing the screen is for.
- A note pinned to a corner that lands on the instruments. The ticket's card
  sat bottom left and went straight through speed, shield and hull — the
  three figures a captain is actually reading. A note goes where the screen
  is empty, and in flight that is below the link plate on the right.
- A note pinned to the top edge that covers the panel header of the thing it
  is explaining. The Staple's hint covered the word "the Staple". A note may
  cover rows, vista or empty sky, which come back when it is dismissed, and
  never a title or a control.
- A fixed-width panel holding a one-line empty state, which reads as a box
  with a sentence adrift in it. A panel sizes to what it holds.
- A board that draws the hull as a small patch in an empty field. The margin
  around a draught is somewhere to aim, not somewhere to finish.
- A sentence set in `.micro`. Uppercase at `--track-micro` over two lines
  turns an aside into a shout: "TO DEMURRAGE" is a sign over a door, and the
  line on a docket is prose. `.micro` is for labels and figures beside them;
  a sentence takes `--size-label` in sentence case.
- A selected state built only from `--amber-wash`. Twelve per cent over
  `--raised` is not a state: the Factor's two chain endings read as the same
  card in a capture, and the chosen one has to carry a full `--amber` rule
  and an inset bar as well as the wash. A selection that only a difference
  engine can see is not a selection.

**Found in captures and being fixed:**

- *The centred card in a void* — a single panel floating mid-screen against
  near-black, with no backdrop and no surrounding chrome. It is the default
  shape a web app falls into. Interface screens sit on the real star-and-nebula
  backdrop with terminal chrome around them, not in empty space. *(Seen in the
  first boot captures. Fixed when M1 lands the backdrop.)*
- *Timid chamfers* — at 6px the corner cut was invisible at normal viewing size,
  so panels read as plain rectangles and the shape language did not register.
  Raised to 10px, and judged from a capture rather than from the number.
  *(Fixed.)*
- *Sparse panels* — the first roster panel reserved a fixed minimum height and
  left half of it empty, which reads as an unfinished web layout rather than an
  instrument. Density is a feature: panels size to their content. *(Being fixed
  as real screens replace the scaffold.)*

- *Conversation over the instruments* — the chat overlay was anchored a fixed
  212px from the bottom and dropped to the view's padding when the composer
  opened, which put two lines of chat across the heading and structure
  readings. A captain flying must never have a gauge covered by something
  someone else typed. Anything anchored to that corner now clears
  `--hud-instruments-clear`, open or shut. *(Seen in the first chat capture.
  Fixed.)*
- *An empty detail panel* — the chart's right-hand column showed a system's
  name, a sentence and its berths, and then four-fifths of nothing. Density is
  a feature here too: it now carries the lanes out of the selected system, so
  a route can be read in one place. *(Seen in the first chart capture. Fixed.)*

- *Controls adrift of their row* — the Staple's Buy and Sell buttons sat
  outside the table's right edge, with each row's rule stopping short of them,
  because the cell holding them was given `display: flex` and left the table's
  layout. A control that acts on a row has to sit inside it. The flex belongs
  on a wrapper inside the cell. *(Seen in the first Staple capture. Fixed.)*

*(Reviewed and extended after each screen is first captured.)*
