/**
 * Ledger categories.
 *
 * Every mark created or destroyed passes through the ledger tagged with one of
 * these, so the change in total marks always equals faucets minus sinks. The
 * categories live in shared because the admin page and the soak report both
 * group by them.
 */

/** Marks entering the world. */
export const FAUCETS = {
  'starting-balance': 'Opening balance',
  'insurance-claim': 'Claim settled',
  bounty: 'Bounty',
  'commission-pay': 'Commission',
  'cargo-sale': 'Sold at the Staple',
  dividend: 'Dividend',
  'share-sale': 'Sold on the Bourse',
  salvage: 'Salvage',
  'refit-refund': 'Refit refund',
} as const;

/** Marks leaving it. */
export const SINKS = {
  repair: 'Repairs',
  propellant: 'Propellant',
  'landing-fee': 'Landing fee',
  composition: 'Composition',
  'hull-purchase': 'Hull',
  'module-purchase': 'Fittings',
  'cargo-purchase': 'Bought at the Staple',
  'share-purchase': 'Bought on the Bourse',
  'trade-fee': 'Fee',
  'licence-purchase': 'Hull licence',
  'letter-of-marque': 'Letter of marque',
} as const;

export type FaucetCategory = keyof typeof FAUCETS;
export type SinkCategory = keyof typeof SINKS;
export type LedgerCategory = FaucetCategory | SinkCategory;

export function isFaucet(category: LedgerCategory): category is FaucetCategory {
  return category in FAUCETS;
}

export function categoryLabel(category: LedgerCategory): string {
  return (
    (FAUCETS as Record<string, string>)[category] ??
    (SINKS as Record<string, string>)[category] ??
    category
  );
}

export const ALL_CATEGORIES: readonly LedgerCategory[] = [
  ...(Object.keys(FAUCETS) as FaucetCategory[]),
  ...(Object.keys(SINKS) as SinkCategory[]),
];
