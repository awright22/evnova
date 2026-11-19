/**
 * Wander: fly between random points in the system, stopping at each.
 *
 * Exercises the whole flight envelope — turning, burning, braking and coasting
 * — which makes it the right load for netcode testing. Targets come from a
 * seeded generator so a soak run reproduces exactly.
 */

import { Rng, seekPoint } from '@marque/shared';
import type { BotBrain, BotView } from '../bot.ts';
import type { ShipInput } from '@marque/shared';

export interface WanderOptions {
  readonly seed: string;
  /** Radius of the area to wander within, in world units. */
  readonly radius?: number;
}

export function wanderBrain(options: WanderOptions): BotBrain {
  const rng = new Rng(options.seed);
  const radius = options.radius ?? 2500;

  let targetX = 0;
  let targetY = 0;
  let hasTarget = false;
  let holdUntilStep = 0;

  const pickTarget = (): void => {
    const bearing = rng.range(-Math.PI, Math.PI);
    const distance = radius * Math.sqrt(rng.next());
    targetX = Math.cos(bearing) * distance;
    targetY = Math.sin(bearing) * distance;
    hasTarget = true;
  };

  return {
    name: 'wander',
    decide(view: BotView, cmd: ShipInput): void {
      if (!hasTarget) pickTarget();

      const { self, profile } = view;
      const distance = Math.hypot(targetX - self.x, targetY - self.y);
      const speed = Math.hypot(self.vx, self.vy);

      // Arrived and settled: pause briefly, then pick somewhere new.
      if (distance <= 60 && speed < 2) {
        if (holdUntilStep === 0) holdUntilStep = view.step + rng.int(15, 60);
        if (view.step >= holdUntilStep) {
          holdUntilStep = 0;
          pickTarget();
        }
        cmd.turn = 0;
        cmd.thrust = 0;
        cmd.brake = false;
        return;
      }

      const intent = seekPoint(self, targetX, targetY, profile);
      cmd.turn = intent.turn;
      cmd.thrust = intent.thrust;
      cmd.brake = intent.brake;
    },
  };
}
