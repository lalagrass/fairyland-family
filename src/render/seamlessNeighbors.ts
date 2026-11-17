import type { RuntimeMapScene } from './assetLoader';

export interface SeamlessNeighborOffset {
  targetMapId: string;
  offsetX: number;
  offsetY: number;
}

/** 戶外野外地圖編號規則為 1xxxx；室內（2xxxx）等維持一般過場。 */
export function isOutdoorMapId(mapId: string): boolean {
  return /^1\d{4}$/.test(mapId);
}

/**
 * 直接由執行時載入的地圖傳送點推導相鄰戶外地圖的原點偏移 `(px - tx, py - ty)`，
 * 不在本 repo 儲存任何原版地圖排版表。
 */
export function computeSeamlessNeighbors(scene: RuntimeMapScene | null): SeamlessNeighborOffset[] {
  if (!scene || !isOutdoorMapId(scene.map_id)) return [];
  const buckets = new Map<string, Array<{ ox: number; oy: number }>>();
  for (const p of scene.portals ?? []) {
    if (!p.target_map || p.target_map === scene.map_id || !isOutdoorMapId(p.target_map)) continue;
    const raw = p as unknown as { target_x?: number; target_y?: number };
    if (typeof raw.target_x !== 'number' || typeof raw.target_y !== 'number') continue;
    const ox = p.world_x - raw.target_x;
    const oy = p.world_y - raw.target_y;
    const list = buckets.get(p.target_map) ?? [];
    list.push({ ox, oy });
    buckets.set(p.target_map, list);
  }

  const out: SeamlessNeighborOffset[] = [];
  for (const [targetMapId, samples] of buckets.entries()) {
    const meanX = samples.reduce((s, v) => s + v.ox, 0) / samples.length;
    const meanY = samples.reduce((s, v) => s + v.oy, 0) / samples.length;
    const maxResidual = samples.reduce(
      (m, v) => Math.max(m, Math.hypot(v.ox - meanX, v.oy - meanY)),
      0,
    );
    if (maxResidual <= 240) {
      out.push({
        targetMapId,
        offsetX: Math.round(meanX),
        offsetY: Math.round(meanY),
      });
    }
  }
  return out;
}

/** 判斷從 prevMapId 走到 nextMapId 是否為無縫戶外過場（不觸發黑屏淡出）。 */
export function isSeamlessTransition(
  prevMapId: string | null,
  nextMapId: string | null,
  prevScene?: RuntimeMapScene | null,
): boolean {
  if (!prevMapId || !nextMapId || prevMapId === nextMapId) return true;
  if (!isOutdoorMapId(prevMapId) || !isOutdoorMapId(nextMapId)) return false;
  if (!prevScene) return true;
  return computeSeamlessNeighbors(prevScene).some(n => n.targetMapId === nextMapId);
}
