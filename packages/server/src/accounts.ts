/**
 * Accounts.
 *
 * A captain is a callsign plus a device token, gated by a shared invite code
 * from server configuration. A recovery phrase, shown once at sign-up, moves
 * the account to another device.
 *
 * Nothing secret is stored. The device token is high-entropy random, so a
 * SHA-256 of it is enough; the recovery phrase is words, so it gets scrypt
 * with a per-account salt. Comparisons are constant-time.
 */

import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { config } from './config.ts';
import { schema, type Store } from './db/index.ts';

/** Words the recovery phrase is drawn from: plain, unambiguous, in voice. */
const PHRASE_WORDS = [
  'anchor', 'ballast', 'beacon', 'berth', 'bonded', 'bridge', 'broker', 'bunker',
  'cargo', 'charter', 'claim', 'clause', 'consign', 'convoy', 'course', 'credit',
  'customs', 'deadweight', 'demurrage', 'dividend', 'docket', 'draught', 'duty',
  'escrow', 'factor', 'freight', 'gantry', 'hazard', 'hull', 'indent', 'invoice',
  'jetty', 'ladder', 'lading', 'ledger', 'levy', 'lien', 'manifest', 'margin',
  'mooring', 'notice', 'option', 'parcel', 'pilot', 'premium', 'prize', 'quay',
  'quorum', 'rebate', 'registry', 'salvage', 'scrip', 'seal', 'shipment',
  'specie', 'stowage', 'surety', 'tally', 'tariff', 'tender', 'tonnage',
  'transit', 'tribunal', 'underwrite', 'vessel', 'voyage', 'warrant', 'wharf',
] as const;

/** Words in a recovery phrase. Six of sixty-eight is about 36 bits. */
const PHRASE_LENGTH = 6;

export interface Account {
  readonly id: string;
  readonly callsign: string;
  readonly isAdmin: boolean;
}

export interface SignUpResult {
  readonly account: Account;
  /** Shown once and never again. */
  readonly deviceToken: string;
  readonly recoveryPhrase: string;
}

export type AuthFailure =
  | 'bad-invite'
  | 'callsign-taken'
  | 'callsign-invalid'
  | 'unknown-account'
  | 'bad-token'
  | 'bad-recovery';

export class AuthError extends Error {
  constructor(readonly reason: AuthFailure) {
    super(reason);
    this.name = 'AuthError';
  }
}

export class Accounts {
  constructor(private readonly store: Store) {}

