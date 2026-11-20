/**
 * The title.
 *
 * The first thing anybody sees, so it says what this is and gets out of the
 * way: the name, the premise in one line, and the three doors — in, settings,
 * credits. A captain who has been here before is let straight through; this
 * is for the first time and for whenever they come back to change something.
 */

import './shell.css';

export function Title({
  version,
  returning,
  onEnter,
  onSettings,
  onCredits,
}: {
  readonly version: string;
  /** True when this device already has a captain on the Register. */
  readonly returning: boolean;
  onEnter: () => void;
  onSettings: () => void;
  onCredits: () => void;
}): React.JSX.Element {
  return (
    <main className="title" aria-label="Marque">
      <div className="title__plate panel">
        <h1 className="title__name">Marque</h1>
        <p className="title__line">
          Nobody governs settled space. Three chartered companies do, and everything
          else runs on paper.
        </p>

        <div className="title__doors">
          <button type="button" className="button button--primary" onClick={onEnter} autoFocus>
            {returning ? 'Back to the Reach' : 'Enter the Register'}
          </button>
          <button type="button" className="button" onClick={onSettings}>
            Settings
          </button>
          <button type="button" className="button" onClick={onCredits}>
            Credits
          </button>
        </div>

        <p className="title__version micro">{version}</p>
      </div>
    </main>
  );
}
