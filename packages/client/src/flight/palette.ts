/**
 * The palette, in a form the renderer can use.
 *
 * The CSS tokens are the source of truth, so these are read from the document
 * at startup rather than duplicated. A token that changes in
 * `tokens.css` changes the flight view with it, and there is no second list to
 * drift.
 */

/** Read a CSS custom property as a 24-bit colour number. */
function token(name: string, fallback: number): number {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const parsed = parseHex(value);
  return parsed ?? fallback;
}

export function parseHex(value: string): number | undefined {
  const match = /^#([0-9a-fA-F]{6})$/.exec(value);
  return match ? Number.parseInt(match[1]!, 16) : undefined;
}

export interface Palette {
  readonly void: number;
  readonly panel: number;
  readonly raised: number;
  readonly rule: number;
  readonly ruleStrong: number;
  readonly textPrimary: number;
  readonly textSecondary: number;
  readonly textMuted: number;
  readonly amber: number;
  readonly amberBright: number;
  readonly amberDim: number;
  readonly danger: number;
  readonly shield: number;
  readonly hull: number;
  readonly liveryKessler: number;
  readonly liveryThirty: number;
  readonly liveryReprisal: number;
  readonly liveryUnlettered: number;
  readonly nebulaHomeRoads: number;
  readonly nebulaConcessions: number;
  readonly nebulaMarque: number;
}

let cached: Palette | undefined;

export function palette(): Palette {
  cached ??= {
    void: token('--void', 0x070a10),
    panel: token('--panel', 0x0e131b),
    raised: token('--raised', 0x161d28),
    rule: token('--rule', 0x273244),
    ruleStrong: token('--rule-strong', 0x3a4961),
    textPrimary: token('--text-primary', 0xdde3ec),
    textSecondary: token('--text-secondary', 0x8d98a9),
    textMuted: token('--text-muted', 0x788597),
    amber: token('--amber', 0xf2a33a),
    amberBright: token('--amber-bright', 0xffbe63),
    amberDim: token('--amber-dim', 0xa06a1e),
    danger: token('--danger', 0xe64f54),
    shield: token('--shield', 0x5e9fd4),
    hull: token('--hull', 0xc3ccd6),
    liveryKessler: token('--livery-kessler', 0xe9e2d0),
    liveryThirty: token('--livery-thirty', 0x3a6fd8),
    liveryReprisal: token('--livery-reprisal', 0x2fa596),
    liveryUnlettered: token('--livery-unlettered', 0x4a525e),
    nebulaHomeRoads: token('--nebula-home-roads', 0x5e86b8),
    nebulaConcessions: token('--nebula-concessions', 0x96586c),
    nebulaMarque: token('--nebula-marque', 0x2f7f76),
  };
  return cached;
}

export function nebulaFor(region: string, p = palette()): number {
  switch (region) {
    case 'concessions':
      return p.nebulaConcessions;
    case 'marque':
      return p.nebulaMarque;
    default:
      return p.nebulaHomeRoads;
  }
}

// --- Colour maths -------------------------------------------------------
// Canvas and Pixi both want numbers, so the usual CSS helpers are unavailable.

export function rgb(colour: number): [number, number, number] {
  return [(colour >> 16) & 0xff, (colour >> 8) & 0xff, colour & 0xff];
}

export function pack(r: number, g: number, b: number): number {
  const clamp255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
  return (clamp255(r) << 16) | (clamp255(g) << 8) | clamp255(b);
}

/** Mix two colours. `t` of 0 returns `a`, 1 returns `b`. */
export function mix(a: number, b: number, t: number): number {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  return pack(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

export function lighten(colour: number, amount: number): number {
  return mix(colour, 0xffffff, amount);
}

export function darken(colour: number, amount: number): number {
  return mix(colour, 0x000000, amount);
}

/** Shift a colour toward the system star's tint, for scene lighting. */
export function tintBy(colour: number, tint: number, amount: number): number {
  const [tr, tg, tb] = rgb(tint);
  const [cr, cg, cb] = rgb(colour);
  return pack(
    cr * (1 - amount) + (cr * tr) / 255 * amount,
    cg * (1 - amount) + (cg * tg) / 255 * amount,
    cb * (1 - amount) + (cb * tb) / 255 * amount,
  );
}
