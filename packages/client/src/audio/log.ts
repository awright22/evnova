/**
 * What the game has sounded.
 *
 * Spec section 3: "You can't hear audio either, so check it by measurement:
 * loudness-normalize every file, confirm every row in the feedback table has
 * a sound mapped, and log which sound events fire during a scripted session."
 *
 * There are no files — everything is synthesised — so the measurement that
 * is left is this one. Every sound the client plays reports its name here,
 * and with `?harness=1` the log is published on `window` so a scripted
 * session can read back what it heard and check it against the feedback
 * table. `tools/verify/src/audio.ts` is the session that does it.
 *
 * It costs one array push per sound, and nothing at all when the harness
 * flag is absent: without it the log keeps only a count per name, which is
 * two numbers and no allocation.
 */

/**
 * Every sound the client can make, named as the feedback table names it.
 *
 * A list rather than a bare union, because the audit has to check at run
 * time that a row maps to a sound something actually plays, and a type
 * cannot be asked that.
 */
export const SOUND_NAMES = [
  // Flight
  'engine',
  'thruster',
  'spool',
  'jump',
  'arrival',
  'land',
  'launch',
  // Combat
  'gun',
  'turret',
  'missile',
  'beam',
  'intercept',
  'shieldHit',
  'hullHit',
  'moduleDisabled',
  'explosionSmall',
  'explosionLarge',
  'lock',
  // Paper and counters
  'stamp',
  'refused',
  'boarded',
  'claim',
  'filled',
  'called',
  'dividend',
  'commission',
  'chat',
  'contact',
  'posted',
  'hover',
  'select',
  'confirm',
] as const;

export type SoundName = (typeof SOUND_NAMES)[number];

interface Heard {
  readonly name: SoundName;
  /** Milliseconds since the page loaded. */
  readonly at: number;
}

declare global {
  interface Window {
    __marqueAudio?: {
      heard: Heard[];
      counts: Record<string, number>;
      /** What the music is doing, which is a state rather than an event. */
      music: { started: boolean; region: string; fighting: boolean };
    };
  }
}

/**
 * What the bed is doing.
 *
 * Music is not in `SoundName` and not in the feedback table, because it is
 * not feedback: nothing a captain does causes it, and no row of that table
 * is answered by it. The audit still has to be able to say whether it ever
 * started, so it lives here beside the log rather than in it.
 */
const music = { started: false, region: '', fighting: false };

export function musicIs(state: Partial<typeof music>): void {
  Object.assign(music, state);
  if (typeof window !== 'undefined' && window.__marqueAudio) {
    window.__marqueAudio.music = music;
  }
}

const counts: Record<string, number> = {};
let heard: Heard[] | undefined;

/** True once the harness has asked for the full log. */
function recording(): boolean {
  if (heard !== undefined) return true;
  if (typeof window === 'undefined') return false;
  if (new URLSearchParams(window.location.search).get('harness') !== '1') return false;
  heard = [];
  window.__marqueAudio = { heard, counts, music };
  return true;
}

/**
 * Say that a sound was played.
 *
 * Called from the code that makes the noise rather than from the code that
 * decides to, so a sound that is mapped but never reaches the speakers —
 * a bus at zero, a voice that failed to start — is not reported as heard.
 */
export function sounded(name: SoundName): void {
  counts[name] = (counts[name] ?? 0) + 1;
  if (!recording() || !heard) return;
  heard.push({ name, at: Math.round(performance.now()) });
  // A long session should not grow without bound; the harness reads the
  // whole log, and four thousand entries is more than any session makes.
  if (heard.length > 4000) heard.splice(0, 1000);
}

/** How many times each sound has been played this session. */
export function soundCounts(): Readonly<Record<string, number>> {
  return counts;
}

/**
 * Which sound answers each row of the feedback table.
 *
 * Spec section 3 asks for this to be confirmed rather than assumed: audio
 * cannot be judged by reading code, so the check that is left is that every
 * row of the table in `docs/ART_DIRECTION.md` names a sound that exists and
 * that something in the client plays. The keys here are the row labels from
 * that table, exactly; `log.test.ts` parses the document and fails if a row
 * is missing, renamed or added without a sound.
 *
 * A row can map to more than one sound where the table's own description is
 * of more than one thing happening — a write-off is a different noise for a
 * gunboat and for a freighter.
 */
export const FEEDBACK_SOUNDS: Record<string, readonly SoundName[]> = {
  Thrust: ['engine'],
  Turn: ['thruster'],
  'Fire gun': ['gun'],
  'Fire turret': ['turret'],
  'Fire missile': ['missile'],
  'Hit dealt': ['hullHit', 'shieldHit'],
  'Hold a beam': ['beam'],
  'Cut into rock': ['beam'],
  'Point defense intercepts': ['intercept'],
  'Hit taken on shields': ['shieldHit'],
  'Hit taken on hull': ['hullHit'],
  'Module disabled': ['moduleDisabled'],
  'Ship written off': ['explosionSmall', 'explosionLarge'],
  'Target acquired': ['lock'],
  'Jump spool': ['spool'],
  Jump: ['jump'],
  Arrival: ['arrival'],
  Land: ['land'],
  Launch: ['launch'],
  'Buy at the Staple': ['stamp'],
  'Sell at the Staple': ['stamp'],
  'Insufficient funds': ['refused'],
  'Order filled at the Bourse': ['filled'],
  'Dividend received': ['dividend'],
  'Commission accepted': ['stamp'],
  'Commission complete': ['commission'],
  'Chat message': ['chat'],
  'Player enters system': ['contact'],
  'Posted by the Prize Court': ['posted'],
  'Cutting rock': ['beam'],
  'Hold filled while cutting': ['beam'],
  'Boarding a prize': ['boarded'],
  'Standing order left': ['stamp'],
  'Standing order filled': ['filled'],
  'Short sold': ['stamp'],
  'Position closed out by the Bourse': ['called'],
  // The table says so in as many words: the range makes no ceremony.
  'Taken out on the range': [],
  'A claim settled': ['claim'],
  'Hover any control': ['hover'],
  'Press any control': ['select'],
  'Confirm a destructive action': ['confirm'],
};
