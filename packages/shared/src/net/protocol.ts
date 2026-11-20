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
  'no-room': 'The hull will not take any more.',
  'nothing-to-do': 'Nothing to do: the hull is already sound.',
  'nothing-owed': 'The Prize Court has nothing against you.',
  'no-such-design': 'No such draught on your books.',
  'no-such-ship': 'No such hull.',
  'too-many-designs': 'Your books are full. Clear a draught first.',
  'too-many-ships': 'Your moorings are full.',
  'no-yard': 'This berth keeps no Yard.',
  'no-such-commodity': 'The Register knows no such good.',
  'no-such-market': 'This berth keeps no Staple.',
  'nothing-to-trade': 'Nothing to trade.',
  'out-of-stock': 'The berth has none left.',
  'hold-full': 'The hold will not take any more.',
  'not-carrying': 'You are not carrying that.',
  'berth-full': 'The berth has no room for more.',
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
  service: z.enum(['repair', 'propellant', 'ordnance', 'composition']),
  /** Units wanted. Ignored by repair, which is all or nothing. */
  units: z.int().min(0).max(100_000).default(0),
});
export type PortServiceIntent = z.infer<typeof PortServiceIntent>;

/** The longest line the Register will print. */
export const CHAT_MAX_LENGTH = 240;

/** How many recent lines a captain is given on arrival. */
export const CHAT_BACKLOG = 40;

/**
 * Strip a line down to what the Register prints.
 *
 * Control characters, newlines and runs of whitespace all collapse: the chat
 * is one line per message, and nothing a captain types may move another
 * captain's interface around.
 */
export function scrubChat(body: string): string {
  return body
    // eslint-disable-next-line no-control-regex -- removing them is the point.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CHAT_MAX_LENGTH);
}

/** A module on the grid, as the editor sends it. */
export const PlacementIntent = z.object({
  moduleId: z.string().min(1).max(64),
  x: z.int().min(-64).max(64),
  y: z.int().min(-64).max(64),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
});
export type PlacementIntent = z.infer<typeof PlacementIntent>;

/** Keep a design, or replace one already kept. */
export const SaveDesignIntent = z.object({
  id: z.string().max(64).optional(),
  name: z.string().min(1).max(40),
  placements: z.array(PlacementIntent).min(1).max(160),
});
export type SaveDesignIntent = z.infer<typeof SaveDesignIntent>;

/** Forget a design. */
export const ForgetDesignIntent = z.object({ id: z.string().min(1).max(64) });
export type ForgetDesignIntent = z.infer<typeof ForgetDesignIntent>;

/**
 * Build a hull, or refit one.
 *
 * `refitting` names a hull the captain owns, which is changed rather than
 * added to the hangar.
 */
export const BuildIntent = z.object({
  name: z.string().min(1).max(40),
  placements: z.array(PlacementIntent).min(1).max(160),
  refitting: z.string().max(64).optional(),
});
export type BuildIntent = z.infer<typeof BuildIntent>;

/** Buy from or sell to the berth's Staple. */
export const StapleIntent = z.object({
  side: z.enum(['buy', 'sell']),
  commodity: z.string().max(64),
  /** Units wanted. The berth trades as many of them as it can. */
  units: z.int().min(1).max(100_000),
});
export type StapleIntent = z.infer<typeof StapleIntent>;

/**
 * Say something, on the global channel or to this system only.
 *
 * The body is bounded here and scrubbed on the server: the Register prints
 * plain text, and a line that could carry control characters or run to a
 * thousand glyphs is not plain text.
 */
export const ChatIntent = z.object({
  channel: z.enum(['global', 'system']),
  body: z.string().min(1).max(CHAT_MAX_LENGTH),
});
export type ChatIntent = z.infer<typeof ChatIntent>;

/**
 * Everything the server sends a client that is not room state.
 *
 * Exported so a tool can register a no-op for each: the SDK warns once per
 * message when nothing is listening, and a headless client that only wants to
 * fly should not have to keep its own copy of this list in step. Adding a
 * message here is what keeps the bot, the soak and the verification harnesses
 * quiet without anyone remembering to update them.
 */
export const SERVER_MESSAGES = [
  'purse',
  'impact',
  'written-off',
  'respawned',
  'posted',
  'chat',
  'chat-backlog',
  'at-port',
  'landed',
  'jump-complete',
  'jump-failed',
  'market',
  'yard',
  'survey',
] as const;

/** A line as it reaches the other captains. */
export interface ChatLine {
  readonly id: string;
  readonly channel: 'global' | 'system';
  readonly callsign: string;
  /** Where the speaker was, so a global line carries its origin. */
  readonly system: string;
  readonly body: string;
  /** Server wall-clock at the time it was said, for ordering and timestamps. */
  readonly at: number;
}

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
