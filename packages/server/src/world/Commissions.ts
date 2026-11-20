/**
 * The commission board, and what a captain has taken off it.
 *
 * A board is derived rather than stored: `boardFor` in `@marque/shared`
 * builds it from the berth, the hour and the captain's standing, so nothing
 * is written down until somebody actually takes a job. What is written down
 * is the terms as they stood when it was taken — a Factor does not get to
 * change them afterwards, and the row is the only thing either side can point
 * at later.
 *
 * Answering one is never decided here. The room knows when a hull landed,
 * when a bounty died, when a freighter got out; this is told, and settles.
 */

import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import {

  boardFor,
  content,
  fillText,
  type Spoken,
  isCharter,
  type ChainDef,
  type CommissionKind,
  type CommissionOffer,
  type CommissionTerms,
  type PortDef,
  type SystemDef,
} from '@marque/shared';

import { RAIDER_NAMES } from '../rooms/npc.ts';
import { schema, type Store } from '../db/index.ts';
import type { Ledger } from './Ledger.ts';
import type { Pilot } from './PilotStore.ts';
import type { Standings } from './Standings.ts';

/** Why a commission could not be taken or answered. */
export type CommissionRefusal =
  | 'no-such-commission'
  | 'already-taken'
  | 'too-many-commissions'
  | 'standing-too-low'
  | 'hold-full';

export class CommissionRefused extends Error {
  constructor(readonly reason: CommissionRefusal) {
    super(reason);
    this.name = 'CommissionRefused';
  }
}

/**
 * What a commission's placeholders stand for, in the words a captain reads.
 *
 * Ports and systems are named here rather than carried as ids, because a
 * Factor's board is player-facing: a line that says "to tare" is a row from
 * a table, and a line that says "to Tare" is a shipping instruction.
 */
function spokenWords(terms: CommissionTerms): Spoken {
  const { commodities, systems } = content();

  let toPort = terms.toPortId;
  for (const system of systems.values()) {
    const port = system.ports.find((candidate) => candidate.id === terms.toPortId);
    if (port) {
      toPort = port.name;
      break;
    }
  }

  let fromPort = terms.fromPortId;
  for (const system of systems.values()) {
    const port = system.ports.find((candidate) => candidate.id === terms.fromPortId);
    if (port) {
      fromPort = port.name;
      break;
    }
  }

  return {
    commodity: commodities.get(terms.commodityId)?.name ?? terms.commodityId,
    toPort,
    fromPort,
    toSystem: systems.get(terms.toSystemId)?.name ?? terms.toSystemId,
  };
}

/** A commission in hand, as the interface and the room both read it. */
export interface HeldCommission {
  readonly id: string;
  readonly templateId: string;
  readonly chainId: string;
  readonly step: number;
  readonly kind: CommissionKind;
  readonly state: string;
  readonly terms: CommissionTerms;
  readonly title: string;
  readonly brief: string;
  readonly takenAt: number;
  readonly dueAt: number;
}

/** How many a captain may have in hand at once. */
const MAX_HELD = 6;

export class Commissions {
  constructor(
    private readonly store: Store,
    private readonly ledger: Ledger,
    private readonly standings: Standings,
  ) {}

  /**
   * What this berth is posting for this captain right now.
   *
   * Offers already taken are filtered out, so a board does not show a captain
   * work they are carrying. Chain beats are offered ahead of casual work,
   * because a story in progress is the thing the captain came back for.
   */
  board(pilot: Pilot, port: PortDef, system: SystemDef, now: number): CommissionOffer[] {
    const { commissions, systems, commodities } = content();
    const held = new Set(this.held(pilot.accountId).map((row) => row.templateId));

    const chainOffer = this.nextChainBeat(pilot, port);

    const offers = boardFor({
      port,
      system,
      templates: commissions.templates,
      standings: this.standings.of(pilot.accountId),
      systems,
      commodities,
      hour: now / 3_600_000,
      raiderNames: RAIDER_NAMES,
    })
      .filter((offer) => !held.has(offer.templateId))
      .map((offer) => this.spoken(offer));

    return chainOffer ? [chainOffer, ...offers] : offers;
  }

