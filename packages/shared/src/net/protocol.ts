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

import type { CommissionOffer } from '../sim/commissions.ts';

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
  'no-such-licence': 'The Register issues no such warrant.',
  'licence-held': 'You already hold that warrant, or better.',
  'not-parked-here': 'That hull is not moored at this berth.',
  'already-flying-it': 'You are already in that hull.',
  'bad-share-code': 'That draught code will not read.',
  'unknown-fitting': 'That draught calls for a fitting the Register does not list.',
  'unknown-captain': 'No captain of that callsign is on the Register.',
  'give-to-self': 'You already have it.',
  'no-such-listing': 'The Bourse lists no such company.',
  'no-bourse': 'This berth keeps no Bourse.',
  'holding-capped': 'You may not hold more of one company than that.',
  'not-holding': 'You do not hold that many shares.',
  'market-too-thin': 'The pool will not take an order that size. Try a smaller parcel.',
  'limit-not-reached': 'The price has not come to your limit.',
  'short-capped': 'You may not be short more of one company than that.',
  'margin-short': 'There is not enough behind that to sell short.',
  'no-such-order': 'That order is no longer open.',
  'too-many-orders': 'You have as many orders standing as the Bourse will keep.',
  'limit-out-of-range': 'A limit has to be a price somebody might pay.',
  'unknown-draught': 'The Register lists no such draught.',
  'barred-here': 'This company will not have you alongside.',
  'not-a-seat': 'Letters are issued at a company seat, not here.',
  'standing-too-low': 'This company does not trust you with that.',
  'letter-held': 'You already hold a letter of marque.',
  'no-such-commission': 'That commission is no longer posted.',
  'already-taken': 'You are already carrying that one.',
  'too-many-commissions': 'You have as much work in hand as a Factor will give you.',
  'no-such-captain': 'No captain of that callsign is on the Register.',
  'already-in-a-convoy': 'That captain already sails in a convoy.',
  'not-in-a-convoy': 'You are not sailing in a convoy.',
  'not-invited': 'That convoy has not asked you.',
  'already-invited': 'You have already asked them.',
  'convoy-full': 'A convoy will not take another hull.',
  'not-the-leader': 'Only the captain who opened the convoy may do that.',
  'cannot-invite-yourself': 'You are already aboard.',
  'trade-with-yourself': 'You are already aboard.',
  'not-at-the-same-berth': 'You are not alongside the same berth.',
  'nothing-offered': 'An offer has to be of something.',
  'not-enough-cargo': 'That is not in the hold.',
  'not-adrift': 'That hull can still run. Stop it first.',
  'target-protected': 'That hull has only just arrived. Leave it be.',
  'too-fast-to-board': 'Match speeds before putting anybody across.',
  'nothing-aboard': 'There is nothing in it worth taking.',
  'no-room-in-hold': 'There is not room aboard for that.',
  'no-such-offer': 'That offer is no longer open.',
  'too-many-offers': 'You have as many offers open as a berth will keep.',
  'unknown-commodity': 'The Staple trades no such good.',
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
/**
 * The longest a callsign can be.
 *
 * Written once: four intents name a captain, and a field that refuses at a
 * different length from the server is a field that looks broken.
 */
export const CALLSIGN_MAX_LENGTH = 20;

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

/**
 * Buy or sell shares on the Bourse.
 *
 * `shares` is what the captain is asking for; the Bourse fills what it can and
 * answers with what it actually did, because the pool's price moves as the
 * order walks it and a captain must be told what they really paid.
 */
export const BourseIntent = z.object({
  side: z.enum(['buy', 'sell']),
  ticker: z.string().max(8),
  shares: z.int().min(1).max(100_000_000),
});
export type BourseIntent = z.infer<typeof BourseIntent>;

/**
 * Leave a standing order with the Bourse.
 *
 * There is no book to rest on: a listing trades against a pool, so a limit is
 * an instruction to walk the curve on each market tick as far as the price
 * allows and no further. `short` lets a sell go past what the captain holds,
 * which is borrowing and is held to a margin.
 */
export const PlaceOrderIntent = z.object({
  side: z.enum(['buy', 'sell']),
  ticker: z.string().max(8),
  shares: z.int().min(1).max(100_000_000),
  /** Marks a share. A buy will not pay above it; a sell will not take below it. */
  limit: z.number().positive().max(1_000_000),
  short: z.boolean().optional(),
});
export type PlaceOrderIntent = z.infer<typeof PlaceOrderIntent>;

/**
 * Put something else up on the range.
 *
 * A draught that beats a gunboat and cannot touch a turret is a thing to
 * find out on a range rather than off Sato's Error.
 */
