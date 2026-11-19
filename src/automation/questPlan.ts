import type { SnapshotItem } from '../protocol/index';

/**
 * FM8 任務鏈的純函式。只吃宿主快照上的任務與地名，不寫死任務編號、座標或考據數值。
 * 測試用的名稱一律是虛構的。
 */

export interface ChainStopConditions {
  /** 執行超過這麼久就停。null＝不限。 */
  maxDurationMs: number | null;
  /** 等級達到就停。null＝不限。 */
  targetLevel: number | null;
  /** 金錢達到就停。null＝不限。 */
  targetGold: number | null;
  stopOnBagFull: boolean;
  /** 死亡次數達到就停。null＝不限。 */
  maxDeaths: number | null;
}

export type ChainLoopActivity = 'HUNT' | 'GATHER' | 'CRAFT';

export interface QuestChainConfig {
  stop: ChainStopConditions;
  /** 目前等級做得到的任務都結束後，進入新手循環。 */
  newbieLoop: boolean;
  loopActivity: ChainLoopActivity;
  /** 血量百分比低於此值：戰鬥改逃跑，循環則回村補給。 */
  returnHpPct: number;
}

export const DEFAULT_CHAIN_CONFIG: QuestChainConfig = {
  stop: {
    maxDurationMs: null,
    targetLevel: null,
    targetGold: null,
    stopOnBagFull: false,
    maxDeaths: null,
  },
  newbieLoop: true,
  loopActivity: 'HUNT',
  returnHpPct: 30,
};

export interface ChainMetrics {
  startedAt: number;
  now: number;
  level: number;
  gold: number;
  inventoryCount: number;
  inventoryCap: number;
  deaths: number;
}

export type ChainStopCode = 'TIME' | 'LEVEL' | 'GOLD' | 'BAG_FULL' | 'DEATHS';

export const CHAIN_STOP_LABEL: Record<ChainStopCode, string> = {
  TIME: '時間到',
  LEVEL: '等級達成',
  GOLD: '金錢達成',
  BAG_FULL: '背包已滿',
  DEATHS: '死亡次數達到上限',
};

export function evaluateChainStop(cond: ChainStopConditions, m: ChainMetrics): ChainStopCode | null {
  if (cond.maxDurationMs !== null && m.now - m.startedAt >= cond.maxDurationMs) return 'TIME';
  if (cond.targetLevel !== null && m.level >= cond.targetLevel) return 'LEVEL';
  if (cond.targetGold !== null && m.gold >= cond.targetGold) return 'GOLD';
  if (cond.stopOnBagFull && m.inventoryCap > 0 && m.inventoryCount >= m.inventoryCap) return 'BAG_FULL';
  if (cond.maxDeaths !== null && m.deaths >= cond.maxDeaths) return 'DEATHS';
  return null;
}

export interface ChainQuest {
  questId: number;
  title: string;
  npcName: string;
  minLevel: number;
  status: 'AVAILABLE' | 'IN_PROGRESS' | 'READY' | 'COMPLETED';
  prerequisites?: number[];
  objectives: ChainObjective[];
  rewardExp: number;
  rewardCoins: number;
}

export interface ChainObjective {
  type: string;
  description: string;
  current: number;
  required: number;
  met: boolean;
  targetMaps?: Array<{ mapId: string; mapName: string | null; x?: number; y?: number; reason: string }>;
}

export function compareQuestOrder(a: { questId: number; minLevel: number }, b: { questId: number; minLevel: number }): number {
  return a.minLevel - b.minLevel || a.questId - b.questId;
}

/** 依前置任務做穩定拓撲排序。有環的任務附在最後，避免排序本身卡住。 */
export function orderQuests<T extends { questId: number; minLevel: number; prerequisites?: number[] }>(quests: readonly T[]): T[] {
  const byId = new Map(quests.map(q => [q.questId, q]));
  const indeg = new Map<number, number>();
  const children = new Map<number, number[]>();
  for (const q of quests) {
    const pres = [...new Set(q.prerequisites ?? [])].filter(id => id !== q.questId && byId.has(id));
    indeg.set(q.questId, pres.length);
    for (const p of pres) {
      const list = children.get(p) ?? [];
      list.push(q.questId);
      children.set(p, list);
    }
  }
  const ready = quests.filter(q => (indeg.get(q.questId) ?? 0) === 0);
  const out: T[] = [];
  while (ready.length > 0) {
    ready.sort(compareQuestOrder);
    const q = ready.shift()!;
    out.push(q);
    for (const childId of children.get(q.questId) ?? []) {
      const next = (indeg.get(childId) ?? 1) - 1;
      indeg.set(childId, next);
      if (next === 0) {
        const node = byId.get(childId);
        if (node) ready.push(node);
      }
    }
  }
  if (out.length < quests.length) {
    const seen = new Set(out.map(q => q.questId));
    out.push(...quests.filter(q => !seen.has(q.questId)).sort(compareQuestOrder));
  }
  return out;
}

