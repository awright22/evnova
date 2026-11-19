# Art direction

**Direction: working spacecraft.** Industrial and instrument-like. The interface
reads as avionics and shipping manifests; the ships read as machines somebody
maintains. Information density is a feature.

This file is the reference for every visual and audio decision. Tokens here are
the source of truth and are mirrored as CSS custom properties in
`packages/client/src/styles/tokens.css`. If a value needs to change, change it
here and regenerate, never hard-code a colour or a duration in a component.

---

## 1. Colour

A deep, desaturated navy-charcoal base. **Amber is the one signal colour** for
the player and for interactive elements. Cool white carries data. Red is danger
and hostiles only.

### Surfaces

| Token | Value | Use |
|---|---|---|
| `--bg-void` | `#05070b` | Space itself, behind the star layers |
| `--bg-base` | `#0b1016` | Screen background when landed |
| `--bg-raised` | `#121924` | Panel background |
| `--bg-panel` | `#161f2b` | Panel header, raised rows |
| `--bg-inset` | `#080c12` | Wells: input fields, grid backgrounds, charts |
| `--bg-hover` | `#1d2836` | Row and control hover |
| `--bg-active` | `#243141` | Pressed state |

### Rules and edges

| Token | Value | Use |
|---|---|---|
| `--line` | `#22303f` | Default 1px rule and panel border |
| `--line-strong` | `#32475c` | Section divisions, table headers |
| `--line-faint` | `#161f2b` | Interior grid lines, dense tables |

### Text

| Token | Value | Use |
|---|---|---|
| `--text-primary` | `#e6edf5` | Headings, primary data |
| `--text-secondary` | `#9fb0c3` | Body copy, descriptions |
| `--text-muted` | `#6b7f94` | Labels, units, secondary annotation |
| `--text-disabled` | `#495a6c` | Disabled controls |
| `--text-on-amber` | `#1a1205` | Text on an amber fill |

### Amber — the player, and anything interactive

| Token | Value | Use |
|---|---|---|
| `--amber` | `#f0a637` | Player ship marker, focus ring, primary action |
| `--amber-bright` | `#ffc266` | Hover, active readout, engine core |
| `--amber-dim` | `#a8701f` | Inactive-but-available, chart axis emphasis |
| `--amber-wash` | `rgba(240,166,55,0.12)` | Selected row, active tab fill |
| `--amber-glow` | `#ffb74d` | Additive bloom source for engines and sparks |

### Danger — hostiles and alerts only

| Token | Value | Use |
|---|---|---|
| `--danger` | `#e04b3a` | Hostile markers, wanted status, alert borders |
| `--danger-bright` | `#ff6b56` | Incoming-fire flash, critical alert |
| `--danger-dim` | `#8f2a1e` | Damaged-module overlay, depleted bar track |
| `--danger-wash` | `rgba(224,75,58,0.14)` | Alert banner fill |

### Market gain and loss — inside market screens only

Deliberately *not* the danger red: loss leans crimson, danger leans orange, so a
falling share price never reads as someone shooting at you.

| Token | Value | Use |
|---|---|---|
| `--gain` | `#4fb07a` | Positive change, bid side |
| `--loss` | `#d8566a` | Negative change, ask side |
| `--gain-wash` | `rgba(79,176,122,0.14)` | Candle body, positive row |
| `--loss-wash` | `rgba(216,86,106,0.14)` | Candle body, negative row |

### Status

| Token | Value | Use |
|---|---|---|
| `--shield` | `#5fa8d3` | Shield bars and impact ripples |
| `--hull` | `#c3ccd6` | Structure bars |
| `--fuel` | `#b8912e` | Fuel gauge |
| `--caution` | `#d9a441` | Non-critical warnings |

### Faction liveries

One livery colour each, so a hull's allegiance is readable at a glance.

| Faction | Primary | Accent |
|---|---|---|
| Registry Authority | `#cfe0f0` | `#5b7fa6` |
| Haulers' Compact | `#7c8b3f` | `#b8912e` |
| Tailings Combine | `#a4552c` | `#c98b5e` |
| Pirates | `#5a5f66` | `#3c4044` |
| Independents | `#8a94a0` | `#5d6670` |

### Region nebula hues

One hue per region, desaturated enough that the Tailings never reads as an
alert.