export const RangeSparIntent = z.object({
  /** A catalogue draught, or empty to put the same thing up again. */
  against: z.string().max(64),
});
export type RangeSparIntent = z.infer<typeof RangeSparIntent>;

/** Withdraw a standing order. */
export const CancelOrderIntent = z.object({
  id: z.string().max(64),
});
export type CancelOrderIntent = z.infer<typeof CancelOrderIntent>;

/** A standing order as the interface draws it. */
export interface OrderLine {
  readonly id: string;
  readonly ticker: string;
  readonly side: 'buy' | 'sell';
  /** Shares still wanted. */
  readonly shares: number;
  /** Shares filled so far, and what they came to. */
  readonly filled: number;
  readonly settled: number;
  /** Marks a share it will not trade past. */
  readonly limit: number;
  readonly short: boolean;
  readonly state: 'open' | 'filled' | 'cancelled';
  /** Why it closed, where it closed for a reason worth reading. */
  readonly reason: string;
  readonly placedAt: number;
}

/**
 * Where a captain stands against what they have borrowed.
 *
 * `equity` is what would be left if the whole account were closed out now;
 * `owed` is the market value of the shares they are short. A captain whose
 * equity falls below `maintenance` of what they owe has the position bought
 * back for them, whether or not they are online to see it.
 */
export interface MarginState {
  readonly equity: number;
  readonly owed: number;
  /** Equity needed to open or add to a short, as a share of what is owed. */
  readonly initial: number;
  /** And the level it may fall to before the Bourse closes it out. */
  readonly maintenance: number;
}

/** A listing as the interface draws it. */
export interface Listing {
  readonly ticker: string;
  readonly name: string;
  readonly parent: string;
  readonly sector: string;
  readonly description: string;
  /** Marks a share, as quoted now. */
  readonly price: number;
  /** What the Exchange thinks it is worth, which the price drifts toward. */
  readonly fairValue: number;
  /** Earnings a tick, smoothed. */
  readonly earnings: number;
  /** Price a market tick ago, so the interface can show the move. */
  readonly previous: number;
  /** Recent prices, oldest first, for the chart. */
  readonly history: readonly number[];
  /** Shares in issue, and the most one captain may hold. */
  readonly float: number;
  readonly holdingCap: number;
  /** What this captain holds, and what they paid for it in total. */
  readonly held: number;
  readonly costBasis: number;
  /** Dividends this captain has been paid on it, all told. */
  readonly dividends: number;
  /** Shares the pool can still sell, so the ticket can bound its field. */
  readonly available: number;
  /**
   * The pool's own holdings, so the ticket can quote exactly.
   *
   * Sent rather than inferred. The interface previews an order with the same
   * `quoteBuy`/`quoteSell` the server fills it with, and those take a pool;
   * reconstructing one from the price and the available shares is right only
   * up to the rounding in both, which is exactly the kind of near-miss that
   * shows a captain one total and charges another.
   */
  readonly poolShares: number;
  readonly poolMarks: number;
}

/** A headline in the Gazette. */
export interface Headline {
  readonly id: string;
  /** The listing it is about, or empty for a general notice. */
  readonly ticker: string;
  readonly text: string;
  /** Server wall-clock, for ordering and for "two minutes ago". */
  readonly at: number;
  /** Which way it moved the company, for the interface's accent. */
  readonly direction: 'up' | 'down' | 'flat';
}

/**
 * A commission in hand, as the Factor's board sends it.
 *
 * The terms flattened, plus the clock it is against and, for a convoy's
 * shared work, whose name is on it. Declared here rather than copied into
 * the screen: the two drifted once, the figures all came out undefined and
 * nothing but a capture noticed.
 */
export interface HeldCommissionLine extends CommissionOffer {
  readonly takenAt: number;
  readonly dueAt: number;
  /** The captain who took it on, or empty when that is the one reading it. */
  readonly holder: string;
  /** True when it is on a convoy's books, so anybody in it may discharge it. */
  readonly shared: boolean;
}

/**
 * A captain in a convoy, as the convoy's own screen and the map read them.
 *
 * Where they are travels with the row, because the point of a convoy is
 * knowing where everybody is: a member in another system is a line on the
 * chart, and a member alongside is somebody you can hand cargo to.
 */
export interface ConvoyMemberLine {
  readonly callsign: string;
  /** When they joined, or were asked, so the screen can keep the server's order. */
  readonly joinedAt: number;
  /** 'member', or 'invited' for somebody who has not answered yet. */
  readonly state: 'member' | 'invited';
  readonly isLeader: boolean;
  /** True for the captain reading it. */
  readonly isSelf: boolean;
  /** Empty when they are not connected. */
  readonly systemId: string;
  readonly systemName: string;
  /** The berth they are alongside, or empty while they are flying. */
  readonly portId: string;
  readonly portName: string;
  readonly online: boolean;
}

