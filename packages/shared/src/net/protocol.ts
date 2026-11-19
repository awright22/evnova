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

/** Scoop a canister the hull is close enough to reach. */
export const ScoopIntent = z.object({
  id: z.string().max(64),
});
export type ScoopIntent = z.infer<typeof ScoopIntent>;

/** How close a hull must be to scoop a canister, in world units. */
export const SCOOP_RANGE = 90;