  /**
   * The beat of a chain this captain is due, if a chain is open to them here.
   *
   * A chain is offered at its own charter's berths, to a captain it trusts,
   * one beat at a time and in order. Nothing is stored for a chain that has
   * not been started: the captain's finished rows say which beat is next.
   */
  private nextChainBeat(pilot: Pilot, port: PortDef): CommissionOffer | undefined {
    const { commissions } = content();
    if (!isCharter(port.owner)) return undefined;

    const chain = commissions.chains.find((candidate) => candidate.charter === port.owner);
    if (!chain) return undefined;

    const standing = this.standings.of(pilot.accountId)[port.owner];
    if (standing < chain.requiresStanding) return undefined;

    const mine = this.rowsFor(pilot.accountId).filter((row) => row.chainId === chain.id);
    // One beat in hand at a time.
    if (mine.some((row) => row.state === 'taken')) return undefined;

    const done = mine.filter((row) => row.state === 'done').length;
    if (done >= chain.steps.length) return undefined;

    const step = chain.steps[done];
    if (!step) return undefined;

    const terms: CommissionTerms = {
      templateId: chain.id,
      kind: step.kind,
      charter: chain.charter,
      title: step.title,
      brief: done === 0 ? `${chain.premise}\n\n${step.brief}` : step.brief,
      pay: step.basePay,
      standing: 0,
      hours: step.hours,
      units: step.units,
      commodityId: step.commodity ?? '',
      fromPortId: port.id,
      toPortId: step.toPort ?? port.id,
      toSystemId: step.toSystem ?? '',
      target: '',
    };

    return this.spoken({ ...terms, id: `chain:${chain.id}:${done}` });
  }

  /** Put a template's words through its own placeholders. */
  private spoken(offer: CommissionOffer): CommissionOffer {
    const words = spokenWords(offer);
    return {
      ...offer,
      title: fillText(offer.title, offer, words),
      brief: fillText(offer.brief, offer, words),
      toPortName: words.toPort,
      toSystemName: words.toSystem,
    };
  }

  /**
   * Take a commission off a board.
   *
   * The offer is rebuilt from the board rather than trusted from the client:
   * an id is a claim about what was posted, and a Factor's terms are the
   * Factor's.
   */
  take(pilot: Pilot, offerId: string, port: PortDef, system: SystemDef, now: number): HeldCommission {
    const held = this.held(pilot.accountId);
    if (held.length >= MAX_HELD) throw new CommissionRefused('too-many-commissions');

    const offer = this.board(pilot, port, system, now).find((row) => row.id === offerId);
    if (!offer) throw new CommissionRefused('no-such-commission');
    if (held.some((row) => row.templateId === offer.templateId)) {
      throw new CommissionRefused('already-taken');
    }

    const chain = offerId.startsWith('chain:')
      ? content().commissions.chains.find((candidate) => candidate.id === offer.templateId)
      : undefined;
    const step = chain ? Number(offerId.split(':')[2] ?? 0) : 0;

    const id = randomUUID();
    const dueAt = offer.hours > 0 ? now + offer.hours * 3_600_000 : 0;

    this.store.db
      .insert(schema.commissions)
      .values({
        id,
        accountId: pilot.accountId,
        templateId: offer.templateId,
        chainId: chain?.id ?? '',
        step,
        kind: offer.kind,
        state: 'taken',
        terms: JSON.stringify(offer),
        takenAt: now,
        dueAt,
      })
      .run();

    return {
      id,
      templateId: offer.templateId,
      chainId: chain?.id ?? '',
      step,
      kind: offer.kind,
      state: 'taken',
      terms: offer,
      title: offer.title,
      brief: offer.brief,
      takenAt: now,
      dueAt,
    };
  }

