/**
 * Connection to the game server.
 *
 * Every failure has a designed state: the interface never shows a white screen
 * or raw error text. The reasons here are the closed set the boot screen knows
 * how to render.
 */

import { ColyseusSDK, type Room } from '@colyseus/sdk';
import { SystemState } from '@marque/shared';

declare const __SERVER_URL__: string;
declare const __BUILD_VERSION__: string;

export const SERVER_URL = __SERVER_URL__;
export const BUILD_VERSION = __BUILD_VERSION__;

export type ConnectionStatus =
  | { kind: 'connecting' }
  | { kind: 'connected'; room: Room<unknown, SystemState> }
  | { kind: 'failed'; reason: FailureReason; detail: string };

/**
 * Why a connection attempt failed, as something the interface can explain.
 * `unknown` is the catch-all and still renders a designed state.
 */
export type FailureReason = 'unreachable' | 'rejected' | 'timeout' | 'unknown';

export interface ConnectOptions {
  readonly callsign: string;
  readonly endpoint?: string;
  /** Draught to fly. The server falls back to the starter if it is unknown. */
  readonly blueprint?: string;
  readonly signal?: AbortSignal;
}

const CONNECT_TIMEOUT_MS = 10_000;

/** Join the system room, or resolve a failure the boot screen can describe. */
export async function connect(options: ConnectOptions): Promise<ConnectionStatus> {
  const endpoint = options.endpoint ?? SERVER_URL;
  const sdk = new ColyseusSDK(endpoint);

  try {
    const room = await withTimeout(
      sdk.joinOrCreate<SystemState>(
        'system',
        {
          callsign: options.callsign,
          version: BUILD_VERSION,
          ...(options.blueprint !== undefined ? { blueprint: options.blueprint } : {}),
        },
        SystemState,
      ),
      CONNECT_TIMEOUT_MS,
    );
    return { kind: 'connected', room };
  } catch (error) {
    return { kind: 'failed', ...classify(error) };
  }
}

function classify(error: unknown): { reason: FailureReason; detail: string } {
  if (error instanceof TimeoutError) {
    return { reason: 'timeout', detail: `No response within ${CONNECT_TIMEOUT_MS} ms` };
  }

  const message = error instanceof Error ? error.message : String(error);

  // A websocket that cannot open reports a generic failure by design: the
  // browser deliberately hides the cause. Treat it as unreachable.
  if (/failed to (fetch|connect)|ECONNREFUSED|NetworkError|websocket/i.test(message)) {
    // Keep the underlying message: the player does not need it, but whoever
    // runs the server does, and it is the only clue they get.
    return { reason: 'unreachable', detail: message };
  }

  // Colyseus rejects a join with a typed reason: the server said no.
  if (/\b4\d\d\b|rejected|not allowed|invalid/i.test(message)) {
    return { reason: 'rejected', detail: message };
  }

  return { reason: 'unknown', detail: message };
}

class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** What the boot screen tells the player, per failure reason. */
export function explainFailure(reason: FailureReason): {
  heading: string;
  body: string;
  retry: boolean;
} {
  switch (reason) {
    case 'unreachable':
      return {
        heading: 'No answer',
        body: 'The terminal is not responding. It may be down for maintenance, or this build is pointed at the wrong address.',
        retry: true,
      };
    case 'timeout':
      return {
        heading: 'The link timed out',
        body: 'The terminal accepted the connection and then stopped responding.',
        retry: true,
      };
    case 'rejected':
      return {
        heading: 'Refused',
        body: 'The terminal declines the connection. Check your invite code and your callsign.',
        retry: false,
      };
    case 'unknown':
      return {
        heading: 'The link failed',
        body: 'The connection could not be established. No further detail was returned.',
        retry: true,
      };
  }
}
