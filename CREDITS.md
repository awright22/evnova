# Credits

Every third-party asset in this project, with its author, source and licence.
An entry lands here in the same commit as the asset it describes.

Allowed licences: CC0, CC-BY, OFL, MIT, Apache-2.0, BSD. Not allowed:
non-commercial, no-derivatives, share-alike, "free for personal use", unclear
or missing licences, and anything extracted from a commercial game.

Nothing in this project comes from Escape Velocity Nova or any other commercial
game: no names, text, art or audio.

---

## Fonts

*None vendored yet. Fonts land with the first interface work in M1.*

Planned, both self-hosted from `@fontsource` packages:

| Asset | Author | Source | Licence |
|---|---|---|---|
| IBM Plex Sans | IBM / Bold Monday | `@fontsource/ibm-plex-sans` | OFL 1.1 |
| Barlow Condensed | Jeremy Tribby | `@fontsource/barlow-condensed` | OFL 1.1 |

## Audio

*None vendored yet.*

Per `docs/HUMAN_TODO.md`, audio sources are not reachable from the build
environment, so sounds are synthesised in Web Audio. Synthesised audio is
original work and needs no entry here; if sourced audio is added later, it is
listed with its author and licence.

## Art

Ship, module, planet and nebula art is procedural: generated in code from the
rules in `docs/ART_DIRECTION.md`. The icon set is drawn in code as SVG. All of
it is original work.

## Libraries

Runtime dependencies are listed in each package's `package.json` with their
licences resolvable through `pnpm licenses list`. They are not vendored assets
and are not itemised here.