  /** Everything this captain is carrying. */
  held(accountId: string): HeldCommission[] {
    return this.rowsFor(accountId)
      .filter((row) => row.state === 'taken')
      .map((row) => toHeld(row));
  }

  /** Give one up. The Factor is not pleased, but it is not a crime. */
  abandon(pilot: Pilot, id: string, now: number): void {
    const row = this.store.db
      .select()
      .from(schema.commissions)
      .where(and(eq(schema.commissions.id, id), eq(schema.commissions.accountId, pilot.accountId)))
      .get();
    if (!row || row.state !== 'taken') throw new CommissionRefused('no-such-commission');

    this.fail(pilot, toHeld(row), now);
  }

  /**
   * Answer a commission: pay it, move the standing, and close the row.
   *
   * Returns what to tell the captain, so the room does not have to work out
   * the wording.
   */
  settle(pilot: Pilot, commission: HeldCommission, now: number): { text: string; pay: number } {
    const { commissions, tuning } = content();

    this.store.db
      .update(schema.commissions)
      .set({ state: 'done', settledAt: now })
      .where(eq(schema.commissions.id, commission.id))
      .run();

    const pay = Math.max(0, Math.round(commission.terms.pay));
    if (pay > 0) {
      this.ledger.post(
        {
          accountId: pilot.accountId,
          delta: pay,
          category: 'commission-pay',
          reason: commission.title,
        },
        pilot,
      );
    }

    const charter = commission.terms.charter;
    if (charter !== undefined && isCharter(charter)) {
      const gain = commission.terms.standing || tuning.standing.perCommission;
      this.standings.shift(pilot.accountId, charter, gain, now);
    }

    // The Factor's own words for a job done.
    const template = commissions.templates.find(
      (candidate) => candidate.id === commission.templateId,
    );
    const chain = commissions.chains.find((candidate) => candidate.id === commission.chainId);
    const step = chain?.steps[commission.step];
    const said = step?.onDone ?? template?.onDone ?? 'Received, and paid.';
    return { text: fillText(said, commission.terms, spokenWords(commission.terms)), pay };
  }

  /** And the other way: nothing paid, and the poster remembers. */
  fail(pilot: Pilot, commission: HeldCommission, now: number): { text: string } {
    const { commissions, tuning } = content();

    this.store.db
      .update(schema.commissions)
      .set({ state: 'failed', settledAt: now })
      .where(eq(schema.commissions.id, commission.id))
      .run();

    const charter = commission.terms.charter;
    if (charter !== undefined && isCharter(charter)) {
      // Half what answering it would have been worth. A job not done is not
      // the same as a hull destroyed.
      this.standings.shift(pilot.accountId, charter, -tuning.standing.perCommission / 2, now);
    }

    const template = commissions.templates.find(
      (candidate) => candidate.id === commission.templateId,
    );
    const chain = commissions.chains.find((candidate) => candidate.id === commission.chainId);
    const step = chain?.steps[commission.step];
    const said = step?.onFailed ?? template?.onFailed ?? 'The Factor has noted it.';
    return { text: fillText(said, commission.terms, spokenWords(commission.terms)) };
  }

  /**
   * Everything whose time ran out, so the room can tell its captains.
   *
   * Escorts are not in it. For every other kind a deadline is the moment it
   * is too late; for an escort it is the moment it is done, and failing one
   * at exactly the point it should have been paid is the sort of thing a
   * captain never forgives.
   */
  overdue(accountId: string, now: number): HeldCommission[] {
    return this.held(accountId).filter(
      (row) => row.kind !== 'escort' && row.dueAt > 0 && now > row.dueAt,
    );
  }

