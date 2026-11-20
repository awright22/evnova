/**
 * Content loading.
 *
 * Data files are validated against their schemas here, once, so a bad number
 * fails at startup with a readable path rather than surfacing as a strange
 * simulation result later. The loaded content is immutable and shared.
 */

import blueprintData from '../../data/blueprints.json' with { type: 'json' };
import commodityData from '../../data/commodities.json' with { type: 'json' };
import commissionData from '../../data/commissions.json' with { type: 'json' };
import companyData from '../../data/companies.json' with { type: 'json' };
import moduleData from '../../data/modules.json' with { type: 'json' };
import systemData from '../../data/systems.json' with { type: 'json' };
import tuningData from '../../data/tuning.json' with { type: 'json' };

import { selfDealingReturn } from '../economy/pool.ts';

import type {
  Blueprint,
  LicenceDef} from './schema.ts';
import {
  BlueprintLibrary,
  CommissionBook,
  CommodityCatalogue,
  CompanyRegister,
  ModuleCatalogue,
  SystemLibrary,
  Tuning,
  type ChainDef,
  type CommissionTemplate,
  type CommodityDef,
  type CompanyDef,
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
  readonly commodities: ReadonlyMap<string, CommodityDef>;
  /** The listed companies, by ticker. */
  readonly companies: ReadonlyMap<string, CompanyDef>;
  /** Commission templates and the three hand-written chains. */
  readonly commissions: { templates: CommissionTemplate[]; chains: ChainDef[] };
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
  const commodityCatalogue = parse(
    CommodityCatalogue,
    stripComments(commodityData),
    'data/commodities.json',
  );
  const catalogue = parse(ModuleCatalogue, stripComments(moduleData), 'data/modules.json');
  const library = parse(BlueprintLibrary, stripComments(blueprintData), 'data/blueprints.json');
  const systemLibrary = parse(SystemLibrary, stripComments(systemData), 'data/systems.json');
  const register = parse(CompanyRegister, stripComments(companyData), 'data/companies.json');

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

  const commodities = new Map<string, CommodityDef>();
  for (const commodity of commodityCatalogue.commodities) {
    if (commodities.has(commodity.id)) {
      throw new Error(`duplicate commodity id "${commodity.id}"`);
    }
    commodities.set(commodity.id, commodity);
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

  // Invariant 6 is a property of the tuning, not of the code around it: if
  // this product reaches one, a captain can buy shares, spend to lift that
  // company's earnings, and sell for more than they spent, and no amount of
  // care elsewhere will stop them. Refusing to boot is the only honest
  // response to a world that cannot hold its own invariant.
  const capture = selfDealingReturn(
    tuning.exchange.smoothing,
    tuning.exchange.multiple,
    tuning.exchange.holdingCap,
  );
  if (capture >= 1) {
    throw new Error(
      `data/tuning.json: exchange.smoothing * multiple * holdingCap is ${capture.toFixed(3)}, ` +
        'which is one or more. Self-dealing would pay: a captain could lift a company\'s ' +
        'earnings by a mark and gain at least a mark on their own holding. Invariant 6 ' +
        'requires this below one.',
    );
  }

  const companies = new Map<string, CompanyDef>();
  for (const company of register.companies) {
    if (companies.has(company.ticker)) {
      throw new Error(`duplicate ticker "${company.ticker}"`);
    }
    // A listing that earns on its modules must name a maker the catalogue
    // knows, or the Exchange would credit nobody and the stock would sit at
    // its floor for ever with no way to tell why.
    for (const rule of company.earns) {
      if (rule.kind === 'modules-sold') {
        const made = [...modules.values()].some((m) => m.manufacturer === rule.manufacturer);
        if (!made) throw new Error(`${company.ticker} earns on "${rule.manufacturer}", which makes nothing`);
      }
      if (rule.kind === 'goods-sold') {
        for (const commodityId of rule.commodities) {
          if (!commodities.has(commodityId)) {
            throw new Error(`${company.ticker} earns on "${commodityId}", which is not a good`);
          }
        }
        if (company.ports === undefined) {
          throw new Error(`${company.ticker} earns on goods leaving its ports but names none`);
        }
      }
    }
    if (company.poolShares > company.float) {
      throw new Error(`${company.ticker}'s pool holds more shares than are in issue`);
    }
    companies.set(company.ticker, company);
  }

  const commissions = parse(
    CommissionBook,
    stripComments(commissionData),
    'data/commissions.json',
  );

  // Every place a commission names has to exist, or a captain is sent
  // somewhere there is nothing. Checked at startup rather than discovered by
  // a player who flew four jumps to an empty lane.
  for (const chain of commissions.chains) {
    for (const [index, step] of chain.steps.entries()) {
      if (step.toSystem !== undefined && !systems.has(step.toSystem)) {
        throw new Error(`chain "${chain.id}" step ${index} sends a captain to "${step.toSystem}"`);
      }
      if (step.toPort !== undefined) {
        const exists = [...systems.values()].some((system) =>
          system.ports.some((port) => port.id === step.toPort),
        );
        if (!exists) throw new Error(`chain "${chain.id}" step ${index} names berth "${step.toPort}"`);
      }
      if (step.commodity !== undefined && !commodities.has(step.commodity)) {
        throw new Error(`chain "${chain.id}" step ${index} asks for "${step.commodity}"`);
      }
    }
  }
  for (const template of commissions.templates) {
    for (const commodityId of template.commodities) {
      if (!commodities.has(commodityId)) {
        throw new Error(`commission "${template.id}" asks for "${commodityId}", which is not a good`);
      }
    }
  }

  return {
    tuning,
    modules,
    blueprints,
    licences,
    systems,
    commodities,
    companies,
    commissions,
  };
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