| Region | Nebula | Star tint |
|---|---|---|
| The Spine | `#2b4a6b` | `#dce8f5` hard white |
| The Slack | `#3f6b5c` | `#cfe0d4` soft green-white |
| The Tailings | `#6b3a28` | `#f0d2b8` low warm |

### Colour-vision-safe option

A settings toggle that: replaces the gain/loss pair with `--gain` → `#5aa9d6`
(blue) and `--loss` → `#d8853a` (orange); adds a shape or arrow to every
colour-coded market cell; and switches hostile markers from colour-only to a
filled triangle against the player's hollow diamond. Never colour alone to carry
meaning.

---

## 2. Type

Two openly licensed faces, self-hosted from `@fontsource` packages. Every number
is tabular.

| Role | Face | Licence |
|---|---|---|
| Interface text, data | **IBM Plex Sans** | OFL 1.1 |
| Headings, ship names | **Barlow Condensed** | OFL 1.1 |

Tabular figures are mandatory on anything numeric: `font-variant-numeric:
tabular-nums`. A column of prices that shifts as digits change is a bug.

### Scale

Sizes in px / line-height in px. 8px grid, dense by intent.

| Token | Face | Size/Leading | Weight | Treatment |
|---|---|---|---|---|
| `--type-display` | Barlow Condensed | 32/36 | 600 | Title screen, port name |
| `--type-h1` | Barlow Condensed | 24/28 | 600 | Screen heading |
| `--type-h2` | Barlow Condensed | 19/24 | 600 | Panel heading |
| `--type-h3` | Barlow Condensed | 16/20 | 600 | uppercase, `0.06em` tracking |
| `--type-body` | IBM Plex Sans | 14/20 | 400 | Descriptions, prose |
| `--type-body-sm` | IBM Plex Sans | 13/18 | 400 | Dense tables, tooltips |
| `--type-label` | IBM Plex Sans | 12/16 | 500 | uppercase, `0.08em`, `--text-muted` |
| `--type-data` | IBM Plex Sans | 14/20 | 500 | tabular, `--text-primary` |
| `--type-data-lg` | IBM Plex Sans | 20/24 | 600 | tabular, headline figures |
| `--type-micro` | IBM Plex Sans | 11/14 | 500 | uppercase, `0.1em`, units and stamps |

Interface scale setting multiplies every size by 0.875, 1, 1.125 or 1.25 and
rounds to the nearest whole pixel.

---

## 3. Space and shape

**Spacing.** An 8px grid with 4px and 12px as permitted half-steps:
`--space-0.5: 4px`, `--space-1: 8px`, `--space-1.5: 12px`, `--space-2: 16px`,
`--space-3: 24px`, `--space-4: 32px`, `--space-6: 48px`, `--space-8: 64px`.

**Panels.** Squared, with a small chamfer cut from the corners — an actual
diagonal cut via `clip-path`, never a border radius.

| Token | Value |
|---|---|
| `--chamfer-lg` | `6px` (screen-level panels) |
| `--chamfer-sm` | `3px` (buttons, chips, inputs) |
| `--border-width` | `1px` |

**Elevation.** No soft drop shadows. Depth comes from a 1px lighter top edge and
a 1px darker bottom edge, plus the surface ramp. The only shadow in the game is
a hard 1px offset used for the focus ring's outer contrast.

**Controls.** Minimum hit target 28px tall, 24px for dense table controls.
Buttons are rectangular with `--chamfer-sm`. Every interactive element has
hover, focus, pressed and disabled states; focus is a 2px `--amber` ring offset
1px, visible on keyboard focus only.

**Framing.** In flight the HUD is a cockpit overlay: readouts anchored to the
screen edges, nothing floating in the middle. Landed, every screen is the ship's
terminal connected to the port — one chrome, one icon set, a persistent header
carrying port name, credits, fuel and standing.

**Icons.** One set, drawn in code as 16px and 24px SVG on a 2px stroke grid,
square caps, no filled glyphs except status dots. Emoji are never icons.

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
| `--ease-emphasis` | `cubic-bezier(0.2, 0, 0, 1)` | Arriving content |

Nothing appears or disappears without a transition. Screens cross-fade with a
4px vertical offset; panels wipe open from their header edge.

**Reduced motion.** When set: no camera shake, no screen offset, no scaling
entrances, no parallax response to the cursor. Opacity fades remain at
`--motion-instant`. Gameplay-critical motion (ships, projectiles) is never
reduced — only presentation.

---

