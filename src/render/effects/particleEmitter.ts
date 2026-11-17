import { Container, Graphics, type BLEND_MODES } from 'pixi.js';
import type { ParticleEmitterScript } from './schema';

export interface LiveParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  maxAge: number;
  startScale: number;
  endScale: number;
  startAlpha: number;
  endAlpha: number;
  startColor: number;
  endColor: number;
}

function parseHexColor(raw: string | number | undefined, fallback = 0xffffff): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw !== 'string') return fallback;
  const clean = raw.replace(/^#/, '');
  const n = Number.parseInt(clean, 16);
  return Number.isFinite(n) ? n : fallback;
}

function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

/**
 * 原生 PixiJS v8 粒子系統模擬器：
 * 採用與 `@pixi/particle-emitter` v3 JSON 相同的 `behaviors` 設定格式，
 * 避免 `@pixi/particle-emitter@5.0.10` 與 PixiJS v8 不相容的 peerDependencies 問題。
 */
export class ParticleSimulation {
  readonly particles: LiveParticle[] = [];
  private emitElapsed = 0;
  private emitCarry = 0;
  private rngState = 1337;

  constructor(private config: ParticleEmitterScript, seed = 1337) {
    this.rngState = seed || 1337;
    const wave = config.particlesPerWave ?? Math.min(8, config.maxParticles);
    this.spawnWave(wave);
  }

  private rand(): number {
    this.rngState = (this.rngState * 1664525 + 1013904223) >>> 0;
    return this.rngState / 0xffffffff;
  }

  private pickNum(behaviorType: 'scale' | 'alpha' | 'moveSpeed'): { start: number; end: number } {
    const b = this.config.behaviors.find(x => x.type === behaviorType);
    const start = typeof b?.config.start === 'number' ? b.config.start : behaviorType === 'moveSpeed' ? 120 : 1;
    const end = typeof b?.config.end === 'number' ? b.config.end : behaviorType === 'alpha' ? 0 : start;
    return { start, end };
  }

  private pickColors(): { start: number; end: number } {
    const b = this.config.behaviors.find(x => x.type === 'color');
    return {
      start: parseHexColor(b?.config.start, 0xffffff),
      end: parseHexColor(b?.config.end, 0xffd180),
    };
  }

  private spawnWave(count: number): void {
    const speed = this.pickNum('moveSpeed');
    const scale = this.pickNum('scale');
    const alpha = this.pickNum('alpha');
    const colors = this.pickColors();

    for (let i = 0; i < count; i += 1) {
      if (this.particles.length >= this.config.maxParticles) break;
      const angle = this.rand() * Math.PI * 2;
      const spd = speed.start * (0.6 + 0.8 * this.rand());
      const maxAge =
        this.config.lifetime.min +
        (this.config.lifetime.max - this.config.lifetime.min) * this.rand();
      this.particles.push({
        x: (this.config.pos?.x ?? 0) + (this.rand() - 0.5) * 10,
        y: (this.config.pos?.y ?? 0) + (this.rand() - 0.5) * 10,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd,
        age: 0,
        maxAge: Math.max(0.05, maxAge),
        startScale: scale.start,
        endScale: scale.end,
        startAlpha: alpha.start,
        endAlpha: alpha.end,
        startColor: colors.start,
        endColor: colors.end,
      });
    }
  }

  step(dtSec: number): void {
    const clamped = Math.max(0, Math.min(0.1, dtSec));
    this.emitElapsed += clamped;
    if (this.emitElapsed < this.config.emitterLifetime) {
      const freq = Math.max(0.005, this.config.frequency);
      this.emitCarry += clamped;
      while (this.emitCarry >= freq) {
        this.emitCarry -= freq;
        this.spawnWave(this.config.particlesPerWave ?? 4);
      }
    }

    const gravity = this.config.gravityY ?? 0;
    for (let i = this.particles.length - 1; i >= 0; i -= 1) {
      const p = this.particles[i];
      p.age += clamped;
      if (p.age >= p.maxAge) {
        this.particles.splice(i, 1);
        continue;
      }
      p.vy += gravity * clamped;
      p.vx *= 1 - Math.min(0.4, clamped * 1.8);
      p.vy *= 1 - Math.min(0.4, clamped * 1.8);
      p.x += p.vx * clamped;
      p.y += p.vy * clamped;
    }
  }

  renderToGraphics(g: Graphics, originX: number, originY: number, blendMode: BLEND_MODES): void {
    g.clear();
    g.blendMode = blendMode;
    for (const p of this.particles) {
      const t = Math.max(0, Math.min(1, p.age / p.maxAge));
      const radius = Math.max(1.5, 4.5 * (p.startScale + (p.endScale - p.startScale) * t));
      const alpha = Math.max(0, Math.min(1, p.startAlpha + (p.endAlpha - p.startAlpha) * t));
      const color = lerpColor(p.startColor, p.endColor, t);
      g.circle(originX + p.x, originY + p.y, radius).fill({ color, alpha });
    }
  }
}

export function createParticleOverlay(
  config: ParticleEmitterScript,
  seed: number,
  elapsedSec: number,
  originX: number,
  originY: number,
  blendMode: BLEND_MODES,
): Container {
  const sim = new ParticleSimulation(config, seed);
  const stepSize = 1 / 30;
  let remaining = Math.max(0, elapsedSec);
  while (remaining > 0.001) {
    const dt = Math.min(stepSize, remaining);
    sim.step(dt);
    remaining -= dt;
  }
  const c = new Container();
  const g = new Graphics();
  sim.renderToGraphics(g, originX, originY, blendMode);
  c.addChild(g);
  return c;
}
