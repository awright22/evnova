/**
 * Hunter: mark one named hull and shoot it until it is a wreck.
 *
 * The capture harness needs a write-off it can rely on. Waiting for a patrol
 * to answer for a posted captain works and takes anywhere from twenty
 * seconds to never, because a patrol is on its own schedule and the sky it
 * is crossing is wide. This brain is the gunner the loss harness already
 * uses, in a bot: it picks its mark by callsign, closes, and fires.
 *
 * It is not a shortcut around anything. The marking goes through the same
 * intent a captain uses, the trigger is the same input bit, and the server
 * decides what the rounds do. Its mark is a captain the Prize Court has
 * already posted, so there is nothing unlawful about the shot either.
 */

import { isAimedAt, turnToward } from '@marque/shared';
import type { BotBrain, BotView } from '../bot.ts';
import type { ShipInput } from '@marque/shared';

/**
 * Where to stand off, and where to break off.
 *
 * Well inside a gun's 1,300-unit reach and well outside the mark's. The
 * first version closed to 260, which against a hull that still has a gun
 * means trading shots at point-blank with something that has nothing to
 * lose — and the gunner lost, quietly, thirty seconds into a two-minute
 * wait, which from the capture's side looked like a write-off that simply
 * never happened.
 */
const STAND_OFF = 900;

/** Closer than this and it brakes rather than running the mark down. */
const BREAK_OFF = 700;

export function hunterBrain(callsign: string): BotBrain {
  let markId = '';
  /** Step of the last line said, so this is a note and not a stream. */
  let saidAt = -Infinity;

  return {
    name: 'hunter',

    decide(view: BotView, cmd: ShipInput): void {
      const { self, profile } = view;

      // A gunner that cannot find its mark is the reason a capture of a
      // write-off fails, and it is invisible from the page's side. Say so
      // every few seconds: the harness keeps this log and prints it when
      // the screen does not come out.
      if (view.step - saidAt > 300) {
        saidAt = view.step;
        const mark = view.ships.get(markId);
        const range = mark
          ? Math.round(Math.hypot(mark.x - self.x, mark.y - self.y))
          : -1;
        const hp = mark ? [...mark.moduleHp].reduce((sum, v) => sum + v, 0) : -1;
        console.log(
          `hunter: in ${view.systemId} after "${callsign}": `
            + (mark ? `range ${range}, their structure ${hp}` : 'not in this sky')
            + `; ${view.ships.size} hull(s) up`,
        );
      }

      // Find the mark by name each time it is lost: a captain who was
      // written off and set down again comes back under a new session id,
      // and the one being hunted here is the one in the paperwork.
      const held = view.ships.get(markId);
      if (!held || held.destroyedAt > 0 || held.callsign !== callsign) {
        markId = '';
        view.ships.forEach((ship, id) => {
          if (markId !== '' || id === view.sessionId) return;
          if (ship.callsign === callsign && ship.destroyedAt === 0) markId = id;
        });
        if (markId !== '') view.mark(markId);
      }

      const mark = view.ships.get(markId);
      if (!mark) {
        // Not in this system yet. Hold station rather than wander off: the
        // hull being waited for is about to be here.
        cmd.turn = 0;
        cmd.thrust = 0;
        cmd.brake = true;
        cmd.firePrimary = false;
        cmd.fireSecondary = false;
        return;
      }

      const dx = mark.x - self.x;
      const dy = mark.y - self.y;
      const range = Math.hypot(dx, dy);
      const bearing = Math.atan2(dy, dx);

      cmd.turn = turnToward(self, bearing, profile);
      cmd.thrust = range > STAND_OFF && isAimedAt(self, bearing, 0.7) ? 1 : 0;
      cmd.brake = range < BREAK_OFF;
      // Inside reach and pointed at it. The trigger stays down: a mount
      // that is out of arc simply does not fire.
      cmd.firePrimary = range < 1250;
      cmd.fireSecondary = isAimedAt(self, bearing, 0.3) && range < 2400;
    },
  };
}
