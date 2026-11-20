/**
 * The application shell.
 *
 * Owns nothing itself: it subscribes to the game client and renders whichever
 * screen the captain is on. A hyperjump changes rooms, so the room cannot be
 * owned by a component — it lives in the game client and the flight view is
 * keyed on it.
 *
 * Every failure has a designed state. The interface never shows a white
 * screen or raw error text.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ChatLine } from '@marque/shared';

import { ChatOverlay } from './chat/ChatOverlay.tsx';
import { FlightView } from './flight/FlightView.tsx';
import { GameClient, type GameSnapshot } from './game/GameClient.ts';
import { Register } from './game/Register.tsx';
import { GalaxyMap } from './map/GalaxyMap.tsx';
import { PortHub } from './port/PortHub.tsx';
import { Staple } from './port/Staple.tsx';
import { Editor } from './yard/Editor.tsx';
import { Moorings } from './yard/Moorings.tsx';
import { Bourse } from './bourse/Bourse.tsx';
import { Board } from './commissions/Board.tsx';
import { Convoy } from './convoy/Convoy.tsx';
import { Offers } from './offers/Offers.tsx';
import { Admin } from './admin/Admin.tsx';
import { httpBaseFrom, loadAccount } from './game/account.ts';
import { Title } from './shell/Title.tsx';
import { flightAudio } from './audio/flight.ts';
import { playNotice } from './audio/notices.ts';
import { Hint, useHint } from './shell/Hint.tsx';
import { Pilotage } from './shell/Pilotage.tsx';
import {
  endorse,
  loadPilotage,
  savePilotage,
  type Endorsement,
} from './shell/pilotage.ts';
import { Settings } from './shell/Settings.tsx';
import { Credits } from './shell/Credits.tsx';
import {
  applySettings,
  loadSettings,
  saveSettings,
  type Settings as SettingsState,
} from './shell/settings.ts';
import { RangeBanner } from './flight/RangeBanner.tsx';
import { BUILD_VERSION, SERVER_URL } from './net/connection.ts';
import './styles/boot.css';

export function App(): React.JSX.Element {
  // The admin page is not a game screen: it is reached by URL, shows the
  // books and nothing else, and the server decides whether this device may
  // see it. Checked before the client is built, because an operator reading
  // the ledger has no business joining a room to do it.
  const admin = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('admin') !== null;
  }, []);

  // Settings are applied before anything renders, so a captain who has
  // scaled the interface up never sees one frame of it small.
  const [settings, setSettings] = useState(() => {
    const loaded = loadSettings();
    applySettings(loaded);
    return loaded;
  });

  const change = useCallback((next: SettingsState) => {
    setSettings(next);
    applySettings(next);
    saveSettings(next);
  }, []);

  /**
   * Where the shell is standing.
   *
   * The title comes first, unless a capture or a test asked to go straight
   * in: the harness drives the game and has no business pressing a door.
   */
  const [shell, setShell] = useState<'title' | 'settings' | 'credits' | 'game'>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('harness') !== null || params.get('callsign') !== null
      ? 'game'
      : 'title';
  });

  if (admin) {
    // The server's HTTP origin, not the socket's: the admin page is three
    // fetches and no room, and `ws://` is not a scheme fetch knows.
    return <Admin endpoint={httpBaseFrom(SERVER_URL)} deviceToken={loadAccount()?.deviceToken} />;
  }

  if (shell === 'settings') {
    return <Settings settings={settings} onChange={change} onClose={() => setShell('title')} />;
  }

  if (shell === 'credits') {
    return <Credits onClose={() => setShell('title')} />;
  }

  if (shell === 'title') {
    return (
      <Title
        version={BUILD_VERSION}
        returning={loadAccount() !== undefined}
        onEnter={() => setShell('game')}
        onSettings={() => setShell('settings')}
        onCredits={() => setShell('credits')}
      />
    );
  }

  return <Game settings={settings} onSettings={change} />;
}

