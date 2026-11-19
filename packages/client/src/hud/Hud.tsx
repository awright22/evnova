/**
 * The flight HUD.
 *
 * A cockpit overlay: readouts anchored to the screen edges, nothing floating
 * in the middle of the view. The numeric readouts refresh on a slow interval
 * rather than every frame, because React re-rendering at 60 Hz would cost more
 * than the instrument is worth; the radar draws itself every frame.
 */

import { useEffect, useState, type RefObject } from 'react';

import './hud.css';

/** The marked hull's state, which the spec asks the interface to show. */
export interface TargetReadout {
  callsign: string;
  /** Distance in world units. */
  range: number;
  /** 0..1. */
  shield: number;
  /** 0..1. */
  integrity: number;
  hostile: boolean;
}

/** What the flight loop publishes for the HUD to read. */
export interface HudReadout {
  speed: number;
  heading: number;
  throttle: number;
  callsign: string;
  draught: string;
  system: string;
  contacts: number;
  rtt: number;
  linkOk: boolean;
  shield: number;
  shieldMax: number;
  /** Structure remaining, 0..1. */
  integrity: number;
  target: TargetReadout | undefined;
  /** The most recent refused intent, shown briefly as a designed state. */
  refusal: string | undefined;
  /** What the captain has aboard and on account. */
  propellant: number;
  propellantCapacity: number;
  marks: number;
  /** The system a jump is spooling toward, empty when not spooling. */
  spoolingTo: string;
  /** The plotted course, empty when none. */
  course: string;
  /** Spool and approach, each 0..1. */
  spoolProgress: number;
  landingProgress: number;
  /** The nearest berth within reach, which is what L lands at. */
  berth: { name: string; distance: number; tooFast: boolean } | undefined;
}

export function Hud({
  readout,
  radarRef,
}: {
  readout: RefObject<HudReadout>;
  radarRef: RefObject<HTMLCanvasElement | null>;
}): React.JSX.Element {
  const [shown, setShown] = useState<HudReadout>({ ...readout.current });

  // 10 Hz is faster than anyone reads a number and far cheaper than a frame.
  useEffect(() => {
    const timer = setInterval(() => setShown({ ...readout.current }), 100);
    return () => clearInterval(timer);
  }, [readout]);

  return (
    <div className="hud" aria-hidden="false">
      <header className="hud__corner hud__corner--tl panel">
        <div className="hud__identity">
          <span className="hud__callsign">{shown.callsign}</span>
          <span className="label">{shown.draught}</span>
        </div>
        <div className="hud__system">
          <span className="label">System</span>
          <span className="hud__system-name">{shown.system}</span>
        </div>
        <div className="hud__purse">
          <span className="label">Purse</span>
          <span className="hud__purse-value data">{formatMarks(shown.marks)}</span>
          <span className="micro">M</span>
        </div>
      </header>

      <div className="hud__corner hud__corner--tr panel">
        <Reading label="Link" value={shown.linkOk ? `${Math.round(shown.rtt)}` : '--'} unit="ms" />
        <Reading label="Contacts" value={String(shown.contacts)} />
      </div>

      {shown.target && <TargetPanel target={shown.target} />}

      {shown.refusal !== undefined && (
        <div className="hud__refusal panel" role="status">
          <span className="micro">Refused</span>
          <span>{shown.refusal}</span>
        </div>
      )}

      <div className="hud__corner hud__corner--bl panel">
        <div className="hud__speed">
          <span className="label">Speed</span>
          <span className="hud__speed-value">{Math.round(shown.speed)}</span>
          <span className="micro">u/s</span>
        </div>
        <div className="hud__row">
          <Reading label="Heading" value={formatHeading(shown.heading)} unit="&deg;" />
          <Throttle value={shown.throttle} />
        </div>
        <div className="hud__bars">
          <Gauge
            label="Shield"
            value={shown.shieldMax > 0 ? shown.shield / shown.shieldMax : 0}
            tone="shield"
            readout={`${Math.round(shown.shield)}`}
          />
          <Gauge
            label="Structure"
            value={shown.integrity}
            tone={shown.integrity < 0.35 ? 'danger' : 'hull'}
            readout={`${Math.round(shown.integrity * 100)}%`}
          />
          <Gauge
            label="Propellant"
            value={
              shown.propellantCapacity > 0 ? shown.propellant / shown.propellantCapacity : 0
            }
            tone={
              shown.propellantCapacity > 0 && shown.propellant / shown.propellantCapacity < 0.2
                ? 'danger'
                : 'hull'
            }
            readout={`${shown.propellant}`}
          />
        </div>
      </div>

      <TravelBanner readout={shown} />

      <div className="hud__corner hud__corner--br">
        <div className="hud__radar panel">
          <canvas ref={radarRef} className="hud__radar-canvas" />
        </div>
        <span className="micro hud__radar-label">Scope</span>
      </div>
    </div>
  );
}

/**
 * What travel is available or under way, in the one place the eye already goes
 * for state it did not ask for. Only one of the three can be true at a time:
 * spooling outranks an approach, and an approach outranks an offer to land.
 */
