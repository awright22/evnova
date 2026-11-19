/**
 * Shared simulation, protocol and content.
 *
 * Everything in this package runs on both the server and the client and is
 * deterministic: time arrives as a step timing or an injected clock, and
 * randomness comes from a seeded generator.
 */

export * from './math/scalar.ts';
export * from './math/rng.ts';
export * from './sim/timing.ts';
export * from './sim/profile.ts';
export * from './sim/flight.ts';
export * from './sim/steering.ts';
export * from './sim/combat.ts';
export * from './content/schema.ts';
export * from './content/load.ts';
export * from './ships/geometry.ts';
export * from './ships/derive.ts';
export * from './ships/validate.ts';
export * from './net/input.ts';
export * from './net/state.ts';
