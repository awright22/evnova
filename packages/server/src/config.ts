/**
 * Server configuration, read once from the environment and validated.
 *
 * Nothing else in the server reads `process.env` directly: a missing or
 * malformed value fails at startup with a readable message rather than
 * surfacing as a strange runtime error later.
 */

import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(2567),

  /** Shared invite code required to create an account. Empty disables the gate. */
  INVITE_CODE: z.string().default(''),

  /**
   * Comma-separated list of origins allowed to connect. Empty allows any
   * origin, which is the right default for local development only.
   */
  ALLOWED_ORIGINS: z.string().default(''),

  /** SQLite file, or any connection string the database layer understands. */
  DATABASE_URL: z.string().default('./data/marque.db'),

  /** Comma-separated callsigns granted admin rights. */
  ADMIN_CALLSIGNS: z.string().default(''),

  /** Marks a new captain starts with. */
  STARTING_MARKS: z.coerce.number().int().nonnegative().default(2500),

  /** System a new captain wakes in. */
  STARTING_SYSTEM: z.string().default('parity'),

  /** Where daily snapshots are written. */
  SNAPSHOT_DIR: z.string().default('./data/snapshots'),

  /** Daily snapshots to keep. */
  SNAPSHOT_KEEP: z.coerce.number().int().positive().default(7),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const lines = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
  throw new Error(`Invalid server configuration:\n${lines.join('\n')}`);
}

const env = parsed.data;

export const config = {
  nodeEnv: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  port: env.PORT,
  inviteCode: env.INVITE_CODE,
  allowedOrigins: env.ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0),
  databaseUrl: env.DATABASE_URL,
  adminCallsigns: env.ADMIN_CALLSIGNS.split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0),
  startingMarks: env.STARTING_MARKS,
  startingSystem: env.STARTING_SYSTEM,
  snapshotDir: env.SNAPSHOT_DIR,
  snapshotKeep: env.SNAPSHOT_KEEP,
} as const;

export type Config = typeof config;
