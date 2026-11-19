/**
 * The chart.
 *
 * Fetched once from the server rather than bundled, so a client and a server
 * on different builds disagree about the galaxy loudly and immediately rather
 * than quietly.
 */

export interface ChartPort {
  readonly id: string;
  readonly name: string;
  readonly owner: string;
  readonly services: readonly string[];
  readonly description: string;
}

export interface ChartSystem {
  readonly id: string;
  readonly name: string;
  readonly region: 'home-roads' | 'concessions' | 'marque';
  readonly security: 'secured' | 'contested' | 'lawless';
  readonly description: string;
  readonly mapX: number;
  readonly mapY: number;
  readonly links: readonly string[];
  readonly ports: readonly ChartPort[];
}

export interface Chart {
  readonly systems: readonly ChartSystem[];
  readonly byId: ReadonlyMap<string, ChartSystem>;
}

let cached: Promise<Chart> | undefined;

export function loadChart(httpBase: string): Promise<Chart> {
  cached ??= fetch(`${httpBase}/galaxy`)
    .then((response) => {
      if (!response.ok) throw new Error(`the chart is unavailable (${response.status})`);
      return response.json() as Promise<{ systems: ChartSystem[] }>;
    })
    .then((payload) => ({
      systems: payload.systems,
      byId: new Map(payload.systems.map((system) => [system.id, system])),
    }));
  return cached;
}

/** What the player reads for each region and security level. */
export const REGION_NAMES: Record<ChartSystem['region'], string> = {
  'home-roads': 'the Home Roads',
  concessions: 'the Concessions',
  marque: 'the Marque',
};

export const SECURITY_NAMES: Record<ChartSystem['security'], string> = {
  secured: 'Secured',
  contested: 'Contested',
  lawless: 'Lawless',
};