function Game({
  settings,
  onSettings,
}: {
  readonly settings: SettingsState;
  onSettings: (next: SettingsState) => void;
}): React.JSX.Element {
  const client = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return new GameClient(
      SERVER_URL,
      params.get('draught') ?? undefined,
      params.get('callsign') ?? undefined,
    );
  }, []);

  const [snapshot, setSnapshot] = useState<GameSnapshot>(() => client.snapshot());
  const [chartOpen, setChartOpen] = useState(false);
  const [chat, setChat] = useState<readonly ChatLine[]>([]);
  const [stapleOpen, setStapleOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [yardOpen, setYardOpen] = useState(false);
  const [mooringsOpen, setMooringsOpen] = useState(false);
  const [bourseOpen, setBourseOpen] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);
  const [offersOpen, setOffersOpen] = useState(false);
  const [convoyOpen, setConvoyOpen] = useState(false);
  const [composing, setComposing] = useState(false);

  // Whether the Bourse's own note has been settled, which is what the
  // Register's note waits for.
  const bourseHinted = !useHint('bourse').show;

  // The provisional ticket: seven endorsements the Register's clerk adds as
  // the captain does each thing once. Device-local, like the settings.
  const [ticket, setTicket] = useState(() => loadPilotage());
  const endorsed = useCallback((id: Endorsement) => {
    setTicket((before) => {
      const after = endorse(before, id);
      if (after !== before) savePilotage(after);
      return after;
    });
  }, []);
  const waive = useCallback(() => {
    setTicket((before) => {
      const after = { ...before, confirmed: true };
      savePilotage(after);
      return after;
    });
  }, []);

  useEffect(() => {
    const unsubscribe = client.subscribe(setSnapshot);
    const unsubscribeChat = client.subscribeChat(setChat);
    void client.start();
    return () => {
      unsubscribe();
      unsubscribeChat();
      client.dispose();
    };
  }, [client]);

  const { mode, purse, chart } = snapshot;

  // A refusal is a sound of its own, flat and short, so a captain who is
  // not reading the notice line still knows the Staple declined. One per
  // refusal: the snapshot carries the text until something clears it.
  const refusal = snapshot.notice;
  const lastRefusal = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (refusal !== undefined && refusal !== lastRefusal.current) playNotice('refused');
    lastRefusal.current = refusal;
  }, [refusal]);

  // What the captain is carrying, which the Yard's bill is settled against.
  const hold = useMemo(
    () =>
      new Map(
        (snapshot.staple?.listings ?? [])
          .filter((listing) => listing.carried > 0)
          .map((listing) => [listing.commodityId, listing.carried] as const),
      ),
    [snapshot.staple],
  );

  /**
   * Who is sailing with this captain, by callsign.
   *
   * The radar and the chart both mark them, and a hull in the simulation
   * carries a callsign rather than an account. Only those who have actually
   * joined: somebody who has been asked and has not answered is not in it.
   */
  const convoyCallsigns = useMemo(
    () =>
      new Set(
        (snapshot.convoy?.members ?? [])
          .filter((member) => member.state === 'member' && !member.isSelf)
          .map((member) => member.callsign),
      ),
    [snapshot.convoy],
  );

  /** Where each of them is, for the chart to mark the systems they are in. */
  const convoyBySystem = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const member of snapshot.convoy?.members ?? []) {
      if (member.state !== 'member' || member.isSelf || member.systemId === '') continue;
      out.set(member.systemId, [...(out.get(member.systemId) ?? []), member.callsign]);
    }
    return out;
  }, [snapshot.convoy]);

  // Alongside is the second endorsement, and arriving somewhere else is the
  // fourth. Both are read off the mode rather than off the intent, because
  // an intent the server refused is not a thing the captain did.
  useEffect(() => {
    if (mode.kind === 'port') {
      endorsed('land');
      // The clamps. Heard here rather than in the flight view, which is on
      // its way out by the time the hull is actually alongside.
      flightAudio()?.land();
    }
    if (mode.kind === 'jumping') {
      // The whump, and the spool released into it. Heard here for the same
      // reason: the lane takes the hull by taking the room, so the flight
      // view is gone before its own loop could see the spool end.
      flightAudio()?.endSpool(true);
    }
  }, [mode.kind, endorsed]);

  // The system the captain is actually in. `snapshot.systemId` is empty
  // until a room is attached, and the purse carries it in the meantime —
  // which is why the arrival chime never sounded: the effect below read the
  // empty one and returned every time.
  const arrivedIn = snapshot.systemId || purse.system;
  const firstSystem = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (arrivedIn === '') return;
    if (firstSystem.current === undefined) {
      firstSystem.current = arrivedIn;
      return;
    }
    if (arrivedIn === firstSystem.current) return;
    firstSystem.current = arrivedIn;
    endorsed('jump');
    // Somewhere else. The whump belonged to the lane; this is the chime on
    // the other side of it.
    flightAudio()?.arrival();
  }, [arrivedIn, endorsed]);

  // Leaving the berth closes its floor: a market is a thing you stand in, and
  // one left open over the flight view would be reading stale prices.
  useEffect(() => {
    if (mode.kind !== 'port') {
      setStapleOpen(false);
      setYardOpen(false);
      setMooringsOpen(false);
      setBourseOpen(false);
      setBoardOpen(false);
      setOffersOpen(false);
      setConvoyOpen(false);
    }
  }, [mode.kind]);

  const onJump = useCallback(
    (systemId: string) => {
      client.jump(systemId);
      setChartOpen(false);
    },
    [client],
  );

  // Chat follows the captain between flight and a berth, and keeps the same
  // log across a jump: only the system channel's name changes.
  const systemName =
    chart?.byId.get(snapshot.systemId || purse.system)?.name ?? snapshot.systemId;

  const chatOverlay = (
    <ChatOverlay
      lines={chat}
      systemName={systemName}
      captureKeys={!chartOpen}
      onSay={(channel, body) => client.say(channel, body)}
      onComposingChange={setComposing}
    />
  );

  // The chart is available from flight and from a berth.
  const chartOverlay =
    chartOpen && chart ? (
      <GalaxyMap
        chart={chart}
        currentSystem={snapshot.systemId || purse.system}
        reachable={chart.byId.get(snapshot.systemId || purse.system)?.links ?? []}
        propellant={purse.propellant}
        jumpCost={purse.jumpCost}
        refusal={snapshot.notice}
        course={snapshot.course}
        convoy={convoyBySystem}
        onJump={onJump}
        onPlot={(systemId) => {
          client.plot(systemId);
          setChartOpen(false);
        }}
        onClose={() => setChartOpen(false)}
      />
    ) : null;

  if (settingsOpen) {
    return (
      <Settings
        settings={settings}
        onChange={onSettings}
        onClose={() => setSettingsOpen(false)}
      />
    );
  }

  switch (mode.kind) {
    case 'register':
      return (
        <Register
          httpBase={client.httpBase}
          onSignedIn={(account) => void client.signedIn(account)}
        />
      );

    case 'connecting':
      return <Waiting heading="Opening the link." detail={SERVER_URL} />;

    case 'jumping':
      return <Waiting heading="In the lane." detail={`Arriving at ${mode.to}`} />;

    case 'port': {
      const system = chart?.byId.get(snapshot.systemId || purse.system);
      const port = system?.ports.find((candidate) => candidate.id === mode.portId);
      if (!system || !port) {
        return <Waiting heading="Alongside." detail="Reading the berth's register." />;
      }
      return (
        <>
          <PortHub
            state={{
              system,
              port,
              marks: purse.marks,
              propellant: purse.propellant,
              propellantCapacity: purse.propellantCapacity,
              ordnance: purse.ordnance,
              composition: purse.composition,
              hasStaple: snapshot.staple !== undefined,
              propellantAsk:
                snapshot.staple?.listings.find((l) => l.commodityId === 'propellant')?.ask ?? 0,
              ordnanceAsk:
                snapshot.staple?.listings.find((l) => l.commodityId === 'ordnance')?.ask ?? 0,
              structure: purse.structure,
              draught: purse.draught,
              mooredHere: (snapshot.yard?.ships ?? []).filter(
                (hull) => hull.portId === port.id,
              ).length,
              posted: snapshot.commissions?.board.length ?? 0,
              alongside: snapshot.offers?.alongside.length ?? 0,
              convoy: (snapshot.convoy?.members ?? []).filter(
                (member) => member.state === 'member' && !member.isSelf,
              ).length,
              convoyAsks: snapshot.convoy?.invitations.length ?? 0,
              busy: false,
              notice: snapshot.notice,
            }}
            onBuy={(service) => client.buy(service)}
            onLaunch={() => {
              flightAudio()?.launch();
              void client.launch();
            }}
            onOpenChart={() => setChartOpen(true)}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenStaple={() => setStapleOpen(true)}
            onOpenYard={() => {
              setYardOpen(true);
              endorsed('yard');
            }}
            onOpenMoorings={() => setMooringsOpen(true)}
            onOpenBourse={() => {
              setBourseOpen(true);
              endorsed('bourse');
            }}
            onOpenBoard={() => setBoardOpen(true)}
            onOpenOffers={() => setOffersOpen(true)}
            onOpenConvoy={() => setConvoyOpen(true)}
            hasYard={port.services.includes('yard')}
            hasMoorings={port.services.includes('moorings')}
            hasBourse={port.services.includes('bourse')}
            hasFactor={port.services.includes('factor')}
            standing={snapshot.standing}
          />
          {boardOpen && (
            <Board
              offers={snapshot.commissions?.board ?? []}
              held={snapshot.commissions?.held ?? []}
              berthName={snapshot.commissions?.berthName ?? port.name}
              ending={snapshot.commissions?.ending}
              convoyName={
                snapshot.convoy && snapshot.convoy.id !== '' ? snapshot.convoy.name : undefined
              }
              busy={false}
              notice={snapshot.notice}
              onTake={(id) => void client.takeCommission(id)}
              onAbandon={(id) => void client.abandonCommission(id)}
              onShare={(id, shared) => void client.shareCommission(id, shared)}
              onChooseEnding={(chain, choice, name) =>
                void client.chooseChainEnding(chain, choice, name)
              }
              onClose={() => setBoardOpen(false)}
            />
          )}
          {offersOpen && (
            <Offers
              state={
                snapshot.offers ?? {
                  offers: [],
                  alongside: [],
                  hold: [],
                  designs: [],
                  holdCapacity: 0,
                  holdUsed: 0,
                }
              }
              hold={snapshot.offers?.hold ?? []}
              designs={snapshot.offers?.designs ?? []}
              marks={purse.marks}
              berthName={port.name}
              owner={port.owner}
              busy={false}
              notice={snapshot.notice}
              onOffer={(offer) => void client.offerTrade(offer)}
              onAnswer={(id, accept) => void client.answerOffer(id, accept)}
              onClose={() => setOffersOpen(false)}
            />
          )}
          {convoyOpen && (
            <Convoy
              convoy={
                snapshot.convoy ?? {
                  id: '',
                  name: '',
                  isLeader: false,
                  members: [],
                  invitations: [],
                  limit: 8,
                }
              }
              busy={false}
              notice={snapshot.notice}
              onInvite={(callsign) => void client.inviteToConvoy(callsign)}
              onAnswer={(fleetId, accept) => void client.answerConvoy(fleetId, accept)}
              onLeave={() => void client.leaveConvoy()}
              onRemove={(callsign) => void client.leaveConvoy(callsign)}
              onClose={() => setConvoyOpen(false)}
            />
          )}
          {bourseOpen && (
            <Bourse
              listings={snapshot.bourse?.listings ?? []}
              news={snapshot.bourse?.news ?? []}
              standings={snapshot.bourse?.standings ?? []}
              marks={purse.marks}
              berthName={port.name}
              busy={false}
              notice={snapshot.notice}
              feeRate={snapshot.bourse?.feeRate ?? 0}
              maxPoolFraction={snapshot.bourse?.maxPoolFraction ?? 0}
              orders={snapshot.bourse?.orders ?? []}
              margin={snapshot.bourse?.margin}
              onTrade={(side, ticker, shares) => void client.deal(side, ticker, shares)}
              onPlaceOrder={(side, ticker, shares, limit, short) =>
                void client.placeOrder(side, ticker, shares, limit, short)
              }
              onCancelOrder={(id) => void client.cancelOrder(id)}
              onClose={() => setBourseOpen(false)}
            />
          )}
          {mooringsOpen && (
            <Moorings
              hulls={snapshot.yard?.ships ?? []}
              flyingId={snapshot.yard?.flyingId ?? ''}
              flyingName={snapshot.yard?.flyingName ?? purse.draught}
              portId={port.id}
              berthName={port.name}
              busy={false}
              notice={snapshot.notice}
              onSwitch={(id) => void client.switchShip(id)}
              onClose={() => setMooringsOpen(false)}
            />
          )}
          {yardOpen && (
            <Editor
              flying={snapshot.yard?.flying ?? []}
              flyingId={snapshot.yard?.flyingId ?? ''}
              flyingName={snapshot.yard?.flyingName ?? purse.draught}
              licence={purse.licence}
              marks={purse.marks}
              stock={snapshot.yard?.stock ?? {}}
              berthName={snapshot.yard?.berthName ?? port.name}
              owner={snapshot.yard?.owner ?? port.owner}
              licences={snapshot.yard?.licences ?? []}
              staple={snapshot.staple}
              hold={hold}
              notice={snapshot.notice}
              serverProblems={snapshot.surveyProblems}
              busy={false}
              onBuild={(name, placements, refitting) =>
                // The editor decides this from the same `flyingId` it quotes
                // against, so the bill it showed is the bill that is charged.
                client.build(
                  name,
                  placements,
                  refitting ? snapshot.yard?.flyingId : undefined,
                )
              }
              onSave={(name, placements) => client.saveDesign(name, placements)}
              onTakeOut={(name, placements) => {
                // The Yard closes behind them: the range is a sky, not a
                // screen, and coming back reopens the counter where they
                // left it.
                setYardOpen(false);
                void client.enterRange(placements, name);
              }}
              onBuyLicence={(id) => void client.buyLicence(id)}
              onExport={(name, placements) => client.exportDesign(name, placements)}
              onImport={(code) => void client.importDesign(code)}
              onClose={() => setYardOpen(false)}
            />
          )}
          {stapleOpen && snapshot.staple && (
            <Staple
              state={snapshot.staple}
              marks={purse.marks}
              notice={snapshot.notice}
              busy={false}
              onTrade={(side, commodity, units) => {
                void client.trade(side, commodity, units).then((took) => {
                  if (took) endorsed(side === 'buy' ? 'buy' : 'sell');
                });
              }}
              onClose={() => setStapleOpen(false)}
            />
          )}
          <Hint which="staple" ready={stapleOpen && snapshot.staple !== undefined} />
          <Hint which="yard" ready={yardOpen} />
          <Hint which="moorings" ready={mooringsOpen} />
          <Hint which="bourse" ready={bourseOpen} />
          {/*
            The Register is a section of the Bourse rather than a screen of
            its own, so its note waits until the Bourse's has been settled:
            two notes stacked on one screen is worse than no note at all.
          */}
          <Hint which="register" ready={bourseOpen && bourseHinted} />
          <Hint which="factor" ready={boardOpen} />
          <Hint which="offers" ready={offersOpen} />
          <Hint which="convoy" ready={convoyOpen} />
          <Hint which="chart" ready={chartOpen} />
          <Pilotage ticket={ticket} onWaive={waive} />
          {chatOverlay}
          {chartOverlay}
        </>
      );
    }

    case 'flight':
      return (
        <>
          {snapshot.room && (
            <FlightView
              // The renderer bakes the palette into its textures and takes
              // the effect density at startup, so those two settings rebuild
              // it. Nobody is flying while the settings are open, and it is
              // the honest alternative to a repaint path used twice a year.
              key={`${snapshot.epoch}:${settings.palette}:${settings.quality}`}
              room={snapshot.room}
              purse={purse}
              notice={snapshot.notice}
              course={snapshot.course}
              courseName={
                snapshot.course === undefined
                  ? undefined
                  : chart?.byId.get(snapshot.course)?.name
              }
              convoy={convoyCallsigns}
              bindings={settings.bindings}
              onLand={(portId) => client.land(portId)}
              onOpenChart={() => setChartOpen(true)}
              onJump={() => client.jumpPlotted()}
              onCancelJump={() => client.cancelJump()}
              composing={composing}
            />
          )}
          {snapshot.range && (
            <RangeBanner
              range={snapshot.range}
              onSpar={(against) => void client.spar(against)}
              onLeave={() => void client.leaveRange()}
            />
          )}
          {/*
            The ticket sits bottom left, where the instruments are not, and
            only while something is still owed. Not on the range: nothing
            there is the captain's, so nothing there is endorsed.
          */}
          {!snapshot.range && <Pilotage ticket={ticket} onWaive={waive} />}
          <Hint which="chart" ready={chartOpen} />
          <Hint which="range" ready={snapshot.range !== undefined} />
          {chatOverlay}
          {chartOverlay}
        </>
      );

    case 'failed':
      return (
        <Failure
          heading={mode.heading}
          body={mode.body}
          detail={mode.detail}
          onRetry={mode.canRetry ? () => client.retry() : undefined}
        />
      );
  }
}

