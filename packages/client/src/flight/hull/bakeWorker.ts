/**
 * The bakery's worker: bakes hulls off the main thread.
 *
 * A bake is a few hundred milliseconds of arithmetic over half a million
 * pixels, and the flight view meets a new draught whenever one jumps in. Done
 * on the main thread that is a dropped quarter-second; done here it is a hull
 * that appears a moment after its contact does.
 */

import type { Blueprint, ModuleDef } from '@marque/shared';

import { bakeHull, type HullBake } from './bake.ts';

export type BakeRequest =
  | { readonly kind: 'catalogue'; readonly modules: readonly ModuleDef[] }
  | { readonly kind: 'bake'; readonly id: number; readonly blueprint: Blueprint };

export type BakeReply =
  | { readonly kind: 'baked'; readonly id: number; readonly bake: HullBake }
  | { readonly kind: 'failed'; readonly id: number; readonly reason: string };

/** The worker's own scope, typed narrowly: the client compiles against the DOM library. */
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<BakeRequest>) => void) | null;
  postMessage(message: BakeReply, transfer?: Transferable[]): void;
};

let catalogue: Map<string, ModuleDef> | undefined;

scope.onmessage = (event) => {
  const request = event.data;
  if (request.kind === 'catalogue') {
    catalogue = new Map(request.modules.map((module) => [module.id, module]));
    return;
  }
  if (!catalogue) {
    scope.postMessage({ kind: 'failed', id: request.id, reason: 'the bakery was asked to bake before it had a catalogue' });
    return;
  }
  try {
    const bake = bakeHull(request.blueprint, catalogue);
    scope.postMessage({ kind: 'baked', id: request.id, bake }, [bake.base.buffer, bake.shape.buffer, bake.paint.buffer]);
  } catch (error) {
    scope.postMessage({ kind: 'failed', id: request.id, reason: error instanceof Error ? error.message : String(error) });
  }
};
