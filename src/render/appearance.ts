import type { SnapshotRampTint, StaticAssetManifest } from '../protocol/index';

export interface SpriteFrameInfo {
  file?: string;
  atlas?: string;
  x?: number;
  y?: number;
  w: number;
  h: number;
  draw_x: number;
  draw_y: number;
}

export interface SpriteLayerSpec {
  slot: string;
  key: string;
  zIndex?: number;
  tintable?: boolean;
  variant?: string;
}

export interface SpriteModelManifest {
  model: string;
  is_human?: boolean;
  canvas_w?: number;
  canvas_h?: number;
  center_x: number;
  center_y: number;
  pixelScale?: number;
  layers?: SpriteLayerSpec[];
  atlases?: string[];
  actions: Record<string, Record<string, { loop: number; speed: number; frames: number[] }>>;
  frames: Record<string, Record<string, SpriteFrameInfo>>;
}

export interface AppearanceInput {
  id: string;
  name: string;
  kind: 'player' | 'member' | 'npc';
  modelId: string;
  weaponModel?: string;
  tint?: SnapshotRampTint;
  action: number;
  dir: number;
  nowMs: number;
}

export interface AppearanceLayerPlan {
  slot: string;
  imageUrl: string;
  isAtlas: boolean;
  atlasX: number;
  atlasY: number;
  w: number;
  h: number;
  offsetX: number;
  offsetY: number;
  zIndex: number;
  tintColor?: string;
}

export interface AppearanceRenderPlan {
  providerId: string;
  modelId: string;
  resolvedAction: number;
  frameNumber: number;
  pixelScale: number;
  layers: AppearanceLayerPlan[];
  fallbackLabel: string;
}

export interface AppearanceProvider {
  readonly id: string;
  readonly label: string;
  resolveSpriteManifestUrl(modelId: string, assets?: StaticAssetManifest): string;
  resolveCharacter(
    input: AppearanceInput,
    manifest?: SpriteModelManifest | null,
    assets?: StaticAssetManifest,
  ): AppearanceRenderPlan;
}

const DEFAULT_SPRITE_MANIFEST = '/assets/sprites/{modelId}/manifest.json';
const DEFAULT_SPRITE_ATLAS = '/assets/sprites/{modelId}/{file}';

const ACTION_FALLBACKS: Record<number, number[]> = {
  0: [21, 0],
  1: [1, 2, 0],
  2: [2, 1, 0],
  4: [4, 0, 21],
  20: [20, 21, 0],
  21: [21, 0],
};

/** 把 FX12 的路徑樣板（例如 `/assets/sprites/{modelId}/{file}`）展開為同源 URL。 */
export function formatAssetUrl(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_all, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : `{${k}}`,
  );
}

