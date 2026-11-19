/**
 * Server metrics.
 *
 * The spec budgets an average tick under 4 ms with 12 players and 40 NPCs in
 * one system, and treats frame-time spikes as bugs. An average alone hides
 * spikes, so this keeps a reservoir of samples and reports percentiles.
 *
 * Rooms register themselves here, so the metrics route can report across every
 * live room without reaching into Colyseus internals.
 */

/** Rolling sample window per room. 4096 samples at 30 Hz is about two minutes. */
const WINDOW = 4096;

export interface TickStats {
  readonly samples: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  /** Steps that took longer than one frame at 30 fps: the spec's spike bound. */
  readonly over33Ms: number;
}

export class TickMetrics {
  private readonly samples = new Float64Array(WINDOW);
  private count = 0;
  private cursor = 0;
  private spikes = 0;

  record(durationMs: number): void {
    this.samples[this.cursor] = durationMs;
    this.cursor = (this.cursor + 1) % WINDOW;
    if (this.count < WINDOW) this.count++;
    if (durationMs > 33) this.spikes++;
  }

  stats(): TickStats {
    if (this.count === 0) {
      return { samples: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, over33Ms: 0 };
    }

    const sorted = Array.from(this.samples.subarray(0, this.count)).sort((a, b) => a - b);
    const total = sorted.reduce((sum, value) => sum + value, 0);

    return {
      samples: this.count,
      meanMs: round(total / this.count),
      p50Ms: round(percentile(sorted, 0.5)),
      p95Ms: round(percentile(sorted, 0.95)),
      p99Ms: round(percentile(sorted, 0.99)),
      maxMs: round(sorted[sorted.length - 1] ?? 0),
      over33Ms: this.spikes,
    };
  }

  reset(): void {
    this.count = 0;
    this.cursor = 0;
    this.spikes = 0;
  }
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * One live room's contribution to the metrics report.
 *
 * Counts are read through functions rather than stored, so the report always
 * reflects the room as it is now rather than as it was when it registered.
 */
export interface RoomMetricsSource {
  readonly roomId: string;
  readonly systemId: string;
  readonly clients: () => number;
  readonly entities: () => number;
  readonly tick: TickMetrics;
}

const rooms = new Set<RoomMetricsSource>();

export function registerRoom(source: RoomMetricsSource): () => void {
  rooms.add(source);
  return () => rooms.delete(source);
}

const startedAt = Date.now();

export function metricsReport(): object {
  const live = [...rooms];
  return {
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    rooms: live.length,
    clients: live.reduce((sum, room) => sum + room.clients(), 0),
    entities: live.reduce((sum, room) => sum + room.entities(), 0),
    perRoom: live.map((room) => ({
      roomId: room.roomId,
      systemId: room.systemId,
      clients: room.clients(),
      entities: room.entities(),
      tick: room.tick.stats(),
    })),
  };
}
