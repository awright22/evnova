/**
 * Schemas for the content data in `packages/shared/data/`.
 *
 * Every data file is validated at server start, so a bad number fails loudly at
 * boot rather than quietly in the simulation. The inferred types are the ones
 * the rest of the codebase uses: there is no second hand-written interface to
 * drift out of sync.
 */

import { z } from 'zod';

/** The ten commodities, by their plain data keys. */
export const CommodityId = z.enum([
  'ore',
  'ice',
  'grain',
  'alloy',
  'propellant',
  'provisions',
  'machinery',
  'circuitry',
  'ordnance',
  'leaf',
]);
export type CommodityId = z.infer<typeof CommodityId>;

/** Tickers of the listed companies that manufacture modules. */
export const ManufacturerId = z.enum(['HRC', 'SLP', 'RPO']);
export type ManufacturerId = z.infer<typeof ManufacturerId>;

export const ModuleType = z.enum([
  'bridge',
  'hull',
  'armour',
  'engine',
  'thruster',
  'reactor',
  'shield',
  'weapon',
  'turret',
  'rack',
  'cargo',
  'tank',
]);
export type ModuleType = z.infer<typeof ModuleType>;

const Footprint = z.object({
  width: z.int().min(1).max(8),
  height: z.int().min(1).max(8),
});

/** What a weapon module does. Only weapon, turret and rack modules carry one. */
export const WeaponDef = z.object({
  /** Damage per round, before shields. */
  damage: z.number().positive(),
  roundsPerSecond: z.number().positive(),
  /** Muzzle velocity in units per second. */
  projectileSpeed: z.number().positive(),
  /** Maximum distance a round travels before it expires. */
  range: z.number().positive(),
  /** Random angular spread in radians, applied from a seeded generator. */
  spread: z.number().min(0).default(0),
  /** Turrets only: half-arc the mount can traverse, in radians. */
  arc: z.number().positive().optional(),
  /** Turrets only: traverse rate in radians per second. */
  tracking: z.number().positive().optional(),
  /** Racks only: turn rate of the round, in radians per second. */
  homing: z.number().positive().optional(),
  /** Racks only: units of Ordnance each shot consumes. */
  ammoPerShot: z.int().positive().optional(),
});
export type WeaponDef = z.infer<typeof WeaponDef>;

/**
 * A module definition.
 *
 * Type-specific stats are optional here and checked against the type by
 * `refine` below, so a module that claims to be an engine must carry thrust and
 * a module that is not an engine must not.
 */
export const ModuleDef = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    type: ModuleType,
    manufacturer: ManufacturerId,
    tier: z.int().min(1).max(3),
    footprint: Footprint,
    mass: z.number().positive(),
    hitPoints: z.number().positive(),
    cost: z.int().nonnegative(),
    bom: z.partialRecord(CommodityId, z.int().positive()),
    power: z.object({
      draw: z.number().nonnegative().optional(),
      output: z.number().nonnegative().optional(),
    }),
    description: z.string().min(1),

    // Type-specific.
    thrust: z.number().positive().optional(),
    torque: z.number().positive().optional(),
    cargoCapacity: z.int().positive().optional(),
    propellantCapacity: z.int().positive().optional(),
    shieldCapacity: z.number().positive().optional(),
    shieldRegen: z.number().positive().optional(),
    shieldDelay: z.number().positive().optional(),
    weapon: WeaponDef.optional(),
  })
  .refine((m) => (m.type === 'engine') === (m.thrust !== undefined), {
    message: 'engines must declare thrust, and only engines may',
    path: ['thrust'],
  })
  .refine((m) => (m.type === 'thruster') === (m.torque !== undefined), {
    message: 'thrusters must declare torque, and only thrusters may',
    path: ['torque'],
  })
  .refine((m) => (m.type === 'cargo') === (m.cargoCapacity !== undefined), {
    message: 'cargo bays must declare cargoCapacity, and only cargo bays may',
    path: ['cargoCapacity'],
  })
  .refine((m) => (m.type === 'tank') === (m.propellantCapacity !== undefined), {
    message: 'tanks must declare propellantCapacity, and only tanks may',
    path: ['propellantCapacity'],
  })
  .refine((m) => (m.type === 'shield') === (m.shieldCapacity !== undefined), {
    message: 'shield generators must declare shieldCapacity, and only they may',
    path: ['shieldCapacity'],
  })
  .refine((m) => (m.type === 'reactor') === (m.power.output !== undefined), {
    message: 'reactors must declare power output, and only reactors may',
    path: ['power', 'output'],
  })
  .refine(
    (m) => (m.type === 'weapon' || m.type === 'turret' || m.type === 'rack') === (m.weapon !== undefined),
    { message: 'only weapons, turrets and racks declare weapon stats, and all of them must', path: ['weapon'] },
  )
  .refine((m) => m.type !== 'turret' || m.weapon?.arc !== undefined, {
    message: 'a turret must declare the arc it can traverse',
    path: ['weapon', 'arc'],
  })
  .refine((m) => m.type !== 'rack' || m.weapon?.homing !== undefined, {
    message: 'a missile rack must declare its rounds\' homing rate',
    path: ['weapon', 'homing'],
  });
