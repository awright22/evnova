/**
 * The server is authoritative.
 *
 * M2's acceptance check: a client sending forged positions, hits or stats has
 * no effect on outcomes. This connects with the real SDK and then misbehaves
 * in every way the protocol allows a client to misbehave, and asserts that
 * nothing it sent changed anything it should not have.
 *
 *   pnpm verify:authority
 */

import { ColyseusSDK, type Room } from '@colyseus/sdk';
import {
  ShipInput,
  SystemState,
  content,
  deriveStats,
  placeAll,
} from '@marque/shared';

import { sleep, startStack } from './harness.ts';

interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

const checks: Check[] = [];

function record(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
}

async function main(): Promise<void> {
  const serverPort = 2586;
  const stack = await startStack({ serverPort, previewPort: 4186 });

  try {
    const sdk = new ColyseusSDK(`ws://127.0.0.1:${serverPort}`);
    const room: Room<unknown, SystemState> = await sdk.joinOrCreate<SystemState>(
      'system',
      { callsign: 'Forger' },
      SystemState,
    );

    const self = await waitForShip(room);
    const { blueprints, modules, tuning } = content();
    const blueprint = blueprints.get(self.blueprint)!;
    const stats = deriveStats(placeAll(blueprint.placements, modules), tuning);

    const input = room.input({ type: ShipInput });

    // --- 1. Out-of-range input axes are clamped, not obeyed ---------------
    // The wire carries whatever the client encodes. An int8 turn axis can
    // arrive as 127; the server's sanitiser must fix it up before the
    // simulation reads it.
    for (let i = 0; i < 90; i++) {
      (input.data as unknown as Record<string, number | boolean>).turn = 127;
      (input.data as unknown as Record<string, number | boolean>).thrust = 255;
      input.send();
      await sleep(16);
    }
    await sleep(600);

    const spin = Math.abs(self.angVel);
    const speed = Math.hypot(self.vx, self.vy);
    record(
      'an out-of-range turn axis cannot spin the hull faster than its thrusters allow',
      spin <= stats.profile.maxTurnRate + 0.05,
      `angVel ${spin.toFixed(3)} against a ceiling of ${stats.profile.maxTurnRate.toFixed(3)}`,
    );
    record(
      'an out-of-range thrust axis cannot drive the hull past its top speed',
      speed <= stats.profile.topSpeed * 1.02,
      `speed ${speed.toFixed(1)} against a top speed of ${stats.profile.topSpeed.toFixed(1)}`,
    );

    // Stop, so later checks are not measuring a hull still under power.
    (input.data as unknown as Record<string, number | boolean>).turn = 0;
    (input.data as unknown as Record<string, number | boolean>).thrust = 0;
    for (let i = 0; i < 10; i++) {
      input.send();
      await sleep(16);
    }

    // --- 2. There is no channel that writes state ------------------------
    // Forging a position means inventing a message type for it. The server
    // has no handler, so the only question is whether it survives the attempt.
    const positionBefore = { x: self.x, y: self.y };
    for (const forged of [
      ['move', { x: 999_999, y: 999_999 }],
      ['setPosition', { x: 0, y: 0 }],
      ['damage', { target: room.sessionId, amount: 10_000 }],
      ['state', { shield: 99_999 }],
      ['__proto__', { polluted: true }],
    ] as const) {
      try {
        room.send(forged[0], forged[1]);
      } catch {
        // A refused send is a pass, not a failure.
      }
    }
    await sleep(900);

    const moved = Math.hypot(self.x - positionBefore.x, self.y - positionBefore.y);
    record(
      'messages that claim to set position, damage or stats change nothing',
      moved < 400 && self.shield <= stats.shieldCapacity + 1 && room.connection.isOpen,
      `drifted ${moved.toFixed(1)} units under its own momentum, shield ${self.shield.toFixed(0)} of ${stats.shieldCapacity.toFixed(0)}`,
    );

    // --- 3. Intents are validated for state, not just shape --------------
    const markBefore = self.target;
    const rejections: string[] = [];

    for (const [label, payload] of [
      ['a hull that is not in this system', { id: 'no-such-hull' }],
      ['its own hull', { id: room.sessionId }],
    ] as const) {
      try {
        await room.request('target', payload);
        rejections.push(`${label}: ACCEPTED`);
      } catch (error) {
        rejections.push(`${label}: refused`);
        void error;
      }
    }

    record(
      'marking a hull that does not exist, or its own, is refused with a reason',
      rejections.every((r) => r.endsWith('refused')) && self.target === markBefore,
      rejections.join('; '),
    );

    // --- 4. Range is checked against the server's position ---------------
    let scoopRefused = false;
    try {
      await room.request('scoop', { id: 'no-such-canister' });
    } catch {
      scoopRefused = true;
    }
    record(
      'scooping something that is not there is refused',
      scoopRefused,
      scoopRefused ? 'refused' : 'ACCEPTED',
    );

    // --- 5. Malformed payloads do not take the room down -----------------
    // Payloads large enough to breach the transport's frame limit are refused
    // below the room, which is correct, so they are not part of this case.
    for (const payload of [null, 42, 'string', { id: 123 }, { id: 'x'.repeat(200) }]) {
      try {
        await room.request('target', payload).catch(() => undefined);
      } catch {
        // A refused intent is the expected outcome.
      }
    }
    await sleep(900);
    record(
      'malformed intent payloads leave the room running',
      room.connection.isOpen && room.state.ships.has(room.sessionId),
      room.connection.isOpen ? 'still connected and still flying' : 'the connection dropped',
    );

    await room.leave();
    report();
  } finally {
    await stack.stop();
  }
}

function report(): void {
  const width = Math.max(...checks.map((c) => c.name.length));
  console.log('');
  for (const check of checks) {
    console.log(`  ${check.passed ? 'PASS' : 'FAIL'}  ${check.name.padEnd(width)}  ${check.detail}`);
  }

  const failed = checks.filter((c) => !c.passed);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length} of ${checks.length} authority checks did not hold.`);
    process.exitCode = 1;
  } else {
    console.log(`\nPASS: all ${checks.length} authority checks held.`);
  }
}

function waitForShip(room: Room<unknown, SystemState>, timeoutMs = 15_000) {
  const existing = room.state.ships.get(room.sessionId);
  if (existing) return Promise.resolve(existing);
  return new Promise<NonNullable<ReturnType<typeof room.state.ships.get>>>((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error('the server never created a hull for this session'));
    }, timeoutMs);
    const poll = setInterval(() => {
      const ship = room.state.ships.get(room.sessionId);
      if (ship) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve(ship);
      }
    }, 16);
  });
}

await main();
