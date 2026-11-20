/**
 * Credits.
 *
 * Read from `CREDITS.md` itself, at build time, so the screen and the file
 * cannot drift: the rule in `CLAUDE.md` is that every third-party asset is
 * entered there with its licence in the same commit as the asset, and this
 * is that file, set as a document.
 *
 * The rendering is deliberately small — headings, paragraphs, links and
 * nothing else. It is a credits list, not a Markdown viewer, and a credits
 * list that needed a parser would be a credits list with too much in it.
 */

import credits from '../../../../CREDITS.md?raw';

import './shell.css';

interface Line {
  readonly kind: 'head' | 'text';
  readonly text: string;
}

/** Headings and paragraphs. Everything else is read as text. */
export function readCredits(source: string): Line[] {
  const out: Line[] = [];
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('#')) {
      out.push({ kind: 'head', text: line.replace(/^#+\s*/, '') });
      continue;
    }
    out.push({ kind: 'text', text: line.replace(/^[-*]\s*/, '') });
  }
  return out;
}

export function Credits({ onClose }: { onClose: () => void }): React.JSX.Element {
  const lines = readCredits(credits);

  return (
    <main
      className="credits"
      aria-label="Credits"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <article className="panel credits__sheet">
        <header className="credits__head">
          <h1>Credits</h1>
          <button type="button" className="button" onClick={onClose} autoFocus>
            Back
          </button>
        </header>
        <div className="credits__body">
          {lines.map((line, index) =>
            line.kind === 'head' ? (
              <h2 key={index}>{line.text}</h2>
            ) : (
              <p key={index}>{line.text}</p>
            ),
          )}
        </div>
      </article>
    </main>
  );
}