  /**
   * Create an account.
   *
   * The invite code gates it. Everything is written in one transaction, so a
   * half-created captain is not a state the world can be in.
   */
  signUp(options: { callsign: string; inviteCode: string }): SignUpResult {
    if (!this.inviteAccepted(options.inviteCode)) throw new AuthError('bad-invite');

    const callsign = normaliseCallsign(options.callsign);
    if (!callsign) throw new AuthError('callsign-invalid');

    const key = callsign.toLowerCase();
    const existing = this.store.db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.callsignKey, key))
      .get();
    if (existing) throw new AuthError('callsign-taken');

    const id = randomBytes(16).toString('hex');
    const deviceToken = randomBytes(32).toString('base64url');
    const recoveryPhrase = makeRecoveryPhrase();
    const recoverySalt = randomBytes(16).toString('hex');
    const now = Date.now();

    try {
      this.store.transaction(() => {
        this.store.db
          .insert(schema.accounts)
          .values({
            id,
            callsign,
            callsignKey: key,
            deviceTokenHash: hashToken(deviceToken),
            recoveryHash: hashPhrase(recoveryPhrase, recoverySalt),
            recoverySalt,
            isAdmin: config.adminCallsigns.includes(key),
            createdAt: now,
            lastSeenAt: now,
          })
          .run();

        this.store.db
          .insert(schema.pilots)
          .values({
            accountId: id,
            marks: config.startingMarks,
            systemId: config.startingSystem,
            blueprintId: 'prudent-return',
            ammo: 24,
            updatedAt: now,
          })
          .run();
      });
    } catch (error) {
      // A unique-index violation means someone took the callsign between the
      // check and the insert. The database is the authority, not the check.
      if (String(error).includes('UNIQUE')) throw new AuthError('callsign-taken');
      throw error;
    }

    return {
      account: { id, callsign, isAdmin: config.adminCallsigns.includes(key) },
      deviceToken,
      recoveryPhrase,
    };
  }

  /** Sign in with a device token. */
  signIn(deviceToken: string): Account {
    const hash = hashToken(deviceToken);
    const row = this.store.db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.deviceTokenHash, hash))
      .get();

    if (!row) throw new AuthError('bad-token');

    this.store.db
      .update(schema.accounts)
      .set({ lastSeenAt: Date.now() })
      .where(eq(schema.accounts.id, row.id))
      .run();

    return { id: row.id, callsign: row.callsign, isAdmin: row.isAdmin };
  }

  /**
   * Move an account to this device with its recovery phrase.
   *
   * The old device token stops working: a phrase that could be used twice
   * would be a phrase worth stealing.
   */
  recover(options: { callsign: string; recoveryPhrase: string }): SignUpResult {
    const key = normaliseCallsign(options.callsign).toLowerCase();
    const row = this.store.db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.callsignKey, key))
      .get();

    if (!row) throw new AuthError('unknown-account');

    const offered = hashPhrase(normalisePhrase(options.recoveryPhrase), row.recoverySalt);
    if (!constantTimeEquals(offered, row.recoveryHash)) throw new AuthError('bad-recovery');

    const deviceToken = randomBytes(32).toString('base64url');
    const recoveryPhrase = makeRecoveryPhrase();
    const recoverySalt = randomBytes(16).toString('hex');

    this.store.transaction(() => {
      this.store.db
        .update(schema.accounts)
        .set({
          deviceTokenHash: hashToken(deviceToken),
          recoveryHash: hashPhrase(recoveryPhrase, recoverySalt),
          recoverySalt,
          lastSeenAt: Date.now(),
        })
        .where(eq(schema.accounts.id, row.id))
        .run();
    });

    return {
      account: { id: row.id, callsign: row.callsign, isAdmin: row.isAdmin },
      deviceToken,
      recoveryPhrase,
    };
  }

  /** Constant-time comparison against the configured invite code. */
  private inviteAccepted(offered: string): boolean {
    if (config.inviteCode === '') return true;
    return constantTimeEquals(offered ?? '', config.inviteCode);
  }
}

// --- Helpers --------------------------------------------------------------

/**
 * A callsign a captain can actually type and the Register can print.
 *
 * Letters, digits, spaces, hyphens and apostrophes. Normalised first so two
 * accounts cannot differ only by an invisible character.
 */
export function normaliseCallsign(raw: string): string {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} '-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
}

function makeRecoveryPhrase(): string {
  const words: string[] = [];
  for (let i = 0; i < PHRASE_LENGTH; i++) {
    words.push(PHRASE_WORDS[randomInt(PHRASE_WORDS.length)]!);
  }
  return words.join(' ');
}

/** Accept a phrase however it was typed back. */
export function normalisePhrase(raw: string): string {
  return typeof raw === 'string' ? raw.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ') : '';
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** scrypt work factor. 2^15 needs 128 * N * r bytes, which is just over 32 MB. */
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

function hashPhrase(phrase: string, salt: string): string {
  // Costly on purpose: a phrase is words, so it has far less entropy than the
  // device token and an attacker with the database must pay per guess. Node's
  // default memory cap is below what this costs, so it is raised explicitly
  // rather than the work being lowered to fit.
  return scryptSync(phrase, salt, 32, SCRYPT).toString('hex');
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // Still compare, so the failure takes the same time as a wrong value.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}