function Waiting({ heading, detail }: { heading: string; detail: string }): React.JSX.Element {
  return (
    <main className="boot">
      <div className="boot__frame panel">
        <header className="panel-header">
          <div className="boot__brand">
            <h1 className="boot__title">Marque</h1>
            <span className="micro">Ship&apos;s terminal</span>
          </div>
          <span className="boot__badge boot__badge--wait">
            <span className="dot" />
            <span className="micro">Working</span>
          </span>
        </header>
        <div className="boot__body">
          <p className="boot__message">{heading}</p>
        </div>
        <footer className="boot__footer">
          <Field label="Terminal" value={detail} />
          <Field label="Build" value={BUILD_VERSION} />
        </footer>
      </div>
    </main>
  );
}

function Failure({
  heading,
  body,
  detail,
  onRetry,
}: {
  heading: string;
  body: string;
  detail: string;
  onRetry: (() => void) | undefined;
}): React.JSX.Element {
  return (
    <main className="boot">
      <div className="boot__frame panel">
        <header className="panel-header">
          <div className="boot__brand">
            <h1 className="boot__title">Marque</h1>
            <span className="micro">Ship&apos;s terminal</span>
          </div>
          <span className="boot__badge boot__badge--bad">
            <span className="dot" />
            <span className="micro">No link</span>
          </span>
        </header>

        <div className="boot__body">
          <div className="boot__failure">
            <h2>{heading}</h2>
            <p className="boot__message">{body}</p>
            <p className="boot__detail">
              <span className="micro boot__detail-label">Detail</span>
              <span className="boot__detail-text">{detail}</span>
            </p>
            {onRetry && (
              <button type="button" className="button button--primary" onClick={onRetry}>
                Try again
              </button>
            )}
          </div>
        </div>

        <footer className="boot__footer">
          <Field label="Terminal" value={SERVER_URL} />
          <Field label="Build" value={BUILD_VERSION} />
        </footer>
      </div>
    </main>
  );
}

function Field({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="boot__field">
      <span className="label">{label}</span>
      <span className="data boot__field-value">{value}</span>
    </div>
  );
}