export type NextQuestResult<T> =
  | { kind: 'QUEST'; quest: T }
  | { kind: 'LEVEL_LOCKED'; blocked: T[] }
  | { kind: 'DONE' };

function prereqsMet(q: { prerequisites?: number[] }, done: Set<number>): boolean {
  return (q.prerequisites ?? []).every(id => done.has(id));
}

/**
 * 下一個該做的任務。進行中／可回報優先，其次是等級夠且前置已完成的可接任務。
 * 剩下的若只是等級或前置還不到，交給新手循環，不算卡住。
 */
export function selectNextQuest<T extends ChainQuest>(quests: readonly T[], level: number): NextQuestResult<T> {
  const ordered = orderQuests(quests);
  const done = new Set(ordered.filter(q => q.status === 'COMPLETED').map(q => q.questId));
  const active = ordered.find(q => (q.status === 'IN_PROGRESS' || q.status === 'READY') && prereqsMet(q, done));
  if (active) return { kind: 'QUEST', quest: active };
  const available = ordered.find(q => q.status === 'AVAILABLE' && prereqsMet(q, done) && level >= q.minLevel);
  if (available) return { kind: 'QUEST', quest: available };
  const blocked = ordered.filter(q => q.status !== 'COMPLETED' && (!prereqsMet(q, done) || level < q.minLevel));
  if (blocked.length > 0) return { kind: 'LEVEL_LOCKED', blocked };
  return { kind: 'DONE' };
}

export interface PlanContext {
  npcNames: string[];
  maps: Array<{ mapId: string; name: string }>;
  gatherPoints: Array<{ mapId?: string; materials?: Array<{ name: string }> }>;
  recipes: Array<{ recipeId: number; name: string }>;
}

export type ObjectivePlan =
  | { kind: 'TALK'; npcName: string }
  | { kind: 'VISIT'; mapId: string; mapName: string }
  | { kind: 'COMBAT'; capture: boolean }
  | { kind: 'GATHER' }
  | { kind: 'CRAFT'; recipeId: number; recipeName: string }
  | { kind: 'STUCK'; reason: string };

/** 從宿主寫進目標描述的「」引號取出名字。 */
export function quotedNames(text: string): string[] {
  const out: string[] = [];
  const re = /「([^」]+)」|"([^"]+)"/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const name = (m[1] ?? m[2] ?? '').trim();
    if (name.length >= 1) out.push(name);
  }
  return out;
}

export function npcNamedIn(description: string, known: readonly string[]): string | null {
  for (const quoted of quotedNames(description)) {
    const hit = known.find(n => n === quoted || n.includes(quoted) || quoted.includes(n));
    return hit ?? quoted;
  }
  const hits = known.filter(n => n.length >= 2 && description.includes(n));
  hits.sort((a, b) => b.length - a.length);
  return hits[0] ?? null;
}

export function mapNamedIn(
  description: string,
  maps: readonly { mapId: string; name: string }[],
): { mapId: string; name: string } | null {
  const ids = [...description.matchAll(/\d{4,6}/g)].map(m => m[0]);
  for (const id of ids) {
    const hit = maps.find(m => m.mapId === id);
    if (hit) return { mapId: hit.mapId, name: hit.name || hit.mapId };
  }
  if (ids.length === 1) return { mapId: ids[0], name: ids[0] };
  const hits = maps.filter(m => m.name.length >= 2 && description.includes(m.name));
  hits.sort((a, b) => b.name.length - a.name.length);
  return hits[0] ? { mapId: hits[0].mapId, name: hits[0].name } : null;
}

/** 依宿主目標決定下一步。對不上就回 STUCK，呼叫端必須停下而不是重試。 */
export interface GatherPointLike {
  id?: string;
  mapId?: string;
  mapName?: string | null;
  name?: string;
  skillId?: number | null;
  skillName?: string | null;
  requiredToolItemId?: number | null;
  requiredToolName?: string | null;
  x?: number;
  y?: number;
  materials?: Array<{ itemId?: number; name?: string }>;
}

export interface GatherPick {
  point: GatherPointLike;
  materialName: string;
  itemId?: number;
}

/**
 * 只拿「這個目標描述裡出現的材料名」對採集點。
 * 名稱較長的優先，避免短名誤中別的點；對不上就回 null，呼叫端必須停下或先去提示地圖，不能改採別的材料。
 */
