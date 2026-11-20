/**
 * The screens to capture.
 *
 * One entry per screen or state. A screen with a designed failure state gets an
 * entry for each, because those are exactly the states that rot unnoticed.
 */

import type { Page } from 'playwright';

import type { SeedSpec } from '@marque/harness/seed';

export interface Screen {
  readonly name: string;
  readonly description: string;
  /** Path appended to the client's base URL. */
  readonly path?: string;
  /**
   * A captain written into the world before the server starts, for a screen
   * that only exists once something has already happened. The capture joins
   * as them instead of opening a new account. See `seed.ts`.
   */
  readonly seed?: SeedSpec;
  /**
   * Other captains, seeded and brought online in pages of their own.
   *
   * Some screens are about two captains in the same room — an offer needs
   * somebody to offer to — and one browser page can only ever be one of
   * them. These are opened first, driven by their own `act`, and held open
   * while the screen is captured.
   */
  readonly companions?: readonly {
    readonly seed: SeedSpec;
    readonly act?: (page: Page) => Promise<void>;
  }[];
  /** Prepare the page before it loads, e.g. block the server to force a state. */
  readonly setup?: (page: Page) => Promise<void>;
  /** Wait for this selector before capturing. */
  readonly settle?: string;
  /**
   * How long to wait for it. Twenty seconds unless a screen says otherwise.
   *
   * A screen that spawns a gunner first has already spent four seconds of
   * the run before its page is opened, and under software rasterisation a
   * cold renderer can take another ten to put a HUD up. The write-off
   * capture kept failing on the settle rather than on the thing it is
   * about, which read as "the write-off never happened".
   */
  readonly settleTimeoutMs?: number;
  /** Extra settle time in ms, for animations that have no end selector. */
  readonly settleMs?: number;
  /** Drive the page before capturing: hold keys, wait, fly somewhere. */
  readonly act?: (page: Page) => Promise<void>;
  /** Bot traffic to fly in the same system during this capture. */
  readonly bots?: number;
  /**
   * A gunner flown only for this capture, which hunts one callsign.
   *
   * For the one screen that needs a hull to actually be lost. The traffic
   * bots wander; a patrol answers for a posted captain on its own schedule
   * and took longer than any timeout worth having. This is spawned when the
   * screen starts and stopped when it finishes, so nothing else in the run
   * is being shot at.
   */
  readonly gunner?: { readonly hunt: string; readonly system: string; readonly draught: string };
  /**
   * Leave the provisional ticket and the hints alone.
   *
   * Every other capture is taken as an experienced captain: the ticket is
   * confirmed and every hint settled, so a screen is photographed without a
   * note sitting over it. The two screens that are about the notes set this.
   */
  readonly teaching?: boolean;
  /**
   * A screen that is known not to capture here, and why.
   *
   * It is still attempted and still reported, and it does not fail the run.
   * A capture harness whose exit code is red for a known reason is a
   * harness nobody reads, and the point of the run is to catch what is
   * newly broken.
   */
  readonly knownMiss?: string;
  /**
   * Capture a run of frames instead of one still.
   *
   * For motion a still cannot judge — the stamp is 260ms end to end, and a
   * photograph of it says nothing about whether it lands. Written as
   * `name-01.png` and so on. A screenshot itself takes a little time under
   * software rasterisation, so the spacing is a floor rather than a
   * metronome; what matters is that the whole sequence is covered.
   */
  readonly frames?: { readonly count: number; readonly everyMs: number };
}

/**
 * What the client publishes on `window` when opened with `?harness=1`: enough
 * of the room for a capture to fly the ship. Described here rather than
 * imported because this file is typechecked for Node, and the code that uses
 * it runs in the page.
 */
interface HarnessWindow {
  __marqueHarness?: {
    room: {
      sessionId: string;
      state: {
        systemId: string;
        ships: Map<
          string,
          {
            x: number;
            y: number;
            angle: number;
            shield: number;
            destroyedAt: number;
            callsign: string;
            patrol: boolean;
            moduleHp: readonly number[];
          }
        >;
        asteroids: Map<string, { x: number; y: number; radius: number; left: number }>;
      };
    };
  };
}

/** Hold a key for a while, so the capture catches the ship actually moving. */
async function hold(page: Page, key: string, ms: number): Promise<void> {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

/**
 * Fly onto the mark and shoot it, the way a captain would.
 *
 * A fixed gun fires along the hull's facing, so a capture that holds the
 * trigger without steering lands nothing. This reads the ship's heading and
 * the mark's bearing through the `?harness=1` seam and taps the turn keys
 * until they agree, then fires. Nothing here reaches past the client: it is
 * the same information the screen shows, read instead of looked at.
 *
 * Returns false when there is nothing to shoot at.
 */
/**
 * Fly out to the nearest rock and cut into it.
 *
 * A belt is thousands of units off the berths — that is the point of it — so
 * a capture of one is a flight rather than a pose. Burns toward the rock,
 * brakes into the last stretch, then holds the trigger: a rig has no mark
 * and no cooldown, it just has to be pointed at rock.
 */
async function flyToRock(page: Page, seconds: number): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;

  /** Where the nearest rock is, relative to the nose, and how far. */
  const read = (): Promise<{ delta: number; range: number; radius: number } | null> =>
    page.evaluate(() => {
      const harness = (globalThis as unknown as HarnessWindow).__marqueHarness;
      const room = harness?.room;
      if (!room) return null;
      const self = room.state.ships.get(room.sessionId);
      if (!self) return null;

      let nearest: { range: number; bearing: number; radius: number } | undefined;
      for (const [, rock] of room.state.asteroids) {
        if (rock.left <= 0) continue;
        const range = Math.hypot(rock.x - self.x, rock.y - self.y);
        if (!nearest || range < nearest.range) {
          nearest = {
            range,
            bearing: Math.atan2(rock.y - self.y, rock.x - self.x),
            radius: rock.radius,
          };
        }
      }
      if (!nearest) return null;

      let delta = nearest.bearing - self.angle;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      return { delta, range: nearest.range, radius: nearest.radius };
    });

  // The belt arrives with the rest of the room's state, which is a moment
  // after the hull does. Giving up on the first empty read is how this
  // photographed a captain sitting at the berth they started at.
  for (let tries = 0; tries < 40; tries += 1) {
    if (await read()) break;
    await page.waitForTimeout(250);
  }
  if (!(await read())) return false;

  while (Date.now() < deadline) {
    const aim = await read();
    if (!aim) break;

    // Come round onto it first, then burn, then brake into the last stretch.
    if (Math.abs(aim.delta) > 0.12) {
      const key = aim.delta > 0 ? 'ArrowRight' : 'ArrowLeft';
      await page.keyboard.down(key);
      await page.waitForTimeout(Math.min(240, Math.abs(aim.delta) * 400));
      await page.keyboard.up(key);
      continue;
    }

    const close = aim.range < aim.radius + 160;
    if (close) {
      // Alongside it: stop, point at it, and cut.
      await page.keyboard.down('ArrowDown');
      await page.waitForTimeout(900);
      await page.keyboard.up('ArrowDown');
      await page.keyboard.down('Space');
      await page.waitForTimeout(1800);
      return true;
    }

    await page.keyboard.down('ArrowUp');
    await page.waitForTimeout(aim.range > aim.radius + 2500 ? 1400 : 400);
    await page.keyboard.up('ArrowUp');
  }

  return false;
}