export type ModuleDef = z.infer<typeof ModuleDef>;

export const ModuleCatalogue = z.object({
  modules: z.array(ModuleDef).min(1),
});
export type ModuleCatalogue = z.infer<typeof ModuleCatalogue>;

/** A quarter-turn, in degrees. */
export const Rotation = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);
export type Rotation = z.infer<typeof Rotation>;

/**
 * One module placed on the grid. `x` grows forward toward the nose and `y`
 * grows to starboard, so a module's lane astern is simply the cells at lower
 * `x` in its own rows.
 */
export const Placement = z.object({
  moduleId: z.string().min(1),
  x: z.int().min(-64).max(64),
  y: z.int().min(-64).max(64),
  rotation: Rotation.default(0),
});
export type Placement = z.infer<typeof Placement>;

export const LicenceId = z.enum([
  'open-ticket',
  'frigate-warrant',
  'cruiser-warrant',
  'capital-charter',
]);
export type LicenceId = z.infer<typeof LicenceId>;

/** A ship design. Player ships, the starter ship and NPC ships share this. */
export const Blueprint = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  licence: LicenceId,
  placements: z.array(Placement).min(1),
  /** Two paint colours, as hex. The renderer derives a third for panel lines. */
  paint: z.tuple([z.string().regex(/^#[0-9a-fA-F]{6}$/), z.string().regex(/^#[0-9a-fA-F]{6}$/)]),
  description: z.string().min(1).optional(),
});
export type Blueprint = z.infer<typeof Blueprint>;

export const BlueprintLibrary = z.object({
  blueprints: z.array(Blueprint).min(1),
});
export type BlueprintLibrary = z.infer<typeof BlueprintLibrary>;

export const LicenceDef = z.object({
  name: z.string().min(1),
  maxModules: z.int().positive(),
  maxExtent: z.int().positive(),
  cost: z.int().nonnegative(),
});
export type LicenceDef = z.infer<typeof LicenceDef>;

/**
 * How much law reaches a system.
 *
 * `secured` is the Home Roads: attacking lawful traffic gets you posted,
 * patrols respond, and ports close to you until you pay the composition.
 * `contested` is the Concessions, where patrols are thin and on a schedule
 * everyone knows. `lawless` is the Marque.
 */
export const SecurityLevel = z.enum(['secured', 'contested', 'lawless']);
export type SecurityLevel = z.infer<typeof SecurityLevel>;

/** What a commodity is made of, in the economy's terms. */
export const CommodityTier = z.enum([
  'raw',
  'refined',
  'consumer',
  'manufactured',
  'luxury',
]);
export type CommodityTier = z.infer<typeof CommodityTier>;

export const CommodityDef = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  tier: CommodityTier,
  /** Marks a unit fetches at a berth holding exactly its target stock. */
  basePrice: z.int().positive(),
  /** Carried mass, so a hold of Ore flies worse than a hold of Leaf. */
  tonnesPerUnit: z.number().positive(),
  description: z.string().min(1),
});
export type CommodityDef = z.infer<typeof CommodityDef>;

export const CommodityCatalogue = z.object({
  commodities: z.array(CommodityDef).min(1),
});
export type CommodityCatalogue = z.infer<typeof CommodityCatalogue>;

/** The floor and ceiling a tier's price is held between, as base multiples. */
const PriceBand = z.object({
  min: z.number().positive(),
  max: z.number().positive(),
});