## 5. Space, ships and effects

### Backdrop

Near-black `--bg-void` with, back to front:

1. **Star layer 3** — 1px points, 0.08 parallax, opacity 0.35, ~900 per screen.
2. **Star layer 2** — 1px–2px points, 0.18 parallax, opacity 0.6, ~400.
3. **Star layer 1** — 2px points with a faint cross flare, 0.35 parallax,
   opacity 0.9, ~120.
4. **Dust** — drifting 1px motes, 0.65 parallax, opacity 0.25, additive.
5. **Nebula** — a shader field in the region hue: two octaves of value noise,
   domain-warped, 0.5 parallax, screen-blended at 0.22 opacity. Never a linear
   gradient.

The system's star tints all scene lighting and casts a directional rim on every
hull from the star's actual position.

### Ships

Every module tile is drawn by one procedural system so any player design looks
intentional: a 2px darker outline, interior panel lines on a 4px grid, a 1px
top-left highlight and bottom-right shade, livery accents on designated faces,
lit windows on habitable modules, and glowing nozzles on engines. Players pick
two paint colours; the renderer derives a third shade for panel lines.

Each blueprint renders once to a texture; damage draws as overlays on top —
scorch at 50% module health, a blown-panel overlay plus venting at 0%.

### Effect recipes

**Engine plume.** Length `18 + 46 × throttle` px, additive, core
`--amber-bright` to edge `--amber-glow` at 35% alpha, 2px turbulence at 12Hz,
plus a 1px bloom pass. Cuts to a 6px idle glow at zero throttle over 90ms.

**Projectile trail.** 8-segment ribbon fading to zero alpha over 140ms, width
tapering 3px → 0.5px, additive in the weapon's colour.

**Shield hit.** A ripple centred on the impact point: an expanding arc clipped to
the shield ellipse, 180ms, `--shield` at 0.8 alpha fading out, with a 6px
chromatic smear at the contact normal.

**Hull hit.** 10 radial sparks over 220ms with gravity-free linear decay, a 2px
white flash for one frame, and a persistent 4px scorch decal.

**Explosion, by stages.** Flash (one frame, white, 1.6× hull radius) → fireball
(220ms, `--amber-bright` → `--danger` → smoke, additive) → sparks (30 particles,
500ms) → tumbling debris (4–9 module-shaped pieces with angular velocity,
2.5s) → shockwave (a 1px expanding ring with refraction, 320ms) → smoke
(drifting, 1.8s, 0.3 alpha). Scale all durations by `0.8 + 0.4 × hullSize`.

**Hyperjump.** Spool: a 4s rising ring around the ship plus a radial streak
building to full. Release: scene stretches along the jump axis over 260ms with
chromatic separation, then a white wipe. Arrival: the reverse over 320ms.

### Camera

Smooth follow with a time constant of 120ms. Velocity look-ahead of
`velocity × 0.35s`, clamped to 220px. Zoom eases from 1.0 at rest to 0.82 at top
speed. Impact shake is restrained: 6px maximum amplitude decaying over 220ms,
and disabled entirely under reduced motion.

### Planets and port vistas

Procedural shader planets: a lit sphere with a terminator softened by an
atmosphere shell, two-octave surface noise in the planet's palette, night-side
city lights where the port is inhabited, and a thin atmospheric rim lit by the
system star. Never a photograph.

---

## 6. Audio

Web Audio throughout, with positional panning and distance falloff. Every file
is loudness-normalised to **-23 LUFS** with a -1 dBTP ceiling, so no single
sound jumps out of the mix.

**Buses.** master → {music, effects, interface}, each with its own volume
setting. Music ducks 6 dB under alerts over 120ms and recovers over 400ms.

**Engine.** A loop whose playback rate follows throttle from 0.82 to 1.18 and
whose gain follows it from 0.15 to 0.7, both smoothed over 80ms.

**Distance model.** Inverse falloff, reference distance 400 units, max 6000,
rolloff 1.1. Stereo panning from the camera-relative x offset, clamped to ±0.85
so nothing hard-pans.

**Music.** One ambient bed per region, plus a combat layer that crossfades in
over 1.5s when a hostile is within 2500 units and out over 4s once clear.

Sources are openly licensed where they fit the direction; anything that cannot
be sourced is synthesised in Web Audio. Licences are recorded in `CREDITS.md`.

---

## 7. Feedback table