  /**
   * The choice a finished chain is waiting on, if there is one.
   *
   * A chain's endings are offered once its last beat is answered and before
   * anything else from that charter, because the captain is standing in a
   * room with both parties in it. Settled by `chooseEnding`.
   */
  pendingEnding(accountId: string): ChainDef | undefined {
    const { commissions } = content();
    for (const chain of commissions.chains) {
      const progress = this.chainProgress(accountId, chain);
      if (progress.done < progress.total) continue;
      // Already settled once: a chain ends once.
      if (this.endingTaken(accountId, chain.id)) continue;
      return chain;
    }
    return undefined;
  }

  /**
   * Take one of a chain's two endings.
   *
   * Paid, the standing moved through the one rule that moves standing, and
   * the Gazette given its line. The row that records it is the chain's own
   * id with a step past its last, so `pendingEnding` can see it was done
   * without a table of its own.
   */
  chooseEnding(
    pilot: Pilot,
    chainId: string,
    endingId: string,
    now: number,
  ): { text: string; headline: string; pay: number } {
    const { commissions } = content();
    const chain = commissions.chains.find((candidate) => candidate.id === chainId);
    if (!chain) throw new CommissionRefused('no-such-commission');

    const progress = this.chainProgress(pilot.accountId, chain);
    if (progress.done < progress.total) throw new CommissionRefused('no-such-commission');
    if (this.endingTaken(pilot.accountId, chain.id)) {
      throw new CommissionRefused('already-taken');
    }

    const ending = chain.endings.find((candidate) => candidate.id === endingId);
    if (!ending) throw new CommissionRefused('no-such-commission');

    this.store.db
      .insert(schema.commissions)
      .values({
        id: randomUUID(),
        accountId: pilot.accountId,
        templateId: chain.id,
        chainId: chain.id,
        step: chain.steps.length,
        kind: 'delivery',
        state: 'done',
        terms: JSON.stringify({ endingId, title: ending.choice }),
        takenAt: now,
        dueAt: 0,
        settledAt: now,
      })
      .run();

    if (ending.pay > 0) {
      this.ledger.post(
        {
          accountId: pilot.accountId,
          delta: ending.pay,
          category: 'commission-pay',
          reason: `${chain.name}: ${ending.choice}`,
        },
        pilot,
      );
    }

    // One rule moves standing, and it moves the rivals itself.
    this.standings.shift(pilot.accountId, chain.charter, ending.standing, now);

    return { text: ending.text, headline: ending.headline, pay: ending.pay };
  }

  /** Whether this captain has already settled this chain. */
  private endingTaken(accountId: string, chainId: string): boolean {
    const { commissions } = content();
    const chain = commissions.chains.find((candidate) => candidate.id === chainId);
    if (!chain) return false;
    return this.rowsFor(accountId).some(
      (row) => row.chainId === chainId && row.step >= chain.steps.length,
    );
  }

  /** Where a chain stands, for the board and for the interface. */
  chainProgress(accountId: string, chain: ChainDef): { done: number; total: number } {
    const mine = this.rowsFor(accountId).filter(
      // The ending's own row sits past the last step; it is not a beat.
      (row) => row.chainId === chain.id && row.step < chain.steps.length,
    );
    return {
      done: mine.filter((row) => row.state === 'done').length,
      total: chain.steps.length,
    };
  }

  private rowsFor(accountId: string): (typeof schema.commissions.$inferSelect)[] {
    return this.store.db
      .select()
      .from(schema.commissions)
      .where(eq(schema.commissions.accountId, accountId))
      .all();
  }
}

function toHeld(row: typeof schema.commissions.$inferSelect): HeldCommission {
  const terms = JSON.parse(row.terms) as CommissionTerms;
  return {
    id: row.id,
    templateId: row.templateId,
    chainId: row.chainId,
    step: row.step,
    kind: row.kind as CommissionKind,
    state: row.state,
    terms,
    title: terms.title,
    brief: terms.brief,
    takenAt: row.takenAt,
    dueAt: row.dueAt,
  };
}
