/**
 * NPC freight.
 *
 * Goods move from surplus to shortage along hyperlanes, slowly. This is what
 * makes the galaxy stable rather than a set of berths each drifting to its
 * own extreme: a berth that only eats Provisions would otherwise run out and
 * sit at its price ceiling for good, and one that only makes Ore would fill
 * to capacity and sit at its floor.
 *
 * It is also what makes a route worth flying and worth resting. Freight is
 * deliberately slower than a captain, so an overused lane decays faster than
 * the freighters can repair it and a neglected one recovers while nobody is
 * looking.
 *
 * Runs on the world's injected clock, so it moves a month in seconds under
 * the soak and in a month under real time. Deterministic: what moves depends
 * on the state of the berths and the hours elapsed, not on when the tick
 * happened to fire.
 */

import {
  content,
  pressure,
  type CommodityDef,
  type PortDef,
  type SystemDef,
} from '@marque/shared';

import type { Exchange } from './Exchange.ts';
import type { Market } from './Market.ts';

/** One load, as the report and the news feed describe it. */
export interface Shipment {
  readonly commodityId: string;
  readonly fromPortId: string;
  readonly toPortId: string;
  readonly units: number;
}

/**
 * The carrier's cut of what it delivers.
 *
 * Freight earns on the haulage, not on the cargo: a carrier that earned the
 * full value of everything it moved would be worth more than the goods.
 */
const FREIGHT_MARGIN = 0.08;

/** A berth with a surplus or a shortage of one commodity. */
interface Candidate {
  readonly port: PortDef;
  readonly system: SystemDef;
  readonly pressure: number;
  readonly stock: number;
  readonly room: number;
}

export class Freight {
  /**
   * The Bourse, once the world has one.
   *
   * Set after construction rather than injected, because the Exchange and
   * this service both hold the ledger and the World builds them in one pass.
   * Optional so a test can exercise this service without an exchange behind
   * it; an earnings event with nobody listening is simply not reported.
   */
  exchange: Exchange | undefined;

  constructor(private readonly market: Market) {}

  /**
   * Move what the hours allow.
   *
   * For each commodity, the deepest shortage is supplied from the largest
   * surplus that can reach it, and the quantity is bounded by what the hours
   * pay for, what the source can spare and what the destination can take.
   * Returns what moved, so the soak can report it.
   */
  run(hours: number, now: number): Shipment[] {
    if (hours <= 0) return [];

    const { commodities, systems, tuning } = content();
    const moved: Shipment[] = [];
    const budget = tuning.freight.unitsPerHour * hours;
    if (budget < 1) return [];

    for (const commodity of commodities.values()) {
      const candidates = this.survey(systems, commodity);
      if (candidates.length < 2) continue;

      // Deepest shortage first, largest surplus last.
      candidates.sort((a, b) => a.pressure - b.pressure);

      let remaining = budget;
      let low = 0;
      let high = candidates.length - 1;

      while (remaining >= 1 && low < high) {
        const needy = candidates[low]!;
        const flush = candidates[high]!;

        // Nothing left worth moving: the shortage is shallow or the surplus
        // is not one. Freight does not chase a berth that is nearly at target.
        if (needy.pressure > -tuning.freight.threshold) break;
        if (flush.pressure < tuning.freight.threshold) break;

        // Only along a lane the galaxy actually has, and only as far as
        // freight is willing to go.
        const hops = this.hops(needy.system, flush.system, systems);
        if (hops === undefined || hops > tuning.freight.maxHops) {
          // This pair cannot trade; try the next-largest surplus.
          high--;
          continue;
        }

        const shortfall = Math.max(0, -needy.pressure);
        const wanted = Math.min(
          remaining,
          needy.room,
          flush.stock,
          Math.ceil(shortfall * this.targetOf(needy, commodity)),
        );

        const units = Math.floor(wanted);
        if (units < 1) {
          low++;
          continue;
        }

        this.market.adjustStock(flush.port, commodity, -units, now);
        this.market.adjustStock(needy.port, commodity, units, now);

        moved.push({
          commodityId: commodity.id,
          fromPortId: flush.port.id,
          toPortId: needy.port.id,
          units,
        });

        // The carrier for the destination's region earns on freight actually
        // delivered — the units arriving, valued at the good's base price, so
        // a carrier's earnings follow the traffic rather than the local
        // price, which a captain could move on their own.
        const ticker = this.exchange?.carrierOf(needy.system.region);
        if (ticker !== undefined) {
          this.exchange?.credit({
            ticker,
            marks: Math.round(units * commodity.basePrice * FREIGHT_MARGIN),
            kind: 'freight',
            where: needy.port.name,
            what: needy.system.region,
          });
        }

        remaining -= units;
        low++;
        high--;
      }
    }

    return moved;
  }

  /** Where every berth stands on one commodity. */
  private survey(
    systems: ReadonlyMap<string, SystemDef>,
    commodity: CommodityDef,
  ): Candidate[] {
    const out: Candidate[] = [];

    for (const system of systems.values()) {
      for (const port of system.ports) {
        if (!port.services.includes('staple')) continue;
        const pile = this.market.pileOf(port, commodity);
        out.push({
          port,
          system,
          pressure: pressure(pile),
          stock: pile.stock,
          room: Math.max(0, pile.capacity - pile.stock),
        });
      }
    }

    return out;
  }

  private targetOf(candidate: Candidate, commodity: CommodityDef): number {
    return this.market.pileOf(candidate.port, commodity).target;
  }

  /**
   * Lanes between two systems, or undefined when there is no route.
   *
   * A breadth-first walk, stopped at the freight range: beyond that the
   * answer does not matter, and the galaxy is small enough that this is
   * cheaper than keeping a distance table in step with the data.
   */
  private hops(
    from: SystemDef,
    to: SystemDef,
    systems: ReadonlyMap<string, SystemDef>,
  ): number | undefined {
    if (from.id === to.id) return 0;

    const { maxHops } = content().tuning.freight;
    const seen = new Set<string>([from.id]);
    let frontier = [from.id];

    for (let depth = 1; depth <= maxHops; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const link of systems.get(id)?.links ?? []) {
          if (seen.has(link)) continue;
          if (link === to.id) return depth;
          seen.add(link);
          next.push(link);
        }
      }
      if (next.length === 0) return undefined;
      frontier = next;
    }

    return undefined;
  }
}