function rgbTupleToHex(rgb?: [number, number, number]): string | undefined {
  if (!rgb) return undefined;
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${clamp(rgb[0])}${clamp(rgb[1])}${clamp(rgb[2])}`;
}

function pickActionAndFrame(
  manifest: SpriteModelManifest,
  requestedAction: number,
  dir: number,
  nowMs: number,
): { action: number; frame: number } {
  const dKey = String(((dir % 8) + 8) % 8);
  const candidates = ACTION_FALLBACKS[requestedAction] ?? [requestedAction, 0, 21];
  for (const act of candidates) {
    const seq = manifest.actions?.[String(act)]?.[dKey] ?? manifest.actions?.[String(act)]?.['0'];
    if (seq && seq.frames.length > 0) {
      const fps = Math.max(1, seq.speed || 8);
      const step = Math.floor((nowMs * fps) / 1000);
      const idx = seq.loop === 0 || seq.loop === 1
        ? step % seq.frames.length
        : Math.min(seq.frames.length - 1, step);
      return { action: act, frame: seq.frames[idx] };
    }
  }
  return { action: 0, frame: 1 };
}

function resolveLayers(
  manifest: SpriteModelManifest,
  weaponModel?: string,
): Array<{ slot: string; key: string; zIndex: number }> {
  if (manifest.layers && manifest.layers.length > 0) {
    const sorted = [...manifest.layers].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
    const out: Array<{ slot: string; key: string; zIndex: number }> = [];
    for (const spec of sorted) {
      if (!manifest.frames?.[spec.key]) continue;
      if (spec.slot === 'weapon') {
        if (!weaponModel) continue;
        if (spec.key !== weaponModel && spec.variant !== weaponModel) continue;
      } else if (spec.variant) {
        continue;
      }
      out.push({ slot: spec.slot, key: spec.key, zIndex: spec.zIndex ?? 0 });
    }
    if (out.length > 0) return out;
  }
  const fallback: Array<{ slot: string; key: string; zIndex: number }> = [];
  if (manifest.frames?.Body) {
    fallback.push({ slot: 'body', key: 'Body', zIndex: 0 });
  }
  if (weaponModel && manifest.frames?.[weaponModel]) {
    fallback.push({ slot: 'weapon', key: weaponModel, zIndex: 10 });
  }
  return fallback;
}

/** 原版外觀提供者（FM1 唯一實作；執行時透過 FX12 讀取同源 fairyland 素材，不在 family 放圖檔）。 */
export class OriginalAppearanceProvider implements AppearanceProvider {
  readonly id = 'original';
  readonly label = '原版';

  resolveSpriteManifestUrl(modelId: string, assets?: StaticAssetManifest): string {
    const tpl = assets?.paths.spriteManifest ?? DEFAULT_SPRITE_MANIFEST;
    return formatAssetUrl(tpl, { modelId });
  }

  resolveCharacter(
    input: AppearanceInput,
    manifest?: SpriteModelManifest | null,
    assets?: StaticAssetManifest,
  ): AppearanceRenderPlan {
    const atlasTpl = assets?.paths.spriteAtlas ?? DEFAULT_SPRITE_ATLAS;
    if (!manifest) {
      return {
        providerId: this.id,
        modelId: input.modelId,
        resolvedAction: input.action,
        frameNumber: 1,
        pixelScale: 1,
        layers: [],
        fallbackLabel: input.name || input.modelId,
      };
    }

    const { action, frame } = pickActionAndFrame(manifest, input.action, input.dir, input.nowMs);
    const activeLayers = resolveLayers(manifest, input.weaponModel);
    const layers: AppearanceLayerPlan[] = [];

    for (const layer of activeLayers) {
      const f = manifest.frames?.[layer.key]?.[String(frame)];
      if (!f || f.w <= 0 || f.h <= 0) continue;
      const relFile = f.atlas ?? f.file;
      if (!relFile) continue;
      const imageUrl = formatAssetUrl(atlasTpl, {
        modelId: input.modelId,
        file: relFile,
        atlasFile: relFile,
      });
      const tintColor =
        layer.slot === 'hair'
          ? rgbTupleToHex(input.tint?.hair)
          : layer.slot === 'armor'
            ? rgbTupleToHex(input.tint?.outfit)
            : undefined;
      layers.push({
        slot: layer.slot,
        imageUrl,
        isAtlas: Boolean(f.atlas),
        atlasX: f.x ?? 0,
        atlasY: f.y ?? 0,
        w: f.w,
        h: f.h,
        offsetX: f.draw_x - manifest.center_x,
        offsetY: f.draw_y - manifest.center_y,
        zIndex: layer.zIndex,
        tintColor,
      });
    }

    return {
      providerId: this.id,
      modelId: input.modelId,
      resolvedAction: action,
      frameNumber: frame,
      pixelScale: manifest.pixelScale ?? 1,
      layers,
      fallbackLabel: input.name || input.modelId,
    };
  }
}

export const originalAppearanceProvider = new OriginalAppearanceProvider();
