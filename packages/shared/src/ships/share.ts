/**
 * Share codes.
 *
 * A draught is a name and a list of placements. A share code is that, packed
 * into bytes and written in an alphabet a captain can paste into the Register
 * without it being mangled by a chat client or a mail program.
 *
 * Three properties the format is built for:
 *
 * 1. **Deterministic.** The same draught always encodes to the same code, on
 *    either side of the wire. The module dictionary is ordered by first
 *    appearance in the placement list rather than by hash or insertion into a
 *    map, so there is nothing for a platform to disagree about.
 * 2. **Self-describing.** Placements refer to modules through a dictionary of
 *    ids carried in the code itself, not by index into the catalogue. Adding a
 *    fitting to `modules.json` or reordering the file cannot silently turn one
 *    captain's gun into another captain's cargo bay.
 * 3. **Checked.** A code carries a CRC over its own bytes, so a truncated or
 *    mistyped paste is refused with a reason rather than decoded into a
 *    draught nobody designed.
 *
 * Base64url is implemented here rather than taken from the platform: this
 * module runs in the browser and on the server, and the two disagree about
 * which of `btoa`, `Buffer` and `atob` exist.
 */

import type { Placement } from '../content/schema.ts';

/** Format version. Bumped only if the layout below changes. */
const VERSION = 1;

/** Longest name a code may carry, matching `SaveDesignIntent`. */
const MAX_NAME = 40;

/** Most placements a code may carry, matching `SaveDesignIntent`. */
const MAX_PLACEMENTS = 160;

/**
 * Coordinates are stored in one unsigned byte each, biased by this.
 *
 * The placement schema bounds a coordinate to ±64, so the biased value lands
 * in 0..128 and a byte is enough.
 */
const COORD_BIAS = 64;

/** What went wrong reading a code. A closed set, like every other refusal. */
export type ShareCodeProblem =
  | 'empty'
  | 'not-a-code'
  | 'wrong-version'
  | 'truncated'
  | 'bad-checksum'
  | 'no-placements'
  | 'too-many-placements'
  | 'bad-name';

export const SHARE_CODE_PROBLEMS: Record<ShareCodeProblem, string> = {
  empty: 'No code to read.',
  'not-a-code': 'That is not a draught code.',
  'wrong-version': 'That code was written for a different Register.',
  truncated: 'That code is incomplete. Check nothing was cut off the end.',
  'bad-checksum': 'That code does not check out. A character is wrong.',
  'no-placements': 'That code carries no fittings.',
  'too-many-placements': 'That code carries more fittings than a draught may hold.',
  'bad-name': 'That code carries no name.',
};

export interface SharedDesign {
  readonly name: string;
  readonly placements: readonly Placement[];
}

export class ShareCodeError extends Error {
  constructor(readonly problem: ShareCodeProblem) {
    super(SHARE_CODE_PROBLEMS[problem]);
    this.name = 'ShareCodeError';
  }
}

/**
 * Pack a draught into a share code.
 *
 * Layout, all little-endian where width exceeds a byte:
 *
 * ```
 *   0        version
 *   1        name length in bytes
 *   2..      name, UTF-8
 *   +0       dictionary length
 *   +1..     per entry: id length, then id in UTF-8
 *   +0       placement count
 *   +1..     per placement: dictionary index, x + bias, y + bias, rotation / 90
 *   last 2   CRC-16/CCITT-FALSE over every byte before these two
 * ```
 */
export function encodeShareCode(design: SharedDesign): string {
  const name = design.name.trim().slice(0, MAX_NAME);
  if (name === '') throw new ShareCodeError('bad-name');
  if (design.placements.length === 0) throw new ShareCodeError('no-placements');
  if (design.placements.length > MAX_PLACEMENTS) throw new ShareCodeError('too-many-placements');

  // Dictionary in order of first appearance: deterministic without sorting,
  // and it keeps the common case — a design built mostly of hull sections —
  // packing the repeated id once.
  const dictionary: string[] = [];
  const indexOf = new Map<string, number>();
  for (const placement of design.placements) {
    if (!indexOf.has(placement.moduleId)) {
      indexOf.set(placement.moduleId, dictionary.length);
      dictionary.push(placement.moduleId);
    }
  }

  const bytes: number[] = [VERSION];

  const nameBytes = utf8Encode(name);
  bytes.push(nameBytes.length, ...nameBytes);

  bytes.push(dictionary.length);
  for (const id of dictionary) {
    const idBytes = utf8Encode(id);
    bytes.push(idBytes.length, ...idBytes);
  }

  bytes.push(design.placements.length);
  for (const placement of design.placements) {
    bytes.push(
      indexOf.get(placement.moduleId)!,
      placement.x + COORD_BIAS,
      placement.y + COORD_BIAS,
      placement.rotation / 90,
    );
  }

  const crc = crc16(bytes);
  bytes.push(crc & 0xff, (crc >> 8) & 0xff);

  return base64urlEncode(Uint8Array.from(bytes));
}

/**
 * Read a share code back into a draught.
 *
 * Nothing here trusts the code: every length is checked against what is left
 * in the buffer before it is read, so a hostile code is a `ShareCodeError` and
 * not an out-of-bounds read. The result is still only a *claim* about a
 * draught — the caller validates the placements against the catalogue and the
 * captain's licence, because a code can legitimately name a fitting the
 * reader's Register has never heard of.
 */
