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
import type {
  ConvoyState,
  Headline,
  Listing,
  MarginState,
  OffersState,
  OrderLine,
  Placement,
  Problem,
  Standing,
} from '@marque/shared';

import type { BoardOffer, HeldOffer } from '../commissions/Board.tsx';

import {
  CHAT_BACKLOG,
  REJECTIONS,
  SERVER_MESSAGES,
  SystemState,
  content,
  encodeShareCode,
  normaliseShareCode,
  rejectionText,
  scrubChat,
  type ChatLine,
  type RejectionReason,
} from '@marque/shared';

import { playNotice } from '../audio/notices.ts';
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

/** What a berth is trading, as the Staple shows it. */
export interface StapleState {
  readonly port: string;
  /** Whose berth it is: the seal struck on an order here. */
  readonly owner: string;
  readonly listings: readonly {
    commodityId: string;
    name: string;
    tier: string;
    ask: number;
    bid: number;
    stock: number;
    capacity: number;
    pressure: number;
    carried: number;
  }[];
  readonly holdCapacity: number;
  readonly holdUsed: number;
}

/** A berth's board, and what the captain already has in hand. */
export interface CommissionState {
  readonly board: readonly BoardOffer[];
  readonly held: readonly HeldOffer[];
  readonly berthName: string;
  /**
   * A finished chain waiting on its last choice.
   *
   * Only present at the chartering company's own seat, which is the one berth
   * where the choice can be made, so its presence is the whole condition: the
   * screen does not have to work out whether it is allowed.
   */
  readonly ending?: ChainEnding;
}

/** The two ways a chain can end, as the Factor lays them out. */
export interface ChainEnding {
  readonly chain: string;
  readonly name: string;
  readonly charter: string;
  readonly choices: readonly {
    readonly id: string;
    readonly choice: string;
    readonly pay: number;
    /** Whether the chartering company comes out of it liking you more. */
    readonly favours: boolean;
  }[];
}

/** What a Factor said when a commission was answered, or was not. */
export interface CommissionNews {
  readonly id: string;
  readonly title: string;
  readonly outcome: 'done' | 'failed';
  readonly text: string;
  readonly pay?: number;
}

/** What the three charters think of this captain, and what to call it. */
export interface StandingState {
  readonly standings: Record<string, number>;
  readonly names: Record<string, string>;
}

/** The floor, the feed and the board, as one screen's worth of state. */
export interface BourseState {
  readonly listings: readonly Listing[];
  readonly news: readonly Headline[];
  readonly standings: readonly Standing[];
  readonly feeRate: number;
  readonly maxPoolFraction: number;
  /** Standing orders the Bourse is carrying out, open ones first. */
  readonly orders: readonly OrderLine[];
  /** Where this captain stands against what they have borrowed. */
  readonly margin: MarginState | undefined;
}

/**
 * The range, while a captain is on one.
 *
 * `problems` is the Yard's own verdict on the draught: a grid the warrant
 * will not carry is refused out here exactly as it would be at the counter,
 * rather than flown and then found out about.
 */
export interface RangeState {
  /** The callsign on the hull under test. */
  readonly flying: string;
  /** The draught it is up against. */
  readonly against: string;
  readonly note: string;
  readonly problems: readonly string[];
}

