/**
 * Content loading.
 *
 * Data files are validated against their schemas here, once, so a bad number
 * fails at startup with a readable path rather than surfacing as a strange
 * simulation result later. The loaded content is immutable and shared.
 */

import blueprintData from '../../data/blueprints.json' with { type: 'json' };
import moduleData from '../../data/modules.json' with { type: 'json' };
import systemData from '../../data/systems.json' with { type: 'json' };
import tuningData from '../../data/tuning.json' with { type: 'json' };

import type {
  Blueprint,
  LicenceDef} from './schema.ts';
import {
  BlueprintLibrary,
  ModuleCatalogue,
  SystemLibrary,
  Tuning,
  type LicenceId,
  type ModuleDef,
  type SystemDef,
} from './schema.ts';

export interface Content {
  readonly tuning: Tuning;
  readonly modules: ReadonlyMap<string, ModuleDef>;
  readonly blueprints: ReadonlyMap<string, Blueprint>;
  readonly licences: ReadonlyMap<LicenceId, LicenceDef>;
  readonly systems: ReadonlyMap<string, SystemDef>;
}

/**
 * Validate and index every data file.
 *
 * Throws with the failing path if anything is wrong, which is what we want at
 * server start: a malformed catalogue should stop the boot, not corrupt a
 * world.
 */
export function loadContent(): Content {
  const tuning = parse(Tuning, stripComments(tuningData), 'data/tuning.json');
  const catalogue = parse(ModuleCatalogue, stripComments(moduleData), 'data/modules.json');
  const library = parse(BlueprintLibrary, stripComments(blueprintData), 'data/blueprints.json');
  const systemLibrary = parse(SystemLibrary, stripComments(systemData), 'data/systems.json');

  const modules = new Map<string, ModuleDef>();
  for (const module of catalogue.modules) {
    if (modules.has(module.id)) throw new Error(`duplicate module id "${module.id}"`);
    modules.set(module.id, module);
  }

  const blueprints = new Map<string, Blueprint>();
  for (const blueprint of library.blueprints) {
    if (blueprints.has(blueprint.id)) {
      throw new Error(`duplicate blueprint id "${blueprint.id}"`);
    }
    for (const placement of blueprint.placements) {
      if (!modules.has(placement.moduleId)) {
        throw new Error(
          `blueprint "${blueprint.id}" references unknown module "${placement.moduleId}"`,
        );
      }
    }
    blueprints.set(blueprint.id, blueprint);
  }

  const licences = new Map<LicenceId, LicenceDef>(
    Object.entries(tuning.licences) as [LicenceId, LicenceDef][],
  );

  const systems = new Map<string, SystemDef>();
  for (const system of systemLibrary.systems) {
    if (systems.has(system.id)) throw new Error(`duplicate system id "${system.id}"`);
    const portIds = new Set<string>();
    for (const port of system.ports) {
      if (portIds.has(port.id)) {
        throw new Error(`system "${system.id}" has two ports called "${port.id}"`);
      }
      portIds.add(port.id);
    }
    systems.set(system.id, system);
  }

  // The draught a new captain is given has to exist, or sign-up fails at the
  // one moment a player cannot route around.
  if (!blueprints.has(tuning.start.draught)) {
    throw new Error(`start draught "${tuning.start.draught}" is not a known draught`);
  }

  // And the system they are set down in, for the same reason.
  if (!systems.has(tuning.start.system)) {
    throw new Error(`start system "${tuning.start.system}" is not a known system`);
  }

  // Hyperlanes run both ways. A one-sided link would strand a captain, so it
  // fails the boot rather than the jump.
  for (const system of systems.values()) {
    for (const link of system.links) {
      const other = systems.get(link);
      if (!other) {
        throw new Error(`system "${system.id}" links to unknown system "${link}"`);
      }
      if (!other.links.includes(system.id)) {
        throw new Error(
          `hyperlane "${system.id}" to "${link}" is one-sided: "${link}" does not link back`,
        );
      }
    }
  }

  return { tuning, modules, blueprints, licences, systems };
}

/**
 * Remove `$comment` keys at every depth.
 *
 * Data files carry their own documentation — the reasoning behind a number
 * belongs next to the number — but a schema should not have to model that.
 */
function stripComments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripComments);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !key.startsWith('$'))
        .map(([key, child]) => [key, stripComments(child)]),
    );
  }
  return value;
}

function parse<T>(schema: { safeParse: (input: unknown) => { success: boolean; data?: T; error?: { issues: { path: PropertyKey[]; message: string }[] } } }, input: unknown, file: string): T {
  const result = schema.safeParse(input);
  if (!result.success || result.data === undefined) {
    const issues = (result.error?.issues ?? [])
      .map((issue) => `  ${file}:${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid content in ${file}:\n${issues}`);
  }
  return result.data;
}

/** The validated content, loaded once per process. */
let cached: Content | undefined;

export function content(): Content {
  cached ??= loadContent();
  return cached;
}
