/**
 * The Gazette.
 *
 * Spec section 10: every event class that moves earnings can publish a
 * headline, so a captain can always answer "why did this move?". That is the
 * whole purpose — a price that changes without an explanation is noise, and
 * noise is not something anybody can trade against on purpose.
 *
 * Headlines are written from the events the Exchange banked over a market
 * tick, grouped by company, so a hundred small sales at a berth become one
 * line about a run on a good rather than a hundred lines about nothing. The
 * wording is the setting's: dry, specific, and about the trade rather than
 * about the player.
 */

import { content, type Headline } from '@marque/shared';

import type { EarningsEvent } from './Exchange.ts';

/** Below this many marks over a tick, nothing worth printing happened. */
const WORTH_PRINTING = 60;

export class Gazette {
  private readonly lines: Headline[] = [];
  private nextId = 1;

  /** The feed, newest first. */
  recent(limit = 40): Headline[] {
    return this.lines.slice(-limit).reverse();
  }

  /**
   * Write up a market tick.
   *
   * One line per company that moved, plus a line for each dividend. A company
   * that earned nothing gets no line: a feed that prints "nothing happened"
   * ten times a tick is a feed nobody reads.
   */
  report(
    events: readonly EarningsEvent[],
    dividends: readonly { ticker: string; marks: number }[],
    now: number,
  ): void {
    const { companies, commodities, tuning } = content();

    // Grouped by company and by what drove it, so the busiest cause is the
    // one that gets named.
    interface Running {
      marks: number;
      where?: string | undefined;
      what?: string | undefined;
    }
    const byCompany = new Map<string, Map<string, Running>>();
    for (const event of events) {
      const kinds: Map<string, Running> = byCompany.get(event.ticker) ?? new Map<string, Running>();
      const key = `${event.kind}:${event.what ?? ''}`;
      const running: Running = kinds.get(key) ?? {
        marks: 0,
        where: event.where,
        what: event.what,
      };
      running.marks += event.marks;
      kinds.set(key, running);
      byCompany.set(event.ticker, kinds);
    }

    for (const [ticker, kinds] of byCompany) {
      const company = companies.get(ticker);
      if (!company) continue;

      const total = [...kinds.values()].reduce((sum, entry) => sum + entry.marks, 0);
      if (Math.abs(total) < WORTH_PRINTING) continue;

      // The largest cause by absolute size is what the line is about.
      let leading: { kind: string; marks: number; where?: string; what?: string } | undefined;
      for (const [key, entry] of kinds) {
        const kind = key.slice(0, key.indexOf(':'));
        if (!leading || Math.abs(entry.marks) > Math.abs(leading.marks)) {
          leading = { kind, marks: entry.marks, where: entry.where, what: entry.what };
        }
      }
      if (!leading) continue;

      const good = leading.what !== undefined ? commodities.get(leading.what)?.name : undefined;
      this.publish(
        ticker,
        headlineFor(company.name, leading.kind, total, {
          ...(leading.where !== undefined ? { where: leading.where } : {}),
          ...(good !== undefined ? { good } : {}),
        }),
        total > 0 ? 'up' : 'down',
        now,
      );
    }

    for (const dividend of dividends) {
      const company = companies.get(dividend.ticker);
      if (!company) continue;
      this.publish(
        dividend.ticker,
        `${company.name} distributes ${dividend.marks.toLocaleString()} marks to shareholders.`,
        'up',
        now,
      );
    }

    const keep = tuning.exchange.newsKeep;
    if (this.lines.length > keep) this.lines.splice(0, this.lines.length - keep);
  }

  /** A line the world writes directly, outside the earnings cycle. */
  publish(ticker: string, text: string, direction: Headline['direction'], at: number): void {
    this.lines.push({ id: `h${this.nextId++}`, ticker, text, at, direction });
  }
}

/**
 * The line itself.
 *
 * Written per event class because each one is a different story: goods
 * leaving a stockpile is a run on a good, marks spent on fittings is a yard's
 * order book, freight is a route holding or failing. The figures are real, so
 * a captain reading the feed and a captain reading the chart see the same
 * thing described two ways.
 */
function headlineFor(
  name: string,
  kind: string,
  marks: number,
  about: { where?: string; good?: string },
): string {
  const figure = Math.abs(Math.round(marks)).toLocaleString();
  const rising = marks > 0;

  switch (kind) {
    case 'goods-sold':
      return about.good !== undefined
        ? rising
          ? `${about.good} moves off ${name}'s shelves; ${figure} marks taken at the counter.`
          : `${about.good} sits unsold at ${name}'s berths.`
        : `${name} reports ${figure} marks across the counter.`;

    case 'modules-sold':
      return rising
        ? `${name}'s order book fills: ${figure} marks of fittings written up.`
        : `${name} refunds more than it sells; the yard is quiet.`;

    case 'freight':
      return rising
        ? `${name} lands ${figure} marks of freight on schedule.`
        : `${name} writes off ${figure} marks of freight lost in transit.`;

    case 'salvage':
      return rising
        ? `${name} recovers ${figure} marks from wrecks nobody else would claim.`
        : `${name} finds nothing worth lifting.`;

    case 'insurance':
      return rising
        ? `${name} takes ${figure} marks in premiums against a quiet quarter.`
        : `${name} settles ${figure} marks in claims; the Hall is unamused.`;

    default:
      return rising
        ? `${name} reports earnings of ${figure} marks.`
        : `${name} reports a loss of ${figure} marks.`;
  }
}
