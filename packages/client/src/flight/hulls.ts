/**
 * The hulls this client can draw.
 *
 * The content catalogue describes every draught the game ships with, which
 * covers every NPC and every captain who has never been to a Yard. It cannot
 * describe a hull somebody built: that grid was designed after this build was
 * compiled, and it arrives on the wire as a share code on the hull's state.
 *
 * This reads like the catalogue — `get` and `has`, same shape — and learns a
 * built hull the first time it sees one. Everything downstream (the texture
 * renderer, the structure readout, the muzzle-speed lookup) therefore needs no
 * knowledge that custom hulls exist.
 *
 * A code that will not decode is remembered as unknown rather than retried,
 * because the alternative is attempting to decode the same bad code sixty
 * times a second for as long as that hull is on screen.
 */

import {
  builtBlueprint,
  decodeShareCode,
  type Blueprint,
  type LicenceId,
  type ModuleDef,
  type Tuning,
} from '@marque/shared';

/**
 * What a built hull was built under.
 *
 * The licence only decides whether a design is legal, which the server settled
 * before the hull existed. Nothing the client draws depends on it, so a hull
 * learned from the wire is recorded against the widest warrant rather than the
 * client guessing at its owner's paperwork.
 */
const ASSUMED_LICENCE: LicenceId = 'capital-charter';

export class HullBook {
  /** Codes already decoded, so a hull is decoded once however long it flies. */
  private readonly learned = new Map<string, Blueprint>();
  /** Codes that would not decode, so a bad one is attempted once. */
  private readonly rejected = new Set<string>();

  constructor(
    private readonly catalogue: ReadonlyMap<string, Blueprint>,
    private readonly modules: ReadonlyMap<string, ModuleDef>,
    private readonly tuning: Tuning,
  ) {}

  get(id: string): Blueprint | undefined {
    return this.catalogue.get(id) ?? this.learned.get(id);
  }

  has(id: string): boolean {
    return this.catalogue.has(id) || this.learned.has(id);
  }

  /** Every draught the game ships with, which is what most of the sky is flying. */
  catalogueDraughts(): Iterable<Blueprint> {
    return this.catalogue.values();
  }

  /**
   * Take in a hull seen on the wire.
   *
   * `code` empty means the id names a catalogue draught and there is nothing
   * to learn. Returns the blueprint either way, so a caller that has a hull's
   * state in hand can resolve and learn in one step.
   */
  learn(id: string, code: string, name?: string): Blueprint | undefined {
    if (code === '') return this.catalogue.get(id);

    const known = this.learned.get(id);
    if (known) return known;
    if (this.rejected.has(id)) return undefined;

    try {
      const design = decodeShareCode(code);

      // A grid naming a fitting this build has never heard of is refused
      // whole. Drawing it would mean a hull with holes where the unknown
      // modules are, and a structure readout that silently disagrees with the
      // server's. Better to draw nothing and leave the contact unresolved.
      const unknown = design.placements.find(
        (placement) => !this.modules.has(placement.moduleId),
      );
      if (unknown) throw new Error(`unknown fitting "${unknown.moduleId}"`);

      const blueprint = builtBlueprint(
        { id, name: name ?? design.name, placements: design.placements },
        ASSUMED_LICENCE,
        this.tuning,
      );
      this.learned.set(id, blueprint);
      return blueprint;
    } catch {
      this.rejected.add(id);
      return undefined;
    }
  }

  /** How many built hulls this client has learned, for the diagnostics. */
  get learnedCount(): number {
    return this.learned.size;
  }
}
