import { describe, expect, it } from 'vitest';

import { content } from './load.ts';

const { systems } = content();

/** Region each security level belongs to, per spec section 19. */
const SECURITY_BY_REGION = {
  'home-roads': 'secured',
  concessions: 'contested',
  marque: 'lawless',
} as const;

describe('the galaxy', () => {
  it('has the twenty systems the spec names, in three regions', () => {
    expect(systems.size).toBe(20);

    const byRegion = new Map<string, number>();
    for (const system of systems.values()) {
      byRegion.set(system.region, (byRegion.get(system.region) ?? 0) + 1);
    }
    expect(byRegion.get('home-roads')).toBe(6);
    expect(byRegion.get('concessions')).toBe(8);
    expect(byRegion.get('marque')).toBe(6);
  });

  it('has at least thirty landable ports, each named once', () => {
    const names = [...systems.values()].flatMap((s) => s.ports.map((p) => p.name));
    expect(names.length).toBeGreaterThanOrEqual(30);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every system a security level that matches its region', () => {
    for (const system of systems.values()) {
      expect(system.security, system.id).toBe(SECURITY_BY_REGION[system.region]);
    }
  });

  it('puts the spec\'s fixed ports in the systems the spec puts them in', () => {
    const where = (portName: string): string | undefined =>
      [...systems.values()].find((s) => s.ports.some((p) => p.name === portName))?.id;

    expect(where('Countinghouse')).toBe('hallam');
    expect(where('Quorum')).toBe('vane');
    expect(where('Barratry')).toBe('landfall');
    expect(where('Jettison')).toBe('bitter-end');
    expect(where('the Bourse')).toBe('parity');
    expect(where("Underwriters' Hall")).toBe('parity');
    expect(where('the Prize Court')).toBe('soundings');
  });

  it('runs every hyperlane both ways', () => {
    for (const system of systems.values()) {
      for (const link of system.links) {
        const other = systems.get(link);
        expect(other, `${system.id} links to a system that does not exist: ${link}`).toBeDefined();
        expect(other!.links, `${link} does not link back to ${system.id}`).toContain(system.id);
      }
    }
  });

  it('never links a system to itself', () => {
    for (const system of systems.values()) {
      expect(system.links).not.toContain(system.id);
    }
  });

  it('can be flown from Parity to every other system', () => {
    const seen = new Set<string>(['parity']);
    const queue = ['parity'];
    while (queue.length > 0) {
      const current = queue.pop()!;
      for (const link of systems.get(current)?.links ?? []) {
        if (!seen.has(link)) {
          seen.add(link);
          queue.push(link);
        }
      }
    }
    expect(seen.size).toBe(systems.size);
  });

  it('leaves no system stranded on a single lane', () => {
    // A system with one lane is a dead end a captain can be trapped in.
    for (const system of systems.values()) {
      expect(system.links.length, `${system.id} has only ${system.links.length} lane(s)`)
        .toBeGreaterThanOrEqual(2);
    }
  });

  it('keeps every port inside its system', () => {
    for (const system of systems.values()) {
      for (const port of system.ports) {
        const distance = Math.hypot(port.x, port.y);
        expect(distance, `${port.id} sits outside ${system.id}`).toBeLessThan(system.radius);
        // And clear of the star at the centre.
        expect(distance, `${port.id} sits inside ${system.id}'s star`).toBeGreaterThan(
          system.star.radius * 3,
        );
      }
    }
  });

  it('separates the ports within a system', () => {
    for (const system of systems.values()) {
      for (let i = 0; i < system.ports.length; i++) {
        for (let j = i + 1; j < system.ports.length; j++) {
          const a = system.ports[i]!;
          const b = system.ports[j]!;
          const gap = Math.hypot(a.x - b.x, a.y - b.y);
          expect(gap, `${a.id} and ${b.id} overlap`).toBeGreaterThan(a.radius + b.radius + 500);
        }
      }
    }
  });

  it('keeps the chart readable: no two systems on the same spot', () => {
    const seen = new Set<string>();
    for (const system of systems.values()) {
      const key = `${system.mapX},${system.mapY}`;
      expect(seen.has(key), `${system.id} shares a chart position`).toBe(false);
      seen.add(key);
    }
  });

  it('gives the Unlettered their haven and nobody else a port', () => {
    const unlettered = [...systems.values()].flatMap((s) =>
      s.ports.filter((p) => p.owner === 'unlettered').map((p) => ({ port: p, system: s })),
    );
    expect(unlettered.length).toBeGreaterThan(0);
    // Their ports are only ever in the Marque.
    for (const entry of unlettered) {
      expect(entry.system.region, `${entry.port.name} is not in the Marque`).toBe('marque');
    }
  });

  it('writes every description in the house style', () => {
    for (const system of systems.values()) {
      expect(system.description, system.id).not.toMatch(/!/);
      for (const port of system.ports) {
        expect(port.description, port.id).not.toMatch(/!/);
        // Two or three sentences, per the voice rules.
        const sentences = port.description.split(/[.?]\s/).filter((s) => s.trim().length > 0);
        expect(sentences.length, `${port.id} runs ${sentences.length} sentences`).toBeLessThanOrEqual(3);
        expect(sentences.length, `${port.id} is a single clause`).toBeGreaterThanOrEqual(2);
      }
    }
  });
});
