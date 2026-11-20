/**
 * Commissions: what a Factor will pay a captain to do.
 *
 * The board at a berth is not stored. It is derived from the berth, the hour
 * and the captain's standing, through a seeded generator — so two captains
 * standing on the same berth in the same hour see the same work, the board
 * changes on its own as the day goes on, and nothing has to be written down
 * until somebody actually takes a job.
 *
 * Everything here is pure. The server decides when a commission is answered;
 * this decides what is offered, what it says and what it pays.
 */

import { Rng } from '../math/rng.ts';
import type {
  CommissionTemplate,
  CommodityDef,
  PortDef,
  SystemDef,
} from '../content/schema.ts';
import type { Charter } from './standing.ts';

/** How long a berth's board stands before it is written again, in hours. */
export const BOARD_HOURS = 6;

/** The most a berth posts at once. A board is a page, not a catalogue. */
export const BOARD_SIZE = 5;

/** What a commission asks of a particular captain, once it is drawn up. */
export interface CommissionTerms {
  readonly templateId: string;
  readonly kind: CommissionTemplate['kind'];
  readonly charter: Charter | undefined;
  readonly title: string;
  readonly brief: string;
  readonly pay: number;
  readonly standing: number;
  /** Hours allowed, or 0 for work with no deadline. */
  readonly hours: number;
  readonly units: number;
  readonly commodityId: string;
  readonly fromPortId: string;
  readonly toPortId: string;
  readonly toSystemId: string;
  /** The named Unlettered captain, for a bounty. */
  readonly target: string;
}

/** An offer on a board, which is terms plus the id a captain takes it by. */
export interface CommissionOffer extends CommissionTerms {
  readonly id: string;
}

/**
 * Fill a template's text.
 *
 * Only the placeholders listed here are replaced; anything else in braces is
 * left alone, so a stray brace in authored prose reads as a brace rather
 * than vanishing.
 */
export function fillText(text: string, terms: CommissionTerms, commodityName: string): string {
  const values: Record<string, string> = {
    units: String(terms.units),
    commodity: commodityName,
    toPort: terms.toPortId,
    toSystem: terms.toSystemId,
    fromPort: terms.fromPortId,
    pay: terms.pay.toLocaleString(),
    hours: String(Math.round(terms.hours)),
    target: terms.target,
  };
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
}

/** What a template pays for these particular terms. */
export function payFor(
  template: CommissionTemplate,
  options: { units: number; jumps: number },
): number {
  return Math.round(
    template.basePay + template.perJump * options.jumps + template.perUnit * options.units,
  );
}

/**
 * The board at a berth, for one captain, in one window of the day.
 *
 * Seeded from the berth, the window and nothing about the captain except
 * which offers their standing lets them see — so a captain who improves
 * their standing finds *more* work on the same board rather than a different
 * board, which is the difference between being trusted and being somebody
 * else.
 */
export function boardFor(options: {
  port: PortDef;
  system: SystemDef;
  templates: readonly CommissionTemplate[];
  standings: Record<Charter, number>;
  /** Every system, for picking somewhere to carry things to. */
  systems: ReadonlyMap<string, SystemDef>;
  commodities: ReadonlyMap<string, CommodityDef>;
  /** Hours of world time since the world began. */
  hour: number;
  /** Names the Unlettered go by, for bounties. */
  raiderNames: readonly string[];
}): CommissionOffer[] {
  const window = Math.floor(options.hour / BOARD_HOURS);
  const rng = new Rng(`board:${options.port.id}:${window}`);

  // What this berth could post at all: its own charter's work, plus the work
  // anybody posts. A Kessler counting-house does not advertise for Reprisal.
  const eligible = options.templates.filter((template) => {
    if (template.charter !== undefined && template.charter !== options.port.owner) return false;
    if (template.charter !== undefined) {
      return options.standings[template.charter] >= template.requiresStanding;
    }
    return true;
  });
  if (eligible.length === 0) return [];

  const destinations = [...options.systems.values()].filter(
    (system) => system.id !== options.system.id && system.ports.length > 0,
  );

  const offers: CommissionOffer[] = [];
  const used = new Set<string>();

  for (let i = 0; i < BOARD_SIZE * 3 && offers.length < BOARD_SIZE; i++) {
    const template = rng.pick(eligible);
    // One of each template per board: a page of five identical hauls reads
    // as a bug even when it is not.
    if (used.has(template.id)) continue;
    used.add(template.id);

    const destination =
      destinations.length > 0 ? rng.pick(destinations) : options.system;
    const toPort = rng.pick(destination.ports);
    const jumps = Math.max(1, hopsBetween(options.system, destination, options.systems));

    const units =
      template.units[1] > 0
        ? Math.round(rng.range(template.units[0], template.units[1]))
        : 0;

    const commodityId =
      template.commodities.length > 0
        ? rng.pick(template.commodities)
        : pickTradedGood(options.port, options.commodities, rng);

    const terms: CommissionTerms = {
      templateId: template.id,
      kind: template.kind,
      charter: template.charter,
      title: template.title,
      brief: template.brief,
      pay: payFor(template, { units, jumps }),
      standing: template.standing,
      hours: template.hours,
      units,
      commodityId,
      fromPortId: options.port.id,
      toPortId: toPort.id,
      toSystemId: destination.id,
      target:
        template.kind === 'bounty' && options.raiderNames.length > 0
          ? rng.pick(options.raiderNames)
          : '',
    };

    offers.push({ ...terms, id: `${options.port.id}:${window}:${template.id}` });
  }

  return offers;
}

/** A good this berth actually handles, so a parcel is not conjured. */
function pickTradedGood(
  port: PortDef,
  commodities: ReadonlyMap<string, CommodityDef>,
  rng: Rng,
): string {
  const handled = [
    ...Object.keys(port.trade?.produces ?? {}),
    ...Object.keys(port.trade?.consumes ?? {}),
  ].filter((id) => commodities.has(id));

  return handled.length > 0 ? rng.pick(handled.sort()) : 'grain';
}

/**
 * Lanes between two systems, by breadth-first search.
 *
 * Used only to price a job by how far it is. Returns 0 when there is no
 * route, which prices it as local rather than as impossible — a commission
 * nobody can reach is a worse answer than one that pays badly.
 */
export function hopsBetween(
  from: SystemDef,
  to: SystemDef,
  systems: ReadonlyMap<string, SystemDef>,
): number {
  if (from.id === to.id) return 0;

  const seen = new Set([from.id]);
  let frontier = [from.id];
  for (let depth = 1; depth <= 12; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const link of systems.get(id)?.links ?? []) {
        if (seen.has(link)) continue;
        if (link === to.id) return depth;
        seen.add(link);
        next.push(link);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return 0;
}
