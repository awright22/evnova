/** Client entry point. */

// Latin subsets only. The unsuffixed entry points pull Cyrillic, Greek,
// Vietnamese and latin-ext as well, which is ~200 kB of fonts nothing in this
// game renders, against a 5 MB budget for everything before the title screen.
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-sans-condensed/latin-500.css';
import '@fontsource/ibm-plex-sans-condensed/latin-600.css';
// EB Garamond is loaded only where in-world documents render, not here: it is
// reserved for the Gazette, commissions, charters and court notices.
import './styles/tokens.css';
import './styles/base.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import { listenToControls } from './audio/controls.ts';

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');

// Hover and select, for every control in the game, wired once at the
// document rather than screen by screen: a sound added per screen is a
// sound missing from the next screen somebody writes. Silent until a
// captain has touched something and the mix exists.
listenToControls();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