export function pickQuestGatherPoint(description: string, points: readonly GatherPointLike[]): GatherPick | null {
  let best: GatherPick | null = null;
  let bestLen = 1;
  for (const point of points) {
    for (const material of point.materials ?? []) {
      const name = material.name?.trim() ?? '';
      if (name.length <= bestLen) continue;
      if (!description.includes(name)) continue;
      best = {
        point,
        materialName: name,
        ...(material.itemId !== undefined ? { itemId: material.itemId } : {}),
      };
      bestLen = name.length;
    }
  }
  return best;
}

export function planUnmetObjective(obj: ChainObjective, ctx: PlanContext): ObjectivePlan {
  switch (obj.type) {
    case 'TALK_TO_NPC': {
      const npcName = npcNamedIn(obj.description, ctx.npcNames);
      if (!npcName) return { kind: 'STUCK', reason: `交談目標無法從描述辨識：${obj.description}` };
      return { kind: 'TALK', npcName };
    }
    case 'VISIT_MAPS': {
      const hint = obj.targetMaps?.[0];
      if (hint) return { kind: 'VISIT', mapId: hint.mapId, mapName: hint.mapName ?? hint.mapId };
      const mapped = mapNamedIn(obj.description, ctx.maps);
      if (!mapped) return { kind: 'STUCK', reason: `訪問地圖無法從宿主資料辨識：${obj.description}` };
      return { kind: 'VISIT', mapId: mapped.mapId, mapName: mapped.name };
    }
    case 'KILL_MONSTERS':
    case 'DEFEAT_BOSS':
    case 'CAPTURE_PETS': {
      if (!obj.targetMaps || obj.targetMaps.length === 0) {
        return { kind: 'STUCK', reason: `戰鬥目標沒有宿主提供的 targetMaps：${obj.description}` };
      }
      return { kind: 'COMBAT', capture: obj.type === 'CAPTURE_PETS' };
    }
    case 'GATHER_COUNT':
    case 'COLLECT_ITEMS': {
      const matched = ctx.gatherPoints.some(p => p.materials?.some(m => m.name && obj.description.includes(m.name)));
      const hinted = (obj.targetMaps?.length ?? 0) > 0;
      if (!matched && !hinted && ctx.gatherPoints.length === 0) {
        return { kind: 'STUCK', reason: `採集或收集目標不在宿主採集清單：${obj.description}` };
      }
      if (!matched && !hinted) {
        return { kind: 'STUCK', reason: `採集或收集目標對不上宿主採集清單：${obj.description}` };
      }
      return { kind: 'GATHER' };
    }
    case 'CRAFT_COUNT': {
      const hit = ctx.recipes.find(r => r.name && obj.description.includes(r.name));
      if (!hit) return { kind: 'STUCK', reason: `配方名稱對不上宿主清單：${obj.description}` };
      return { kind: 'CRAFT', recipeId: hit.recipeId, recipeName: hit.name };
    }
    default:
      return { kind: 'STUCK', reason: `不認識的任務目標類型 ${obj.type}：${obj.description}` };
  }
}

export interface StuckState {
  signature: string;
  idleTicks: number;
}

export const IDLE_STUCK_LIMIT = 6;

export function progressSignature(
  questId: number | null,
  status: string | null,
  objectives: readonly { current: number; met: boolean }[],
  opening: string | null,
  mapId: string | null,
): string {
  const objs = objectives.map(o => `${o.current}${o.met ? 'y' : 'n'}`).join(',');
  return `${questId ?? '-'}|${status ?? '-'}|${objs}|${opening ?? '-'}|${mapId ?? '-'}`;
}

/** 閒置且簽名不變累積到上限就判定卡住。有在走路、戰鬥或工作時不計。 */
export function nextStuck(
  prev: StuckState | null,
  signature: string,
  idle: boolean,
  limit = IDLE_STUCK_LIMIT,
): { state: StuckState; stuck: boolean } {
  if (!idle) return { state: { signature, idleTicks: 0 }, stuck: false };
  if (prev && prev.signature === signature) {
    const idleTicks = prev.idleTicks + 1;
    return { state: { signature, idleTicks }, stuck: idleTicks >= limit };
  }
  return { state: { signature, idleTicks: 1 }, stuck: false };
}

/** 回村時可賣的東西：留下封印石、工具，以及尚未完成任務描述裡點名的物品。 */
export function sellableItems(items: readonly SnapshotItem[], keepNames: readonly string[]): SnapshotItem[] {
  return items.filter(it => {
    if (it.count <= 0) return false;
    const name = it.name ?? '';
    if (name.includes('封印') || name.includes('捕捉')) return false;
    if (keepNames.some(k => k.length >= 2 && name.includes(k))) return false;
    return true;
  });
}
