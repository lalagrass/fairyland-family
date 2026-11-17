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

export type AppearanceId = 'original' | 'wuxia-test' | string;

export interface VectorShapeLayer {
  slot: string;
  shape: 'rect' | 'circle' | 'diamond';
  x: number;
  y: number;
  w?: number;
  h?: number;
  radius?: number;
  fillHex: string;
  strokeHex?: string;
}

export interface AppearanceRenderPlan {
  providerId: string;
  modelId: string;
  resolvedAction: number;
  frameNumber: number;
  pixelScale: number;
  layers: AppearanceLayerPlan[];
  vectorLayers?: VectorShapeLayer[];
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

const DIR_VECTORS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],    // 0 S
  [-0.7, 0.7], // 1 SW
  [-1, 0],   // 2 W
  [-0.7, -0.7], // 3 NW
  [0, -1],   // 4 N
  [0.7, -0.7], // 5 NE
  [1, 0],    // 6 E
  [0.7, 0.7], // 7 SE
];

/**
 * 第二套外觀提供者（FM3 原創幾何測試外觀，含多圖層／8 方向／走路・工作・戰鬥姿態；零原版圖檔）。
 */
export class WuxiaTestAppearanceProvider implements AppearanceProvider {
  readonly id = 'wuxia-test';
  readonly label = '新武俠（幾何測試）';

  resolveSpriteManifestUrl(): string {
    return '/family/assets/appearances/wuxia_test/manifest.json';
  }

  resolveCharacter(input: AppearanceInput): AppearanceRenderPlan {
    const dirIdx = ((input.dir % 8) + 8) % 8;
    const [fx, fy] = DIR_VECTORS[dirIdx];
    const phase = (input.nowMs % 640) / 640;
    const wave = Math.sin(phase * Math.PI * 2);

    const isWalk = input.action === 1 || input.action === 2;
    const isWork = input.action === 20;
    const isBattle = input.action >= 4 && input.action <= 10;

    const bobY = isWalk ? Math.round(Math.abs(wave) * -4) : isWork ? Math.round(wave * 3) : 0;
    const fistPush = isBattle ? 12 + Math.round(Math.max(0, wave) * 6) : isWork ? 10 + Math.round(wave * 5) : 7;
    const cloakColor = rgbTupleToHex(input.tint?.outfit) ?? '#2f6fed';
    const hairColor = rgbTupleToHex(input.tint?.hair) ?? '#1e2633';

    const vectorLayers: VectorShapeLayer[] = [
      // 武者長衫軀幹
      {
        slot: 'body',
        shape: 'diamond',
        x: 0,
        y: -18 + bobY,
        w: 22,
        h: 28,
        fillHex: cloakColor,
        strokeHex: '#e4eaf3',
      },
      // 護甲腰帶
      {
        slot: 'armor',
        shape: 'rect',
        x: -10,
        y: -14 + bobY,
        w: 20,
        h: 6,
        fillHex: '#ffcb6b',
        strokeHex: '#332200',
      },
      // 頭部
      {
        slot: 'head',
        shape: 'circle',
        x: 0,
        y: -36 + bobY,
        radius: 9,
        fillHex: '#f6d1b0',
        strokeHex: '#202630',
      },
      // 髮髻 / 頭帶朝向指示
      {
        slot: 'hair',
        shape: 'circle',
        x: Math.round(-fx * 4),
        y: Math.round(-41 + bobY - fy * 2),
        radius: 5,
        fillHex: hairColor,
      },
      // 主武器雙拳拳套（朝 8 方向延伸，走路／工作／出招帶律動）
      {
        slot: 'weapon',
        shape: 'circle',
        x: Math.round(fx * fistPush + (isWalk ? wave * 4 : 0)),
        y: Math.round(-20 + bobY + fy * fistPush * 0.6),
        radius: isBattle ? 6 : 5,
        fillHex: isWork ? '#5fd3c7' : '#ff8c42',
        strokeHex: '#ffffff',
      },
    ];

    return {
      providerId: this.id,
      modelId: 'wuxia_test',
      resolvedAction: input.action,
      frameNumber: Math.floor(phase * 4) + 1,
      pixelScale: 1,
      layers: [],
      vectorLayers,
      fallbackLabel: input.name || 'wuxia_test',
    };
  }
}

export const wuxiaTestAppearanceProvider = new WuxiaTestAppearanceProvider();

export const APPEARANCE_PROVIDERS: readonly AppearanceProvider[] = [
  originalAppearanceProvider,
  wuxiaTestAppearanceProvider,
];

export function getAppearanceProvider(id?: string | null): AppearanceProvider {
  return APPEARANCE_PROVIDERS.find(p => p.id === id) ?? originalAppearanceProvider;
}
