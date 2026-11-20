/**
 * The provisional ticket, and the hints.
 *
 * Spec section 13 asks for two things: a skippable guided first session that
 * covers flying, landing, buying cargo, jumping, selling, the Yard and the
 * Bourse; and a contextual hint the first time each system is used.
 *
 * Neither is a tutorial voice. An Open Ticket is issued provisional, with
 * seven endorsements the Register's clerk adds as the holder does each thing
 * once — which is what a guided first session is, written as paperwork. A
 * captain who wants none of it waives the endorsements and the ticket is
 * confirmed anyway; the world does not care either way, which is the point.
 *
 * All of it is kept on the device. What a captain has already been told is
 * not a fact about the world, and a captain who opens the game on another
 * machine is no less experienced for it — but they are also no worse off
 * being told once more.
 */

/** The seven things the clerk wants to see, in the order they happen. */
export const ENDORSEMENTS = [
  'fly',
  'land',
  'buy',
  'jump',
  'sell',
  'yard',
  'bourse',
] as const;

export type Endorsement = (typeof ENDORSEMENTS)[number];

export interface EndorsementText {
  /** The clerk's name for it, as it reads on the ticket. */
  readonly heading: string;
  /** What to do, in one line. */
  readonly instruction: string;
  /** The keys or the control, where there is one. */
  readonly keys?: string;
  /**
   * Where it can be earned.
   *
   * The card shows the next one the captain can actually do something
   * about. Asking for a purchase at the Staple while they are in the sky
   * is an instruction about somewhere they are not.
   */
  readonly where: 'sky' | 'berth';
}

export const ENDORSEMENT_TEXT: Record<Endorsement, EndorsementText> = {
  fly: {
    heading: 'Under way',
    instruction: 'Take her off the mark and get the feel of her.',
    keys: 'Burn and turn',
    where: 'sky',
  },
  land: {
    heading: 'Alongside',
    instruction: 'Bring her in to a berth and make fast.',
    keys: 'Come alongside, inside the ring',
    where: 'sky',
  },
  buy: {
    heading: 'Laden',
    instruction: "Buy something at the berth's Staple. Cheap and dull will do.",
    where: 'berth',
  },
  jump: {
    heading: 'Cleared outward',
    instruction: 'Plot a course on the chart and spool the lane.',
    keys: 'Open the chart, then spool',
    where: 'sky',
  },
  sell: {
    heading: 'Discharged',
    instruction: 'Sell it at the far end for more than you paid.',
    where: 'berth',
  },
  yard: {
    heading: 'Surveyed',
    instruction: 'Look in at a Yard and see what she is made of.',
    where: 'berth',
  },
  bourse: {
    heading: 'Subscribed',
    instruction: 'Open the Bourse. Every voyage out there is somebody else’s money.',
    where: 'berth',
  },
};

export interface Pilotage {
  /** Endorsements the clerk has added. */
  readonly done: readonly Endorsement[];
  /** True once the captain has waived the rest, or earned them all. */
  readonly confirmed: boolean;
}

export const FRESH_TICKET: Pilotage = { done: [], confirmed: false };

const KEY = 'marque.pilotage';

export function loadPilotage(): Pilotage {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return FRESH_TICKET;
    const stored = JSON.parse(raw) as Partial<Pilotage>;
    const done = Array.isArray(stored.done)
      ? ENDORSEMENTS.filter((id) => (stored.done as unknown[]).includes(id))
      : [];
    return { done, confirmed: stored.confirmed === true };
  } catch {
    // Storage disabled, or written by a build that has moved on. A captain
    // who is shown the ticket again has lost nothing.
    return FRESH_TICKET;
  }
}

export function savePilotage(pilotage: Pilotage): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(pilotage));
  } catch {
    // Nothing to be done. It still holds for this session.
  }
}

/** The ticket with one more endorsement on it, or the same ticket. */
export function endorse(pilotage: Pilotage, id: Endorsement): Pilotage {
  if (pilotage.done.includes(id)) return pilotage;
  const done = ENDORSEMENTS.filter((each) => each === id || pilotage.done.includes(each));
  return { done, confirmed: pilotage.confirmed || done.length === ENDORSEMENTS.length };
}

/**
 * The endorsement being worked on, or nothing once the ticket is confirmed.
 *
 * Strictly in order, because the order is the voyage: there is nothing to
 * sell before anything has been bought. An endorsement earned out of turn
 * still counts — a captain who opens the Bourse on their first berth has
 * done it — it just is not the one being asked for.
 */
export function current(
  pilotage: Pilotage,
  where?: 'sky' | 'berth',
): Endorsement | undefined {
  if (pilotage.confirmed) return undefined;
  const owed = ENDORSEMENTS.filter((id) => !pilotage.done.includes(id));
  if (where !== undefined) {
    // The next one they can act on from where they are standing. Falling
    // back to the first owed, so the card always says what is left rather
    // than going blank at a berth with only sky work outstanding.
    const here = owed.find((id) => ENDORSEMENT_TEXT[id].where === where);
    if (here !== undefined) return here;
  }
  return owed[0];
}

// --- The hints ---------------------------------------------------------
//
// One per system, shown the first time it is opened and never again. Three
// or four lines: what this counter is for, and the one thing about it that
// is not obvious from looking at it.

