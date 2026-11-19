/**
 * The message protocol.
 *
 * Three channels, each with a different guarantee:
 *
 * 1. Input — `ShipInput`, thirty a second, flat primitives, sanitised.
 * 2. Intents — request/response messages that need a result, validated
 *    against the schemas below and rejected with one of the reasons here.
 * 3. State — synchronised schema, server to client.
 *
 * Rejection reasons are a closed set so the interface can render a designed
 * state for each rather than printing whatever the server said.
 */

import { z } from 'zod';

/** Why the server refused an intent. */
export const REJECTIONS = {
  'unknown-target': 'That hull is not in this system.',
  'target-self': 'You cannot mark your own hull.',
  'target-written-off': 'That hull has been written off.',
  'not-landed': 'You are not landed at a port.',
  'out-of-range': 'You are too far away.',
  'cannot-afford': 'You are short of marks.',
  'not-owned': 'You do not own that.',
  'invalid-design': 'That draught does not pass survey.',
  'rate-limited': 'Too many requests. Slow down.',
  'no-lane': 'No lane runs from here to there.',
  'too-close-to-the-star': 'Too close to the star to spool. Move clear of the centre.',
  'short-of-propellant': 'Not enough Propellant aboard for a hull this heavy.',
  'already-spooling': 'Already spooling.',
  'too-fast-to-land': 'Too fast to be taken alongside.',
  'not-in-reach': 'Not close enough to the berth.',
  'posted-here': 'The port will not have you while you are posted.',
  'no-such-service': 'This berth does not offer that.',
  'nothing-to-do': 'Nothing to do: the hull is already sound.',
  'no-room': 'The hull will not take any more.',
} as const;

export type RejectionReason = keyof typeof REJECTIONS;

export function rejectionText(reason: RejectionReason): string {
  return REJECTIONS[reason];
}

// --- Intent payloads ------------------------------------------------------

/** Select a hull as the mark, or clear it with an empty id. */
export const TargetIntent = z.object({
  id: z.string().max(64),
});
export type TargetIntent = z.infer<typeof TargetIntent>;

/** Spool for a linked system. */
export const JumpIntent = z.object({
  system: z.string().max(64),
});
export type JumpIntent = z.infer<typeof JumpIntent>;

/** Land at a port the hull is close enough and slow enough to reach. */
export const LandIntent = z.object({
  port: z.string().max(64),
});
export type LandIntent = z.infer<typeof LandIntent>;

/** Leave the berth. Carries nothing, but goes through the same validation. */
export const LaunchIntent = z.object({});
export type LaunchIntent = z.infer<typeof LaunchIntent>;

/** What a captain asks a berth for. Quantities are integers, always. */
export const PortServiceIntent = z.object({
  service: z.enum(['repair', 'propellant', 'ordnance']),
  /** Units wanted. Ignored by repair, which is all or nothing. */
  units: z.int().min(0).max(100_000).default(0),
});
export type PortServiceIntent = z.infer<typeof PortServiceIntent>;

/** Scoop a canister the hull is close enough to reach. */
export const ScoopIntent = z.object({
  id: z.string().max(64),
});
export type ScoopIntent = z.infer<typeof ScoopIntent>;

/** How close a hull must be to scoop a canister, in world units. */
export const SCOOP_RANGE = 90;

// --- Travel ---------------------------------------------------------------

/** Seconds a hyperjump spools for, flying and vulnerable throughout. */
export const JUMP_SPOOL_SECONDS = 4;

/** How far from the system's centre a hull must be to spool. */
export const JUMP_CLEARANCE = 2600;

/** Propellant a jump burns per tonne of hull. */
export const PROPELLANT_PER_TONNE = 0.06;

/** Seconds of protection on arrival. */
export const ARRIVAL_PROTECTION_SECONDS = 2;

/** How close a hull must be to a berth to be taken alongside. */
export const LANDING_RANGE = 420;

/** And how slow. */
export const LANDING_SPEED = 90;

/** Seconds the approach takes once cleared. */
export const LANDING_SECONDS = 2.2;

/** Propellant a jump needs, from the hull's mass. Always at least one unit. */
export function jumpCost(massTonnes: number): number {
  return Math.max(1, Math.ceil(massTonnes * PROPELLANT_PER_TONNE));
}