Every player action and world event, with its response in each channel. A row
with a blank cell is unfinished work. Minimum two channels per row.

| Event | Visual | Audio | Motion |
|---|---|---|---|
| Thrust | Plume extends, engine glow blooms | Engine loop rate and gain rise | Camera zooms out toward 0.82, look-ahead extends |
| Turn | Maneuvering jets puff on the outboard side | Short thruster hiss, panned to the jet | Hull rolls 4° into the turn, HUD horizon tilts |
| Fire gun | Muzzle flash, tracer with trail | Dry mechanical report | 2px recoil kick along the barrel axis |
| Fire turret | Barrel swings to lead, muzzle flash | Softer report, slight pitch variance per shot | Turret rotation eased over 120ms |
| Fire missile | Rack door, launch bloom, thick trail | Rail clunk then a receding roar | 3px launch shove, rack icon decrements |
| Hit dealt | Impact spark on the target, damage number ticks | Confirming thud, pitched by damage | Crosshair pips flare outward 120ms |
| Hit taken on shields | Shield ripple at the impact point | Resonant shield ring | 2px shake, shield bar pulses |
| Hit taken on hull | Sparks, white flash, scorch decal | Dull structural bang | 5px shake, hull bar pulses red |
| Module disabled | Module greys, vents, status tile goes dark | Power-down whine, warning chirp | Tile flips to its disabled face over 160ms |
| Ship destroyed | Full staged explosion, debris, canisters | Layered boom by hull size, debris patter | 6px shake, 180ms slow-motion dip |
| Target acquired | Bracket snaps on, range and bars appear | Soft two-tone lock | Bracket scales 1.3 → 1.0 over 120ms |
| Jump spool | Rising ring, radial streaks, countdown | Rising harmonic spool, 4s | Ring rotates, HUD edges pull inward |
| Jump | Scene stretches, chromatic split, white wipe | Spool releases into a deep whump | 260ms stretch along the jump axis |
| Arrival | Reverse wipe, lane beacon flares | Arrival chime, ambience crossfades | 320ms settle, 2px overshoot |
| Land | Approach vista, berth lights, iris to port screen | Docking clamps, hull creak, ambience shift | 200ms iris, HUD retracts upward |
| Launch | Berth recedes, HUD deploys | Clamps release, engine spins up | 200ms iris out, HUD slides down |
| Buy | Row flashes amber, credits tick down | Two-tone confirm, lower pitch | Quantity counter rolls over 160ms |
| Sell | Row flashes amber, credits tick up | Two-tone confirm, higher pitch | Counter rolls, hold indicator shrinks |
| Insufficient funds | Credits readout flashes `--danger`, field outlines red | Flat error buzz | Field shakes 3px twice over 160ms |
| Order filled | Ticket collapses to a filled row, news line appears | Crisp fill click | Row slides into the ledger over 160ms |
| Dividend received | Credits tick up, portfolio row shows a `+` badge | Soft three-note chime | Badge fades in over 200ms, then out |
| Mission accepted | Board row stamps `ACCEPTED`, objective docks in HUD | Paper-and-stamp confirm | Objective slides into the HUD over 160ms |
| Mission complete | Objective ticks, reward line itemises | Resolving two-note chime | Objective lifts out, credits roll |
| Chat message | Line appears in the overlay, channel tab marks unread | Quiet tick, interface bus | Line fades up 4px over 120ms |
| Player enters system | Radar contact appears, roster line added | Distant beacon ping | Contact scales in over 120ms |
| Hover any control | Surface lifts to `--bg-hover`, 1px edge brightens | Very quiet hover tick | 80ms fade |
| Confirm a destructive action | Dialog with the consequence stated plainly | Lower, heavier confirm | 160ms modal rise |

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

**Also avoided in this project:**

- Border radius above 0 anywhere; corners are chamfered or square
- Centre-floating HUD elements that obscure the flight view
- Neon glow on text; bloom belongs to engines, weapons and shields only
- Saturated red for anything that is not danger or a hostile
- Amber used decoratively, which dilutes it as the player's signal colour
- Full-width progress bars where a compact gauge fits the density
- Animated gradients, shimmer or pulsing idle states on static elements
- Drop-shadowed text for contrast; fix the surface instead
- Icon-only buttons without a tooltip and an accessible label
- Tooltips that restate the visible label instead of explaining the value

*(Reviewed and extended after each screen is first captured.)*
