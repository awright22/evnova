/**
 * Settings.
 *
 * Spec section 13 lists what has to be here: key and gamepad bindings, the
 * four volume controls, graphics quality, interface scale, reduced motion and
 * a colour-vision-safe palette. Every one of them takes effect as it is
 * changed rather than on a Save button — a volume a captain cannot hear
 * while they drag it is a volume they have to guess at.
 *
 * Keyboard alone throughout, like every screen: the binding cells are
 * buttons, and binding one is pressing it and then pressing the key.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { Volumes } from '../audio/mix.ts';
import { playNotice } from '../audio/notices.ts';
import {
  ACTIONS,
  ACTION_NAMES,
  DEFAULT_SETTINGS,
  SCALE_RANGE,
  type Action,
  type Settings as SettingsState,
} from './settings.ts';
import './shell.css';

/** What a key is called, where its code is not what a captain would say. */
const KEY_NAMES: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Space: 'Space',
  ShiftLeft: 'Left shift',
  ShiftRight: 'Right shift',
  Tab: 'Tab',
  Escape: 'Esc',
};

export function keyName(code: string): string {
  if (code === '') return '—';
  return KEY_NAMES[code] ?? code.replace(/^Key/, '').replace(/^Digit/, '');
}

export function Settings({
  settings,
  onChange,
  onClose,
}: {
  readonly settings: SettingsState;
  onChange: (next: SettingsState) => void;
  onClose: () => void;
}): React.JSX.Element {
  /** The cell waiting for a key, as `action:slot`, or nothing. */
  const [binding, setBinding] = useState<string | undefined>(undefined);
  const screen = useRef<HTMLElement | null>(null);

  useEffect(() => {
    screen.current?.focus();
  }, []);

  // While a cell is listening, the next key goes to it and nowhere else.
  useEffect(() => {
    if (binding === undefined) return undefined;

    const take = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      setBinding(undefined);
      if (event.code === 'Escape') return;

      const [action, slot] = binding.split(':') as [Action, string];
      const pair = [...settings.bindings[action]] as [string, string];
      pair[slot === '1' ? 1 : 0] = event.code;
      onChange({ ...settings, bindings: { ...settings.bindings, [action]: pair } });
    };

    window.addEventListener('keydown', take, { capture: true });
    return () => window.removeEventListener('keydown', take, { capture: true });
  }, [binding, onChange, settings]);

  const setVolume = useCallback(
    (bus: keyof Volumes, value: number) => {
      onChange({ ...settings, volumes: { ...settings.volumes, [bus]: value } });
      // Heard as it is dragged, on the bus being changed, so a captain is
      // setting a level rather than a number.
      playNotice(bus === 'interface' ? 'filled' : 'called');
    },
    [onChange, settings],
  );

  /** Which other actions a key is already bound to, so a clash is visible. */
  const clashes = (code: string, mine: Action): string[] => {
    if (code === '') return [];
    return ACTIONS.filter(
      (action) => action !== mine && settings.bindings[action].includes(code),
    ).map((action) => ACTION_NAMES[action]);
  };

  return (
    <main
      className="shell"
      ref={screen}
      tabIndex={-1}
      aria-label="Settings"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && binding === undefined) onClose();
      }}
    >
      <header className="shell__head panel">
        <h1>Settings</h1>
        <span className="micro">Kept on this device. Nothing here reaches the world.</span>
        <button type="button" className="button" onClick={onClose}>
          Back
        </button>
      </header>

      <section className="panel shell__block" aria-label="Sound">
        <header className="panel-header">
          <h2>Sound</h2>
          <span className="micro">Four buses, as the spec asks</span>
        </header>
        <div className="shell__rows">
          {(['master', 'music', 'effects', 'interface'] as const).map((bus) => (
            <label key={bus} className="shell__row">
              <span className="label">{bus === 'interface' ? 'Interface' : bus}</span>
              <input
                className="shell__slider"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={settings.volumes[bus]}
                onChange={(event) => setVolume(bus, Number(event.target.value))}
              />
              <span className="data shell__figure">
                {Math.round(settings.volumes[bus] * 100)}%
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="panel shell__block" aria-label="The screen">
        <header className="panel-header">
          <h2>The screen</h2>
        </header>
        <div className="shell__rows">
          <label className="shell__row">
            <span className="label">Interface scale</span>
            <input
              className="shell__slider"
              type="range"
              min={SCALE_RANGE.min}
              max={SCALE_RANGE.max}
              step={0.05}
              value={settings.scale}
              onChange={(event) => onChange({ ...settings, scale: Number(event.target.value) })}
            />
            <span className="data shell__figure">{Math.round(settings.scale * 100)}%</span>
          </label>

          <Choice
            label="Motion"
            value={settings.motion}
            options={[
              ['system', 'As the browser asks'],
              ['reduced', 'Held back'],
              ['full', 'All of it'],
            ]}
            onPick={(motion) => onChange({ ...settings, motion })}
            note="Gameplay motion is never reduced; this is the interface."
          />

          <Choice
            label="Palette"
            value={settings.palette}
            options={[
              ['livery', 'Company liveries'],
              ['safe', 'Colour-vision safe'],
            ]}
            onPick={(palette) => onChange({ ...settings, palette })}
            note="Nothing is ever told by colour alone, either way."
          />

          <Choice
            label="Effects"
            value={settings.quality}
            options={[
              ['full', 'Everything'],
              ['plain', 'Plain'],
            ]}
            onPick={(quality) => onChange({ ...settings, quality })}
            note="Plain thins the particles and the bloom. It changes nothing a hull does."
          />
        </div>
      </section>

      <section className="panel shell__block shell__block--wide" aria-label="Keys">
        <header className="panel-header">
          <h2>Keys</h2>
          <span className="micro">
            {binding === undefined
              ? 'Press a key cell, then the key you want'
              : 'Press a key, or Esc to leave it alone'}
          </span>
        </header>
        <table className="shell__keys">
          <thead>
            <tr>
              <th scope="col">Action</th>
              <th scope="col">Key</th>
              <th scope="col">Or</th>
            </tr>
          </thead>
          <tbody>
            {ACTIONS.map((action) => (
              <tr key={action}>
                <th scope="row">{ACTION_NAMES[action]}</th>
                {[0, 1].map((slot) => {
                  const code = settings.bindings[action][slot] ?? '';
                  const taken = clashes(code, action);
                  const id = `${action}:${slot}`;
                  return (
                    <td key={slot}>
                      <button
                        type="button"
                        className={`shell__key${binding === id ? ' shell__key--listening' : ''}${
                          taken.length > 0 ? ' shell__key--clash' : ''
                        }`}
                        title={taken.length > 0 ? `Also ${taken.join(', ').toLowerCase()}` : undefined}
                        onClick={() => setBinding(binding === id ? undefined : id)}
                      >
                        {binding === id ? 'Press a key' : keyName(code)}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <footer className="shell__foot">
          <button
            type="button"
            className="button"
            onClick={() => onChange({ ...settings, bindings: DEFAULT_SETTINGS.bindings })}
          >
            Back to the standard keys
          </button>
          <span className="micro">
            A gamepad is read as well as the keys, with the same actions on the sticks and
            the face buttons.
          </span>
        </footer>
      </section>
    </main>
  );
}

/** A small set of named choices, as a segmented control. */
function Choice<T extends string>({
  label,
  value,
  options,
  note,
  onPick,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly (readonly [T, string])[];
  readonly note?: string;
  onPick: (value: T) => void;
}): React.JSX.Element {
  return (
    <div className="shell__row shell__row--choice">
      <span className="label">{label}</span>
      <div className="shell__choices" role="group" aria-label={label}>
        {options.map(([option, name]) => (
          <button
            key={option}
            type="button"
            className={`shell__choice${option === value ? ' shell__choice--on' : ''}`}
            aria-pressed={option === value}
            onClick={() => onPick(option)}
          >
            {name}
          </button>
        ))}
      </div>
      {note !== undefined && <span className="micro shell__note">{note}</span>}
    </div>
  );
}