/** The convoy push: who is in it, and what is waiting on an answer. */
export interface ConvoyState {
  /** Empty when this captain sails alone. */
  readonly id: string;
  readonly name: string;
  readonly isLeader: boolean;
  readonly members: readonly ConvoyMemberLine[];
  /** Invitations waiting on this captain. */
  readonly invitations: readonly {
    readonly fleetId: string;
    readonly name: string;
    readonly from: string;
    readonly at: number;
  }[];
  /** How many may sail together, so the screen can say when it is full. */
  readonly limit: number;
}

/** An offer between two captains alongside the same berth. */
export interface TradeOfferLine {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /** True when this captain made it, so the screen knows which way it reads. */
  readonly mine: boolean;
  /** What the receiving captain pays. Negative is the offerer paying. */
  readonly marks: number;
  readonly cargo: readonly {
    readonly commodityId: string;
    readonly name: string;
    readonly units: number;
  }[];
  readonly designName: string;
  readonly offeredAt: number;
}

/** Everything open either way, and who else is alongside to offer to. */
export interface OffersState {
  readonly offers: readonly TradeOfferLine[];
  /** Other captains landed at this berth right now, by callsign. */
  readonly alongside: readonly string[];
  /**
   * What this captain is carrying, and what is on their books.
   *
   * Carried here rather than read off the Staple and the Yard, because a
   * captain can hand something over at any berth and plenty of berths keep
   * neither: taking them from the other screens meant an empty picker at
   * exactly the berths where two captains are most likely to meet.
   */
  readonly hold: readonly {
    readonly commodityId: string;
    readonly name: string;
    readonly units: number;
  }[];
  readonly designs: readonly { readonly id: string; readonly name: string }[];
  /**
   * What the hull will carry, and what is in it.
   *
   * So the screen can say an inbound parcel will not fit, rather than
   * leaving the captain to find out when the server refuses it.
   */
  readonly holdCapacity: number;
  readonly holdUsed: number;
}

/** A line on the leaderboard. */
export interface Standing {
  readonly callsign: string;
  /** Marks, plus shares at the quoted price, plus hulls at their build cost. */
  readonly worth: number;
  readonly marks: number;
  readonly shares: number;
  readonly hulls: number;
  /** True for the captain reading it, so their own line can be marked. */
  readonly isSelf: boolean;
}

/** Take a commission off a berth's board. */
export const TakeCommissionIntent = z.object({
  id: z.string().min(1).max(128),
});
export type TakeCommissionIntent = z.infer<typeof TakeCommissionIntent>;

/** Give one up. The Factor remembers, but it is not a crime. */
export const AbandonCommissionIntent = z.object({
  id: z.string().min(1).max(64),
});
export type AbandonCommissionIntent = z.infer<typeof AbandonCommissionIntent>;

/**
 * Settle a finished chain by taking one of its two endings.
 *
 * Both are available and both pay; the difference is who is owed afterwards.
 */
export const ChainEndingIntent = z.object({
  chain: z.string().min(1).max(64),
  ending: z.string().min(1).max(64),
});
export type ChainEndingIntent = z.infer<typeof ChainEndingIntent>;

/**
 * Take out, or give up, a letter of marque.
 *
 * `charter` empty surrenders whatever is held — a captain who wants to deal
 * with the other two again has to, and the Register would rather be told than
 * work it out.
 */
export const LetterIntent = z.object({
  charter: z.string().max(32),
});
export type LetterIntent = z.infer<typeof LetterIntent>;

/**
 * Ask another captain to sail with you.
 *
 * Opens a convoy if the asking captain is not in one, because "make a
 * convoy, then invite somebody" is one intent in two steps.
 */
export const ConvoyInviteIntent = z.object({
  callsign: z.string().min(1).max(CALLSIGN_MAX_LENGTH),
});
export type ConvoyInviteIntent = z.infer<typeof ConvoyInviteIntent>;

/** Take an invitation up, or turn it down. */
export const ConvoyAnswerIntent = z.object({
  fleet: z.string().min(1).max(64),
  accept: z.boolean(),
});
export type ConvoyAnswerIntent = z.infer<typeof ConvoyAnswerIntent>;

/**
 * Leave a convoy, or put somebody out of it.
 *
 * An empty callsign leaves; a callsign is the leader removing that captain.
 * The leader leaving dissolves it rather than handing it on.
 */
