/**
 * M5's acceptance check: a captain designs, affords and builds.
 *
 * The three things the milestone is done when:
 *
 *   1. A scripted new captain designs, affords and builds a valid hull using
 *      only what the interface shows — which here means only what the server
 *      told it: the berth's stock, the warrant's caps and the quoted bill.
 *   2. A draught exported by one account builds identically on another.
 *   3. Invalid and unaffordable builds sent straight to the server are
 *      refused, with the reason the interface is built to render.
 *
 * Everything goes through the real protocol against a real server, so this
 * covers what a unit test cannot: that a built hull is the one the captain
 * then flies, that a swap at the Moorings holds across a launch, and that two
 * accounts reading the same code get the same bill to the mark.
 *
 *   pnpm verify:yard
 */

import { ColyseusSDK, type Room } from '@colyseus/sdk';
import {
  SERVER_MESSAGES,
  SystemState,
  buildCost,
  content,
  decodeShareCode,
  encodeShareCode,
  stocksModule,
  type Placement,
  type PortDef,
  type Problem,
} from '@marque/shared';
import { requirePortFree, spawnGroup, stopGroup } from '@marque/harness';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { REPO_ROOT, sleep } from './harness.ts';

const PORT = 2591;

interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

const checks: Check[] = [];

function record(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
}

/** What the Yard tells a captain about their books and this berth. */
interface YardPayload {
  designs: { id: string; name: string; placements: Placement[] }[];
  ships: { id: string; name: string; placements: Placement[]; portId: string; systemId: string }[];
  licence: string;
  flying: Placement[];
  flyingId: string;
  flyingName: string;
  stock: Record<string, number>;
  berthName: string;
  licences: {
    id: string;
    name: string;
    cost: number;
    maxModules: number;
    maxExtent: number;
    held: boolean;
    behind: boolean;
  }[];
  /** The captain's two colours, or null while they fly the yard's. */
  paint: [string, string] | null;
}

interface Purse {
  marks: number;
  draught: string;
  licence: string;
  landedPort: string;
}

interface BuildReceipt {
  shipId: string;
  marks: number;
  premium: number;
  materialsCost: number;
  marksAfter: number;
}

/** A connected captain, with the pushes they have been sent. */
interface Captain {
  readonly room: Room<unknown, SystemState>;
  readonly inbox: {
    yard?: YardPayload;
    purse?: Purse;
    survey?: { problems: Problem[] };
    given?: { name: string; from: string };
  };
}

async function signUp(callsign: string): Promise<string> {
  const answer = (await (
    await fetch(`http://127.0.0.1:${PORT}/account/sign-up`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callsign, inviteCode: '' }),
    })
  ).json()) as { deviceToken: string };
  return answer.deviceToken;
}

async function connect(sdk: ColyseusSDK, callsign: string): Promise<Captain> {
  const deviceToken = await signUp(callsign);
  const room: Room<unknown, SystemState> = await sdk.joinOrCreate<SystemState>(
    'system',
    { deviceToken, systemId: content().tuning.start.system },
    SystemState,
  );

  // Registered before any await, so the pushes that arrive on joining — the
  // purse, and the Yard once alongside — are not missed.
  const inbox: Captain['inbox'] = {};
  for (const type of SERVER_MESSAGES) room.onMessage(type, () => undefined);
  room.onMessage('yard', (payload) => (inbox.yard = payload as YardPayload));
  room.onMessage('purse', (payload) => (inbox.purse = payload as Purse));
  room.onMessage('survey', (payload) => (inbox.survey = payload as { problems: Problem[] }));
  room.onMessage('given-design', (payload) => (inbox.given = payload as { name: string; from: string }));

  return { room, inbox };
}

/**
 * Build, typed.
 *
 * `room.request`'s type parameter is its payload, not its answer, so the
 * answer is narrowed once here rather than cast at every call.
 */
async function build(
  room: Room<unknown, SystemState>,
  name: string,
  placements: readonly Placement[],
): Promise<BuildReceipt> {
  const answer: unknown = await room.request('build', { name, placements });
  return answer as BuildReceipt;
}

