/**
 * Combat effects.
 *
 * Pooled particles drawn into a handful of Graphics objects rather than a
 * display object each: the budget is three thousand particles on screen, and a
 * container with three thousand children costs more in transform maths than
 * the drawing does.
 *
 * Every recipe here follows the one in `docs/ART_DIRECTION.md`. Effects are
 * presentation: nothing in this file decides an outcome.
 */

import { Container, Graphics } from 'pixi.js';
import { Rng, clamp } from '@marque/shared';

import { PX_PER_UNIT } from './camera.ts';
import { mix, palette } from './palette.ts';

type ParticleKind = 'spark' | 'fireball' | 'smoke' | 'debris';

interface Particle {
  active: boolean;
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ageMs: number;
  lifeMs: number;
  size: number;
  spin: number;
  angle: number;
  colour: number;
}

interface Ripple {
  active: boolean;
  x: number;
  y: number;
  ageMs: number;
  lifeMs: number;
  radius: number;
  /** Direction of the impact, so the ripple opens where the round struck. */
  normal: number;
  colour: number;
}

interface Shockwave {
  active: boolean;
  x: number;
  y: number;
  ageMs: number;
  lifeMs: number;
  maxRadius: number;
}

/** Hard ceiling so a long fight cannot grow the pool without bound. */
const MAX_PARTICLES = 3000;
const MAX_RIPPLES = 64;
const MAX_SHOCKWAVES = 24;

export class Effects {
  readonly view = new Container();

  private readonly additive = new Graphics();
  private readonly normal = new Graphics();

  private readonly particles: Particle[] = [];
  private readonly ripples: Ripple[] = [];
  private readonly shockwaves: Shockwave[] = [];
  private readonly rng: Rng;

  /** Where the pool resumes scanning, so spawning stays O(1) amortised. */
  private cursor = 0;

