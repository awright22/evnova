/**
 * Where hulls are baked, and kept.
 *
 * Bakes run in workers, so meeting a new draught never costs a frame, and are
 * kept for the life of the page, keyed by the grid itself, so a draught met
 * in one system is not baked again in the next. A bake is CPU-side pixels; each
 * scene uploads the ones it draws to its own renderer.
 *
 * Where a worker cannot be started — an environment without them, or one
 * that refuses the script — the bakery says so once on the console and bakes
 * on the main thread instead. That costs a hitch per new draught; it never
 * costs a hull that silently fails to appear.
 */

import type { Blueprint, ModuleDef } from '@marque/shared';

import { bakeHull, type HullBake } from './bake.ts';
import type { BakeReply, BakeRequest } from './bakeWorker.ts';

/** Bakes kept, most recently used last. A hull is a few megabytes of pixels. */
const KEEP = 32;

/** What a grid is, for the cache: its id and every placement in it. */
export function bakeKey(blueprint: Blueprint): string {
  const cells = blueprint.placements
    .map((placement) => `${placement.moduleId}@${placement.x},${placement.y},${placement.rotation}`)
    .join(';');
  return `${blueprint.id}|${cells}`;
}

interface Pending {
  readonly key: string;
  readonly blueprint: Blueprint;
}

export class Bakery {
  private readonly done = new Map<string, HullBake>();
  private readonly failed = new Map<string, string>();
  private readonly waiting = new Map<number, Pending>();
  private readonly asked = new Set<string>();
  private readonly workers: Worker[] = [];
  private nextId = 1;
  private turn = 0;
  private fallback = false;

  constructor(private readonly catalogue: ReadonlyMap<string, ModuleDef>) {
    const count = Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 2) - 1));
    try {
      for (let i = 0; i < count; i++) {
        const worker = new Worker(new URL('./bakeWorker.ts', import.meta.url), { type: 'module', name: `hull-bakery-${i}` });
        worker.onmessage = (event: MessageEvent<BakeReply>) => this.receive(event.data);
        worker.onerror = (event) => {
          event.preventDefault();
          this.giveUpOnWorkers(event.message || 'the bake worker failed to load');
        };
        const hello: BakeRequest = { kind: 'catalogue', modules: [...catalogue.values()] };
        worker.postMessage(hello);
        this.workers.push(worker);
      }
    } catch (error) {
      this.giveUpOnWorkers(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * The bake for a grid, or undefined while it is still in the oven. Asking
   * again is free; the first ask starts the bake.
   */
  get(blueprint: Blueprint): HullBake | undefined {
    const key = bakeKey(blueprint);
    const ready = this.done.get(key);
    if (ready) {
      // Most recently used last, so the oldest is the one let go.
      this.done.delete(key);
      this.done.set(key, ready);
      return ready;
    }
    if (this.failed.has(key) || this.asked.has(key)) return undefined;
    this.asked.add(key);
    if (this.fallback) {
      this.bakeHere(key, blueprint);
      return this.done.get(key);
    }
    const id = this.nextId++;
    this.waiting.set(id, { key, blueprint });
    const request: BakeRequest = { kind: 'bake', id, blueprint };
    this.workers[this.turn++ % this.workers.length]!.postMessage(request);
    return undefined;
  }

  /** Start baking these now, so they are ready before they are needed. */
  prepare(blueprints: Iterable<Blueprint>): void {
    for (const blueprint of blueprints) this.get(blueprint);
  }

  /** Why a grid could not be baked, if it could not. */
  failure(blueprint: Blueprint): string | undefined {
    return this.failed.get(bakeKey(blueprint));
  }

  private receive(reply: BakeReply): void {
    const pending = this.waiting.get(reply.id);
    if (!pending) return;
    this.waiting.delete(reply.id);
    if (reply.kind === 'baked') this.keep(pending.key, reply.bake);
    else {
      this.failed.set(pending.key, reply.reason);
      console.error(`hull bake failed for ${pending.blueprint.id}: ${reply.reason}`);
    }
  }

  private keep(key: string, bake: HullBake): void {
    this.done.set(key, bake);
    while (this.done.size > KEEP) {
      const oldest = this.done.keys().next().value;
      if (oldest === undefined) break;
      this.done.delete(oldest);
      this.asked.delete(oldest);
    }
  }

  private bakeHere(key: string, blueprint: Blueprint): void {
    try {
      this.keep(key, bakeHull(blueprint, this.catalogue));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.failed.set(key, reason);
      console.error(`hull bake failed for ${blueprint.id}: ${reason}`);
    }
  }

  private giveUpOnWorkers(reason: string): void {
    if (this.fallback) return;
    this.fallback = true;
    console.warn(`hull bakery: no worker (${reason}); baking on the main thread`);
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
    // Whatever was in the oven is baked here instead.
    const stranded = [...this.waiting.values()];
    this.waiting.clear();
    for (const pending of stranded) this.bakeHere(pending.key, pending.blueprint);
  }
}

let shared: Bakery | undefined;

/** The page's bakery, made on first use. */
export function hullBakery(catalogue: ReadonlyMap<string, ModuleDef>): Bakery {
  shared ??= new Bakery(catalogue);
  return shared;
}
