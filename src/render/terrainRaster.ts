/**
 * F13：把宿主碰撞格畫成一張程式產生的點陣圖（可走／不可走），不載入任何素材。
 * 每個像素用世界座標反查碰撞格，所以角色的世界座標與格子對得上。
 */
import { terrainCellBlocked, worldToTerrainCell } from '../protocol/terrain';

export interface TerrainRaster {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  walkable: number;
  blocked: number;
}

/** 可走是暗綠，不可走是接近底色的深藍，標記仍看得清楚。 */
export const TERRAIN_WALK_RGBA: readonly [number, number, number, number] = [30, 74, 58, 255];
export const TERRAIN_BLOCK_RGBA: readonly [number, number, number, number] = [14, 20, 30, 255];

export function rasterTerrain(
  cells: Uint8Array,
  cols: number,
  rows: number,
  mapW: number,
  mapH: number,
  maxSide = 1024,
): TerrainRaster {
  const longSide = Math.max(1, mapW, mapH);
  const side = Math.max(1, Math.min(maxSide, longSide));
  const scale = longSide / side;
  const width = Math.max(1, Math.round(mapW / scale));
  const height = Math.max(1, Math.round(mapH / scale));
  const rgba = new Uint8ClampedArray(width * height * 4);
  let walkable = 0;
  let blocked = 0;
  for (let py = 0; py < height; py += 1) {
    const wy = ((py + 0.5) / height) * mapH;
    for (let px = 0; px < width; px += 1) {
      const wx = ((px + 0.5) / width) * mapW;
      const { cx, cy } = worldToTerrainCell(wx, wy);
      const block = terrainCellBlocked(cells, cols, rows, cx, cy);
      const c = block ? TERRAIN_BLOCK_RGBA : TERRAIN_WALK_RGBA;
      const o = (py * width + px) * 4;
      rgba[o] = c[0];
      rgba[o + 1] = c[1];
      rgba[o + 2] = c[2];
      rgba[o + 3] = c[3];
      if (block) blocked += 1;
      else walkable += 1;
    }
  }
  return { width, height, rgba, walkable, blocked };
}
