/**
 * The vista.
 *
 * A port seen from the berth: the planet below, its star, and the structure
 * you are tied to. Drawn procedurally into a canvas from the port's own
 * colours and a seed on its id, so every berth looks like itself and none of
 * it is a photograph.
 */

import { useEffect, useRef } from 'react';
import { Rng } from '@marque/shared';

import type { ChartPort, ChartSystem } from '../map/galaxy.ts';
import { darken, lighten, mix, palette, parseHex, rgb } from '../flight/palette.ts';

export function PortVista({
  port,
  system,
}: {
  port: ChartPort;
  system: ChartSystem;
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = (): void => {
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width === 0 || height === 0) return;

      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const p = palette();
      const rng = new Rng(`vista:${system.id}:${port.id}`);

      // Space.
      ctx.fillStyle = css(p.void);
      ctx.fillRect(0, 0, width, height);

      // Stars.
      for (let i = 0; i < 260; i++) {
        const x = rng.range(0, width);
        const y = rng.range(0, height * 0.75);
        const brightness = rng.range(0.25, 0.9);
        ctx.fillStyle = `rgba(221,227,236,${brightness})`;
        ctx.fillRect(x, y, 1, 1);
      }

      // The nebula of the region, a faint wash near the horizon.
      const hue =
        system.region === 'concessions'
          ? p.nebulaConcessions
          : system.region === 'marque'
            ? p.nebulaMarque
            : p.nebulaHomeRoads;
      const wash = ctx.createLinearGradient(0, height * 0.2, 0, height * 0.8);
      const [hr, hg, hb] = rgb(hue);
      wash.addColorStop(0, `rgba(${hr},${hg},${hb},0)`);
      wash.addColorStop(1, `rgba(${hr},${hg},${hb},0.18)`);
      ctx.fillStyle = wash;
      ctx.fillRect(0, 0, width, height);

      // The planet, filling the lower part of the frame: a limb, not a disc,
      // because the berth is in orbit above it.
      const surface = parseHex(ownerColour(port.owner)) ?? 0x8fa2b8;
      const horizonY = height * 0.78;
      const radius = width * 1.3;
      const cx = width / 2;
      const cy = horizonY + radius;

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.clip();

      const body = ctx.createLinearGradient(0, horizonY, 0, height);
      body.addColorStop(0, css(lighten(surface, 0.12)));
      body.addColorStop(0.5, css(surface));
      body.addColorStop(1, css(darken(surface, 0.55)));
      ctx.fillStyle = body;
      ctx.fillRect(0, horizonY - 2, width, height - horizonY + 2);

      // Banding, so the surface is not a flat sweep.
      for (let i = 0; i < 9; i++) {
        const y = horizonY + rng.range(4, height - horizonY);
        const thickness = rng.range(2, 9);
        ctx.fillStyle = `rgba(0,0,0,${rng.range(0.04, 0.12)})`;
        ctx.fillRect(0, y, width, thickness);
      }

      // Night-side lights where people live.
      if (port.owner !== 'unlettered') {
        const [lr, lg, lb] = rgb(mix(p.amber, 0xffd9a0, 0.4));
        for (let i = 0; i < 90; i++) {
          const x = rng.range(0, width);
          const y = horizonY + rng.range(10, (height - horizonY) * 0.8);
          ctx.fillStyle = `rgba(${lr},${lg},${lb},${rng.range(0.15, 0.6)})`;
          ctx.fillRect(x, y, 1, 1);
        }
      }
      ctx.restore();

      // Atmosphere along the limb.
      const halo = ctx.createLinearGradient(0, horizonY - 26, 0, horizonY + 6);
      halo.addColorStop(0, `rgba(${hr},${hg},${hb},0)`);
      halo.addColorStop(1, `rgba(${hr},${hg},${hb},0.5)`);
      ctx.fillStyle = halo;
      ctx.fillRect(0, horizonY - 26, width, 32);

      // The berth itself: a gantry across the foreground, lit from the star.
      const structure = darken(p.rule, 0.25);
      ctx.fillStyle = css(structure);
      ctx.fillRect(0, height - 54, width, 10);
      ctx.fillStyle = css(darken(structure, 0.4));
      ctx.fillRect(0, height - 44, width, 4);

      for (let x = 18; x < width; x += 96) {
        ctx.fillStyle = css(structure);
        ctx.fillRect(x, height - 54, 12, 54);
        ctx.fillStyle = css(lighten(structure, 0.18));
        ctx.fillRect(x, height - 54, 2, 54);
        // A lit window or two per mast.
        ctx.fillStyle = css(p.amber);
        ctx.globalAlpha = 0.75;
        ctx.fillRect(x + 4, height - 44 + rng.range(4, 30), 4, 3);
        ctx.globalAlpha = 1;
      }

      // The system's star, low and hard.
      const starX = width * 0.76;
      const starY = height * 0.18;
      const glow = ctx.createRadialGradient(starX, starY, 0, starX, starY, 120);
      glow.addColorStop(0, 'rgba(255,255,255,0.85)');
      glow.addColorStop(0.18, `rgba(240,210,160,0.4)`);
      glow.addColorStop(1, 'rgba(240,210,160,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(starX - 130, starY - 130, 260, 260);
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [port, system]);

  return <canvas ref={canvasRef} className="port__vista" aria-hidden="true" />;
}

function ownerColour(owner: string): string {
  switch (owner) {
    case 'kessler':
      return '#E9E2D0';
    case 'thirty':
      return '#3A6FD8';
    case 'reprisal':
      return '#2FA596';
    case 'unlettered':
      return '#4A525E';
    default:
      return '#8FA2B8';
  }
}

function css(colour: number): string {
  const [r, g, b] = rgb(colour);
  return `rgb(${r},${g},${b})`;
}
