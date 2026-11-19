/**
 * The game, as a state machine.
 *
 * Owns the connection, the room, and which screen the captain is looking at.
 * A hyperjump changes rooms, so the room is not something a component can own:
 * it lives here and components subscribe.
 *
 * Written as a class rather than a hook because the lifecycle is genuinely
 * asynchronous — joining, landing, jumping, rejoining — and effects that
 * re-run are the wrong shape for it.
 */

import { ColyseusSDK, type Room } from '@colyseus/sdk';
import {
  CHAT_BACKLOG,
  SERVER_MESSAGES,
  SystemState,
  content,
  scrubChat,
  type ChatLine,
} from '@marque/shared';

import { loadChart, type Chart } from '../map/galaxy.ts';
import { explainFailure, type FailureReason } from '../net/connection.ts';
import {
  berthOf,
  httpBaseFrom,
  loadAccount,
  saveAccount,
  signUp,
  type StoredAccount,
} from './account.ts';

/** What the captain has. Private to them, so it arrives by message. */
export interface Purse {
  marks: number;
  propellant: number;
  propellantCapacity: number;
  ordnance: number;
  structure: number;
  draught: string;
  licence: string;
  composition: number;
  jumpCost: number;
  system: string;
  landedPort: string;
}

const EMPTY_PURSE: Purse = {
  marks: 0,
  propellant: 0,
  propellantCapacity: 0,
  ordnance: 0,
  structure: 1,
  draught: '',
  licence: 'open-ticket',
  composition: 0,
  jumpCost: 1,
  system: '',
  landedPort: '',
};

export type GameMode =
  | { kind: 'connecting' }
  | { kind: 'register'; message: string | undefined }
  | { kind: 'flight' }
  | { kind: 'port'; portId: string }
  | { kind: 'jumping'; to: string }
  | { kind: 'failed'; heading: string; body: string; detail: string; canRetry: boolean };

export interface GameSnapshot {
  readonly mode: GameMode;
  readonly room: Room<unknown, SystemState> | undefined;
  readonly systemId: string;
  readonly purse: Purse;
  readonly chart: Chart | undefined;
  readonly account: StoredAccount | undefined;
  /** Rising counter so a component can key on a room change. */
  readonly epoch: number;
  readonly notice: string | undefined;
  /**
   * The system the captain has plotted for, if any. Held here rather than in
   * the chart so it survives closing the chart, and so J has somewhere to go.
   */
  readonly course: string | undefined;
}

/**
 * A seam for the capture and verification harnesses.
 *
 * Opening the client with `?harness=1` publishes the room on `window` so a
 * script can read the world the way a player reads the screen, and fly the
 * ship properly instead of pressing keys blind. It is off unless that flag is
 * passed, and it grants nothing: the server is authoritative, so a client that
 * can see its own room state can see no more than devtools already shows.
 */
declare global {
  interface Window {
    __marqueHarness?: { room: Room<unknown, SystemState> };
  }
}

function exposeToHarness(room: Room<unknown, SystemState>): void {
  if (typeof window === 'undefined') return;
  if (new URLSearchParams(window.location.search).get('harness') !== '1') return;
  window.__marqueHarness = { room };
}

type Listener = (snapshot: GameSnapshot) => void;
type ChatListener = (lines: readonly ChatLine[]) => void;

export class GameClient {
  private readonly sdk: ColyseusSDK;
  private readonly listeners = new Set<Listener>();
  /**
   * Chat has its own subscription rather than riding the game snapshot: a
   * line arriving should not re-render the flight view.
   */
  private readonly chatListeners = new Set<ChatListener>();
  private chatLines: ChatLine[] = [];

  private mode: GameMode = { kind: 'connecting' };
  private room: Room<unknown, SystemState> | undefined;
  private systemId = '';
  private purse: Purse = { ...EMPTY_PURSE };
  private chart: Chart | undefined;
  private account: StoredAccount | undefined;
  private epoch = 0;
  private notice: string | undefined;
  /** Where the captain means to go next, cleared once they arrive. */
  private course: string | undefined;
  private disposed = false;

  constructor(
    private readonly serverUrl: string,
    private readonly devBlueprint?: string,
    /**
     * A callsign to open an account under without showing the Register. The
     * harnesses pass it so a capture or a frame-rate run reaches flight without
     * a human typing; a player never has it set.
     */
    private readonly autoCallsign?: string,
  ) {
    this.sdk = new ColyseusSDK(serverUrl);
    this.account = loadAccount();
  }