/** What a captain has on their books and at their moorings. */
export interface YardState {
  readonly designs: readonly { id: string; name: string; placements: Placement[] }[];
  readonly ships: readonly {
    id: string;
    name: string;
    placements: Placement[];
    portId: string;
    systemId: string;
  }[];
  readonly licence: string;
  /** The hull being flown, which the editor starts a refit from. */
  readonly flying: Placement[];
  /** Its id in the hangar, or empty for a hull that was never built. */
  readonly flyingId: string;
  readonly flyingName: string;
  /** The highest tier this berth's Yard stocks from each maker. */
  readonly stock: Partial<Record<string, number>>;
  readonly berthName: string;
  /** Whose berth it is: the seal struck on a bill here. */
  readonly owner: string;
  /** The warrant ladder, lowest first, with what each one covers. */
  readonly licences: readonly {
    id: string;
    name: string;
    cost: number;
    maxModules: number;
    maxExtent: number;
    held: boolean;
    behind: boolean;
  }[];
}

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
  /** The berth's Staple, while alongside one that keeps a market. */
  readonly staple: StapleState | undefined;
  /** The captain's draughts and hulls, while alongside. */
  readonly yard: YardState | undefined;
  /** The Bourse, the Gazette and the standings, while alongside one. */
  readonly bourse: BourseState | undefined;
  /** Set while the captain is on the range. */
  readonly range: RangeState | undefined;
  /** Where this captain stands with the three charters. */
  readonly standing: StandingState | undefined;
  /** The berth's board and what the captain is carrying, while alongside. */
  readonly commissions: CommissionState | undefined;
  /** Who this captain sails with, and where they all are. */
  readonly convoy: ConvoyState | undefined;
  /**
   * Set from the moment this captain's hull is written off until they say
   * they have read what it cost. While it is true the shore is held: see
   * `goAshore`.
   */
  readonly lost: boolean;
  /** Offers open either way, and who else is at this counter. */
  readonly offers: OffersState | undefined;
  /** The last word from a Factor about a commission, for the hub to show. */
  readonly commissionNews: CommissionNews | undefined;
  /** What the server's survey found, when it refused a build. */
  readonly surveyProblems: readonly Problem[];
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
  private staple: StapleState | undefined;
  private yard: YardState | undefined;
  private bourse: BourseState | undefined;
  /** True while the captain is on the range rather than in a real sky. */
  private onRange = false;
  private range: RangeState | undefined;
  private standing: StandingState | undefined;
  private commissions: CommissionState | undefined;
  private convoy: ConvoyState | undefined;
  private offers: OffersState | undefined;
  private commissionNews: CommissionNews | undefined;
  private surveyProblems: readonly Problem[] = [];
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

  /**
   * A captain reading what their loss cost, and where they go when they are
   * done reading it.
   *
   * The server settles a write-off on its own clock: six seconds after the
   * hull comes apart it takes the wreck off the books and stands the captain
   * on their last berth. That is right for the world and wrong for the
   * person, who has just lost their ship and gets five seconds with the one
   * screen that says what it cost before a berth they did not walk into
   * replaces it. Nothing about the loss is in doubt by then — it is settled,
   * paid and persisted — so what is held back here is only the view of it.
   * `goAshore` lets it through.
   */
  private lost = false;
  private shore: { kind: 'port'; portId: string } | { kind: 'jump'; system: string } | undefined;

  /**
   * This captain's hull has been written off.
   *
   * Told rather than listened for: the SDK keeps one handler per message
   * type, so a second `onMessage('written-off')` here would simply replace
   * the flight view's — which needs the same message to put an explosion
   * where every hull came apart, not just this one. Registering both looked
   * right and did nothing.
   */
  markLost(): void {
    if (this.lost) return;
    this.lost = true;
    this.shore = undefined;
    // Whatever was last refused is no longer the subject. A captain being
    // told their hull is gone should not also be told the port declined
    // something they have stopped caring about.
    this.notice = undefined;
    this.emit();
  }

  /**
   * Done reading. Go wherever the loss already put us.
   *
   * Safe to call when nothing is held: a captain who never lost a hull has
   * no shore waiting, and the panel is the only thing that calls it.
   */
  goAshore(): void {
    if (!this.lost) return;
    this.lost = false;
    const next = this.shore;
    this.shore = undefined;

    if (!next) {
      // Written off and the shore has not arrived yet — the respawn is still
      // a moment away. Clearing the hold is enough: whichever message comes
      // next is no longer deferred.
      this.emit();
      return;
    }

    if (next.kind === 'port') {
      this.mode = { kind: 'port', portId: next.portId };
      this.notice = undefined;
      this.emit();
      return;
    }

    this.mode = { kind: 'jumping', to: next.system };
    this.emit();
    void this.transferTo(next.system);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): GameSnapshot {
    return {
      mode: this.mode,
      lost: this.lost,
      room: this.room,
      systemId: this.systemId,
      purse: this.purse,
      chart: this.chart,
      account: this.account,
      epoch: this.epoch,
      notice: this.notice,
      course: this.course,
      staple: this.staple,
      yard: this.yard,
      bourse: this.bourse,
      range: this.range,
      standing: this.standing,
      commissions: this.commissions,
      convoy: this.convoy,
      offers: this.offers,
      commissionNews: this.commissionNews,
      surveyProblems: this.surveyProblems,
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
    // One tick for a batch, and none for the backlog that arrives on
    // joining: a captain walking into a busy channel should not hear forty
    // of them. None for this captain's own line either — they typed it.
    const mine = this.account?.callsign;
    if (
      this.chatLines.length > 0
      && added.length < 4
      && added.some((line) => line.callsign !== mine)
    ) {
      playNotice('chat');
    }
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
      // Held, not dropped: the captain is already ashore as far as the world
      // is concerned, and this is where they will be standing when they close
      // the panel.
      if (this.lost) {
        this.shore = { kind: 'port', portId: event.port };
        this.emit();
        return;
      }
      this.mode = { kind: 'port', portId: event.port };
      this.notice = undefined;
      this.emit();
    });

    room.onMessage('jump-complete', (payload) => {
      const event = payload as { system: string };
      // A captain whose last berth was in another system wakes there, and the
      // respawn says so with this rather than with `landed`. Held the same
      // way, or the room changes under the panel and takes it with it.
      if (this.lost) {
        this.shore = { kind: 'jump', system: event.system };
        this.emit();
        return;
      }
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

    room.onMessage('yard', (payload) => {
      this.yard = payload as YardState;
      this.emit();
    });

    // The three arrive separately but are one screen, so they are held
    // together and the parts that have not arrived yet read as empty rather
    // than as undefined.
    room.onMessage('commissions', (payload) => {
      this.commissions = payload as CommissionState;
      this.emit();
    });

    room.onMessage('convoy', (payload) => {
      this.convoy = payload as ConvoyState;
      this.emit();
    });

    room.onMessage('offers', (payload) => {
      this.offers = payload as OffersState;
      this.emit();
    });

    room.onMessage('offer', (payload) => {
      // An offer this captain made has been taken up. Said as a notice
      // rather than left to the list quietly losing a row.
      const taken = payload as { to: string; marks: number };
      this.notice =
        taken.marks > 0
          ? `${taken.to} took your offer, and paid ${taken.marks.toLocaleString()} marks.`
          : `${taken.to} took your offer.`;
      this.emit();
    });

    room.onMessage('commission', (payload) => {
      // A Factor's verdict. Held until the captain has seen it rather than
      // replaced by the next push, because being paid is worth reading.
      this.commissionNews = payload as CommissionNews;
      // Two notes resolving when it was done and paid; nothing when it was
      // not, because a chime for a failure is a chime that means nothing.
      if (this.commissionNews.outcome === 'done') playNotice('commission');
      this.emit();
    });

    room.onMessage('standing', (payload) => {
      this.standing = payload as StandingState;
      this.emit();
    });

    room.onMessage('bourse', (payload) => {
      const board = payload as {
        listings: Listing[];
        feeRate: number;
        maxPoolFraction: number;
        orders?: OrderLine[];
        margin?: MarginState;
      };
      this.bourse = {
        listings: board.listings,
        news: this.bourse?.news ?? [],
        standings: this.bourse?.standings ?? [],
        feeRate: board.feeRate,
        maxPoolFraction: board.maxPoolFraction,
        orders: board.orders ?? [],
        margin: board.margin,
      };
      this.emit();
    });

    room.onMessage('order', (payload) => {
      // The Bourse carried something out on the captain's behalf, which may
      // have been while they were somewhere else entirely. A sound, because
      // a notice nobody is looking at has only one channel.
      const line = payload as { kind?: string };
      playNotice(line.kind === 'liquidated' ? 'called' : 'filled');
    });

    room.onMessage('range', (payload) => {
      this.range = payload as RangeState;
      this.emit();
    });

    room.onMessage('news', (payload) => {
      if (!this.bourse) return;
      this.bourse = { ...this.bourse, news: (payload as { headlines: Headline[] }).headlines };
      this.emit();
    });

    room.onMessage('standings', (payload) => {
      if (!this.bourse) return;
      this.bourse = {
        ...this.bourse,
        standings: (payload as { standings: Standing[] }).standings,
      };
      this.emit();
    });

    room.onMessage('survey', (payload) => {
      this.surveyProblems = (payload as { problems: Problem[] }).problems;
      this.emit();
    });

    room.onMessage('market', (payload) => {
      this.staple = payload as StapleState;
      this.emit();
    });

    room.onMessage('chat', (payload) => {
      this.pushChat([payload as ChatLine]);
    });

    room.onMessage('dividend', (payload) => {
      const paid = payload as { ticker: string; marks: number };
      // Money that arrived while the captain was doing something else, so
      // the notice line says which company and the chime says that
      // something happened at all.
      this.notice = `${paid.ticker} paid a dividend of ${paid.marks.toLocaleString()} marks.`;
      playNotice('dividend');
      this.emit();
    });

    room.onMessage('chat-backlog', (payload) => {
      this.pushChat((payload as { lines: ChatLine[] }).lines);
    });

    room.onMessage('posted', (payload) => {
      const event = payload as { composition: number };
      // The one alert in the game. The music ducks for it, which is what
      // the feedback table asks for by name.
      playNotice('posted');
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
      'market',
      'yard',
      'survey',
      'dividend',
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
  /**
   * Take a draught out on the range.
   *
   * A room of its own, so nothing out there can reach the captain's books.
   * The system room is left first: a captain is in one sky at a time, and
   * holding both would leave their hull sitting in the system they came
   * from while they fly somewhere that does not exist.
   */
  async enterRange(
    placements: readonly Placement[],
    name?: string,
    against?: string,
  ): Promise<void> {
    if (this.disposed) return;

    const from = this.systemId;
    const previous = this.room;
    this.room = undefined;
    this.range = { flying: '', against: against ?? '', note: '', problems: [] };
    this.mode = { kind: 'connecting' };
    this.emit();

    try {
      await previous?.leave();
    } catch {
      // Already gone.
    }

    try {
      const room = await this.sdk.create<SystemState>(
        'range',
        {
          ...(this.account ? { deviceToken: this.account.deviceToken } : {}),
          systemId: from,
          placements,
          ...(name !== undefined ? { name } : {}),
          ...(against !== undefined ? { against } : {}),
        },
        SystemState,
      );
      this.onRange = true;
      this.attach(room);
    } catch (error) {
      this.onRange = false;
      this.range = undefined;
      this.fail(error);
    }
  }

  /** Come back off the range, to the sky the captain actually lives in. */
  async leaveRange(): Promise<void> {
    if (!this.onRange) return;
    this.onRange = false;
    this.range = undefined;
    await this.transferTo(this.systemId);
  }

  /** Put something else up against the draught under test. */
  async spar(against: string): Promise<boolean> {
    if (!this.onRange) return false;
    return this.requestOk('spar', { against });
  }

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

  /**
   * Leave the berth.
   *
   * The mode is moved here rather than on a push from the server, because
   * there is no push: the server launches the hull and says so in the
   * response, and nothing else tells the client it is flying again. Only on
   * the server's `launched`, so a refusal leaves the captain alongside with
   * the reason on the notice line rather than in a sky they are not in.
   */
  async launch(): Promise<void> {
    const took = await this.requestOk('launch', {});
    if (!took) return;
    // The berth's prices belong to the berth: a captain in flight is not
    // looking at a market, and a stale one would be worse than none.
    this.staple = undefined;
    this.yard = undefined;
    this.surveyProblems = [];
    this.mode = { kind: 'flight' };
    // A new hull in the sky is a new flight view, so it gets a new key and
    // builds its renderer from the ship the server just spawned.
    this.epoch++;
    this.emit();
  }

  /**
   * Build or refit at the berth's Yard.
   *
   * The server validates the design for itself and answers a refusal with the
   * problems, which the editor marks on the grid.
   */
  build(name: string, placements: readonly Placement[], refitting?: string): void {
    this.surveyProblems = [];
    void this.request('build', {
      name,
      placements,
      ...(refitting !== undefined ? { refitting } : {}),
    });
  }

  /** Keep a draught on the captain's books, or replace one. */
  saveDesign(name: string, placements: readonly Placement[], id?: string): void {
    void this.request('save-design', {
      name,
      placements,
      ...(id !== undefined ? { id } : {}),
    });
  }

  forgetDesign(id: string): void {
    void this.request('forget-design', { id });
  }

  /**
   * A draught as a code to paste to somebody.
   *
   * Encoded here rather than asked of the server: the editor already holds
   * the placements, the encoding is deterministic shared code, and a captain
   * copying a code should not have to wait for a round trip.
   */
  exportDesign(name: string, placements: readonly Placement[]): string {
    return encodeShareCode({ name, placements: [...placements] });
  }

  /** Read a pasted code onto the captain's books. */
  async importDesign(code: string, name?: string): Promise<boolean> {
    return this.requestOk('import-design', {
      code: normaliseShareCode(code),
      ...(name !== undefined && name !== '' ? { name } : {}),
    });
  }

  /** Hand a draught to another captain, by callsign. */
  async giveDesign(id: string, callsign: string): Promise<boolean> {
    return this.requestOk('give-design', { id, callsign: callsign.trim() });
  }

  /** Buy the next warrant up. */
  async buyLicence(licence: string): Promise<boolean> {
    return this.requestOk('buy-licence', { licence });
  }

  /** Take out a hull moored at this berth. */
  async switchShip(id: string): Promise<boolean> {
    return this.requestOk('switch-ship', { id });
  }

  /** Take a commission off the berth's board. */
  async takeCommission(id: string): Promise<boolean> {
    return this.requestOk('take-commission', { id });
  }

  /** Give one up. */
  async abandonCommission(id: string): Promise<boolean> {
    return this.requestOk('abandon-commission', { id });
  }

  /** Put a commission on the convoy's books, or take it off again. */
  async shareCommission(id: string, shared: boolean): Promise<boolean> {
    return this.requestOk('share-commission', { id, shared });
  }

  /** Ask another captain to sail in convoy. */
  async inviteToConvoy(callsign: string): Promise<boolean> {
    return this.requestOk('convoy-invite', { callsign });
  }

  /** Take an invitation up, or turn it down. */
  async answerConvoy(fleet: string, accept: boolean): Promise<boolean> {
    return this.requestOk('convoy-answer', { fleet, accept });
  }

  /** Leave a convoy. An empty callsign is yourself; a callsign is a removal. */
  async leaveConvoy(callsign = ''): Promise<boolean> {
    return this.requestOk('convoy-leave', { callsign });
  }

  /** Offer another captain cargo, a draught and marks, alongside this berth. */
  async offerTrade(offer: {
    callsign: string;
    marks: number;
    cargo: readonly { commodityId: string; units: number }[];
    design: string;
  }): Promise<boolean> {
    return this.requestOk('trade-offer', {
      callsign: offer.callsign,
      marks: Math.trunc(offer.marks),
      cargo: offer.cargo.map((parcel) => ({
        commodityId: parcel.commodityId,
        units: Math.trunc(parcel.units),
      })),
      design: offer.design,
    });
  }

  /** Take an offer up, turn it down, or take your own back. */
  async answerOffer(id: string, accept: boolean): Promise<boolean> {
    return this.requestOk('trade-answer', { id, accept });
  }

  /**
   * Settle a finished chain by taking one of its two endings.
   *
   * The reply carries the passage the chain ends on, so it is held as a
   * Factor's verdict rather than thrown away: a captain who has run seven
   * errands should get to read how it came out.
   */
  async chooseChainEnding(chain: string, ending: string, name: string): Promise<boolean> {
    const room = this.room;
    if (!room) return false;
    try {
      const settled = await room.request<
        { chain: string; ending: string },
        { text: string; pay: number }
      >('chain-ending', { chain, ending });
      this.notice = undefined;
      this.commissionNews = {
        id: chain,
        title: name,
        outcome: 'done',
        text: settled.text,
        pay: settled.pay,
      };
      this.emit();
      return true;
    } catch (error) {
      this.notice = refusalText(error);
      this.emit();
      return false;
    }
  }

  /** Mark the Factor's last word as read. */
  clearCommissionNews(): void {
    if (this.commissionNews === undefined) return;
    this.commissionNews = undefined;
    this.emit();
  }

  /** Buy or sell shares on the Bourse. */
  async deal(side: 'buy' | 'sell', ticker: string, shares: number): Promise<boolean> {
    if (shares < 1) return false;
    return this.requestOk('bourse', { side, ticker, shares: Math.trunc(shares) });
  }

  /**
   * Leave a standing order with the Bourse.
   *
   * Nothing is charged now: the order waits for the price to come to it, and
   * the market tick carries it out as far as the limit allows.
   */
  async placeOrder(
    side: 'buy' | 'sell',
    ticker: string,
    shares: number,
    limit: number,
    short: boolean,
  ): Promise<boolean> {
    if (shares < 1 || !(limit > 0)) return false;
    return this.requestOk('place-order', {
      side,
      ticker,
      shares: Math.trunc(shares),
      limit,
      short,
    });
  }

  /** Withdraw a standing order. */
  async cancelOrder(id: string): Promise<boolean> {
    return this.requestOk('cancel-order', { id });
  }

  /**
   * Trade at the berth's Staple. The server answers with fresh prices.
   *
   * Says whether the server took it, because a berth that declines is not a
   * cargo bought: the ticket's endorsements are for things that happened.
   */
  async trade(side: 'buy' | 'sell', commodity: string, units: number): Promise<boolean> {
    if (units < 1) return false;
    return this.requestOk('staple', { side, commodity, units: Math.trunc(units) });
  }

  buy(service: 'repair' | 'propellant' | 'ordnance' | 'composition', units = 0): void {
    void this.request('port', { service, units });
  }

  retry(): void {
    void this.join();
  }

  /** Send an intent and turn a refusal into a notice the interface can show. */
  private async request(type: string, payload: unknown): Promise<void> {
    await this.requestOk(type, payload);
  }

  /**
   * As `request`, but says whether the server accepted it.
   *
   * Used where the interface has to act on the answer rather than just show a
   * notice: a form that should only close once its intent was accepted, or a
   * field that should only clear once the code in it was read.
   */
  private async requestOk(type: string, payload: unknown): Promise<boolean> {
    const room = this.room;
    if (!room) return false;
    try {
      await room.request(type, payload);
      this.notice = undefined;
      this.emit();
      return true;
    } catch (error) {
      this.notice = refusalText(error);
      this.emit();
      return false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    void this.room?.leave().catch(() => undefined);
    this.room = undefined;
  }
}

/**
 * The protocol's refusal reasons, as something a captain can read.
 *
 * The SDK puts the server's reason on `reason` and leaves `message` as a
 * generic "request rejected", so reading the message — which this did — threw
 * every typed refusal away and showed the same sentence for all of them. The
 * reason is read first and the message only as a fallback.
 *
 * The table itself is the shared one. The copy this replaced had drifted:
 * every refusal the Staple can give was missing from it.
 */
function refusalText(error: unknown): string {
  const reason = (error as { reason?: unknown } | null)?.reason;
  if (typeof reason === 'string' && reason in REJECTIONS) {
    return rejectionText(reason as RejectionReason);
  }

  // Older or unwrapped errors carry it in the message instead. Longest first,
  // so a short reason cannot shadow a longer one that contains it.
  const raw = error instanceof Error ? error.message : String(error);
  const reasons = (Object.keys(REJECTIONS) as RejectionReason[]).sort(
    (a, b) => b.length - a.length,
  );
  for (const candidate of reasons) {
    if (raw.includes(candidate)) return rejectionText(candidate);
  }

  return 'The terminal declined.';
}