export function decodeShareCode(raw: string): SharedDesign {
  const cleaned = normaliseShareCode(raw);
  if (cleaned === '') throw new ShareCodeError('empty');

  const bytes = base64urlDecode(cleaned);
  // Version, name length, dictionary length, placement count and the CRC: the
  // shortest possible code is longer than this, but this is the floor below
  // which the reads below could not even be attempted.
  if (bytes.length < 7) throw new ShareCodeError('truncated');
  if (bytes[0] !== VERSION) throw new ShareCodeError('wrong-version');

  const crcGiven = bytes[bytes.length - 2]! | (bytes[bytes.length - 1]! << 8);
  if (crc16(bytes.subarray(0, bytes.length - 2)) !== crcGiven) {
    throw new ShareCodeError('bad-checksum');
  }

  const body = bytes.subarray(0, bytes.length - 2);
  let at = 1;

  const take = (count: number): Uint8Array => {
    if (count < 0 || at + count > body.length) throw new ShareCodeError('truncated');
    const slice = body.subarray(at, at + count);
    at += count;
    return slice;
  };
  const byte = (): number => take(1)[0]!;

  const name = utf8Decode(take(byte())).trim();
  if (name === '') throw new ShareCodeError('bad-name');

  const dictionary: string[] = [];
  const dictionaryLength = byte();
  for (let i = 0; i < dictionaryLength; i++) dictionary.push(utf8Decode(take(byte())));

  const count = byte();
  if (count === 0) throw new ShareCodeError('no-placements');
  if (count > MAX_PLACEMENTS) throw new ShareCodeError('too-many-placements');

  const placements: Placement[] = [];
  for (let i = 0; i < count; i++) {
    const index = byte();
    const x = byte();
    const y = byte();
    const quarter = byte();
    const moduleId = dictionary[index];
    if (moduleId === undefined) throw new ShareCodeError('not-a-code');
    if (quarter > 3) throw new ShareCodeError('not-a-code');
    placements.push({
      moduleId,
      x: x - COORD_BIAS,
      y: y - COORD_BIAS,
      rotation: (quarter * 90) as Placement['rotation'],
    });
  }

  return { name: name.slice(0, MAX_NAME), placements };
}

/**
 * Tidy a pasted code.
 *
 * A code crosses a chat window, a mail client or a scrap of paper on the way
 * to the captain who types it in, and any of those may break it across lines.
 * Whitespace carries no meaning in the alphabet, so it comes out, along with
 * any base64 padding a different implementation added.
 *
 * Nothing else is stripped. A hyphen is a real character here — base64url's
 * sixty-third — so a code a mail client has hyphenated cannot be repaired by
 * guessing which hyphens were its own. That is what the checksum is for: such
 * a code is refused with `bad-checksum` rather than quietly decoded into a
 * draught nobody designed.
 */
export function normaliseShareCode(raw: string): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, '').replace(/=+$/, '') : '';
}

// --- Base64url ------------------------------------------------------------

/** The standard base64url alphabet. All sixty-four characters of it. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Index by character code, so decoding is a lookup rather than an indexOf. */
const REVERSE = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

function base64urlEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    if (b === undefined) break;
    out += ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    if (c === undefined) break;
    out += ALPHABET[c & 0x3f];
  }
  return out;
}

function base64urlDecode(text: string): Uint8Array {
  const out: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const value = code < 128 ? REVERSE[code]! : -1;
    if (value < 0) throw new ShareCodeError('not-a-code');
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((accumulator >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

// --- UTF-8 ----------------------------------------------------------------
//
// Hand-rolled for the same reason as base64url: `TextEncoder` is present in
// both runtimes now, but these are a dozen lines and remove the question.

function utf8Encode(text: string): number[] {
  const out: number[] = [];
  for (const character of text) {
    const point = character.codePointAt(0)!;
    if (point < 0x80) out.push(point);
    else if (point < 0x800) out.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
    else if (point < 0x10000) {
      out.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    } else {
      out.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f),
      );
    }
  }
  return out;
}

function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const byte = bytes[i]!;
    let point: number;
    let width: number;
    if (byte < 0x80) [point, width] = [byte, 1];
    else if ((byte & 0xe0) === 0xc0) [point, width] = [byte & 0x1f, 2];
    else if ((byte & 0xf0) === 0xe0) [point, width] = [byte & 0x0f, 3];
    else if ((byte & 0xf8) === 0xf0) [point, width] = [byte & 0x07, 4];
    else throw new ShareCodeError('not-a-code');
    if (i + width > bytes.length) throw new ShareCodeError('truncated');
    for (let k = 1; k < width; k++) {
      const next = bytes[i + k]!;
      if ((next & 0xc0) !== 0x80) throw new ShareCodeError('not-a-code');
      point = (point << 6) | (next & 0x3f);
    }
    out += String.fromCodePoint(point);
    i += width;
  }
  return out;
}

// --- CRC ------------------------------------------------------------------

/**
 * CRC-16/CCITT-FALSE.
 *
 * Bit-by-bit rather than table-driven: a share code is a few hundred bytes, so
 * the table would cost more to ship than the loop costs to run.
 */
function crc16(bytes: ArrayLike<number>): number {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= (bytes[i]! & 0xff) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}
