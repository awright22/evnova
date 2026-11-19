/**
 * The captain's credentials, on this device.
 *
 * The device token is stored locally and sent when joining. The recovery
 * phrase is shown once at sign-up and never stored: if it were kept here,
 * losing the device would not be the thing it protects against.
 */

const TOKEN_KEY = 'marque.deviceToken';
const CALLSIGN_KEY = 'marque.callsign';

export interface StoredAccount {
  readonly callsign: string;
  readonly deviceToken: string;
}

export interface NewAccount extends StoredAccount {
  /** Shown once. Not stored anywhere. */
  readonly recoveryPhrase: string;
}

export function loadAccount(): StoredAccount | undefined {
  try {
    const deviceToken = localStorage.getItem(TOKEN_KEY);
    const callsign = localStorage.getItem(CALLSIGN_KEY);
    if (!deviceToken || !callsign) return undefined;
    return { deviceToken, callsign };
  } catch {
    // Private browsing, or storage disabled. The captain signs in again.
    return undefined;
  }
}

export function saveAccount(account: StoredAccount): void {
  try {
    localStorage.setItem(TOKEN_KEY, account.deviceToken);
    localStorage.setItem(CALLSIGN_KEY, account.callsign);
  } catch {
    // Not fatal: the session still works, it just will not be remembered.
  }
}

export function forgetAccount(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(CALLSIGN_KEY);
  } catch {
    // Nothing to do.
  }
}

/** What the server said when it refused. */
export class RegisterError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'RegisterError';
  }
}

async function post(httpBase: string, path: string, body: unknown): Promise<NewAccount> {
  const response = await fetch(`${httpBase}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    throw new RegisterError(
      asString(payload.error) ?? 'refused',
      asString(payload.message) ?? 'The Register declined.',
    );
  }

  // Read the fields rather than coercing them: a field that is not a string
  // means the server and this build disagree about the protocol, which is
  // worth saying plainly rather than turning into "[object Object]".
  const callsign = asString(payload.callsign);
  const deviceToken = asString(payload.deviceToken);
  const recoveryPhrase = asString(payload.recoveryPhrase);

  if (callsign === undefined || deviceToken === undefined || recoveryPhrase === undefined) {
    throw new RegisterError('malformed', 'The Register answered with something unreadable.');
  }

  return { callsign, deviceToken, recoveryPhrase };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function signUp(
  httpBase: string,
  options: { callsign: string; inviteCode: string },
): Promise<NewAccount> {
  return post(httpBase, '/account/sign-up', options);
}

export function recover(
  httpBase: string,
  options: { callsign: string; recoveryPhrase: string },
): Promise<NewAccount> {
  return post(httpBase, '/account/recover', options);
}

/** The server's HTTP origin, derived from its websocket URL. */
export function httpBaseFrom(serverUrl: string): string {
  return serverUrl.replace(/^ws/, 'http').replace(/\/$/, '');
}