async function engageNearest(
  page: Page,
  seconds: number,
  options: {
    readonly untilHit?: boolean;
    readonly patrolsOnly?: boolean;
    /**
     * One hull, by callsign, and nothing else.
     *
     * Without it the mark is whatever is nearest *this instant*, so a
     * gunner with traffic around it re-aims every pass and sprays four
     * hundred rounds across five hulls instead of putting eight hundred
     * damage through one. A Force Majeure is written off by about seven
     * seconds of a Short Measure's fire; four minutes of not quite hitting
     * anything is what this was doing instead.
     */
    readonly mark?: string;
  } = {},
): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;

  /** Where the nearest hull is, relative to the nose, and how it is holding up. */
  const read = (): Promise<{ delta: number; range: number; markShield: number } | null> =>
    page.evaluate(([patrolsOnly, wanted]: [boolean, string]) => {
      // This runs in the page, not in Node, so the browser globals are named
      // through globalThis rather than typed from the DOM lib.
      const harness = (globalThis as unknown as HarnessWindow).__marqueHarness;
      const room = harness?.room;
      if (!room) return null;
      const self = room.state.ships.get(room.sessionId);
      if (!self) return null;

      let nearest: { range: number; bearing: number; shield: number } | undefined;
      for (const [id, ship] of room.state.ships) {
        if (id === room.sessionId || ship.destroyedAt > 0) continue;
        // A patrol holds station, so it will not come looking. Firing on one
        // brings it, and brings the rest of them.
        if (patrolsOnly && !ship.patrol) continue;
        if (wanted !== '' && ship.callsign !== wanted) continue;
        const range = Math.hypot(ship.x - self.x, ship.y - self.y);
        if (!nearest || range < nearest.range) {
          nearest = {
            range,
            bearing: Math.atan2(ship.y - self.y, ship.x - self.x),
            shield: ship.shield,
          };
        }
      }
      if (!nearest) return null;

      let delta = nearest.bearing - self.angle;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      return { delta, range: nearest.range, markShield: nearest.shield };
    }, [options.patrolsOnly === true, options.mark ?? ''] as [boolean, string]);

  // A named mark may not be in the sky yet, and asking once is not asking.
  //
  // Companions are brought up *before* the page a screen is about, so a
  // gunner told to hold one callsign asked for it, read nothing, and
  // returned without firing a round. Run nineteen is what that looks like
  // from outside: 717 structure down to 448 and then flat for a minute, the
  // 269 being patrols answering the victim's own fire and the gunner never
  // having started. Same fault as `harness=1`: a gunner that does nothing
  // and says nothing.
  let first = await read();
  while (!first && Date.now() < deadline) {
    await page.waitForTimeout(500);
    first = await read();
  }
  if (!first) {
    const which = options.mark !== undefined && options.mark !== ''
      ? `a mark called ${options.mark}`
      : options.patrolsOnly === true ? 'a patrol' : 'anything to fire on';
    console.log(`    gunner waited ${seconds}s and never saw ${which}`);
    return false;
  }
  const shieldAtStart = first.markShield;

  // The trigger stays down for the whole engagement, so every pass through
  // the bearing puts rounds on the mark. Holding a key and watching the world
  // is what a captain does; tapping between round trips to the browser is not
  // fast enough to fly with.
  await page.keyboard.down('Space');

  try {
    while (Date.now() < deadline) {
      const aim = await read();
      if (!aim) break;

      // How wide the mark is from here. Close in, almost any facing hits, and
      // holding out for a tight bearing just saws the nose back and forth.
      const tolerance = Math.min(
        MAX_AIM_TOLERANCE,
        Math.max(AIM_TOLERANCE, Math.atan2(HULL_HALF_WIDTH, Math.max(1, aim.range))),
      );

      if (Math.abs(aim.delta) > tolerance) {
        // Hold the turn until the nose comes round, releasing a little early
        // so the hull's remaining spin carries it the rest of the way.
        const key = aim.delta > 0 ? 'ArrowRight' : 'ArrowLeft';
        const wanted = Math.sign(aim.delta);
        const release = Math.max(AIM_RELEASE, tolerance);
        await page.keyboard.down(key);
        const turnUntil = Date.now() + 3000;
        while (Date.now() < turnUntil) {
          const now = await read();
          if (!now) break;
          if (Math.sign(now.delta) !== wanted || Math.abs(now.delta) < release) break;
        }
        await page.keyboard.up(key);
        continue;
      }

      if (aim.range > GUN_REACH) {
        await page.keyboard.down('ArrowUp');
        const closeUntil = Date.now() + 2500;
        while (Date.now() < closeUntil) {
          const now = await read();
          if (!now) break;
          if (now.range <= STANDOFF || Math.abs(now.delta) > tolerance * 3) break;
        }
        await page.keyboard.up('ArrowUp');
        // Stop the closing speed, so the capture fights rather than rams.
        if (aim.range < GUN_REACH) await hold(page, 'ArrowDown', 700);
        continue;
      }

      // On the mark and in range: let the guns work.
      await page.waitForTimeout(400);

      // Stop once rounds are actually landing, leaving the trigger down and
      // the hull on the mark. A capture taken here shows a fight in progress
      // rather than its aftermath from across the system.
      const now = await read();
      if (options.untilHit && now && now.markShield < shieldAtStart - 1) return true;
    }
  } finally {
    if (!options.untilHit) await page.keyboard.up('Space');
  }

  return true;
}

