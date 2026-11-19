/**
 * Circle: hold a constant turn and thrust.
 *
 * The most demanding steady-state case for prediction, because every single
 * step changes both heading and velocity. If reconciliation is going to drift,
 * it shows up here first, which makes this the brain the netcode check uses.
 */

import type { BotBrain, BotView } from '../bot.ts';
import type { ShipInput } from '@marque/shared';

export function circleBrain(direction: -1 | 1 = 1): BotBrain {
  return {
    name: 'circle',
    decide(_view: BotView, cmd: ShipInput): void {
      cmd.turn = direction;
      cmd.thrust = 1;
      cmd.brake = false;
    },
  };
}
