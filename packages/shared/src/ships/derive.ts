/**
 * Derived ship statistics.
 *
 * One derivation for every hull in the game: the starter ship, player designs
 * and NPC ships all come through here. Handling falls out of the layout, so two
 * captains with the same budget build ships that fly differently.
 *
 * Deterministic and allocation-light: the soak sim derives thousands of these.
 */

import { clamp } from '../math/scalar.ts';
import type { ModuleDef, Tuning } from '../content/schema.ts';
import type { ShipProfile } from '../sim/profile.ts';
import {
  boundsOf,
  centreOfMass,
  leverArm,
  momentOfInertia,
  type Bounds,
  type PlacedModule,
} from './geometry.ts';

/** What a ship is carrying, which is mass like anything else. */
export interface Loadout {
  /** Units of cargo in the hold. */
  readonly cargo: number;
  /** Units of Propellant in the tanks. */
  readonly propellant: number;
}

export const EMPTY_LOADOUT: Loadout = { cargo: 0, propellant: 0 };

/** Everything derived from a blueprint plus what it is carrying. */
export interface ShipStats {
  /** Flight performance, in the shape the simulation step consumes. */
  readonly profile: ShipProfile;

  readonly hullMass: number;
  readonly cargoMass: number;
  readonly propellantMass: number;
  readonly totalMass: number;

  readonly thrust: number;
  readonly torque: number;
  readonly momentOfInertia: number;
  readonly centreOfMass: { x: number; y: number };
  readonly bounds: Bounds;

  readonly powerOutput: number;
  readonly powerDraw: number;

  readonly cargoCapacity: number;
  readonly propellantCapacity: number;

  readonly shieldCapacity: number;
  readonly shieldRegen: number;
  readonly shieldDelay: number;

  /** Sum of module hit points: the ship's structure. */
  readonly structure: number;
  /** Structure below which the ship is written off. */
  readonly writeOffStructure: number;

  readonly moduleCount: number;
}

/**
 * Derive stats from the modules that are still intact.
 *
 * Pass only undamaged modules to get a damaged ship's current performance:
 * losing an engine costs thrust, and losing an outboard plate moves the balance
 * point and changes how the ship turns.
 */
export function deriveStats(
  modules: readonly PlacedModule[],
  tuning: Tuning,
  loadout: Loadout = EMPTY_LOADOUT,
): ShipStats {
  const bounds = boundsOf(modules);

  // Cargo rides in the bays and Propellant in the tanks, so carried mass sits
  // where those fittings sit. That moves the balance point and raises the
  // inertia: a full hold does not just accelerate worse, it turns worse.
  let totalCargoCapacity = 0;
  let totalTankCapacity = 0;
  for (const module of modules) {
    totalCargoCapacity += module.def.cargoCapacity ?? 0;
    totalTankCapacity += module.def.propellantCapacity ?? 0;
  }

  const carriedCargo = Math.min(loadout.cargo, totalCargoCapacity);
  const carriedPropellant = Math.min(loadout.propellant, totalTankCapacity);

  const massOf = (module: PlacedModule): number => {
    let m = module.def.mass;
    const bay = module.def.cargoCapacity;
    if (bay !== undefined && totalCargoCapacity > 0) {
      m += carriedCargo * (bay / totalCargoCapacity) * tuning.mass.tonnesPerCargoUnit;
    }
    const tank = module.def.propellantCapacity;
    if (tank !== undefined && totalTankCapacity > 0) {
      m += carriedPropellant * (tank / totalTankCapacity) * tuning.mass.tonnesPerPropellantUnit;
    }
    return m;
  };

  const com = centreOfMass(modules, massOf);
  const inertia = momentOfInertia(modules, com, massOf);

  let hullMass = 0;
  let thrust = 0;
  let torque = 0;
  let powerOutput = 0;
  let powerDraw = 0;
  let cargoCapacity = 0;
  let propellantCapacity = 0;
  let shieldCapacity = 0;
  let shieldRegen = 0;
  let shieldDelay = 0;
  let structure = 0;

  for (const module of modules) {
    const def: ModuleDef = module.def;
    hullMass += def.mass;
    structure += def.hitPoints;
    powerOutput += def.power.output ?? 0;
    powerDraw += def.power.draw ?? 0;
    thrust += def.thrust ?? 0;
    cargoCapacity += def.cargoCapacity ?? 0;
    propellantCapacity += def.propellantCapacity ?? 0;

    if (def.shieldCapacity !== undefined) {
      shieldCapacity += def.shieldCapacity;
      shieldRegen += def.shieldRegen ?? 0;
      // Several generators recover on the longest delay among them.
      shieldDelay = Math.max(shieldDelay, def.shieldDelay ?? 0);
    }

    if (def.torque !== undefined) {
      // Leverage: a thruster further from the balance point turns the ship
      // harder. This is what makes outboard mounting the right answer.
      const arm = leverArm(module, com);
      const leverage = clamp(
        1 + arm / tuning.thrusters.referenceArm,
        1,
        tuning.thrusters.maxLeverageMultiplier,
      );
      torque += def.torque * leverage;
    }
  }

  const cargoMass = carriedCargo * tuning.mass.tonnesPerCargoUnit;
  const propellantMass = carriedPropellant * tuning.mass.tonnesPerPropellantUnit;
  const totalMass = hullMass + cargoMass + propellantMass;

  const thrustAccel = totalMass > 0 ? thrust / totalMass : 0;
  const turnAccel = inertia > 0 ? torque / inertia : 0;

  const flight = tuning.flight;
  const topSpeed = clamp(
    flight.topSpeedCoefficient * Math.pow(thrustAccel, flight.topSpeedExponent),
    flight.minTopSpeed,
    flight.maxTopSpeed,
  );
  const maxTurnRate = clamp(
    flight.turnRateCoefficient * Math.pow(turnAccel, flight.turnRateExponent),
    flight.minTurnRate,
    flight.maxTurnRate,
  );

  const profile: ShipProfile = {
    thrustAccel,
    topSpeed,
    turnAccel,
    maxTurnRate,
    turnDamping: flight.turnDampingBase,
    mass: totalMass,
  };

  return {
    profile,
    hullMass,
    cargoMass,
    propellantMass,
    totalMass,
    thrust,
    torque,
    momentOfInertia: inertia,
    centreOfMass: com,
    bounds,
    powerOutput,
    powerDraw,
    cargoCapacity,
    propellantCapacity,
    shieldCapacity,
    shieldRegen,
    shieldDelay,
    structure,
    writeOffStructure: structure * tuning.hull.structureWriteOffFraction,
    moduleCount: modules.length,
  };
}

/** Total credit cost of a design, before any insurance premium. */
export function hullCost(modules: readonly PlacedModule[]): number {
  return modules.reduce((sum, module) => sum + module.def.cost, 0);
}

/** Combined bill of materials for a design, in commodity units. */
export function billOfMaterials(modules: readonly PlacedModule[]): Map<string, number> {
  const bom = new Map<string, number>();
  for (const module of modules) {
    for (const [commodity, amount] of Object.entries(module.def.bom)) {
      if (amount === undefined) continue;
      bom.set(commodity, (bom.get(commodity) ?? 0) + amount);
    }
  }
  return bom;
}