  get httpBase(): string {
    return httpBaseFrom(this.serverUrl);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): GameSnapshot {
    return {
      mode: this.mode,
      room: this.room,
      systemId: this.systemId,
      purse: this.purse,
      chart: this.chart,
      account: this.account,
      epoch: this.epoch,
      notice: this.notice,
      course: this.course,
    };
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  /** Subscribe to the chat alone. Returns an unsubscribe. */
  subscribeChat(listener: ChatListener): () => void {
    this.chatListeners.add(listener);
    listener(this.chatLines);
    return () => this.chatListeners.delete(listener);
  }

  private emitChat(): void {
    // A new array each time so React sees the change.
    const lines = this.chatLines;
    for (const listener of this.chatListeners) listener(lines);
  }

  /** Keep the client's own copy bounded, as the server's is. */
  private pushChat(incoming: readonly ChatLine[]): void {
    const seen = new Set(this.chatLines.map((line) => line.id));
    const added = incoming.filter((line) => !seen.has(line.id));
    if (added.length === 0) return;
    this.chatLines = [...this.chatLines, ...added].slice(-CHAT_BACKLOG);
    this.emitChat();
  }

  /** Say something. Refusals land as a notice like any other intent. */
  say(channel: 'global' | 'system', body: string): void {
    const trimmed = scrubChat(body);
    if (trimmed === '') return;
    void this.request('chat', { channel, body: trimmed });
  }

  /** Begin: load the chart, then join wherever the captain left off. */
  async start(): Promise<void> {
    try {
      this.chart = await loadChart(this.httpBase);
    } catch {
      // The chart is not fatal: the captain can still fly, just not plan.
      this.chart = undefined;
    }

    if (!this.account && this.autoCallsign !== undefined) {
      try {
        const opened = await signUp(this.httpBase, {
          callsign: this.autoCallsign,
          inviteCode: '',
        });
        saveAccount(opened);
        this.account = opened;
      } catch {
        // Fall through to the Register: a refused auto-open is not special,
        // and the screen it lands on says why better than a console line.
      }
    }

    if (!this.account && !this.devBlueprint) {
      this.mode = { kind: 'register', message: undefined };
      this.emit();
      return;
    }

    await this.join();
  }

  /**
   * Which system to ask for.
   *
   * The captain's row is the authority. A hull with no account — a tool
   * flying a draught — has no row, and a lookup that fails is not worth
   * failing the join over, so both fall back to the opening system.
   */
  private async whereAmI(): Promise<string> {
    const opening = content().tuning.start.system;
    if (!this.account) return opening;
    try {
      const berth = await berthOf(this.httpBase, this.account.deviceToken);
      return berth.systemId || opening;
    } catch {
      return opening;
    }
  }

  /** Called once an account has been opened or recovered. */
  async signedIn(account: StoredAccount): Promise<void> {
    this.account = account;
    await this.join();
  }

  /**
   * Join the room for wherever the captain is.
   *
   * The system is always named, because rooms are matched on it: joining
   * without one would take whichever room happened to be open, and the server
   * writes the room's system back to the captain's row when it persists them.
   * When the caller does not already know the system — the first join of a
   * session — it is asked for, because only the captain's row knows.
   */
  private async join(systemId?: string): Promise<void> {
    if (this.disposed) return;

    this.mode = { kind: 'connecting' };
    this.emit();

    try {
      const destination = systemId ?? (await this.whereAmI());
      if (this.disposed) return;

      const room = await this.sdk.joinOrCreate<SystemState>(
        'system',
        {
          ...(this.account ? { deviceToken: this.account.deviceToken } : {}),
          systemId: destination,
          ...(this.devBlueprint !== undefined ? { blueprint: this.devBlueprint } : {}),
        },
        SystemState,
      );

      this.attach(room);
    } catch (error) {
      this.fail(error);
    }
  }

  private attach(room: Room<unknown, SystemState>): void {
    this.room = room;
    exposeToHarness(room);
    this.systemId = room.state.systemId;
    // Arriving somewhere clears the course that brought us here.
    if (this.course === this.systemId) this.course = undefined;
    this.epoch++;
    this.mode = { kind: 'flight' };

    room.onMessage('purse', (payload) => {
      this.purse = { ...this.purse, ...(payload as Partial<Purse>) };
      this.emit();
    });

    room.onMessage('at-port', (payload) => {
      const event = payload as { port: string };
      this.mode = { kind: 'port', portId: event.port };
      this.emit();
    });

    room.onMessage('landed', (payload) => {
      const event = payload as { port: string };
      this.mode = { kind: 'port', portId: event.port };
      this.notice = undefined;
      this.emit();
    });

    room.onMessage('jump-complete', (payload) => {
      const event = payload as { system: string };
      this.mode = { kind: 'jumping', to: event.system };
      this.emit();
      void this.transferTo(event.system);
    });

    room.onMessage('jump-failed', (payload) => {
      const event = payload as { reason: string };
      this.notice = event.reason === 'short-of-propellant'
        ? 'Not enough Propellant aboard.'
        : 'The lane would not take the hull that close to the star.';
      this.emit();
    });

    room.onMessage('chat', (payload) => {
      this.pushChat([payload as ChatLine]);
    });

    room.onMessage('chat-backlog', (payload) => {
      this.pushChat((payload as { lines: ChatLine[] }).lines);
    });

    room.onMessage('posted', (payload) => {
      const event = payload as { composition: number };
      // The Court's own words, from spec section 19.
      this.notice =
        `The Prize Court has posted you. Composition is set at ` +
        `${event.composition.toLocaleString()} marks, payable at any berth that will still have you.`;
      this.emit();
    });

    // Anything this class does not handle itself is a presentation broadcast
    // the flight view reads directly. Registering a no-op for each keeps the
    // SDK from warning when no flight view is mounted, and taking the list
    // from the protocol means a message added later cannot be forgotten here.
    const handled = new Set<string>([
      'purse',
      'at-port',
      'landed',
      'jump-complete',
      'jump-failed',
      'chat',
      'chat-backlog',
      'posted',
    ]);
    for (const type of SERVER_MESSAGES) {
      if (!handled.has(type)) room.onMessage(type, () => undefined);
    }

    room.onLeave((code) => {
      if (this.disposed) return;
      // A deliberate transfer sets its own mode; anything else is a drop.
      if (this.mode.kind === 'jumping') return;
      this.mode = {
        kind: 'failed',
        heading: 'The link dropped',
        body: 'The connection to the terminal closed.',
        detail: `close code ${code}`,
        canRetry: true,
      };
      this.emit();
    });

    this.emit();
  }

  /** Leave this room and join the destination's. */
  private async transferTo(systemId: string): Promise<void> {
    const previous = this.room;
    this.room = undefined;
    this.emit();

    try {
      await previous?.leave();
    } catch {
      // Already gone.
    }

    await this.join(systemId);
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const reason: FailureReason = /4\d\d|token|auth/i.test(message) ? 'rejected' : 'unreachable';
    const explained = explainFailure(reason);
    this.mode = {
      kind: 'failed',
      heading: explained.heading,
      body: explained.body,
      detail: message,
      canRetry: explained.retry,
    };
    this.emit();
  }

  // --- Intents ------------------------------------------------------------

  /** Note a destination without committing to it. J spools for this. */
  plot(systemId: string): void {
    this.course = systemId === '' ? undefined : systemId;
    this.emit();
  }

  /** Spool for a linked system, which also becomes the plotted course. */
  jump(systemId: string): void {
    this.notice = undefined;
    this.course = systemId;
    void this.request('jump', { system: systemId });
  }

  /** Spool for whatever is plotted. Returns false when nothing is. */
  jumpPlotted(): boolean {
    const course = this.course;
    if (course === undefined || course === this.systemId) return false;
    this.jump(course);
    return true;
  }

  cancelJump(): void {
    void this.request('jump', { system: '' });
  }

  land(portId: string): void {
    void this.request('land', { port: portId });
  }

  launch(): void {
    void this.request('launch', {});
  }

  buy(service: 'repair' | 'propellant' | 'ordnance' | 'composition', units = 0): void {
    void this.request('port', { service, units });
  }

  retry(): void {
    void this.join();
  }

  /** Send an intent and turn a refusal into a notice the interface can show. */
  private async request(type: string, payload: unknown): Promise<void> {
    const room = this.room;
    if (!room) return;
    try {
      await room.request(type, payload);
      this.notice = undefined;
    } catch (error) {
      this.notice = refusalText(error);
    }
    this.emit();
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    void this.room?.leave().catch(() => undefined);
    this.room = undefined;
  }
}

/** The protocol's refusal reasons, as something a captain can read. */
function refusalText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const reasons: Record<string, string> = {
    'no-lane': 'No lane runs from here to there.',
    'too-close-to-the-star': 'Too close to the star to spool. Move clear of the centre.',
    'short-of-propellant': 'Not enough Propellant aboard for a hull this heavy.',
    'already-spooling': 'Already spooling.',
    'too-fast-to-land': 'Too fast to be taken alongside.',
    'not-in-reach': 'Not close enough to the berth.',
    'posted-here': 'The port will not have you while you are posted.',
    'cannot-afford': 'You are short of marks.',
    'nothing-to-do': 'The hull is already sound.',
    'no-room': 'The hull will not take any more.',
    'no-such-service': 'This berth does not offer that.',
    'not-landed': 'You are not at a berth.',
    'rate-limited': 'Too many requests. Slow down.',
  };

  for (const [reason, text] of Object.entries(reasons)) {
    if (raw.includes(reason)) return text;
  }
  return 'The terminal declined.';
}
