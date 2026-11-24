// [sync-protocol] 自動產生，請勿手改；改協定請到 fairyland 修改後重新執行 npm run sync-protocol
// [sync-protocol] 來源：fairyland/packages/shared/src/protocol/terrain.ts @ 49caebf24d2727cb3bb2f0cd58f7c1b90a5cfc19
/**
 * F13／協定 v8：目前地圖的碰撞幾何。
 *
 * 格子與宿主 `worldToCollisionCell`、地圖檢視器畫的菱形相同：列高 20、磚寬 80、
 * 奇數列右移 40、每格寬 40。這是既有引擎座標，不是新推估。
 * 這個檔案在協定資料夾內，family 同步後可直接用，不解析原版檔。
 */
import type { SnapshotTerrain } from './types.js';

export const TERRAIN_ROW_H = 20;
export const TERRAIN_TILE_W = 80;
export const TERRAIN_ODD_SHIFT = 40;
export const TERRAIN_CELL_W = 40;
/** 宿主碰撞格目前最大 800×1000。再大就拒絕，避免快照帶入任意大小的陣列。 */
export const TERRAIN_MAX_CELLS = 800_000;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function isTerrainShape(cols: number, rows: number): boolean {
  return Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0
    && cols * rows <= TERRAIN_MAX_CELLS;
}

export function terrainByteLength(cols: number, rows: number): number {
  return Math.ceil((cols * rows) / 8);
}

/** 與 `map_runtime.worldToCollisionCell` 同一套式子。 */
export function worldToTerrainCell(worldX: number, worldY: number): { cx: number; cy: number } {
  const cy = Math.floor(worldY / TERRAIN_ROW_H);
  const isOdd = Math.abs(cy % 2) === 1;
  const remX = worldX - (isOdd ? TERRAIN_ODD_SHIFT : 0);
  const tileX = Math.floor(remX / TERRAIN_TILE_W);
  const subX = ((remX % TERRAIN_TILE_W) + TERRAIN_TILE_W) % TERRAIN_TILE_W >= TERRAIN_CELL_W ? 1 : 0;
  return { cx: tileX * 2 + subX, cy };
}

/** 菱形左上緣。中心是 (x + 20, y + 10)，對應檢視器的菱形填色。 */
export function terrainCellOrigin(cx: number, cy: number): { x: number; y: number } {
  const tileIndex = Math.floor(cx / 2);
  const sub = ((cx % 2) + 2) % 2;
  const odd = Math.abs(cy % 2) === 1;
  return {
    x: tileIndex * TERRAIN_TILE_W + (odd ? TERRAIN_ODD_SHIFT : 0) + sub * TERRAIN_CELL_W,
    y: cy * TERRAIN_ROW_H,
  };
}

export function terrainCellCenter(cx: number, cy: number): { x: number; y: number } {
  const o = terrainCellOrigin(cx, cy);
  return { x: o.x + TERRAIN_CELL_W / 2, y: o.y + TERRAIN_ROW_H / 2 };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = i + 1 < bytes.length ? bytes[i + 1] ?? 0 : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] ?? 0 : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
      + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=')
      + (i + 2 < bytes.length ? B64[n & 63] : '=');
  }
  return out;
}

export function base64ToBytes(s: string): Uint8Array | null {
  if (s.length === 0 || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let j = 0;
  for (let i = 0; i < s.length; i += 4) {
    const chars = [s[i] ?? '', s[i + 1] ?? '', s[i + 2] ?? '', s[i + 3] ?? ''];
    const vals = chars.map(ch => (ch === '=' ? -2 : B64.indexOf(ch)));
    if (vals.some(v => v === -1)) return null;
    const last = i + 4 === s.length;
    for (let k = 0; k < 4; k += 1) {
      const isPad = vals[k] === -2;
      if (isPad !== (last && k >= 4 - pad)) return null;
    }
    if ((vals[0] ?? -1) < 0 || (vals[1] ?? -1) < 0) return null;
    const n = ((vals[0] ?? 0) << 18) | ((vals[1] ?? 0) << 12) | ((Math.max(0, vals[2] ?? 0)) << 6) | Math.max(0, vals[3] ?? 0);
    out[j++] = (n >> 16) & 255;
    if ((vals[2] ?? -1) >= 0) out[j++] = (n >> 8) & 255;
    if ((vals[3] ?? -1) >= 0) out[j++] = n & 255;
  }
  return j === out.length ? out : null;
}

/** `grid[i] !== 0` 視為阻擋，與 `isCellWalkable`（只有 0 可走）相同。 */
export function packBlockedCells(grid: Uint8Array, cols: number, rows: number): SnapshotTerrain | null {
  if (!isTerrainShape(cols, rows) || grid.length < cols * rows) return null;
  const total = cols * rows;
  const bytes = new Uint8Array(terrainByteLength(cols, rows));
  for (let i = 0; i < total; i += 1) {
    if (grid[i] !== 0) bytes[i >> 3] |= 1 << (7 - (i & 7));
  }
  return { cols, rows, blocked: bytesToBase64(bytes) };
}

/** 解出每格 0／1。base64 或長度不符就回 null。 */
export function unpackBlockedCells(terrain: SnapshotTerrain): Uint8Array | null {
  if (!isTerrainShape(terrain.cols, terrain.rows) || typeof terrain.blocked !== 'string') return null;
  const bytes = base64ToBytes(terrain.blocked);
  if (!bytes || bytes.length !== terrainByteLength(terrain.cols, terrain.rows)) return null;
  const total = terrain.cols * terrain.rows;
  const out = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) out[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
  return out;
}

/** 格外或該格不是 0 都算阻擋。 */
export function terrainCellBlocked(cells: Uint8Array, cols: number, rows: number, cx: number, cy: number): boolean {
  if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return true;
  return cells[cy * cols + cx] !== 0;
}
