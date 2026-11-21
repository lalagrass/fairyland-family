import type { SnapshotPortalEdge, SnapshotPortalNode } from './protocol/index';

/**
 * F5：在宿主提供的傳送點圖（static-data 的 portalGraph）上找最短地圖路線。
 * 純函式，不碰任何具體地圖 id 或座標；所有資料都來自宿主執行期傳來的圖。
 *
 * - 以「經過最少張地圖」為最短（BFS）；同樣長時以傳送點 id 排序，結果是確定的。
 * - 目的地圖不存在（`targetStatus === 'NOT_IMPORTED'`，原版資料斷點）的傳送點一律不走，並記在 `skipped` 讓面板顯示原因。
 * - `blocked` 是已經試過走不通的傳送點 id，規劃時略過。
 * - 傳送點沒有座標（宿主缺資料）就無法送 WALK_TO，同樣略過；起點圖的傳送點若呼叫端另有座標來源（快照的 `exits`），
 *   以 `knownPositions`（傳送點 id）告知。
 */
export interface PortalLeg { fromMapId: string; edge: SnapshotPortalEdge }

export interface SkippedPortal {
  mapId: string;
  mapName: string | null;
  portalId: string;
  portalName: string;
  targetMapId: string;
  reason: 'TARGET_MISSING' | 'BLOCKED' | 'NO_POSITION';
}

export type PortalRoutePlan =
  | { ok: true; maps: string[]; legs: PortalLeg[]; skipped: SkippedPortal[] }
  | { ok: false; code: 'UNKNOWN_START' | 'NO_ROUTE'; skipped: SkippedPortal[] };

export function planPortalRoute(
  graph: readonly SnapshotPortalNode[],
  from: string,
  to: string,
  opts: { blocked?: ReadonlySet<string>; knownPositions?: ReadonlySet<string> } = {},
): PortalRoutePlan {
  const nodes = new Map<string, SnapshotPortalNode>();
  for (const n of graph) nodes.set(n.mapId, n);
  if (from === to) return { ok: true, maps: [from], legs: [], skipped: [] };
  if (!nodes.has(from)) return { ok: false, code: 'UNKNOWN_START', skipped: [] };

  const skipped: SkippedPortal[] = [];
  const prev = new Map<string, PortalLeg>();
  const seen = new Set<string>([from]);
  const queue = [from];
  let found = false;
  while (queue.length && !found) {
    const cur = queue.shift() as string;
    const node = nodes.get(cur);
    if (!node) continue;
    const edges = [...node.portals].sort((a, b) => a.id.localeCompare(b.id));
    for (const edge of edges) {
      const skip = (reason: SkippedPortal['reason']) => skipped.push({
        mapId: cur, mapName: node.name, portalId: edge.id, portalName: edge.name, targetMapId: edge.targetMapId, reason,
      });
      if (edge.targetStatus === 'NOT_IMPORTED') { skip('TARGET_MISSING'); continue; }
      if (opts.blocked?.has(edge.id)) { skip('BLOCKED'); continue; }
      const hasPos = typeof edge.x === 'number' && typeof edge.y === 'number';
      if (!hasPos && !(cur === from && opts.knownPositions?.has(edge.id))) { skip('NO_POSITION'); continue; }
      if (seen.has(edge.targetMapId)) continue;
      seen.add(edge.targetMapId);
      prev.set(edge.targetMapId, { fromMapId: cur, edge });
      if (edge.targetMapId === to) { found = true; break; }
      queue.push(edge.targetMapId);
    }
  }
  if (!found) return { ok: false, code: 'NO_ROUTE', skipped };
  const legs: PortalLeg[] = [];
  for (let m = to; m !== from; ) {
    const leg = prev.get(m) as PortalLeg;
    legs.unshift(leg);
    m = leg.fromMapId;
  }
  const maps = [from, ...legs.map(l => l.edge.targetMapId)];
  // 只回報路線上各圖的跳過項目（其他分支的斷點與這趟無關）。
  const onRoute = new Set(maps);
  return { ok: true, maps, legs, skipped: skipped.filter(s => onRoute.has(s.mapId)) };
}

/** 面板用的一行原因文字。 */
export function describeSkipped(s: SkippedPortal, mapName: (id: string) => string | null): string {
  const here = s.mapName ?? mapName(s.mapId) ?? s.mapId;
  const to = mapName(s.targetMapId) ?? s.targetMapId;
  if (s.reason === 'TARGET_MISSING') return `略過 ${here}「${s.portalName}」：通往的地圖 ${to} 不存在（原版資料缺）`;
  if (s.reason === 'BLOCKED') return `略過 ${here}「${s.portalName}」：走不通`;
  return `略過 ${here}「${s.portalName}」：宿主沒有它的座標`;
}
