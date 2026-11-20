/**
 * The price chart on the Bourse's detail view.
 *
 * Its class block is `plot`, not `chart`: `.chart` belongs to the galaxy map,
 * where it is a full-screen scrim — `position: absolute; inset: 0` over a
 * wash of the void. Every stylesheet in this client is global, so a figure
 * named `chart` here took those rules, left the column it was supposed to sit
 * in empty, and hung a dark sheet over the whole panel. That was the chart
 * drawing itself across the figures.
 *
 * A quote history is a short series — a few dozen readings, no gaps, no
 * timestamps — so it is drawn as one line rather than candles, with fair value
 * laid across it as a reference. The two together are the whole question a
 * captain asks of a chart here: where the price has been, and where the
 * Exchange thinks it belongs. Price drifts toward that line between ticks, so
 * the gap between line and curve is the trade.
 *
 * Geometry is computed into a 0..100 box and the SVG is stretched to the well
 * with `preserveAspectRatio="none"`. That keeps the plot arithmetic pure and
 * independent of the panel's size; strokes carry `non-scaling-stroke` so the
 * stretch cannot thicken them, and anything that would distort under it — the
 * dot on the last reading, the axis figures — is HTML positioned over the
 * well instead of drawn inside it.
 */

import './bourse.css';

/** Where the line, the area and the reference all sit, in a 0..100 box. */
export interface Plot {
  /** The range drawn, padded past the readings so nothing touches the edge. */
  readonly low: number;
  readonly high: number;
  /** `x,y` pairs for the price line. Empty when there is nothing to draw. */
  readonly line: string;
  /** The same line closed against the floor, for the wash underneath it. */
  readonly area: string;
  /** The most recent reading, for the dot. */
  readonly last: { readonly x: number; readonly y: number } | undefined;
  /** Fair value's height in the box, 0 at the top. */
  readonly fairY: number;
  /** Where the window ended against where it started. */
  readonly direction: 'up' | 'down' | 'flat';
}

/** Headroom above and below the readings, as a share of their span. */
const PADDING = 0.1;

/**
 * Lay a quote history out for drawing.
 *
 * Pure, and the only arithmetic in this file: the range covers the readings,
 * the live quote and fair value together, so the reference line is always on
 * scale and the eye can compare them without a second axis.
 */
export function plot(
  history: readonly number[],
  price: number,
  fairValue: number,
): Plot {
  const readings = history.filter((value) => Number.isFinite(value) && value > 0);
  const scope = [...readings, price, fairValue].filter(
    (value) => Number.isFinite(value) && value > 0,
  );

  const seen = scope.length > 0 ? scope : [1];
  const lowest = Math.min(...seen);
  const highest = Math.max(...seen);
  const span = highest - lowest;
  // A flat series still needs a range, or every reading lands on one line.
  const padding = span > 0 ? span * PADDING : Math.max(highest * 0.05, 0.5);
  const low = Math.max(0, lowest - padding);
  const high = highest + padding;
  const height = high - low > 0 ? high - low : 1;

  const y = (value: number): number =>
    round(Math.min(100, Math.max(0, ((high - value) / height) * 100)));

  const points = readings.map((value, index) => ({
    x: readings.length > 1 ? round((index / (readings.length - 1)) * 100) : 100,
    y: y(value),
  }));

  const line = points.map((point) => `${point.x},${point.y}`).join(' ');
  const first = points[0];
  const last = points[points.length - 1];

  // A window that ended where it began is neither a gain nor a loss, and
  // washing it green or red would read as news that did not happen.
  const opened = readings[0];
  const closed = readings[readings.length - 1];
  const direction =
    points.length < 2 || opened === undefined || closed === undefined
      ? 'flat'
      : closed > opened
        ? 'up'
        : closed < opened
          ? 'down'
          : 'flat';

  return {
    low,
    high,
    line: points.length > 1 ? line : '',
    area:
      points.length > 1 && first && last
        ? `${first.x},100 ${line} ${last.x},100`
        : '',
    last,
    fairY: y(fairValue),
    direction,
  };
}

/** A quote, to the mark and the hundredth, aligned down a column. */
export function formatQuote(marks: number): string {
  return marks.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export interface PriceChartProps {
  /** Readings oldest first, as the listing carries them. */
  readonly history: readonly number[];
  readonly price: number;
  readonly fairValue: number;
  /** The company, for the chart's accessible name. */
  readonly name: string;
}

export function PriceChart({
  history,
  price,
  fairValue,
  name,
}: PriceChartProps): React.JSX.Element {
  const figure = plot(history, price, fairValue);
  const thin = figure.line === '';

  return (
    <figure className="plot">
      <div className="plot__well">
        <svg
          className="plot__svg"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          role="img"
          aria-label={`${name}: ${history.length} quotes, latest ${formatQuote(price)} marks against a fair value of ${formatQuote(fairValue)}`}
        >
          {[20, 40, 60, 80].map((at) => (
            <line
              key={at}
              className="plot__grid"
              x1="0"
              y1={at}
              x2="100"
              y2={at}
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {figure.area !== '' && (
            <polygon
              className={`plot__area plot__area--${figure.direction}`}
              points={figure.area}
            />
          )}

          <line
            className="plot__fair"
            x1="0"
            y1={figure.fairY}
            x2="100"
            y2={figure.fairY}
            vectorEffect="non-scaling-stroke"
          />

          {figure.line !== '' && (
            <polyline
              className="plot__line"
              points={figure.line}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>

        {/*
          The last reading, as a square dot in HTML: a circle inside a
          stretched viewBox would be drawn as an ellipse, and the only filled
          glyph the art direction allows is a status dot.
        */}
        {figure.last && (
          <span
            className={`plot__mark plot__mark--${figure.direction}`}
            style={{ left: `${figure.last.x}%`, top: `${figure.last.y}%` }}
          />
        )}

        <span className="plot__fair-label micro" style={{ top: `${figure.fairY}%` }}>
          Fair {formatQuote(fairValue)}
        </span>

        <span className="plot__bound plot__bound--high micro">
          {formatQuote(figure.high)}
        </span>
        <span className="plot__bound plot__bound--low micro">
          {formatQuote(figure.low)}
        </span>

        {thin && (
          <p className="plot__thin">
            {history.length === 1
              ? 'One quote recorded. The line begins at the next market tick.'
              : 'No quotes recorded yet. The line begins at the next market tick.'}
          </p>
        )}
      </div>

      <figcaption className="plot__caption micro">
        {history.length} quotes &middot; dashed is fair value
      </figcaption>
    </figure>
  );
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