export const ConvoyLeaveIntent = z.object({
  callsign: z.string().max(CALLSIGN_MAX_LENGTH),
});
export type ConvoyLeaveIntent = z.infer<typeof ConvoyLeaveIntent>;

/** Put a commission on the convoy's books, or take it off again. */
export const ShareCommissionIntent = z.object({
  id: z.string().min(1).max(64),
  shared: z.boolean(),
});
export type ShareCommissionIntent = z.infer<typeof ShareCommissionIntent>;

/**
 * Offer another captain cargo, a draught and marks, alongside the same berth.
 *
 * One-sided with a price: `marks` is what the receiving captain pays, and a
 * negative figure is the offering captain paying them. A swap is two offers.
 */
export const TradeOfferIntent = z.object({
  callsign: z.string().min(1).max(CALLSIGN_MAX_LENGTH),
  marks: z.number().int().min(-1_000_000_000).max(1_000_000_000),
  cargo: z
    .array(
      z.object({
        commodityId: z.string().min(1).max(64),
        units: z.number().int().min(1).max(100_000),
      }),
    )
    .max(16),
  design: z.string().max(64),
});
export type TradeOfferIntent = z.infer<typeof TradeOfferIntent>;

/** Take an offer up, turn it down, or take your own back. */
export const TradeAnswerIntent = z.object({
  id: z.string().min(1).max(64),
  accept: z.boolean(),
});
export type TradeAnswerIntent = z.infer<typeof TradeAnswerIntent>;

/** Buy a hull licence. Only upward, and only what the Register issues. */
export const BuyLicenceIntent = z.object({
  licence: z.string().max(64),
});
export type BuyLicenceIntent = z.infer<typeof BuyLicenceIntent>;

/** Take out a hull moored at this berth and leave the current one in its place. */
export const SwitchShipIntent = z.object({
  id: z.string().min(1).max(64),
});
export type SwitchShipIntent = z.infer<typeof SwitchShipIntent>;

/**
 * Read a draught code onto your own books.
 *
 * The code is bounded here at something generous: a draught of 160 fittings
 * with every one a different module encodes to well under this, and a longer
 * string is not a code whatever else it is.
 */
export const ImportDesignIntent = z.object({
  code: z.string().min(8).max(4096),
  /** What to call it. Left out, the name in the code is used. */
  name: z.string().max(40).optional(),
});
export type ImportDesignIntent = z.infer<typeof ImportDesignIntent>;

/** Hand one of your draughts to another captain, by callsign. */
export const GiveDesignIntent = z.object({
  id: z.string().min(1).max(64),
  callsign: z.string().min(1).max(CALLSIGN_MAX_LENGTH),
});
export type GiveDesignIntent = z.infer<typeof GiveDesignIntent>;

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
  'claim',
  'respawned',
  'order',
  'range',
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
  'given-design',
  'bourse',
  'news',
  'standings',
  'standing',
  'scanned',
  'commissions',
  'commission',
  'convoy',
  'offers',
  'offer',
] as const;

/** One of the pushes above, for code that routes them. */
export type ServerMessage = (typeof SERVER_MESSAGES)[number];

/**
 * What a write-off settled, sent only to the captain it happened to.
 *
 * The figures come from the Hall rather than from the client's reckoning of
 * what the draught cost: a claim a captain works out for themselves is a
 * claim that disagrees with their balance.
 */
export interface ClaimState {
  /** The hull that was lost, or empty for a draught nobody paid for. */
  readonly hull: string;
  /** Marks insurance settled. */
  readonly claim: number;
  /** The balance after it. */
  readonly marks: number;
  /** Units of cargo gone for good. */
  readonly lost: number;
  /** Units that dropped as canisters, which anybody can scoop. */
  readonly spilled: number;
  /** Hulls still on the captain's books, parked where they were left. */
  readonly stillOwned: number;
}

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

/**
 * Put a party aboard a hull that cannot run, and take what it is carrying.
 *
 * Only a hull that is adrift — every engine out and not written off — and
 * only from close alongside, with both hulls slow. A hull that could still
 * fly away would fly away, and a wreck has already dropped its cargo.
 */
export const BoardIntent = z.object({
  id: z.string().min(1).max(64),
});
export type BoardIntent = z.infer<typeof BoardIntent>;

/** How close a hull must be to put a party aboard another, in world units. */
export const BOARDING_RANGE = 150;

/**
 * How slowly both hulls must be going, in units a second.
 *
 * Matching speeds is the whole of the manoeuvre: a party cannot cross
 * between two hulls passing at four hundred a second, and making a captain
 * come alongside properly is what keeps boarding from being a drive-by.
 */
export const BOARDING_SPEED = 60;

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
