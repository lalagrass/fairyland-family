export const CHUNK_SIZE_PX = 960;
export const MACRO_CELL_W = 160;
export const MACRO_CELL_H = 80;

export interface ChunkCoord {
  cx: number;
  cy: number;
  key: string;
}

/** 計算目前攝影機視野（含周邊預載緩衝）所涵蓋的地圖分塊座標。 */
export function visibleChunkCoords(
  mapId: string,
  camX: number,
  camY: number,
  viewW: number,
  viewH: number,
  mapW: number,
  mapH: number,
  marginPx = 320,
): ChunkCoord[] {
  const maxCx = Math.max(0, Math.ceil(mapW / CHUNK_SIZE_PX) - 1);
  const maxCy = Math.max(0, Math.ceil(mapH / CHUNK_SIZE_PX) - 1);
  const c0 = Math.max(0, Math.floor((camX - marginPx) / CHUNK_SIZE_PX));
  const c1 = Math.min(maxCx, Math.floor((camX + viewW + marginPx) / CHUNK_SIZE_PX));
  const r0 = Math.max(0, Math.floor((camY - marginPx) / CHUNK_SIZE_PX));
  const r1 = Math.min(maxCy, Math.floor((camY + viewH + marginPx) / CHUNK_SIZE_PX));

  const out: ChunkCoord[] = [];
  for (let cy = r0; cy <= r1; cy += 1) {
    for (let cx = c0; cx <= c1; cx += 1) {
      out.push({ cx, cy, key: `${mapId}:${cx},${cy}` });
    }
  }
  return out;
}

/** 單一分塊對應到 `macro_grid` 的格線範圍。 */
export function chunkMacroCellBounds(
  cx: number,
  cy: number,
  macroCols: number,
  macroRows: number,
): { col0: number; col1: number; row0: number; row1: number } {
  const x0 = cx * CHUNK_SIZE_PX;
  const y0 = cy * CHUNK_SIZE_PX;
  const x1 = x0 + CHUNK_SIZE_PX;
  const y1 = y0 + CHUNK_SIZE_PX;
  return {
    col0: Math.max(0, Math.floor(x0 / MACRO_CELL_W)),
    col1: Math.min(macroCols - 1, Math.ceil(x1 / MACRO_CELL_W) - 1),
    row0: Math.max(0, Math.floor(y0 / MACRO_CELL_H)),
    row1: Math.min(macroRows - 1, Math.ceil(y1 / MACRO_CELL_H) - 1),
  };
}

/** 簡單 LRU 分塊快取鍵值追蹤，避免超大世界地圖記憶體無限成長。 */
export class MapChunkLruTracker {
  private order = new Map<string, number>();

  constructor(private capacity = 48) {}

  touch(key: string, stamp: number): void {
    if (this.order.has(key)) this.order.delete(key);
    this.order.set(key, stamp);
    while (this.order.size > this.capacity) {
      const oldest = this.order.keys().next().value;
      if (oldest === undefined) break;
      this.order.delete(oldest);
    }
  }

  has(key: string): boolean {
    return this.order.has(key);
  }

  size(): number {
    return this.order.size;
  }

  keys(): string[] {
    return [...this.order.keys()];
  }
}
