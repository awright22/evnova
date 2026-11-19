/**
 * The radar scope.
 *
 * A circular instrument in the HUD's bottom-right: the hull at the centre,
 * contacts around it, and anything beyond range pinned to the rim so you can
 * still tell which way it lies. Drawn to a canvas in the flight loop rather
 * than through React, because it updates every frame.
 */

import type { SystemDef } from '@marque/shared';

import { palette, rgb } from '../flight/palette.ts';

/** World units the scope covers, edge to centre. */
export const RADAR_RANGE = 5200;

export interface RadarContact {
  readonly x: number;
  readonly y: number;
  readonly kind: 'ship' | 'port' | 'star';
  readonly isSelf: boolean;
}

export function drawRadar(
  canvas: HTMLCanvasElement,
  selfX: number,
  selfY: number,
  selfAngle: number,
  contacts: readonly RadarContact[],
  system: SystemDef,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const size = canvas.clientWidth;
  if (canvas.width !== Math.round(size * dpr)) {
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  const p = palette();
  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2 - 2;
  const scale = radius / RADAR_RANGE;

  // Well, rings and cardinal ticks: an instrument, not a minimap.
  ctx.fillStyle = css(p.void, 0.72);
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = css(p.rule, 1);
  ctx.lineWidth = 1;
  for (const fraction of [0.33, 0.66]) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius * fraction, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.strokeStyle = css(p.ruleStrong, 1);
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = css(p.rule, 0.8);
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (radius - 5), cy + Math.sin(a) * (radius - 5));
    ctx.lineTo(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
    ctx.stroke();
  }

  // Contacts. The scope is oriented to the world, not the hull, so a captain
  // keeps their bearings while turning.
  for (const contact of contacts) {
    if (contact.isSelf) continue;

    const dx = contact.x - selfX;
    const dy = contact.y - selfY;
    const distance = Math.hypot(dx, dy);

    const beyond = distance * scale > radius - 4;
    const factor = beyond ? (radius - 4) / (distance * scale) : 1;
    const px = cx + dx * scale * factor;
    const py = cy + dy * scale * factor;

    switch (contact.kind) {
      case 'star':
        ctx.fillStyle = css(p.amberDim, beyond ? 0.5 : 0.85);
        ctx.beginPath();
        ctx.arc(px, py, beyond ? 2 : 4, 0, Math.PI * 2);
        ctx.fill();
        break;

      case 'port':
        // A square: a place you can land, not a thing that moves.
        ctx.fillStyle = css(p.textSecondary, beyond ? 0.45 : 0.9);
        ctx.fillRect(px - 2.5, py - 2.5, 5, 5);
        break;

      case 'ship':
        ctx.fillStyle = css(p.textPrimary, beyond ? 0.45 : 1);
        ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
        break;
    }
  }

  // The hull itself: a hollow amber diamond pointing where it is pointing.
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(selfAngle);
  ctx.strokeStyle = css(p.amber, 1);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(5, 0);
  ctx.lineTo(-3, 3.5);
  ctx.lineTo(-3, -3.5);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();

  void system;
}

function css(colour: number, alpha: number): string {
  const [r, g, b] = rgb(colour);
  return `rgba(${r},${g},${b},${alpha})`;
}
