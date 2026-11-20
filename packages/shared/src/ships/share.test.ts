import { describe, expect, it } from 'vitest';

import type { Placement } from '../content/schema.ts';

import {
  ShareCodeError,
  decodeShareCode,
  encodeShareCode,
  normaliseShareCode,
} from './share.ts';

const DESIGN = {
  name: 'Bonded Runner',
  placements: [
    { moduleId: 'hrc-bridge-1', x: 0, y: 0, rotation: 0 },
    { moduleId: 'hrc-hull-1', x: 0, y: 2, rotation: 0 },
    { moduleId: 'hrc-hull-1', x: 1, y: 2, rotation: 90 },
    { moduleId: 'slp-engine-1', x: 0, y: 3, rotation: 180 },
    { moduleId: 'hrc-cargo-1', x: -2, y: 2, rotation: 270 },
  ] satisfies Placement[],
} as const;

describe('share codes', () => {
  it('round-trips a draught', () => {
    const decoded = decodeShareCode(encodeShareCode(DESIGN));
    expect(decoded.name).toBe(DESIGN.name);
    expect(decoded.placements).toEqual(DESIGN.placements);
  });

  it('is deterministic: the same draught always gives the same code', () => {
    // Encoded from two separately built but equal inputs, so nothing about
    // object identity or insertion history can leak into the output.
    const copy = {
      name: 'Bonded Runner',
      placements: DESIGN.placements.map((p) => ({ ...p })),
    };
    expect(encodeShareCode(copy)).toBe(encodeShareCode(DESIGN));
  });

  it('writes a code in one line of the alphabet, with no padding', () => {
    expect(encodeShareCode(DESIGN)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('packs a repeated fitting into the dictionary once', () => {
    // Twenty hull sections should cost about four bytes each plus one copy of
    // the id, not twenty copies of it.
    const many = {
      name: 'Slab',
      placements: Array.from({ length: 20 }, (_, i) => ({
        moduleId: 'hrc-hull-1',
        x: i % 5,
        y: Math.floor(i / 5),
        rotation: 0 as const,
      })),
    };
    expect(encodeShareCode(many).length).toBeLessThan(160);
  });

  it('survives a code broken across lines', () => {
    const code = encodeShareCode(DESIGN);
    const mangled = `${code.slice(0, 10)}\n  ${code.slice(10, 20)}\n\t${code.slice(20)}`;
    expect(decodeShareCode(mangled).placements).toEqual(DESIGN.placements);
  });

  it('refuses a code a mail client has hyphenated, rather than guessing', () => {
    // A hyphen is base64url's sixty-third character, so an inserted one
    // cannot be told from a real one. The checksum catches it.
    const code = encodeShareCode(DESIGN);
    const hyphenated = `${code.slice(0, 12)}-${code.slice(12)}`;
    expect(() => decodeShareCode(hyphenated)).toThrow(ShareCodeError);
  });

  it('keeps negative coordinates and every rotation', () => {
    const corners = {
      name: 'Corners',
      placements: [
        { moduleId: 'a', x: -64, y: -64, rotation: 0 },
        { moduleId: 'b', x: 64, y: 64, rotation: 90 },
        { moduleId: 'c', x: -64, y: 64, rotation: 180 },
        { moduleId: 'd', x: 64, y: -64, rotation: 270 },
      ] satisfies Placement[],
    };
    expect(decodeShareCode(encodeShareCode(corners)).placements).toEqual(corners.placements);
  });

  it('carries a name with characters outside ASCII', () => {
    const named = { name: 'Dérive — 船', placements: DESIGN.placements };
    expect(decodeShareCode(encodeShareCode(named)).name).toBe('Dérive — 船');
  });

  it('refuses a code with a character flipped', () => {
    const code = encodeShareCode(DESIGN);
    // Flip a character in the body to something else in the alphabet, so the
    // code still decodes to bytes and only the checksum catches it.
    const at = 6;
    const swapped = code[at] === 'A' ? 'B' : 'A';
    const broken = code.slice(0, at) + swapped + code.slice(at + 1);
    expect(() => decodeShareCode(broken)).toThrow(
      expect.objectContaining({ problem: 'bad-checksum' }),
    );
  });

  it('refuses a truncated code', () => {
    const code = encodeShareCode(DESIGN);
    expect(() => decodeShareCode(code.slice(0, code.length - 4))).toThrow(ShareCodeError);
  });

  it('refuses characters outside the alphabet', () => {
    expect(() => decodeShareCode('not a code!!')).toThrow(
      expect.objectContaining({ problem: 'not-a-code' }),
    );
  });

  it('refuses an empty code', () => {
    expect(() => decodeShareCode('   ')).toThrow(expect.objectContaining({ problem: 'empty' }));
  });

  it('refuses a code from another version', () => {
    // Byte zero is the version. Rewrite it and re-checksum, so the only
    // problem left is the version itself.
    const code = encodeShareCode(DESIGN);
    const bytes = bytesOf(code);
    bytes[0] = 99;
    const re = recrc(bytes);
    expect(() => decodeShareCode(codeOf(re))).toThrow(
      expect.objectContaining({ problem: 'wrong-version' }),
    );
  });

  it('refuses a draught with no name, and one with no fittings', () => {
    expect(() => encodeShareCode({ name: '  ', placements: DESIGN.placements })).toThrow(
      expect.objectContaining({ problem: 'bad-name' }),
    );
    expect(() => encodeShareCode({ name: 'Empty', placements: [] })).toThrow(
      expect.objectContaining({ problem: 'no-placements' }),
    );
  });

  it('refuses more fittings than a draught may hold', () => {
    const huge = {
      name: 'Too much',
      placements: Array.from({ length: 161 }, (_, i) => ({
        moduleId: 'hrc-hull-1',
        x: i % 13,
        y: Math.floor(i / 13),
        rotation: 0 as const,
      })),
    };
    expect(() => encodeShareCode(huge)).toThrow(
      expect.objectContaining({ problem: 'too-many-placements' }),
    );
  });

  it('cuts a name longer than the Register prints', () => {
    const long = { name: 'x'.repeat(80), placements: DESIGN.placements };
    expect(decodeShareCode(encodeShareCode(long)).name).toHaveLength(40);
  });

  it('strips whitespace and padding when normalising, and nothing else', () => {
    expect(normaliseShareCode(' AB CD==\n')).toBe('ABCD');
    expect(normaliseShareCode('A-B_C')).toBe('A-B_C');
  });
});

// --- Helpers for the tests that have to corrupt a code on purpose ---------

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function bytesOf(code: string): number[] {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const character of code) {
    acc = (acc << 6) | ALPHABET.indexOf(character);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return out;
}

function codeOf(bytes: number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i]!, bytes[i + 1], bytes[i + 2]];
    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    if (b === undefined) break;
    out += ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    if (c === undefined) break;
    out += ALPHABET[c & 0x3f];
  }
  return out;
}

function recrc(bytes: number[]): number[] {
  const body = bytes.slice(0, bytes.length - 2);
  let crc = 0xffff;
  for (const byte of body) {
    crc ^= (byte & 0xff) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return [...body, crc & 0xff, (crc >> 8) & 0xff];
}