export const HINTS = [
  'staple',
  'yard',
  'moorings',
  'bourse',
  'factor',
  'chart',
  'offers',
  'convoy',
  'register',
  'range',
  'boarding',
] as const;

export type HintKey = (typeof HINTS)[number];

export interface HintText {
  readonly heading: string;
  readonly body: string;
}

export const HINT_TEXT: Record<HintKey, HintText> = {
  staple: {
    heading: 'The Staple',
    body:
      'What this berth charges and what it pays, by the unit. Both move as you trade: '
      + 'buying lifts the ask, selling drops the bid, and the berth works its way back '
      + 'towards what it thinks the goods are worth. A long haul to somewhere that '
      + 'wants the cargo beats a short one that has plenty.',
  },
  yard: {
    heading: 'The Yard',
    body:
      'A draught is a grid of modules, and every number a hull has comes out of what '
      + 'is on it. Mass costs thrust, reactors cost nothing until the bill for power '
      + 'comes in, and a gun on the centreline fires where a gun on the beam cannot. '
      + 'The Yard will tell you what is wrong with a draught before it will build it.',
  },
  moorings: {
    heading: 'The Moorings',
    body:
      'Hulls you own and are not flying, each at the berth you left it. Switching is '
      + 'free and instant where the hull is; getting to it is not. A hull parked three '
      + 'systems away is a hull you will be flying something else to reach.',
  },
  bourse: {
    heading: 'The Bourse',
    body:
      'Twelve companies, priced by what people will pay. A share pays a dividend out '
      + 'of what its company earned, and what a company earns is the trade you and '
      + 'everybody else are doing — so a route you work is a holding you could have '
      + 'owned. Your own orders move the price; large ones move it against you.',
  },
  factor: {
    heading: 'The Factor',
    body:
      'Work posted at this berth: carry this there by then, and be paid on delivery '
      + 'less the fee. The Factor notes a late delivery, and a noted captain is offered '
      + 'less. Nothing stops you taking a commission you cannot make.',
  },
  chart: {
    heading: 'The chart',
    body:
      'Lanes between systems, and what each jump costs in Propellant. Plot a course '
      + 'and the lane is yours to spool whenever you are ready for it. Secured space '
      + 'has patrols in it; the Marque does not.',
  },
  offers: {
    heading: 'Alongside',
    body:
      'Trade with another captain at the same berth, on terms neither of you can '
      + 'change after the fact. Both sides seal it or it does not happen, and what is '
      + 'written is what moves.',
  },
  convoy: {
    heading: 'Convoy',
    body:
      'Sail with other captains: you see each other on the radar and on the chart, '
      + 'and a shared commission counts whoever carries it. There is no shared purse. '
      + 'Everything anybody owns stays theirs.',
  },
  register: {
    heading: 'The Register',
    body:
      'Where every captain stands, by the only numbers anybody can check: marks '
      + 'earned, cargo carried, hulls written off. It is published whether or not you '
      + 'come out of it well.',
  },
  range: {
    heading: 'The range',
    body:
      "A Yard's own range, with a hull it has not sold you yet. Fly the draught, "
      + 'shoot at what they put up, and lose it if you like: nothing here is yours, so '
      + 'nothing here is a loss. The marks on your ticket do not change either way.',
  },
  boarding: {
    heading: 'A hull adrift',
    body:
      'A draught with its engines shot out cannot run, and a party can cross to it. '
      + 'Match speeds first: closing at three hundred a second is not a boarding. What '
      + 'comes back is whatever was in the hold, and the Prize Court will have a view '
      + 'about it unless the hull was posted.',
  },
};

const HINT_STORE = 'marque.hints';

/**
 * What has been seen, in one place.
 *
 * Shared rather than per-component on purpose: the same hint can be mounted
 * from two screens, and one hint showing twice over itself is worse than no
 * hint at all. One store, and everyone watching it hears about a dismissal
 * in the same tick.
 */
let seen: readonly HintKey[] | undefined;
const watchers = new Set<() => void>();

function read(): readonly HintKey[] {
  try {
    const raw = localStorage.getItem(HINT_STORE);
    if (raw === null) return [];
    const stored = JSON.parse(raw) as unknown;
    if (!Array.isArray(stored)) return [];
    return HINTS.filter((key) => stored.includes(key));
  } catch {
    return [];
  }
}

export function hintsSeen(): readonly HintKey[] {
  seen ??= read();
  return seen;
}

export function hintSeen(key: HintKey): boolean {
  return hintsSeen().includes(key);
}

/** Mark a hint settled. Everyone watching is told, and the device remembers. */
export function settleHint(key: HintKey): void {
  if (hintSeen(key)) return;
  seen = [...hintsSeen(), key];
  try {
    localStorage.setItem(HINT_STORE, JSON.stringify(seen));
  } catch {
    // Nothing to be done. It still holds for this session.
  }
  for (const watcher of watchers) watcher();
}

export function watchHints(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
}

/** Forget what has been seen. For tests, and for the settings' own reset. */
export function forgetHints(): void {
  seen = [];
  try {
    localStorage.removeItem(HINT_STORE);
  } catch {
    // Nothing to be done.
  }
  for (const watcher of watchers) watcher();
}