/** The reason the server gave, or empty if it did not refuse. */
async function refusal(room: Room<unknown, SystemState>, type: string, payload: unknown): Promise<string> {
  try {
    await room.request(type, payload);
    return '';
  } catch (error) {
    return (error as { reason?: string }).reason ?? 'unknown';
  }
}

async function main(): Promise<void> {
  await requirePortFree(PORT, 'a game server');

  const dir = mkdtempSync(join(tmpdir(), 'marque-yard-'));
  const server = spawnGroup('pnpm', ['exec', 'tsx', 'src/main.ts'], {
    cwd: resolve(REPO_ROOT, 'packages/server'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: join(dir, 'world.db'),
      SNAPSHOT_DIR: join(dir, 'snapshots'),
      NODE_ENV: 'development',
      INVITE_CODE: '',
      // Enough to build with. A new captain's float is tuned for trading, and
      // this harness is about the Yard, not about earning the fare.
      STARTING_MARKS: '4000000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  server.stdout?.on('data', (d: Buffer) => (log += d.toString()));
  server.stderr?.on('data', (d: Buffer) => (log += d.toString()));

  try {
    const deadline = Date.now() + 45_000;
    for (;;) {
      if (server.exitCode !== null) throw new Error(`server exited early:\n${log}`);
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break;
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline) throw new Error(`server never became healthy:\n${log}`);
      await sleep(300);
    }

    const sdk = new ColyseusSDK(`ws://127.0.0.1:${PORT}`);
    const { modules, tuning, systems } = content();

    const shipwright = await connect(sdk, 'Shipwright');
    await sleep(1200);

    // The berth with a Yard in the starting system.
    const system = systems.get(shipwright.room.state.systemId)!;
    const berth: PortDef = system.ports.find((p) => p.services.includes('yard'))!;

    await shipwright.room.request('land', { port: berth.id });
    await sleep(3500);

    const yard = shipwright.inbox.yard;

    record(
      'the Yard opens on the hull the captain actually flies',
      yard !== undefined && yard.flying.length > 0,
      yard ? `${yard.flying.length} fittings, "${yard.flyingName}"` : 'no Yard arrived',
    );

    record(
      'the Yard says what this berth stocks and what the warrant covers',
      yard !== undefined &&
        Object.keys(yard.stock).length === 3 &&
        yard.licences.length === 4 &&
        yard.licences.filter((rung) => rung.held).length === 1,
      yard
        ? `stock ${JSON.stringify(yard.stock)}, holding ${yard.licences.find((l) => l.held)?.name}`
        : 'no Yard arrived',
    );

    // --- 1. Design, afford, build, using only what was sent ---------------
    //
    // The design is built from the berth's own stock list and kept inside the
    // warrant's own caps. Nothing here reads content the interface would not
    // have been given.
    const held = yard!.licences.find((rung) => rung.held)!;
    const offered = [...modules.values()].filter((def) => stocksModule(yard!.stock, def));

    record(
      'the palette the interface would show is a strict subset of the Register',
      offered.length > 0 && offered.length < modules.size,
      `${offered.length} of ${modules.size} fittings stocked at ${yard!.berthName}`,
    );

    // Start from the flown hull and add one stocked cargo bay, which keeps
    // the design valid and makes it unambiguously different.
    const bay = offered.find((def) => def.type === 'cargo' && def.footprint.width === 1)
      ?? offered.find((def) => def.type === 'cargo')!;
    const design: Placement[] = [
      ...yard!.flying,
      { moduleId: bay.id, x: 2, y: 4, rotation: 0 },
    ];

    // Quoted the way the editor quotes it: against nothing, because a captain
    // who has never built owns no hull to credit. The starter came with the
    // ticket.
    const quoted = buildCost(design, modules, tuning, []);
    const marksBefore = shipwright.inbox.purse!.marks;

    record(
      'a first build is quoted as a new hull, not as a refit of the starter',
      yard!.flyingId === '' && quoted.marks > buildCost(design, modules, tuning, yard!.flying).marks,
      `${quoted.marks} outright against ${buildCost(design, modules, tuning, yard!.flying).marks} as a refit`,
    );

    record(
      'the draught stays inside the warrant it is being built under',
      design.length <= held.maxModules,
      `${design.length} fittings against ${held.maxModules}`,
    );

    const receipt = await build(shipwright.room, 'Bonded Runner', design);
    await sleep(600);

    record(
      'building charges the quoted marks and nothing more',
      receipt.marks === quoted.marks &&
        shipwright.inbox.purse!.marks === marksBefore - receipt.marks - receipt.materialsCost,
      `quoted ${quoted.marks}, charged ${receipt.marks} plus ${receipt.materialsCost} in materials`,
    );

    record(
      'the premium is part of the bill, not added to it',
      receipt.premium > 0 && receipt.premium < receipt.marks,
      `${receipt.premium} of ${receipt.marks} is insurance`,
    );

    // --- The built hull is the one that gets flown ------------------------
    //
    // A hull built while flying the starter is moored, not boarded, so it has
    // to be taken out at the Moorings first.
    await shipwright.room.request('switch-ship', { id: receipt.shipId });
    await sleep(600);

    record(
      'a hull taken out at the Moorings is the one being flown',
      shipwright.inbox.yard?.flyingId === receipt.shipId &&
        shipwright.inbox.yard?.flyingName === 'Bonded Runner',
      `flying "${shipwright.inbox.yard?.flyingName}" (${shipwright.inbox.yard?.flyingId.slice(0, 8)})`,
    );

    // --- The captain's colours ----------------------------------------------
    //
    // Spec section 4: players pick two paint colours. From the yards' own
    // paints only, and they ride on the hull's state so every client paints
    // the captain the same.
    const { paints } = content().tuning.yard;
    const offPalette = await refusal(shipwright.room, 'paint', { bands: '#123456', stripe: paints[0]!.hex });
    record(
      'a colour the yards do not keep is refused',
      offPalette === 'no-such-paint',
      `refused with "${offPalette}"`,
    );

    const chosen: [string, string] = [paints[2]!.hex, paints[5]!.hex];
    await shipwright.room.request('paint', { bands: chosen[0], stripe: chosen[1] });
    await sleep(500);
    record(
      "the captain's colours are on their books",
      JSON.stringify(shipwright.inbox.yard?.paint) === JSON.stringify(chosen),
      `the yard says ${JSON.stringify(shipwright.inbox.yard?.paint ?? null)}`,
    );

    await shipwright.room.request('launch', {});
    await sleep(1200);

    const inSpace = shipwright.room.state.ships.get(shipwright.room.sessionId);

    record(
      'the next hull out wears them, where every client can read them',
      inSpace !== undefined && inSpace.paint === chosen.join(' '),
      inSpace ? `the hull carries "${inSpace.paint}"` : 'no hull in the room',
    );

    record(
      'the built hull is what launches, and its grid travels with it',
      inSpace !== undefined &&
        inSpace.blueprint === receipt.shipId &&
        inSpace.hull !== '' &&
        inSpace.moduleHp.length === design.length,
      inSpace
        ? `${inSpace.moduleHp.length} fittings, ${inSpace.hull.length} characters of hull code`
        : 'no hull in the room',
    );

    record(
      "another client can rebuild the hull from what it was sent",
      inSpace !== undefined && decodeShareCode(inSpace.hull).placements.length === design.length,
      inSpace ? `decoded ${decodeShareCode(inSpace.hull).placements.length} placements` : 'no hull',
    );

    await shipwright.room.request('land', { port: berth.id });
    await sleep(3500);

    // --- 2. One account's export builds identically on another ------------
    await shipwright.room.request('save-design', { name: 'Bonded Runner', placements: design });
    await sleep(400);
    const saved = shipwright.inbox.yard!.designs.find((d) => d.name === 'Bonded Runner')!;
    const code = encodeShareCode({ name: saved.name, placements: saved.placements });

    const reader = await connect(sdk, 'Reader');
    await sleep(1200);
    await reader.room.request('land', { port: berth.id });
    await sleep(3500);

    await reader.room.request('import-design', { code });
    await sleep(500);

    const imported = reader.inbox.yard?.designs.find((d) => d.name === 'Bonded Runner');

    record(
      "a code written by one captain reads onto another's books",
      imported !== undefined &&
        JSON.stringify(imported.placements) === JSON.stringify(saved.placements),
      imported ? `${imported.placements.length} fittings, identical` : 'nothing imported',
    );

    const theirReceipt = await build(reader.room, 'Bonded Runner', imported!.placements);
    await sleep(600);

    record(
      'and it builds identically: the same bill to the mark',
      theirReceipt.marks === receipt.marks && theirReceipt.premium === receipt.premium,
      `${theirReceipt.marks} against ${receipt.marks}, premium ${theirReceipt.premium}`,
    );

    const theirHull = reader.inbox.yard!.ships.find((s) => s.id === theirReceipt.shipId)!;

    record(
      'the hull it produces has the same grid, cell for cell',
      JSON.stringify(theirHull.placements) === JSON.stringify(design),
      `${theirHull.placements.length} placements, identical`,
    );

    // Giving it directly, which is the other half of spec section 7.
    await shipwright.room.request('give-design', { id: saved.id, callsign: 'Reader' });
    await sleep(500);

    record(
      'a draught can be handed to another captain by callsign',
      reader.inbox.given?.from === 'Shipwright' &&
        reader.inbox.yard!.designs.filter((d) => d.name === 'Bonded Runner').length === 2,
      reader.inbox.given
        ? `"${reader.inbox.given.name}" from ${reader.inbox.given.from}`
        : 'nothing arrived',
    );

    // --- 3. What the server refuses --------------------------------------
    //
    // An unstocked fitting the same size as one already in the design, so
    // swapping it in leaves the grid geometrically identical and the only
    // thing wrong with the draught is where it is being built. Adding a
    // fitting off to one side would be refused as disconnected first, and the
    // check would pass while testing nothing.
    //
    // Only plate and hull sections are candidates on either side of the swap:
    // they have no lane to keep clear behind or in front of them and no
    // uniqueness rule, so exchanging one for another of the same footprint
    // cannot make the draught fail survey for any other reason.
    const INERT = ['hull', 'armour'];
    const sameSize = (a: { footprint: { width: number; height: number } },
                      b: { footprint: { width: number; height: number } }): boolean =>
      a.footprint.width === b.footprint.width && a.footprint.height === b.footprint.height;

    const candidates = [...modules.values()].filter(
      (def) => INERT.includes(def.type) && !stocksModule(yard!.stock, def),
    );
    const swappable = design.find((placement) => {
      const def = modules.get(placement.moduleId)!;
      return INERT.includes(def.type) && candidates.some((other) => sameSize(other, def));
    })!;
    const swappedFor = candidates.find((other) =>
      sameSize(other, modules.get(swappable.moduleId)!),
    )!;
    const unstockedDesign = design.map((placement) =>
      placement === swappable ? { ...placement, moduleId: swappedFor.id } : placement,
    );

    //
    // Split in two on purpose. A message that is *shaped* wrong — no
    // placements at all — never comes from the editor, which disables Build,
    // so it only has to be refused. A message that is shaped right and asks
    // for something the world does not allow is what a captain can actually
    // reach, and that must come back with a reason the interface can render
    // rather than "unknown".
    const refusals: Record<string, string> = {
      'two bridges': await refusal(shipwright.room, 'build', {
        name: 'Two Bridges',
        placements: [
          { moduleId: 'hrc-bridge-1', x: 0, y: 0, rotation: 0 },
          { moduleId: 'hrc-bridge-1', x: 4, y: 0, rotation: 0 },
        ],
      }),
      'a fitting from the future': await refusal(shipwright.room, 'build', {
        name: 'Invented',
        placements: [{ moduleId: 'hrc-bridge-99', x: 0, y: 0, rotation: 0 }],
      }),
      'a fitting this berth does not stock': await refusal(shipwright.room, 'build', {
        name: 'Elsewhere',
        placements: unstockedDesign,
      }),
      'a draught naming a fitting from the future': await refusal(
        shipwright.room,
        'save-design',
        { name: 'Invented', placements: [{ moduleId: 'hrc-bridge-99', x: 0, y: 0, rotation: 0 }] },
      ),
      'a warrant already held': await refusal(shipwright.room, 'buy-licence', {
        licence: 'open-ticket',
      }),
      'a warrant that does not exist': await refusal(shipwright.room, 'buy-licence', {
        licence: 'dreadnought-charter',
      }),
      "somebody else's hull": await refusal(shipwright.room, 'switch-ship', {
        id: theirReceipt.shipId,
      }),
      'a code that will not read': await refusal(shipwright.room, 'import-design', {
        code: 'AAAAAAAAAAAAAAAA',
      }),
      'a draught given to nobody': await refusal(shipwright.room, 'give-design', {
        id: saved.id,
        callsign: 'Nobody At All',
      }),
      'a draught that is not theirs to give': await refusal(shipwright.room, 'give-design', {
        id: 'some-other-captains-draught',
        callsign: 'Reader',
      }),
    };

    const accepted = Object.entries(refusals).filter(([, reason]) => reason === '');

    record(
      'every invalid build or intent sent straight to the server is refused',
      accepted.length === 0,
      accepted.length === 0
        ? Object.entries(refusals)
            .map(([what, reason]) => `${what} → ${reason}`)
            .join('; ')
        : `accepted: ${accepted.map(([what]) => what).join(', ')}`,
    );

    const untyped = Object.entries(refusals).filter(([, reason]) => reason === 'unknown');

    record(
      'and refused with a typed reason the interface can render',
      untyped.length === 0,
      untyped.length === 0
        ? `${Object.keys(refusals).length} refusals, all typed`
        : `untyped: ${untyped.map(([what]) => what).join(', ')}`,
    );

    // A malformed message is a client bug rather than a game state, so it
    // only has to be refused — but it must not be accepted or crash the room.
    const malformed = await refusal(shipwright.room, 'build', { name: 'Empty', placements: [] });

    record(
      'a malformed message is refused, whatever it says',
      malformed !== '',
      `refused with "${malformed}"`,
    );

    record(
      'a refused build says which fittings are wrong, for the grid to mark',
      (shipwright.inbox.survey?.problems.length ?? 0) > 0,
      `${shipwright.inbox.survey?.problems.length ?? 0} problems on the last refusal`,
    );

    // --- Unaffordable ----------------------------------------------------
    //
    // A captain with nothing cannot build, and is told so rather than going
    // into debt.
    const pauper = await connect(sdk, 'Pauper');
    await sleep(1200);
    await pauper.room.request('land', { port: berth.id });
    await sleep(3500);

    // Spend the float down. The charter is the dearest thing a Yard sells and
    // nobody starting out can cover it.
    const broke = await refusal(pauper.room, 'buy-licence', { licence: 'capital-charter' });

    record(
      'a captain cannot buy a warrant they cannot pay for',
      broke === 'cannot-afford',
      `refused with "${broke}"`,
    );

    record(
      'and the refusal left their purse alone',
      pauper.inbox.purse!.marks > 0 && pauper.inbox.purse!.licence === 'open-ticket',
      `${pauper.inbox.purse!.marks} marks, holding an ${pauper.inbox.purse!.licence}`,
    );

    // --- The warrant ladder ----------------------------------------------
    const bought = await refusal(shipwright.room, 'buy-licence', { licence: 'frigate-warrant' });
    await sleep(500);

    record(
      'buying the next warrant up raises the caps the editor shows',
      bought === '' &&
        shipwright.inbox.yard!.licence === 'frigate-warrant' &&
        shipwright.inbox.yard!.licences.find((l) => l.held)!.maxModules >
          held.maxModules,
      `${held.name} → ${shipwright.inbox.yard!.licences.find((l) => l.held)!.name}`,
    );

    await shipwright.room.leave();
    await reader.room.leave();
    await pauper.room.leave();
    report();
  } finally {
    await stopGroup(server);
    rmSync(dir, { recursive: true, force: true });
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
    console.error(`\nFAIL: ${failed.length} of ${checks.length} Yard checks did not hold.`);
    process.exitCode = 1;
  } else {
    console.log(`\nPASS: all ${checks.length} Yard checks held.`);
  }
}

await main();
process.exit(process.exitCode ?? 0);