  constructor(seed = 'effects') {
    this.rng = new Rng(seed);
    this.additive.blendMode = 'add';
    // Smoke and debris are solid; flame and sparks are light.
    this.view.addChild(this.normal, this.additive);

    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles.push({
        active: false,
        kind: 'spark',
        x: 0, y: 0, vx: 0, vy: 0,
        ageMs: 0, lifeMs: 0, size: 1, spin: 0, angle: 0,
        colour: 0xffffff,
      });
    }
    for (let i = 0; i < MAX_RIPPLES; i++) {
      this.ripples.push({ active: false, x: 0, y: 0, ageMs: 0, lifeMs: 0, radius: 0, normal: 0, colour: 0 });
    }
    for (let i = 0; i < MAX_SHOCKWAVES; i++) {
      this.shockwaves.push({ active: false, x: 0, y: 0, ageMs: 0, lifeMs: 0, maxRadius: 0 });
    }
  }

  get activeCount(): number {
    return this.particles.reduce((n, p) => n + (p.active ? 1 : 0), 0);
  }

  // --- Recipes ------------------------------------------------------------

  /** A round stopped by shields: a ripple at the impact point. */
  shieldHit(x: number, y: number, normal: number): void {
    const ripple = this.takeRipple();
    if (!ripple) return;
    const p = palette();
    ripple.active = true;
    ripple.x = x;
    ripple.y = y;
    ripple.ageMs = 0;
    ripple.lifeMs = 180;
    ripple.radius = 26;
    ripple.normal = normal;
    ripple.colour = p.shield;
  }

  /** A round that reached the hull: sparks and a one-frame flash. */
  hullHit(x: number, y: number, normal: number): void {
    const p = palette();
    for (let i = 0; i < 10; i++) {
      const particle = this.take();
      if (!particle) break;
      const spread = this.rng.range(-1.1, 1.1);
      const speed = this.rng.range(40, 170);
      particle.active = true;
      particle.kind = 'spark';
      particle.x = x;
      particle.y = y;
      particle.vx = Math.cos(normal + spread) * speed;
      particle.vy = Math.sin(normal + spread) * speed;
      particle.ageMs = 0;
      particle.lifeMs = this.rng.range(140, 220);
      particle.size = this.rng.range(0.7, 1.6);
      particle.colour = mix(p.amberBright, 0xffffff, this.rng.next() * 0.6);
    }

    // The flash is a very short, very bright spark at the point itself.
    const flash = this.take();
    if (flash) {
      flash.active = true;
      flash.kind = 'spark';
      flash.x = x;
      flash.y = y;
      flash.vx = 0;
      flash.vy = 0;
      flash.ageMs = 0;
      flash.lifeMs = 60;
      flash.size = 4;
      flash.colour = 0xffffff;
    }
  }

  /**
   * A hull written off, in stages: flash, fireball, sparks, debris,
   * shockwave, smoke. Durations scale with the hull's size.
   */
  explosion(x: number, y: number, vx: number, vy: number, hullSize: number): void {
    const p = palette();
    const scale = 0.8 + 0.4 * clamp(hullSize, 0, 2);

    // Flash.
    const flash = this.take();
    if (flash) {
      flash.active = true;
      flash.kind = 'spark';
      flash.x = x;
      flash.y = y;
      flash.vx = 0;
      flash.vy = 0;
      flash.ageMs = 0;
      flash.lifeMs = 70;
      flash.size = 16 * scale;
      flash.colour = 0xffffff;
    }

    // Fireball.
    for (let i = 0; i < 22; i++) {
      const particle = this.take();
      if (!particle) break;
      const bearing = this.rng.range(-Math.PI, Math.PI);
      const speed = this.rng.range(10, 80) * scale;
      particle.active = true;
      particle.kind = 'fireball';
      particle.x = x + Math.cos(bearing) * this.rng.range(0, 8);
      particle.y = y + Math.sin(bearing) * this.rng.range(0, 8);
      particle.vx = vx * 0.3 + Math.cos(bearing) * speed;
      particle.vy = vy * 0.3 + Math.sin(bearing) * speed;
      particle.ageMs = 0;
      particle.lifeMs = this.rng.range(180, 260) * scale;
      particle.size = this.rng.range(5, 13) * scale;
      particle.colour = mix(p.amberBright, p.danger, this.rng.next());
    }

    // Sparks.
    for (let i = 0; i < 30; i++) {
      const particle = this.take();
      if (!particle) break;
      const bearing = this.rng.range(-Math.PI, Math.PI);
      const speed = this.rng.range(60, 280) * scale;
      particle.active = true;
      particle.kind = 'spark';
      particle.x = x;
      particle.y = y;
      particle.vx = vx * 0.2 + Math.cos(bearing) * speed;
      particle.vy = vy * 0.2 + Math.sin(bearing) * speed;
      particle.ageMs = 0;
      particle.lifeMs = this.rng.range(320, 500);
      particle.size = this.rng.range(0.8, 1.8);
      particle.colour = mix(p.amberBright, 0xffffff, this.rng.next() * 0.5);
    }

    // Tumbling debris, shaped like the module tiles it came from.
    const pieces = 4 + Math.floor(this.rng.next() * 6);
    for (let i = 0; i < pieces; i++) {
      const particle = this.take();
      if (!particle) break;
      const bearing = this.rng.range(-Math.PI, Math.PI);
      const speed = this.rng.range(20, 90) * scale;
      particle.active = true;
      particle.kind = 'debris';
      particle.x = x;
      particle.y = y;
      particle.vx = vx * 0.6 + Math.cos(bearing) * speed;
      particle.vy = vy * 0.6 + Math.sin(bearing) * speed;
      particle.ageMs = 0;
      particle.lifeMs = 2500;
      particle.size = this.rng.range(2.5, 6) * scale;
      particle.angle = this.rng.range(-Math.PI, Math.PI);
      particle.spin = this.rng.range(-3, 3);
      particle.colour = mix(p.textMuted, p.rule, this.rng.next());
    }

    // Shockwave.
    const wave = this.shockwaves.find((w) => !w.active);
    if (wave) {
      wave.active = true;
      wave.x = x;
      wave.y = y;
      wave.ageMs = 0;
      wave.lifeMs = 320;
      wave.maxRadius = 120 * scale;
    }

    // Smoke, drifting and fading.
    for (let i = 0; i < 14; i++) {
      const particle = this.take();
      if (!particle) break;
      const bearing = this.rng.range(-Math.PI, Math.PI);
      particle.active = true;
      particle.kind = 'smoke';
      particle.x = x;
      particle.y = y;
      particle.vx = vx * 0.25 + Math.cos(bearing) * this.rng.range(4, 26);
      particle.vy = vy * 0.25 + Math.sin(bearing) * this.rng.range(4, 26);
      particle.ageMs = 0;
      particle.lifeMs = this.rng.range(1200, 1800);
      particle.size = this.rng.range(8, 20) * scale;
      particle.colour = 0x151a22;
    }
  }

  // --- Update and draw ----------------------------------------------------

  update(dtMs: number): void {
    const dt = dtMs / 1000;

    this.additive.clear();
    this.normal.clear();

    for (const particle of this.particles) {
      if (!particle.active) continue;
      particle.ageMs += dtMs;
      if (particle.ageMs >= particle.lifeMs) {
        particle.active = false;
        continue;
      }

      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.angle += particle.spin * dt;

      // Sparks and debris keep their momentum; fireball and smoke slow as
      // they expand, which is what makes them read as gas rather than shot.
      if (particle.kind === 'fireball' || particle.kind === 'smoke') {
        const drag = Math.exp(-1.6 * dt);
        particle.vx *= drag;
        particle.vy *= drag;
      }

      this.draw(particle);
    }

    for (const ripple of this.ripples) {
      if (!ripple.active) continue;
      ripple.ageMs += dtMs;
      if (ripple.ageMs >= ripple.lifeMs) {
        ripple.active = false;
        continue;
      }
      const t = ripple.ageMs / ripple.lifeMs;
      const radius = ripple.radius * (0.4 + t * 1.3) * PX_PER_UNIT;
      const cx = ripple.x * PX_PER_UNIT;
      const cy = ripple.y * PX_PER_UNIT;
      const from = ripple.normal - 1.1;
      const to = ripple.normal + 1.1;

      // An arc rather than a full ring: the shield flexes where it was struck.
      // `arc` continues the current path, so without moving to its start first
      // it draws a chord back from wherever the path last was.
      this.additive
        .moveTo(cx + Math.cos(from) * radius, cy + Math.sin(from) * radius)
        .arc(cx, cy, radius, from, to)
        .stroke({ width: 2 * (1 - t) + 0.5, color: ripple.colour, alpha: 0.8 * (1 - t) });
    }

    for (const wave of this.shockwaves) {
      if (!wave.active) continue;
      wave.ageMs += dtMs;
      if (wave.ageMs >= wave.lifeMs) {
        wave.active = false;
        continue;
      }
      const t = wave.ageMs / wave.lifeMs;
      this.additive
        .circle(wave.x * PX_PER_UNIT, wave.y * PX_PER_UNIT, wave.maxRadius * t * PX_PER_UNIT)
        .stroke({ width: 1, color: palette().amberBright, alpha: 0.45 * (1 - t) });
    }
  }

  private draw(particle: Particle): void {
    const t = particle.ageMs / particle.lifeMs;
    const px = particle.x * PX_PER_UNIT;
    const py = particle.y * PX_PER_UNIT;

    switch (particle.kind) {
      case 'spark': {
        const size = particle.size * (1 - t * 0.6) * PX_PER_UNIT;
        this.additive.rect(px - size / 2, py - size / 2, size, size).fill({
          color: particle.colour,
          alpha: 1 - t,
        });
        break;
      }
      case 'fireball': {
        const size = particle.size * (0.6 + t * 0.9) * PX_PER_UNIT;
        this.additive.circle(px, py, size).fill({ color: particle.colour, alpha: 0.7 * (1 - t) });
        break;
      }
      case 'smoke': {
        const size = particle.size * (0.5 + t * 1.5) * PX_PER_UNIT;
        this.normal.circle(px, py, size).fill({ color: particle.colour, alpha: 0.3 * (1 - t) });
        break;
      }
      case 'debris': {
        const size = particle.size * PX_PER_UNIT;
        const cos = Math.cos(particle.angle);
        const sin = Math.sin(particle.angle);
        const h = size / 2;
        // A tumbling rectangle: module-shaped, as the art direction asks.
        this.normal
          .moveTo(px + (-h * cos - -h * sin), py + (-h * sin + -h * cos))
          .lineTo(px + (h * cos - -h * sin), py + (h * sin + -h * cos))
          .lineTo(px + (h * cos - h * sin), py + (h * sin + h * cos))
          .lineTo(px + (-h * cos - h * sin), py + (-h * sin + h * cos))
          .closePath()
          .fill({ color: particle.colour, alpha: 1 - t * t });
        break;
      }
    }
  }

  private take(): Particle | undefined {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const index = (this.cursor + i) % MAX_PARTICLES;
      const particle = this.particles[index]!;
      if (!particle.active) {
        this.cursor = (index + 1) % MAX_PARTICLES;
        return particle;
      }
    }
    // Pool exhausted: drop the effect rather than grow without bound.
    return undefined;
  }

  private takeRipple(): Ripple | undefined {
    return this.ripples.find((r) => !r.active);
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}
