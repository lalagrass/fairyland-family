import { Container, Rectangle, Sprite, Texture, type BLEND_MODES } from 'pixi.js';
import type { StaticAssetManifest } from '../../protocol/index';
import { createParticleOverlay } from './particleEmitter';
import {
  resolveSpellFrameUrl,
  resolveSpellManifestUrl,
  type EffectBlendMode,
  type EffectScript,
  type RuntimeSpellManifest,
} from './schema';

function toPixiBlendMode(b?: EffectBlendMode): BLEND_MODES {
  switch (b) {
    case 'additive':
      return 'add';
    case 'screen':
      return 'screen';
    default:
      return 'normal';
  }
}

function parseHexTint(raw?: string): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw.replace(/^#/, ''), 16);
  return Number.isFinite(n) ? n : null;
}

/**
 * 統一特效播放器（序列幀＋粒子＋混色＋色調）：
 * 原版 FX12 `/assets/spells/{spellId}/manifest.json` 與純 JSON 粒子腳本共用同一條管線。
 */
export class EffectPlayer {
  private spellManifests = new Map<string, RuntimeSpellManifest | null>();
  private spellInflight = new Map<string, Promise<RuntimeSpellManifest | null>>();

  preloadSpell(spellId: string, assets?: StaticAssetManifest): Promise<RuntimeSpellManifest | null> {
    if (!spellId) return Promise.resolve(null);
    if (this.spellManifests.has(spellId)) {
      return Promise.resolve(this.spellManifests.get(spellId) ?? null);
    }
    const running = this.spellInflight.get(spellId);
    if (running) return running;
    if (typeof fetch !== 'function') return Promise.resolve(null);

    const url = resolveSpellManifestUrl(spellId, assets);
    const p = fetch(url)
      .then(res => (res.ok ? (res.json() as Promise<RuntimeSpellManifest>) : null))
      .then(data => {
        this.spellManifests.set(spellId, data);
        this.spellInflight.delete(spellId);
        return data;
      })
      .catch(() => {
        this.spellManifests.set(spellId, null);
        this.spellInflight.delete(spellId);
        return null;
      });
    this.spellInflight.set(spellId, p);
    return p;
  }

  renderEffect(
    script: EffectScript,
    elapsedMs: number,
    positions: { actor: { x: number; y: number }; target: { x: number; y: number }; center: { x: number; y: number } },
    seed: number,
    assets: StaticAssetManifest | undefined,
    getTexture: (url: string) => Texture | null,
  ): Container {
    const root = new Container();

    const anchorPos = (who?: 'actor' | 'target' | 'screen') => {
      if (who === 'actor') return positions.actor;
      if (who === 'screen') return positions.center;
      return positions.target;
    };

    // 1. 序列幀層（執行時讀 FX12 spell manifest）
    if (script.frames) {
      const fSpec = script.frames;
      const manifest = this.spellManifests.get(fSpec.spellId);
      if (!manifest && !this.spellManifests.has(fSpec.spellId)) {
        void this.preloadSpell(fSpec.spellId, assets);
      }
      if (manifest && manifest.frames.length > 0) {
        const fps = fSpec.fps ?? 12;
        const idx = Math.min(manifest.frames.length - 1, Math.max(0, Math.floor((elapsedMs * fps) / 1000)));
        const frame = manifest.frames[idx];
        const relFile = frame?.atlas ?? frame?.file;
        const baseTex = relFile ? getTexture(resolveSpellFrameUrl(fSpec.spellId, relFile, assets)) : null;
        if (frame && baseTex) {
          let tex = baseTex;
          if (frame.atlas && frame.w > 0 && frame.h > 0) {
            tex = new Texture({
              source: baseTex.source,
              frame: new Rectangle(
                Math.max(0, frame.x ?? 0),
                Math.max(0, frame.y ?? 0),
                Math.min(frame.w, baseTex.width),
                Math.min(frame.h, baseTex.height),
              ),
            });
          }
          const sp = new Sprite(tex);
          const pos = anchorPos(fSpec.anchorTarget);
          const scale = fSpec.scale ?? 1;
          sp.anchor.set(0.5, 0.5);
          sp.x = Math.round(pos.x);
          sp.y = Math.round(pos.y - 24);
          sp.scale.set(scale, scale);
          sp.blendMode = toPixiBlendMode(fSpec.blend);
          const tint = parseHexTint(fSpec.tint);
          if (tint !== null) sp.tint = tint;
          root.addChild(sp);
        }
      }
    }

    // 2. 粒子層（PixiJS v8 粒子模擬器）
    if (script.particles) {
      const pPos = anchorPos(script.particles.anchorTarget);
      const overlay = createParticleOverlay(
        script.particles.config,
        seed,
        elapsedMs / 1000,
        pPos.x,
        pPos.y - 22,
        toPixiBlendMode(script.particles.blend),
      );
      root.addChild(overlay);
    }

    return root;
  }
}
