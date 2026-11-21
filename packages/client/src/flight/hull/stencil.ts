/**
 * The registry stencil.
 *
 * Every hull carries a registry number, painted on the plating the way a
 * yard paints one: a blocky stencil, not a typeface. The bake runs without a
 * DOM, so there is no canvas to set type with — which suits it. Five by seven,
 * the characters a registry uses and nothing else; asking for any other is a
 * mistake in the caller and fails loudly rather than painting a gap.
 */

const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
};

/** Columns a character advances, including its gap. */
export const STENCIL_ADVANCE = 6;
/** Rows a character stands. */
export const STENCIL_ROWS = 7;

/**
 * The dots a line of stencil text paints, in glyph units from its top-left:
 * one entry per lit dot.
 */
export function stencilDots(text: string): { x: number; y: number }[] {
  const dots: { x: number; y: number }[] = [];
  [...text].forEach((character, index) => {
    const glyph = GLYPHS[character];
    if (!glyph) throw new Error(`the registry stencil has no "${character}"`);
    glyph.forEach((row, y) => {
      [...row].forEach((cell, x) => {
        if (cell === '#') dots.push({ x: index * STENCIL_ADVANCE + x, y });
      });
    });
  });
  return dots;
}
