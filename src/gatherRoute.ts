import { planPortalRoute } from './portalRoute';
import type { SceneSnapshot, SnapshotGatherPoint, SnapshotPortalNode } from './protocol/index';

type GatherSelection =
  | { kind: 'POINT'; point: SnapshotGatherPoint }
  | { kind: 'NO_POINT' }
  | { kind: 'NO_ROUTE' };

/** F7：就地採集優先；跨圖時只用宿主已提供的採集點及傳送點，不猜區域邊界。 */
export function selectGatherPoint(
  job: { skillId: number; targetItemId?: number },
  snap: Pick<SceneSnapshot, 'mapId' | 'mapName' | 'exits' | 'gatherPoints' | 'nearbyGatherPoints' | 'nav'>,
  member: { mapId: string; x: number; y: number; isViewed: boolean },
  skippedPoints: ReadonlySet<string>,
  staticGraph?: readonly SnapshotPortalNode[],
): GatherSelection {
  const matches = (p: SnapshotGatherPoint) => !skippedPoints.has(p.id)
    && p.skillId === job.skillId
    && (job.targetItemId === undefined || p.materials?.some(m => m.itemId === job.targetItemId));
  const nearby = (snap.nearbyGatherPoints ?? []).filter(matches);
  const local = [...snap.gatherPoints.points.filter(matches), ...nearby]
    .filter(p => (p.mapId ?? snap.mapId) === member.mapId)
    .sort((a, b) => Math.hypot(member.x - a.x, member.y - a.y) - Math.hypot(member.x - b.x, member.y - b.y))[0];
  if (local) return { kind: 'POINT', point: local };
  if (!nearby.length) return { kind: 'NO_POINT' };

  const graph = snap.nav.portalGraph?.length ? snap.nav.portalGraph : staticGraph;
  const here = graph?.find(n => n.mapId === member.mapId);
  // 背景角色不能跨圖；舊版或還沒收到傳送點圖時讓既有導航處理。
  if (!member.isViewed || !graph || !here) {
    return { kind: 'POINT', point: nearby[0] };
  }

  const exits = snap.mapId === member.mapId ? snap.exits : [];
  const known = new Set(exits.map(e => e.id));
  const fromGraph = new Set(here.portals.map(p => p.id));
  const extra = exits.filter(e => !fromGraph.has(e.id)).map(e => ({ ...e, targetStatus: 'UNKNOWN' as const }));
  const nodes = graph.map(n => n === here ? { ...n, portals: [...n.portals, ...extra] } : n);
  const distanceByMap = new Map<string, number>();
  let best: { point: SnapshotGatherPoint; distance: number } | undefined;
  let unconfirmed: SnapshotGatherPoint | undefined;
  for (const point of nearby) {
    const mapId = point.mapId ?? snap.mapId;
    let distance = distanceByMap.get(mapId);
    if (distance === undefined) {
      const plan = planPortalRoute(nodes, member.mapId, mapId, { knownPositions: known });
      // 目錄未列出可走路徑不代表不通：保留舊導航；只有宿主明示未匯入才排除。
      distance = plan.ok ? plan.legs.length
        : plan.skipped.some(s => s.targetMapId === mapId && s.reason === 'TARGET_MISSING') ? Infinity : -1;
      distanceByMap.set(mapId, distance);
    }
    if (distance === -1) unconfirmed ??= point;
    else if (Number.isFinite(distance) && (!best || distance < best.distance)) best = { point, distance };
  }
  const point = best?.point ?? unconfirmed;
  return point ? { kind: 'POINT', point } : { kind: 'NO_ROUTE' };
}
