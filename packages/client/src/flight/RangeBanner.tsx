/**
 * On the range.
 *
 * The one thing a captain has to know out here is that none of it is real,
 * so the banner says so and then gets out of the way: what is being flown,
 * what it is up against, and the two things that can be done about it.
 *
 * Over the flight view rather than inside the HUD, because it is not a
 * readout of the hull — it is the frame the hull is being read in, and it
 * goes away the moment the captain comes back.
 */

import { content } from '@marque/shared';

import type { RangeState } from '../game/GameClient.ts';
import './range.css';

export function RangeBanner({
  range,
  onSpar,
  onLeave,
}: {
  readonly range: RangeState;
  onSpar: (against: string) => void;
  onLeave: () => void;
}): React.JSX.Element {
  const { blueprints } = content();
  // Only the draughts the Register itself lists: a captain's own hulls are
  // not sparring partners, and a range that offered them would be offering
  // to shoot at something somebody owns.
  const choices = [...blueprints.values()];
  const against = blueprints.get(range.against);

  if (range.problems.length > 0) {
    return (
      <div className="range range--refused" role="status">
        <div className="range__panel panel">
          <h2>She will not be flown as drawn</h2>
          <ul className="range__problems">
            {range.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
          <button type="button" className="button button--primary" onClick={onLeave}>
            Back to the Yard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="range" role="status">
      <div className="range__bar panel">
        <span className="label range__title">On the range</span>

        <div className="range__choices" role="group" aria-label="What to put up">
          {choices.map((draught) => (
            <button
              key={draught.id}
              type="button"
              className={`range__choice${draught.id === range.against ? ' range__choice--on' : ''}`}
              aria-pressed={draught.id === range.against}
              onClick={() => onSpar(draught.id)}
            >
              {draught.name}
            </button>
          ))}
        </div>

        <button type="button" className="button range__leave" onClick={onLeave}>
          Come back
        </button>
      </div>
      <span className="range__current micro">
        {range.flying !== '' && `${range.flying}, `}
        {against ? `against two ${against.name}s. ` : 'with nothing up yet. '}
        {range.note}
      </span>
    </div>
  );
}
