import type { StaticAssetManifest } from '../../protocol/index';
import { formatAssetUrl } from '../appearance';

export type EffectBlendMode = 'normal' | 'additive' | 'screen';
export type EffectAnchorTarget = 'target' | 'actor' | 'screen';

/** 與 `@pixi/particle-emitter` V3 JSON 相容的粒子發射器描述。 */
export interface ParticleBehaviorConfig {
  type: 'alpha' | 'scale' | 'color' | 'moveSpeed' | 'rotationStatic';
  config: {
    start?: number | string;
    end?: number | string;
    list?: Array<{ value: number | string; time: number }>;
    min?: number;
    max?: number;
  };
}

export interface ParticleEmitterScript {
  lifetime: { min: number; max: number };
  frequency: number;
  emitterLifetime: number;
  maxParticles: number;
  particlesPerWave?: number;
  pos?: { x: number; y: number };
  gravityY?: number;
  behaviors: ParticleBehaviorConfig[];
}

export interface SequenceFramesScript {
  /** FX12 動態讀取 `/assets/spells/{spellId}/manifest.json`（腳本本身不含像素）。 */
  spellId: string;
  blend?: EffectBlendMode;
  tint?: string;
  scale?: number;
  fps?: number;
  anchorTarget?: EffectAnchorTarget;
}

export interface EffectScript {
  id: string;
  label: string;
  /** 若由原版技能對應而來，以技能 ID 區分，避免不同技能共用同一特效而無辨識度。 */
  skillIds?: number[];
  /** 可選的動畫/特效代號比對（如 `sp126`、`c001`）。 */
  effectIds?: string[];
  frames?: SequenceFramesScript;
  particles?: {
    anchorTarget?: EffectAnchorTarget;
    blend?: EffectBlendMode;
    config: ParticleEmitterScript;
  };
  hitFlash?: { color: string; durationMs: number };
  shakePx?: number;
  durationMs: number;
}

export interface SpellManifestFrame {
  file?: string;
  atlas?: string;
  x?: number;
  y?: number;
  w: number;
  h: number;
  draw_x: number;
  draw_y: number;
}

export interface RuntimeSpellManifest {
  name: string;
  frameCount: number;
  blend?: string;
  frames: SpellManifestFrame[];
}

export function resolveSpellManifestUrl(spellId: string, assets?: StaticAssetManifest): string {
  const tpl = assets?.paths.spellManifest ?? '/assets/spells/{spellId}/manifest.json';
  return formatAssetUrl(tpl, { spellId });
}

export function resolveSpellFrameUrl(
  spellId: string,
  relFile: string,
  assets?: StaticAssetManifest,
): string {
  const tpl = assets?.paths.spellAtlas ?? '/assets/spells/{spellId}/{atlasFile}';
  return formatAssetUrl(tpl, { spellId, atlasFile: relFile, file: relFile });
}

export function isValidEffectScript(script: unknown): script is EffectScript {
  if (!script || typeof script !== 'object') return false;
  const s = script as Record<string, unknown>;
  if (typeof s.id !== 'string' || !s.id.trim()) return false;
  if (typeof s.label !== 'string' || !s.label.trim()) return false;
  if (typeof s.durationMs !== 'number' || s.durationMs <= 0) return false;
  if (!s.frames && !s.particles && !s.hitFlash) return false;
  return true;
}
