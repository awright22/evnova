/**
 * Fighter: mark the nearest hull, close on it, and shoot.
 *
 * The load the combat budget is measured against. It marks through the same
 * intent a captain uses and fires through the same input bits, so the server
 * sees nothing it would not see from a browser.
 */

import { Rng, isAimedAt, seekPoint, turnToward } from '@marque/shared';
import type { BotBrain, BotView } from '../bot.ts';
import type { ShipInput } from '@marque/shared';

/** Distance to close to before opening fire. */
const ENGAGE_RANGE = 900;

/** Closer than this and the bot breaks off rather than ramming. */
const BREAK_OFF = 240;

export function fighterBrain(seed: string): BotBrain {
  const rng = new Rng(`fighter:${seed}`);
  let markId = '';
  let reconsiderAt = 0;
  let wanderX = 0;
  let wanderY = 0;

  return {
    name: 'fighter',

    decide(view: BotView, cmd: ShipInput): void {
      const { self, profile } = view;

      // Re-pick a mark periodically: the nearest hull that is not this one.
      const current = view.ships.get(markId);
      if (!current || current.destroyedAt > 0 || view.step >= reconsiderAt) {
        let best = '';
        let bestDistance = Infinity;
        view.ships.forEach((ship, id) => {
          if (id === view.sessionId || ship.destroyedAt > 0) return;
          const distance = Math.hypot(ship.x - self.x, ship.y - self.y);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = id;
          }
        });
        if (best !== markId) {
          markId = best;
          view.mark(markId);
        }
        reconsiderAt = view.step + rng.int(90, 240);
      }

      const mark = view.ships.get(markId);
      if (!mark) {
        // Nothing to fight: keep moving so the system is not static.
        if (wanderX === 0 && wanderY === 0) {
          const bearing = rng.range(-Math.PI, Math.PI);
          const distance = 2500 * Math.sqrt(rng.next());
          wanderX = Math.cos(bearing) * distance;
          wanderY = Math.sin(bearing) * distance;
        }
        const intent = seekPoint(self, wanderX, wanderY, profile);
        cmd.turn = intent.turn;
        cmd.thrust = intent.thrust;
        cmd.brake = intent.brake;
        return;
      }

      const dx = mark.x - self.x;
      const dy = mark.y - self.y;
      const range = Math.hypot(dx, dy);
      const bearing = Math.atan2(dy, dx);

      cmd.turn = turnToward(self, bearing, profile);
      cmd.thrust = range > ENGAGE_RANGE && isAimedAt(self, bearing, 0.7) ? 1 : 0;
      cmd.brake = range < BREAK_OFF;
      cmd.firePrimary = isAimedAt(self, bearing, 0.25) && range < ENGAGE_RANGE * 1.3;
      cmd.fireSecondary = isAimedAt(self, bearing, 0.3) && range < ENGAGE_RANGE * 2;
    },
  };
}