/** How close to the bearing counts as on the mark, at the edge of reach. */
const AIM_TOLERANCE = 0.12;

/** And the widest it ever opens up to, close in. */
const MAX_AIM_TOLERANCE = 0.5;

/** Roughly half a hull across, in world units, for that widening. */
const HULL_HALF_WIDTH = 40;

/** Close to here and no closer: the capture is fighting, not ramming. */
const STANDOFF = 420;

/**
 * And when to let go of the turn. Wider than the tolerance because the hull
 * keeps rotating after the key is up: releasing exactly on the bearing
 * overshoots it every time.
 */
const AIM_RELEASE = 0.4;

/** Inside this the starter's gun reaches, with room for the mark to move. */
const GUN_REACH = 850;

export const SCREENS: readonly Screen[] = [
  {
    name: 'flight-at-rest',
    description: 'The flight view on arrival: backdrop, star, the hull and the HUD at rest.',
    path: '/?callsign=Prudent%20Return',
    settle: '.hud',
    settleMs: 1200,
    bots: 3,
  },
  {
    name: 'flight-under-burn',
    description: 'Under full burn: plume extended, camera led and zoomed out, speed up.',
    path: '/?callsign=Full%20Burn',
    settle: '.hud',
    settleMs: 400,
    bots: 3,
    act: async (page) => {
      await hold(page, 'ArrowUp', 2600);
      await page.keyboard.down('ArrowUp');
      await page.waitForTimeout(250);
    },
  },
  {
    name: 'flight-turning',
    description: 'Burning into a turn, which is the hardest case for prediction.',
    path: '/?callsign=Hard%20Over',
    settle: '.hud',
    settleMs: 400,
    bots: 3,
    act: async (page) => {
      await page.keyboard.down('ArrowUp');
      await page.waitForTimeout(1400);
      await page.keyboard.down('ArrowRight');
      await page.waitForTimeout(900);
    },
  },
  {
    name: 'draught-force-majeure',
    description: 'Force Majeure under burn: two engines, four thrusters, no hold.',
    path: '/?draught=force-majeure&callsign=Force%20Majeure',
    settle: '.hud',
    settleMs: 400,
    bots: 3,
    act: async (page) => {
      await page.keyboard.down('ArrowUp');
      await page.waitForTimeout(2200);
    },
  },
  {
    name: 'draught-fair-wear-and-tear',
    description: 'Fair Wear and Tear under burn: five bays, one large engine, visibly slower to answer.',
    path: '/?draught=fair-wear-and-tear&callsign=Fair%20Wear',
    settle: '.hud',
    settleMs: 400,
    bots: 3,
    act: async (page) => {
      await page.keyboard.down('ArrowUp');
      await page.waitForTimeout(2200);
    },
  },
  {
    name: 'combat',
    description:
      'A fight: rounds in flight, the mark bracketed and its panel up. The capture ' +
      'stops the moment a round lands, so this is the exchange rather than its ' +
      'aftermath. Under software rasterisation the link runs about a second, which ' +
      'is why it reads as a long-range exchange rather than a close pass.',
    path: '/?callsign=Free%20Captain&harness=1',
    settle: '.hud',
    settleMs: 2500,
    bots: 2,
    act: async (page) => {
      // Mark the nearest hull and actually fight it, so the capture catches
      // rounds in flight and shields rippling rather than an empty sky.
      await page.keyboard.press('Tab');
      await page.waitForTimeout(300);
      // Leaves the trigger down on the mark, so the capture is mid-fight.
      await engageNearest(page, 45, { untilHit: true });
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'beams',
    description:
      'The Close Order holding two cutting beams on a mark: the core, the soft '
      + 'surround, and the brighter termination where they land.',
    path: '/?callsign=Close%20Order&harness=1',
    settle: '.hud',
    settleMs: 2500,
    bots: 2,
    // Seeded rather than asked for with `?draught=`: the Close Order needs a
    // Frigate Warrant, and a captain who has just walked in holds an Open
    // Ticket. The hull is put under them the way the Moorings would.
    seed: {
      callsign: 'Close Order',
      // Respondentia, which is contested: Sato's Error is the Marque and
      // four Unlettered wrote this hull off before it got a beam on any of
      // them, which made a fine capture of the claim screen and none at all
      // of what this one is for.
      at: 'respondentia',
      flying: 'close-order',
    },
    act: async (page) => {
      await page.waitForSelector('.hud', { timeout: 20_000 });
      await page.keyboard.press('Tab');
      await page.waitForTimeout(300);
      // A beam is held rather than fired, so the capture has to be taken
      // while the trigger is still down — which is what `untilHit` leaves.
      // Long enough to close: a beam reaches nine hundred units and a mark
      // picked at three thousand is a capture of two lines going off the
      // side of the screen at nothing.
      await engageNearest(page, 55, { untilHit: true });
      await page.waitForTimeout(200);
    },
  },
  {
    name: 'written-off',
    description:
      'The claim screen: what the Hall settled, what went with the hull, and where '
      + 'the captain is being set down. The figures are the ones the server paid, not '
      + "the client's own reckoning of what the draught was worth.",
    path: '/?callsign=Act%20of%20God&harness=1',
    settle: '.hud',
    settleTimeoutMs: 60_000,
    settleMs: 1500,
    bots: 2,
    knownMiss:
      'it needs a captain to actually be lost. Twelve runs: a patrol holds '
      + 'station and never comes looking; a bot gunner is in the room and '
      + 'never finds its mark; a companion browser is in the sky and does '
      + 'not finish the job inside four minutes. The panel itself is '
      + 'verified by `pnpm verify:loss`. See docs/polish/cycle-1.md, M5.',
    // A gunner of its own, and a mark that cannot run.
    //
    // Eleven runs to get here. A patrol hunts a posted captain by rule but
    // holds station, so it never came looking. A bot hunter found its mark
    // and then kept dying, because a lawful captain who fired on a posted
    // one used to be posted in turn and hunted by the patrols that were
    // supposed to be after the first — which is a game fault this cycle
    // fixed, not a harness one. With that fixed and the mark's engines
    // gone, the gunner is a bot flying the same protocol a browser does,
    // firing on a captain the Prize Court has already posted.
    //
    // The gunner is a companion *browser*, not a bot. A bot hunter was
    // tried for six runs and never once saw its mark: the page reported
    // itself in parity with five hulls around it and the bot reported
    // parity with five hulls and no mark among them, which is two rooms
    // for one system and a thread this cycle has not pulled. A companion
    // page joins the way the victim joins, so if the two are ever in
    // different rooms, that is a fault worth seeing rather than one to
    // work around.
    companions: [
      {
        seed: {
          callsign: 'Strict Liability',
          at: 'the-bourse',
          flying: 'short-measure',
          marks: 50_000,
        },
        act: async (page) => {
          // Two minutes. This is the first browser page of the run, opened
          // straight after a client build, a server start, a preview and
          // two bots — and a cold Chromium putting up a Pixi scene under
          // software rasterisation on a loaded box has taken longer than a
          // minute more than once.
          await page.waitForSelector('.hud', { timeout: 120_000 });
          await page.waitForTimeout(2000);
          await page.focus('body');
          await page.keyboard.press('Tab');
          await page.waitForTimeout(300);
          // Started and not awaited: the capture has to get on and open
          // its own page, and this drives the gunner alongside it for as
          // long as the screen takes.
          void engageNearest(page, 300, { mark: 'Act of God' }).catch(() => undefined);
        },
      },
    ],
    //
    // A fragile gunboat with a hold worth dropping, in the Home Roads, with
    // a berth at the far side of the system behind it — so the panel's last
    // line is about somewhere the captain is not.
    seed: {
      callsign: 'Act of God',
      at: 'the-bourse',
      flying: 'force-majeure',
      lastBerth: 'underwriters-hall',
      cargo: { ice: 14 },
      // Already posted, so the patrols answer for them from the first
      // instant. Earning it by shooting something first worked alone and
      // not in a full run, where the traffic has moved on by the time this
      // screen comes round.
      composition: 4000,
      // Engines gone, so the hull cannot run from what the Court sends.
      // It still has its gun, and the capture fires it: a photograph of a
      // captain sitting still while they are shot to pieces is a
      // photograph of the wrong thing.
      crippled: true,
    },
    act: async (page) => {
      await page.waitForSelector('.hud', { timeout: 60_000 });
      // The gunner has to be in the sky before there is anything to lose to.
      await page.waitForFunction(
        () => {
          const harness = (globalThis as unknown as HarnessWindow).__marqueHarness;
          return (harness?.room?.state.ships.size ?? 0) > 1;
        },
        undefined,
        { timeout: 60_000 },
      );
      // Which room this page is actually in, and who is in it with them.
      // The gunner reports the same from its side, and for three runs the
      // two lists did not overlap.
      const sky = await page.evaluate(() => {
        const harness = (globalThis as unknown as HarnessWindow).__marqueHarness;
        if (!harness) return 'no harness';
        const names = [...harness.room.state.ships.values()]
          .map((ship) => (ship as { callsign?: string }).callsign ?? '?')
          .join(', ');
        return `${harness.room.state.systemId}: ${names}`;
      });
      console.log(`    page is in ${String(sky)}`);

      // Nothing to do but be answered for. The hull carries a gun and fires
      // it, because a capture of a captain sitting still while they are shot
      // to pieces is a capture of the wrong thing; this is not a fight it is
      // going to win.
      await page.keyboard.press('Tab');
      await page.waitForTimeout(300);
      // At a patrol, not at whatever is nearest. A patrol holds station and
      // will not come looking for a posted captain across a system; fire on
      // one and it answers, and so does every other one in the sky. Four
      // minutes of waiting for a patrol to wander past taught this.
      await engageNearest(page, 40, { patrolsOnly: true });

      // Watch this hull's own structure while it is being shot at. Fourteen
      // runs have ended with "the write-off never happened" and no way to
      // tell whether the gunner was missing, out of range, or the hull was
      // simply taking a very long time to die. This says which.
      const watch = (async () => {
        for (let i = 0; i < 24; i += 1) {
          await page.waitForTimeout(10_000);
          const mine = await page
            .evaluate(() => {
              const harness = (globalThis as unknown as HarnessWindow).__marqueHarness;
              const room = harness?.room;
              const self = room?.state.ships.get(room.sessionId);
              if (!self) return 'no hull in the sky';
              let hp = 0;
              for (const point of self.moduleHp) hp += point;
              return `structure ${hp}, shield ${Math.round(self.shield)}`;
            })
            .catch(() => 'unreadable');
          console.log(`    t+${(i + 1) * 10}s: ${String(mine)}`);
        }
      })();

      await page.waitForSelector('.flight__written-off', { timeout: 240_000 });
      void watch;
      // The panel goes up on the write-off and the Hall's figures arrive on
      // the next turn of the loop, so the capture waits for the file to be
      // read rather than photographing the sentence that says it is being.
      await page.waitForTimeout(900);
    },
  },
  {
    name: 'belt',
    description:
      "A belt in Lindqvist: rocks lit from the star, the worked ones smaller and "
      + 'duller than the whole ones, with a rig cutting into the nearest.',
    path: '/?callsign=Spoil%20Heap&harness=1',
    settle: '.hud',
    settleMs: 1200,
    seed: {
      callsign: 'Spoil Heap',
      atBelt: 'lindqvist',
      flying: 'spoil-heap',
    },
    act: async (page) => {
      // Set down beside a rock rather than flown out to one: the belt is
      // thousands of units off the berths, which is the point of it and
      // also four minutes of a capture run. The subject is the belt.
      //
      // Waiting on `.hud` rather than `.hud__travel`: the travel panel is
      // there when a berth is in reach or a course is plotted, and out in a
      // belt neither is true — which is how this came to wait twenty
      // seconds for a thing that was never going to appear.
      await page.waitForSelector('.hud', { timeout: 20_000 });
      await flyToRock(page, 40);
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'title',
    description:
      'The title: the name, the premise in a line, and the three doors. No art behind '
      + 'it — the flight view is the art, and a title screen competing with it would lose.',
    path: '/',
    settle: '.title__plate',
    settleMs: 400,
  },
  {
    name: 'settings',
    description:
      'Settings: the four volumes, the interface scale, motion, palette and effects, '
      + 'every key a captain presses, bindable, and what a gamepad does. Each takes '
      + 'effect as it is changed.',
    path: '/',
    settle: '.title__plate',
    settleMs: 300,
    act: async (page) => {
      await page.click('.title__doors button:text("Settings")');
      await page.waitForSelector('.shell__keys', { timeout: 20_000 });
      await page.waitForTimeout(400);
      // One cell listening, which is the whole of how a key is bound.
      await page.locator('.shell__key').first().click();
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'credits',
    description:
      'Credits, read from CREDITS.md itself at build time and set as a document, so the '
      + 'screen and the file cannot drift.',
    path: '/',
    settle: '.title__plate',
    settleMs: 300,
    act: async (page) => {
      await page.click('.title__doors button:text("Credits")');
      await page.waitForSelector('.credits__sheet', { timeout: 20_000 });
      await page.waitForTimeout(400);
    },
  },
  {
    name: 'ticket',
    description:
      'The provisional ticket, which is what a guided first session looks like here: '
      + "seven endorsements the Register's clerk adds as the captain does each thing "
      + 'once, one line at a time, bottom left and out of the instruments. Waivable.',
    path: '/?callsign=Open%20Ticket',
    settle: '.pilotage',
    settleMs: 600,
    teaching: true,
    bots: 2,
  },
  {
    name: 'hint',
    description:
      'A contextual hint, shown the first time a system is opened and never again: what '
      + 'the counter is for, and the one thing looking at it will not tell you.',
    path: '/?callsign=Noted%20Captain',
    settle: '.hud',
    settleMs: 900,
    teaching: true,
    act: async (page) => {
      await page.waitForSelector('.hud__travel', { timeout: 20_000 });
      await page.keyboard.press('KeyL');
      await page.waitForSelector('.port', { timeout: 20_000 });
      await page.click('.port__service-list button:text("Open the floor")');
      await page.waitForSelector('.hint', { timeout: 20_000 });
      await page.waitForTimeout(400);
    },
  },
  {
    name: 'register',
    description:
      'The Register: where a new captain is entered, and the one screen a player sees before flying.',
    // No callsign, so the real sign-up screen shows rather than being skipped.
    path: '/',
    settle: '.register',
    settleMs: 500,
  },
  {
    name: 'register-phrase',
    description: 'The recovery phrase, shown once. The only copy the captain gets.',
    path: '/',
    settle: '.register',
    settleMs: 400,
    act: async (page) => {
      await page.fill('.register input[name="callsign"]', 'Quiet Returns');
      await page.click('.register button[type="submit"]');
      await page.waitForSelector('.register__phrase', { timeout: 20_000 });
      await page.waitForTimeout(600);
    },
  },
  {
    name: 'chart',
    description: 'The chart of the Reach: lanes, reachable systems, the cost of a jump.',
    path: '/?callsign=Chart%20Reader',
    settle: '.hud',
    settleMs: 900,
    act: async (page) => {
      await page.keyboard.press('KeyM');
      await page.waitForSelector('.chart', { timeout: 20_000 });
      await page.waitForTimeout(700);
    },
  },
  {
    name: 'jump-spool',
    description: 'Spooling for a lane: the travel banner filling while the hull holds course.',
    path: '/?callsign=Lane%20Bound',
    settle: '.hud',
    settleMs: 900,
    bots: 2,
    act: async (page) => {
      await page.keyboard.press('KeyM');
      await page.waitForSelector('.chart', { timeout: 20_000 });
      await page.waitForTimeout(400);
      // Enter spools for the selected system and closes the chart.
      await page.keyboard.press('Enter');
      await page.waitForSelector('.hud__travel--spooling', { timeout: 20_000 });
      // Partway through the spool, so the bar reads as a wait with an end.
      await page.waitForTimeout(1800);
    },
  },
  {
    name: 'port-hub',
    description: 'Alongside: the berth\'s terminal, its services and what they cost.',
    path: '/?callsign=Alongside',
    settle: '.hud',
    settleMs: 900,
    act: async (page) => {
      await page.waitForSelector('.hud__travel', { timeout: 20_000 });
      await page.keyboard.press('KeyL');
      await page.waitForSelector('.port', { timeout: 20_000 });
      await page.waitForTimeout(800);
    },
  },
  {
    name: 'staple',
    description:
      "A berth's commodity market: what it charges, what it pays, what it is holding " +
      'against what it wants, and what the captain has aboard.',
    path: '/?callsign=Supercargo',
    settle: '.hud',
    settleMs: 900,
    act: async (page) => {
      await page.waitForSelector('.hud__travel', { timeout: 20_000 });
      await page.keyboard.press('KeyL');
      await page.waitForSelector('.port', { timeout: 20_000 });

      // Open the floor, buy something, and let the prices come back, so the
      // capture shows a market that has been traded in.
      await page.click('.port__service-list button:text("Open the floor")');
      await page.waitForSelector('.staple__table', { timeout: 20_000 });
      await page.waitForTimeout(400);
      await page.click('.staple__row:first-child .staple__order');
      await page.waitForTimeout(900);
    },
  },
  {
    name: 'yard',
    description:
      "The Yard's editor: the hull on the grid, what it weighs and how it will fly, " +
      'what is wrong with it, and what it comes to in marks and materials.',
    path: '/?callsign=Shipwright',
    settle: '.hud',
    settleMs: 900,
    act: async (page) => {
      await page.waitForSelector('.hud__travel', { timeout: 20_000 });
      await page.keyboard.press('KeyL');
      await page.waitForSelector('.port', { timeout: 20_000 });

      await page.click('.port__service-list button:text("Open the Yard")');
      await page.waitForSelector('.grid', { timeout: 20_000 });
      await page.waitForTimeout(500);

      // Pick a fitting and hold it over the grid, so the capture shows the
      // editor mid-edit rather than at rest.
      await page.click('.yard__fitting:has-text("Cargo")');
      await page.waitForTimeout(200);
      const grid = await page.locator('.grid').boundingBox();
      if (grid) {
        await page.mouse.move(grid.x + grid.width * 0.56, grid.y + grid.height * 0.45);
      }
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'yard-code',
    description:
      "A draught written out as a code: the share drawer open over the editor's board, "
      + 'with the code in a field made to be copied.',
    path: '/?callsign=Correspondent',
    settle: '.hud',
    settleMs: 900,
    act: async (page) => {
      await page.waitForSelector('.hud__travel', { timeout: 20_000 });
      await page.keyboard.press('KeyL');
      await page.waitForSelector('.port', { timeout: 20_000 });

      await page.click('.port__service-list button:text("Open the Yard")');
      await page.waitForSelector('.grid', { timeout: 20_000 });
      await page.click('.yard__tools button:text("Code")');
      await page.waitForSelector('.yard__code', { timeout: 20_000 });
      await page.waitForTimeout(400);
    },
  },
  {
    name: 'yard-everywhere',
    description:
      'The whole Register in the palette, with the fittings this berth cannot supply greyed '
      + 'out rather than hidden, so a captain can see what to go and find.',
    path: '/?callsign=Window%20Shopper',
    settle: '.hud',
    settleMs: 900,
    act: async (page) => {
      await page.waitForSelector('.hud__travel', { timeout: 20_000 });
      await page.keyboard.press('KeyL');
      await page.waitForSelector('.port', { timeout: 20_000 });

      await page.click('.port__service-list button:text("Open the Yard")');
      await page.waitForSelector('.grid', { timeout: 20_000 });
      await page.click('.yard__scope');
      await page.waitForSelector('.yard__fitting--elsewhere', { timeout: 20_000 });
      // Scrolled to where the greyed fittings actually are, so the capture
      // shows the gate rather than the top of a list that happens to be
      // entirely in stock.
      await page.locator('.yard__fitting--elsewhere').first().scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
    },
  },
  {
    name: 'moorings',
    description:
      'The Moorings: every hull the captain owns, where each lies, and which one they are in.',
    path: '/?callsign=Fleet%20Owner',
    settle: '.hud',
    settleMs: 900,
    act: async (page) => {
      await page.waitForSelector('.hud__travel', { timeout: 20_000 });
      await page.keyboard.press('KeyL');
      await page.waitForSelector('.port', { timeout: 20_000 });

      // Two hulls, so the register has something in it. A capture of the
      // empty state says nothing about whether the screen works.
      for (const hull of ['Bonded Runner', 'Short Measure']) {
        await page.click('.port__service-list button:text("Open the Yard")');
        await page.waitForSelector('.grid', { timeout: 20_000 });

        await page.fill('.yard__name', hull);
        await page.click('.yard__actions button:text("Build")');
        await page.waitForTimeout(900);
        await page.click('.yard__tools button:text("Close")');
        await page.waitForSelector('.port', { timeout: 20_000 });
      }

      await page.click('.port__service-list button:text("Walk the moorings")');
      await page.waitForSelector('.moorings__table', { timeout: 20_000 });
      await page.waitForTimeout(400);
    },
  },
  {
    name: 'bourse',
    description:
      'The Bourse: the ten listings, the company in hand with its chart and order ticket, '
      + "the captain's book, the Gazette and the Register.",
    path: '/?callsign=Subscriber',
    settle: '.hud',
    settleMs: 900,
    act: async (page) => {
      await page.waitForSelector('.hud__travel', { timeout: 20_000 });
      await page.keyboard.press('KeyL');
      await page.waitForSelector('.port', { timeout: 20_000 });

      await page.click('.port__service-list button:text("Open the Bourse")');
      await page.waitForSelector('.bourse', { timeout: 20_000 });
      // Long enough for the entry motion to have finished: a capture taken
      // mid-transition shows two states at once and reads as a layout fault.
      await page.waitForTimeout(2500);
    },
  },
  {
    name: 'bourse-ticket',
    description:
      'An order on the ticket: what the parcel costs, the average a share, the fee, and '
      + 'where the quote ends up — all before anything is confirmed.',
    path: '/?callsign=Buying%20In',
    settle: '.hud',
    settleMs: 900,
    act: async (page) => {
      await page.waitForSelector('.hud__travel', { timeout: 20_000 });
      await page.keyboard.press('KeyL');
      await page.waitForSelector('.port', { timeout: 20_000 });

      await page.click('.port__service-list button:text("Open the Bourse")');
      await page.waitForSelector('.bourse', { timeout: 20_000 });
      await page.waitForTimeout(400);

      // Put a real parcel in the ticket so the preview has figures in it.
      const field = page.locator('.bourse input[inputmode="numeric"]').first();
      await field.fill('500');
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'bourse-orders',
    description:
      'A standing order being left at a limit, with one already waiting below it and a '
      + 'position sold short carried against the captain. The margin line says what '
      + 'stands behind it and at what level the Bourse closes it out.',
    path: '/?callsign=Short%20Measure',
    settle: '.hud',
    settleMs: 900,
    act: async (page) => {
      await page.waitForSelector('.hud__travel', { timeout: 20_000 });
      await page.keyboard.press('KeyL');
      await page.waitForSelector('.port', { timeout: 20_000 });

      await page.click('.port__service-list button:text("Open the Bourse")');
      await page.waitForSelector('.bourse', { timeout: 20_000 });
      await page.waitForTimeout(400);

      // One order left to wait, so the table below has something in it.
      await page.click('.ticket__mode:text("At a limit")');
      await page.waitForTimeout(200);
      await page.locator('.bourse input[inputmode="numeric"]').first().fill('400');
      await page.locator('#ticket-limit').fill('6.40');
      await page.waitForTimeout(200);
      await page.click('.ticket__confirm button');
      await page.waitForTimeout(700);

      // Then a short, which is the other half of what this screen is for:
      // the sell side, the box ticked, and the margin line under it.
      await page.click('.ticket__side:text("Sell")');
      await page.waitForTimeout(200);
      await page.locator('.ticket__short input').check();
      await page.waitForTimeout(200);
      await page.locator('.bourse input[inputmode="numeric"]').first().fill('300');
      await page.locator('#ticket-limit').fill('7.60');
      await page.waitForTimeout(600);
    },
  },
  {
    name: 'range',
    description:
      'A draught out on the range: the banner saying none of it is real, what is up '
      + 'against it, and a fight already in progress. Nothing out here touches the '
      + "captain's marks, cargo, hull or standing.",
    path: '/?callsign=Trials&harness=1',
    settle: '.hud',
    settleMs: 900,
    act: async (page) => {
      await page.waitForSelector('.hud__travel', { timeout: 20_000 });
      await page.keyboard.press('KeyL');
      await page.waitForSelector('.port', { timeout: 20_000 });

      await page.click('.port__service-list button:text("Open the Yard")');
      await page.waitForSelector('.grid', { timeout: 20_000 });
      await page.waitForTimeout(600);

      // The hull they walked in flying is a valid draught, so it can go
      // straight out: the subject here is the range, not the editor.
      await page.click('button:text("Take her out")');
      await page.waitForSelector('.range', { timeout: 30_000 });
      await page.waitForSelector('.hud', { timeout: 20_000 });
      await page.waitForTimeout(800);

      // Close on what is up, so the capture is of a fight rather than of two
      // specks a thousand units apart.
      await engageNearest(page, 30, { untilHit: true });
      await page.waitForTimeout(250);
    },
  },
  {
    name: 'stamp',
    description:
      'The stamp, frame by frame: the control presses, the seal strikes at 108% with an '
      + "amber rim at its edge, the ink spreads, and the berth's mark is left on the "
      + 'order. The signature interaction of the game, caught across its 260ms.',
    path: '/?callsign=Bill%20of%20Lading',
    settle: '.hud',
    settleMs: 900,
    act: async (page) => {
      await page.waitForSelector('.hud__travel', { timeout: 20_000 });
      await page.keyboard.press('KeyL');
      await page.waitForSelector('.port', { timeout: 20_000 });

      await page.click('.port__service-list button:text("Open the floor")');
      await page.waitForSelector('.staple', { timeout: 20_000 });
      await page.waitForTimeout(500);

      // Struck, and then followed: the frames below start the instant the
      // control goes down.
      await page.locator('.stamp__control:text("Buy")').first().click({ noWaitAfter: true });
    },
    frames: { count: 6, everyMs: 45 },
  },
  {
    name: 'stamp-document',
    description:
      "The stamp at document size: the issuing house's seal struck on a commission, its "
      + 'name set round the rim, the ink spread and the deboss under it.',
    path: '/?callsign=Clerk%20of%20the%20Board',
    settle: '.hud',
    settleMs: 900,
    act: async (page) => {
      await page.waitForSelector('.hud__travel', { timeout: 20_000 });
      await page.keyboard.press('KeyL');
      await page.waitForSelector('.port', { timeout: 20_000 });

      await page.click('.port__service-list button:text("Read the board")');
      await page.waitForSelector('.board', { timeout: 20_000 });
      await page.waitForTimeout(500);

      await page.locator('.board__actions .stamp__control').click({ noWaitAfter: true });
      // Past the sequence, so the capture is of the mark as it rests.
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'board',
    description:
      "The Factor's board: what this berth is paying for, the one being read with its "
      + 'terms, and what the captain is already carrying.',
    path: '/?callsign=Supercargo%20Two',
    settle: '.hud',
    settleMs: 900,
    seed: {
      callsign: 'Supercargo Two',
      // Well enough thought of by Kessler to be offered its own work, and
      // alongside a counting-house, which is where that work is posted.
      standing: { kessler: 420, thirty: -210, reprisal: -210 },
      at: 'countinghouse',
    },
    act: async (page) => {
      await page.waitForSelector('.hud__travel', { timeout: 20_000 });
      await page.keyboard.press('KeyL');
      await page.waitForSelector('.port', { timeout: 20_000 });

      await page.click('.port__service-list button:text("Read the board")');
      await page.waitForSelector('.board__columns', { timeout: 20_000 });
      // Take one, so the third column is a captain's day rather than empty.
      await page.click('.board__actions button:text("Take it on")');
      await page.waitForTimeout(900);
    },
  },
  {
    name: 'board-ending',
    description:
      "A chain's last choice: both ways out of The Daughters' Audit, what each pays, and "
      + 'which way the house will remember it. One is chosen and not yet sworn to.',
    path: '/?callsign=Discreet%20Courier',
    settle: '.hud',
    settleMs: 900,
    seed: {
      callsign: 'Discreet Courier',
      standing: { kessler: 560, thirty: -280, reprisal: -280 },
      at: 'countinghouse',
      chainDone: 'daughters-audit',
    },
    act: async (page) => {
      await page.waitForSelector('.hud__travel', { timeout: 20_000 });
      await page.keyboard.press('KeyL');
      await page.waitForSelector('.port', { timeout: 20_000 });

      await page.click('.port__service-list button:text("Read the board")');
      await page.waitForSelector('.board__ending', { timeout: 20_000 });
      // The second choice, which is the one that pays and costs nothing yet.
      await page.click('.board__choices li:nth-child(2) .board__choice');
      await page.waitForTimeout(600);
    },
  },
  {
    name: 'convoy',
    description:
      'Sailing in convoy: who is in it, where each of them is, who has been asked and has '
      + 'not answered, and the field for asking another captain.',
    path: '/?callsign=Fair%20Wind',
    settle: '.hud',
    settleMs: 900,
    seed: {
      callsign: 'Fair Wind',
      at: 'countinghouse',
      // Two sailing with them and one who has not answered, which is every
      // row the screen can draw at once.
      convoyWith: ['Slack Water', 'Dead Reckoning'],
      convoyAsked: ['Lee Helm'],
    },
    // Three captains who have to exist for the convoy to name them. One of
    // them comes online and lands, so the screen shows a member alongside a
    // berth as well as members who are not on the link.
    companions: [
      { seed: { callsign: 'Lee Helm' } },
      { seed: { callsign: 'Dead Reckoning' } },
      {
        seed: { callsign: 'Slack Water', at: 'lading' },
        act: async (page) => {
          await page.waitForSelector('.hud__travel', { timeout: 20_000 });
          await page.keyboard.press('KeyL');
          await page.waitForSelector('.port', { timeout: 20_000 });
        },
      },
    ],
    act: async (page) => {
      await page.waitForSelector('.hud__travel', { timeout: 20_000 });
      await page.keyboard.press('KeyL');
      await page.waitForSelector('.port', { timeout: 20_000 });

      await page.click('.port__service-list button:text("Open it")');
      await page.waitForSelector('.convoy', { timeout: 20_000 });
      await page.waitForTimeout(600);
    },
  },
  {
    name: 'offers',
    description:
      'An offer between two captains alongside the same berth: what leaves the hold, what '
      + 'is paid for it, and what the purse comes to afterwards.',
    path: '/?callsign=Supercargo%20Three',
    settle: '.hud',
    settleMs: 900,
    seed: {
      callsign: 'Supercargo Three',
      at: 'countinghouse',
      cargo: { alloy: 180, leaf: 40, provisions: 60 },
      designs: ['Prudent Return', 'Short Measure'],
    },
    // Somebody to hand it to, standing at the same berth. Nothing else will
    // do: the screen's whole subject is two captains in one room.
    companions: [
      {
        seed: { callsign: 'Broken Stowage', at: 'countinghouse' },
        act: async (page) => {
          await page.waitForSelector('.hud__travel', { timeout: 20_000 });
          await page.keyboard.press('KeyL');
          await page.waitForSelector('.port', { timeout: 20_000 });
        },
      },
    ],
    act: async (page) => {
      await page.waitForSelector('.hud__travel', { timeout: 20_000 });
      await page.keyboard.press('KeyL');
      await page.waitForSelector('.port', { timeout: 20_000 });

      await page.click('.port__service-list button:text("Offers")');
      await page.waitForSelector('.offers', { timeout: 20_000 });

      // Put a real parcel and a real price on the ticket: an empty ticket
      // photographs the controls rather than the thing they are for.
      await page.locator('.offers__units').first().fill('60');
      await page.locator('.offers__figure').fill('3500');
      await page.click('.offers__chip:text("Prudent Return")');
      await page.waitForTimeout(700);
    },
  },
  {
    name: 'chat',
    description: 'The chat overlay: the composer open on the global channel, with the log behind it.',
    path: '/?callsign=Say%20Again',
    settle: '.hud',
    settleMs: 900,
    bots: 2,
    act: async (page) => {
      // Say a few things, so the log behind the composer is not empty.
      for (const line of [
        'Anyone running Leaf out of Tolliver this week?',
        'Two of them sitting off the lane at Soundings. Mind yourself.',
      ]) {
        await page.keyboard.press('Enter');
        await page.waitForSelector('.chat__input', { timeout: 20_000 });
        await page.keyboard.type(line, { delay: 8 });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(500);
      }
      // Leave it open on a third, mid-sentence, which is what it looks like.
      await page.keyboard.press('Enter');
      await page.waitForSelector('.chat__input', { timeout: 20_000 });
      await page.keyboard.type('Fair winds. I am alongside at the Bourse if', { delay: 8 });
      await page.waitForTimeout(400);
    },
  },
  {
    name: 'posted',
    description:
      'Posted by the Prize Court: the composition owing beside the purse, after firing on lawful traffic in the Home Roads.',
    path: '/?callsign=Barratry&harness=1',
    settle: '.hud',
    settleMs: 1500,
    bots: 2,
    act: async (page) => {
      // Fire on a lawful hull in a secured system. The Court notices.
      await page.keyboard.press('Tab');
      await page.waitForTimeout(300);
      // A generous window: this runs after a dozen other captures, with bot
      // traffic in the system and software rasterisation under it all, so the
      // frame loop and every round trip to the page are slower than they look.
      await engageNearest(page, 60);
      await page.waitForSelector('.hud__posted', { timeout: 20_000 });
      await page.waitForTimeout(800);
    },
  },
  {
    name: 'admin',
    description:
      "The books: the ledger by category with faucets against sinks, what every good "
      + 'is worth across the Reach, the listings, the stockpiles berth by berth, and the '
      + 'tuning the world is running on, editable and put in force without a restart.',
    // The page is reached by URL and shut unless the server was told whose
    // it is, so the capture signs in as the captain it was told about.
    path: '/?admin=1',
    seed: { callsign: 'Harbourmaster', at: 'the-bourse' },
    settle: '.admin__ledger',
    settleMs: 1200,
    act: async (page) => {
      await page.waitForSelector('.admin__table', { timeout: 20_000 });
      await page.waitForTimeout(600);
    },
  },
  {
    name: 'boot-unreachable',
    description: 'The terminal when the server does not answer: a designed state, not an error dump.',
    setup: async (page) => {
      // A captain who already has an account, so the Register is skipped and
      // the capture lands on the state this screen is actually about.
      await page.addInitScript(() => {
        localStorage.setItem('marque.deviceToken', 'capture-device-token');
        localStorage.setItem('marque.callsign', 'Last Known');
      });
      await page.route('**/matchmake/**', (route) => route.abort('connectionrefused'));
    },
    settle: '.boot__failure',
    settleMs: 400,
  },
  {
    name: 'register-refused',
    description: 'The Register when the server will not take the callsign: the refusal is in the form.',
    path: '/',
    settle: '.register',
    settleMs: 400,
    act: async (page) => {
      // A callsign the server already holds, so the refusal is the real one.
      await page.fill('.register input[name="callsign"]', 'Alongside');
      await page.click('.register button[type="submit"]');
      await page.waitForTimeout(1200);
    },
  },
];
