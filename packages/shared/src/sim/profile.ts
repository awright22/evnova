/**
 * Flight performance of a ship, derived from its module grid.
 *
 * The shipyard produces one of these from a blueprint; the simulation only ever
 * reads it. Keeping derived stats in a plain record means NPC ships, player
 * ships and the starter ship all fly through the same code path, and the soak
 * sim can synthesise profiles without building a grid.
 */
export interface ShipProfile {
  /** Forward acceleration at full thrust, units/s^2. Total thrust over mass. */
  readonly thrustAccel: number;
  /**
   * Speed at which forward thrust tapers to nothing, units/s. Not a hard clamp:
   * a ship can exceed it from an external impulse and will coast back down.
   */
  readonly topSpeed: number;
  /** Angular acceleration from maneuvering thrusters, rad/s^2. */
  readonly turnAccel: number;
  /** Maximum sustained turn rate, rad/s. */
  readonly maxTurnRate: number;
  /**
   * How quickly angular velocity bleeds off when the pilot is not turning,
   * as an exponential rate per second. This is the maneuvering thrusters
   * actively stopping the rotation, not drag.
   */
  readonly turnDamping: number;
  /** Total mass in tonnes. Carried here so combat and jump costs can read it. */
  readonly mass: number;
}

/** A readable starting point used by tests, tools and the networking spike. */
export const SPIKE_PROFILE: ShipProfile = {
  thrustAccel: 220,
  topSpeed: 320,
  turnAccel: 14,
  maxTurnRate: 2.6,
  turnDamping: 9,
  mass: 40,
};
