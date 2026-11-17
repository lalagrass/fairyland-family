import type { StaticAssetManifest } from '../protocol/index';
import { formatAssetUrl, type SpriteModelManifest } from './appearance';
import {
  parseLdtkDecorations,
  type LdtkProject,
  type MapDecorationItem,
} from './ldtkLoader';

export interface MapGroundCell {
  tile_file?: string;
  flip_x?: boolean;
  flip_y?: boolean;
}

export interface MapSceneObject {
  id: string;
  file?: string;
  world_x: number;
  world_y: number;
  depth?: number;
  width: number;
  height: number;
  anchor_x: number;
  anchor_y: number;
}

export interface MapSceneNpc {
  id: string;
  name: string;
  model?: string;
  runtime_model?: string;
  world_x: number;
  world_y: number;
}

export interface MapScenePortal {
  id: string;
  name: string;
  target_map: string;
  target_name?: string;
  world_x: number;
  world_y: number;
}

export interface RuntimeMapScene {
  map_id: string;
  name: string;
  pixel_width: number;
  pixel_height: number;
  ground?: {
    macro_width: number;
    macro_height: number;
    macro_grid: MapGroundCell[];
  };
  objects?: MapSceneObject[];
  npcs?: MapSceneNpc[];
  portals?: MapScenePortal[];
}

const DEFAULT_MAP_SCENE = '/assets/maps/{mapId}/map_{mapId}.json';
const DEFAULT_SPRITE_MANIFEST = '/assets/sprites/{modelId}/manifest.json';

/** 執行時同源素材與場景 JSON 載入器（不做持久化快取，不內含任何原版圖檔）。 */
export class RuntimeAssetLoader {
  private mapCache = new Map<string, RuntimeMapScene | null>();
  private mapInflight = new Map<string, Promise<RuntimeMapScene | null>>();
  private spriteCache = new Map<string, SpriteModelManifest | null>();
  private spriteInflight = new Map<string, Promise<SpriteModelManifest | null>>();
  private ldtkCache = new Map<string, MapDecorationItem[]>();
  private ldtkInflight = new Map<string, Promise<MapDecorationItem[]>>();

  getMap(mapId: string): RuntimeMapScene | null | undefined {
    return this.mapCache.get(mapId);
  }

  getSprite(modelId: string): SpriteModelManifest | null | undefined {
    return this.spriteCache.get(modelId);
  }

  getDecorations(mapId: string): MapDecorationItem[] {
    return this.ldtkCache.get(mapId) ?? [];
  }

  async loadDecorations(mapId: string): Promise<MapDecorationItem[]> {
    if (!mapId) return [];
    const hit = this.ldtkCache.get(mapId);
    if (hit) return hit;
    const inflight = this.ldtkInflight.get(mapId);
    if (inflight) return inflight;

    const url = `/family/assets/maps/${mapId}_decor.ldtk`;
    const p = this.fetchJson<LdtkProject>(url)
      .then(proj => {
        const items = proj ? parseLdtkDecorations(proj) : [];
        this.ldtkCache.set(mapId, items);
        this.ldtkInflight.delete(mapId);
        return items;
      })
      .catch(() => {
        this.ldtkCache.set(mapId, []);
        this.ldtkInflight.delete(mapId);
        return [];
      });
    this.ldtkInflight.set(mapId, p);
    return p;
  }

  async loadMap(mapId: string, assets?: StaticAssetManifest): Promise<RuntimeMapScene | null> {
    if (!mapId) return null;
    if (this.mapCache.has(mapId)) return this.mapCache.get(mapId) ?? null;
    const inflight = this.mapInflight.get(mapId);
    if (inflight) return inflight;

    const url = formatAssetUrl(assets?.paths.mapScene ?? DEFAULT_MAP_SCENE, { mapId });
    const p = this.fetchJson<RuntimeMapScene>(url)
      .then(data => {
        this.mapCache.set(mapId, data);
        this.mapInflight.delete(mapId);
        return data;
      })
      .catch(() => {
        this.mapCache.set(mapId, null);
        this.mapInflight.delete(mapId);
        return null;
      });
    this.mapInflight.set(mapId, p);
    return p;
  }

  async loadSprite(modelId: string, assets?: StaticAssetManifest): Promise<SpriteModelManifest | null> {
    if (!modelId) return null;
    if (this.spriteCache.has(modelId)) return this.spriteCache.get(modelId) ?? null;
    const inflight = this.spriteInflight.get(modelId);
    if (inflight) return inflight;

    const url = formatAssetUrl(assets?.paths.spriteManifest ?? DEFAULT_SPRITE_MANIFEST, { modelId });
    const p = this.fetchJson<SpriteModelManifest>(url)
      .then(data => {
        this.spriteCache.set(modelId, data);
        this.spriteInflight.delete(modelId);
        return data;
      })
      .catch(() => {
        this.spriteCache.set(modelId, null);
        this.spriteInflight.delete(modelId);
        return null;
      });
    this.spriteInflight.set(modelId, p);
    return p;
  }

  private async fetchJson<T>(url: string): Promise<T | null> {
    if (typeof fetch !== 'function') return null;
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  }
}
