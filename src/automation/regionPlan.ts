import type { SnapshotRegionRef, StaticRegion } from '../protocol/index';
import type { QueueStopReason } from '../queue';

/**
 * F7（#48）跨區自動化的純函式。區域、村莊地圖與地圖歸屬全部來自宿主（協定 v7 的快照 `region` 與
 * STATIC_DATA `regions`），這裡不寫死任何地圖代號、區域代號或座標。測試用的名稱一律是虛構的。
 */

/** 宿主沒有給區域（地圖不在宿主的區域清單裡，或還沒收到快照）時顯示的文字。 */
export const REGION_UNKNOWN_LABEL = '未知';

export function regionLabel(region: SnapshotRegionRef | null | undefined): string {
  return region?.name ?? REGION_UNKNOWN_LABEL;
}

/** 地圖屬於哪個區域（用 STATIC_DATA 的區域清單查）；查不到就是 null，不從代號猜。 */
export function regionOfMapId(regions: readonly StaticRegion[], mapId: string | null | undefined): StaticRegion | null {
  if (!mapId) return null;
  return regions.find(r => r.mapIds.includes(mapId)) ?? null;
}

/** 只留宿主標成這個區域的任務；沒有 `regionId` 的任務不算在任何區域裡。 */
export function questsInRegion<T extends { regionId?: string }>(quests: readonly T[], regionId: string): T[] {
  return quests.filter(q => q.regionId === regionId);
}

export type RegionTravel =
  | { kind: 'HERE'; region: StaticRegion }
  | { kind: 'TRAVEL'; region: StaticRegion }
  | { kind: 'UNKNOWN_REGION'; regionId: string };

/**
 * 角色要不要先跨區：已經在目標區域就 HERE；不在就 TRAVEL（目的地是宿主給的村莊地圖，路線交給傳送點圖導航）；
 * 目標區域不在宿主清單裡就 UNKNOWN_REGION（設定過期或宿主換了區域清單）。
 */
export function planRegionTravel(
  regions: readonly StaticRegion[],
  currentRegionId: string | null | undefined,
  targetRegionId: string,
): RegionTravel {
  const region = regions.find(r => r.regionId === targetRegionId);
  if (!region) return { kind: 'UNKNOWN_REGION', regionId: targetRegionId };
  return currentRegionId === targetRegionId ? { kind: 'HERE', region } : { kind: 'TRAVEL', region };
}

/** 任務鏈的停工原因碼（含 FM8 原有的）。`stopReason` 只會是這些值之一。 */
export type ChainStopReason =
  | 'USER'
  | 'STUCK'
  | 'QUESTS_DONE'
  | 'TIME'
  | 'LEVEL'
  | 'GOLD'
  | 'BAG_FULL'
  | 'DEATHS'
  /** F7：缺工作工具且買不到。 */
  | 'MISSING_TOOL'
  /** F7：飽食度（體力）不足，宿主拒絕工作。 */
  | 'NO_STAMINA'
  /** F7：買工具的錢不夠。 */
  | 'INSUFFICIENT_GOLD'
  /** F7：前往採集點或跨區的傳送點路線走不通。 */
  | 'NAV_FAILED'
  /** F7：設定的區域不在宿主的區域清單裡。 */
  | 'REGION_UNKNOWN';

export const CHAIN_STOP_REASON_LABEL: Record<ChainStopReason, string> = {
  USER: '玩家停止',
  STUCK: '找不到下一步',
  QUESTS_DONE: '任務做完',
  TIME: '時間到',
  LEVEL: '等級達成',
  GOLD: '金錢達成',
  BAG_FULL: '背包已滿',
  DEATHS: '死亡次數達到上限',
  MISSING_TOOL: '缺少工具',
  NO_STAMINA: '體力不足',
  INSUFFICIENT_GOLD: '金錢不足',
  NAV_FAILED: '路線走不通',
  REGION_UNKNOWN: '宿主沒有這個區域',
};

/**
 * 可以「續跑」的停工原因：處理完（清背包、補工具、恢復體力…）按續跑就從原地接著做，
 * 已完成的任務與回來摘要的起點保留。等級、金錢達成與任務做完是目標達成，不提供續跑。
 */
export const RESUMABLE_STOP_REASONS: ReadonlySet<ChainStopReason> = new Set<ChainStopReason>([
  'USER', 'STUCK', 'TIME', 'BAG_FULL', 'DEATHS', 'MISSING_TOOL', 'NO_STAMINA', 'INSUFFICIENT_GOLD', 'NAV_FAILED', 'REGION_UNKNOWN',
]);

export function isResumable(reason: string | null): boolean {
  return reason !== null && RESUMABLE_STOP_REASONS.has(reason as ChainStopReason);
}

/** 工作佇列的停止原因對到任務鏈的原因碼；對不上的歸成 STUCK，詳細原因放在文字裡。 */
export function chainStopForQueue(reason: QueueStopReason): ChainStopReason {
  switch (reason) {
    case 'BAG_FULL': return 'BAG_FULL';
    case 'MISSING_TOOL':
    case 'SHOP_FAILED': return 'MISSING_TOOL';
    case 'NO_STAMINA': return 'NO_STAMINA';
    case 'INSUFFICIENT_GOLD': return 'INSUFFICIENT_GOLD';
    case 'NAV_FAILED':
    case 'TOO_FAR': return 'NAV_FAILED';
    default: return 'STUCK';
  }
}