function TravelBanner({ readout }: { readout: HudReadout }): React.JSX.Element | null {
  if (readout.spoolingTo !== '') {
    return (
      <div className="hud__travel panel hud__travel--spooling" role="status">
        <span className="micro">Spooling</span>
        <span className="hud__travel-name">{readout.spoolingTo}</span>
        <Progress value={readout.spoolProgress} />
        <span className="micro">Hold course clear of traffic</span>
      </div>
    );
  }

  if (readout.landingProgress > 0) {
    return (
      <div className="hud__travel panel hud__travel--landing" role="status">
        <span className="micro">Coming alongside</span>
        <Progress value={readout.landingProgress} />
      </div>
    );
  }

  if (readout.berth) {
    return (
      <div className="hud__travel panel" role="status">
        <span className="micro">In reach</span>
        <span className="hud__travel-name">{readout.berth.name}</span>
        {readout.berth.tooFast ? (
          <span className="micro hud__travel-hint">Too fast to come alongside</span>
        ) : (
          <span className="micro">
            <kbd className="hud__key">L</kbd> to come alongside
          </span>
        )}
      </div>
    );
  }

  if (readout.course !== '') {
    return (
      <div className="hud__travel panel" role="status">
        <span className="micro">Course</span>
        <span className="hud__travel-name">{readout.course}</span>
        <span className="micro">
          <kbd className="hud__key">J</kbd> to spool
        </span>
      </div>
    );
  }

  return null;
}

/** A continuous bar, for a wait with an end the captain is watching. */
function Progress({ value }: { value: number }): React.JSX.Element {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div
      className="hud__progress"
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span className="hud__progress-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** The mark: who, how far, and what is left of them. */
function TargetPanel({ target }: { target: TargetReadout }): React.JSX.Element {
  return (
    <div className={`hud__target panel${target.hostile ? ' hud__target--hostile' : ''}`}>
      <div className="hud__target-head">
        <span className="hud__target-name">{target.callsign}</span>
        <span className="micro">{target.hostile ? 'Unlettered' : 'Free captain'}</span>
      </div>
      <div className="hud__target-row">
        <span className="label">Range</span>
        <span className="hud__target-range data">{Math.round(target.range)}</span>
        <span className="micro">u</span>
      </div>
      <Gauge label="Shield" value={target.shield} tone="shield" />
      <Gauge
        label="Structure"
        value={target.integrity}
        tone={target.integrity < 0.35 ? 'danger' : 'hull'}
      />
    </div>
  );
}

/**
 * A segmented gauge.
 *
 * Segments rather than a continuous bar: this is an instrument, and a reading
 * you can count is easier to compare at a glance than one you have to measure.
 */
function Gauge({
  label,
  value,
  tone,
  readout,
}: {
  label: string;
  value: number;
  tone: 'shield' | 'hull' | 'danger';
  readout?: string;
}): React.JSX.Element {
  const segments = 12;
  const lit = Math.round(Math.max(0, Math.min(1, value)) * segments);
  return (
    <div className="hud__gauge">
      <span className="label">{label}</span>
      <div
        className={`hud__gauge-track hud__gauge-track--${tone}`}
        role="img"
        aria-label={`${label} ${Math.round(value * 100)} percent`}
      >
        {Array.from({ length: segments }, (_, i) => (
          <span key={i} className={i < lit ? 'hud__seg hud__seg--lit' : 'hud__seg'} />
        ))}
      </div>
      {readout !== undefined && <span className="hud__gauge-readout data">{readout}</span>}
    </div>
  );
}

function Reading({
  label,
  value,
  unit,
}: {
  label: string;
  value: string;
  unit?: string;
}): React.JSX.Element {
  return (
    <div className="hud__reading">
      <span className="label">{label}</span>
      <span className="hud__reading-value">
        {value}
        {unit !== undefined && <span className="micro hud__unit" dangerouslySetInnerHTML={{ __html: unit }} />}
      </span>
    </div>
  );
}

/** A segmented gauge rather than a progress bar: this is an instrument. */
function Throttle({ value }: { value: number }): React.JSX.Element {
  const segments = 8;
  const lit = Math.round(value * segments);
  return (
    <div className="hud__reading">
      <span className="label">Burn</span>
      <div className="hud__throttle" role="img" aria-label={`Throttle ${Math.round(value * 100)}%`}>
        {Array.from({ length: segments }, (_, i) => (
          <span key={i} className={i < lit ? 'hud__seg hud__seg--lit' : 'hud__seg'} />
        ))}
      </div>
    </div>
  );
}

/** Marks are counted in thousands, written with a thin space, never a comma. */
function formatMarks(marks: number): string {
  return String(Math.round(marks)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u2009');
}

function formatHeading(radians: number): string {
  // Compass-style: 0 is the system's +x axis, increasing clockwise on screen.
  let degrees = (radians * 180) / Math.PI;
  degrees = ((degrees % 360) + 360) % 360;
  return String(Math.round(degrees)).padStart(3, '0');
}