export const Tuning = z.object({
  flight: z.object({
    topSpeedCoefficient: z.number().positive(),
    topSpeedExponent: z.number().positive(),
    turnRateCoefficient: z.number().positive(),
    turnRateExponent: z.number().positive(),
    turnDampingBase: z.number().positive(),
    minTopSpeed: z.number().positive(),
    maxTopSpeed: z.number().positive(),
    minTurnRate: z.number().positive(),
    maxTurnRate: z.number().positive(),
  }),
  thrusters: z.object({
    referenceArm: z.number().positive(),
    maxLeverageMultiplier: z.number().min(1),
  }),
  mass: z.object({
    tonnesPerCargoUnit: z.number().positive(),
    tonnesPerPropellantUnit: z.number().positive(),
  }),
  hull: z.object({
    structureWriteOffFraction: z.number().min(0).max(1),
  }),
  ports: z.object({
    landingFee: z.int().nonnegative(),
    repairPricePerPoint: z.number().positive(),
    magazineCapacity: z.int().positive(),
  }),
  licences: z.record(LicenceId, LicenceDef),
  start: z.object({
    draught: z.string().min(1),
    system: z.string().min(1),
    ordnance: z.int().nonnegative(),
  }),
  market: z.object({
    /** How hard price answers scarcity. */
    elasticity: z.number().positive(),
    /** What a berth keeps between what it pays and what it charges, 0..1. */
    spread: z.number().min(0).max(1),
    bands: z.object({
      raw: PriceBand,
      refined: PriceBand,
      consumer: PriceBand,
      manufactured: PriceBand,
      luxury: PriceBand,
    }),
    /** Hours of throughput a berth wants on hand. */
    targetHours: z.number().positive(),
    /** And the least it wants, for something it neither makes nor eats. */
    baselineTarget: z.int().positive(),
    /** How much more than its target a berth can physically hold. */
    capacityMultiple: z.number().min(1),
  }),
  freight: z.object({
    /** Units the Reach's freighters move an hour, across every commodity. */
    unitsPerHour: z.number().positive(),
    /** How far from target a berth must be before freight bothers, 0..1. */
    threshold: z.number().min(0).max(1),
    /** How many lanes a load will travel. */
    maxHops: z.int().positive(),
  }),
  manufacturers: z.record(ManufacturerId, z.string().min(1)),
  yard: z.object({
    /** Liveries a yard delivers a built hull in, chosen by the hull's id. */
    liveries: z
      .array(z.tuple([z.string().regex(/^#[0-9a-fA-F]{6}$/), z.string().regex(/^#[0-9a-fA-F]{6}$/)]))
      .min(1),
    /** Insurance on the hull, as a fraction of what its modules cost. */
    insurancePremium: z.number().min(0),
    /** What a refit returns of the marks value it strips, 0..1. */
    refundFraction: z.number().min(0).max(1),
  }),
  law: z.object({
    compositionPerDamage: z.number().nonnegative(),
    compositionPerWriteOff: z.int().nonnegative(),
    /** Security levels whose berths turn a posted captain away. */
    postedRefusedIn: z.array(SecurityLevel),
    weightBySecurity: z.object({
      secured: z.number().min(0),
      contested: z.number().min(0),
      lawless: z.number().min(0),
    }),
  }),
  world: z.object({
    spawnStandoff: z.number().positive(),
    raiderStandoff: z.number().positive(),
    raiderScatter: z.number().positive(),
    /** How many Unlettered hunt a system, by how much law reaches it. */
    raidersBySecurity: z.object({
      secured: z.int().nonnegative(),
      contested: z.int().nonnegative(),
      lawless: z.int().nonnegative(),
    }),
    /** And how many of the Prize Court's patrols answer for it. */
    patrolsBySecurity: z.object({
      secured: z.int().nonnegative(),
      contested: z.int().nonnegative(),
      lawless: z.int().nonnegative(),
    }),
  }),
});
export type Tuning = z.infer<typeof Tuning>;

export const RegionId = z.enum(['home-roads', 'concessions', 'marque']);
export type RegionId = z.infer<typeof RegionId>;

export const PortOwner = z.enum(['kessler', 'thirty', 'reprisal', 'unlettered', 'neutral']);
export type PortOwner = z.infer<typeof PortOwner>;

/** Services a port offers. The plain terms; the interface shows the in-world ones. */
export const PortService = z.enum([
  'staple',
  'bourse',
  'factor',
  'yard',
  'moorings',
  'repair',
]);
export type PortService = z.infer<typeof PortService>;

const HexColour = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/**
 * What a berth makes and what it eats, in units an hour.
 *
 * Everything else about its market follows from these: the target stock it
 * wants on hand, the capacity it can hold, and which way its prices drift
 * when nobody trades with it.
 */
export const PortTrade = z.object({
  produces: z.record(z.string(), z.number().nonnegative()).default({}),
  consumes: z.record(z.string(), z.number().nonnegative()).default({}),
});
export type PortTrade = z.infer<typeof PortTrade>;

export const PortDef = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  owner: PortOwner,
  x: z.number(),
  y: z.number(),
  radius: z.number().positive(),
  services: z.array(PortService),
  /** Present on every berth with a Staple; absent on one without. */
  trade: PortTrade.optional(),
  surfaceColour: HexColour,
  accentColour: HexColour,
  description: z.string().min(1),
});
export type PortDef = z.infer<typeof PortDef>;

export const StarDef = z.object({
  name: z.string().min(1),
  radius: z.number().positive(),
  colour: HexColour,
  coronaColour: HexColour,
  /** Tints the lighting on every hull in the system. */
  lightTint: HexColour,
});
export type StarDef = z.infer<typeof StarDef>;

export const SystemDef = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  region: RegionId,
  security: SecurityLevel,
  description: z.string().min(1),
  /** Position on the chart, in chart units. Only the map reads these. */
  mapX: z.number(),
  mapY: z.number(),
  /** Systems reachable by one hyperjump. Links are validated to be mutual. */
  links: z.array(z.string().min(1)),
  star: StarDef,
  /** Distance from the centre at which the system ends. */
  radius: z.number().positive(),
  ports: z.array(PortDef),
});
export type SystemDef = z.infer<typeof SystemDef>;

export const SystemLibrary = z.object({
  systems: z.array(SystemDef).min(1),
});
export type SystemLibrary = z.infer<typeof SystemLibrary>;
