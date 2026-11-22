import type { SceneSnapshot, SnapshotQuestEntry, SnapshotQuestObjective } from '../protocol/index';

/**
 * F9 任務卡片（fairyland-family#50）：把宿主快照的任務清單整理成卡片要顯示的文字。
 *
 * 規則：所有文字與數值都只讀宿主快照，本檔不寫任何任務資料。宿主沒給的值（null、缺欄位、空字串、非有限數）
 * 一律顯示「未知」，不自己補。協定 v5 的任務欄位還沒有逐欄的「佔位」旗標，所以「沒有值」就是目前唯一能判斷的訊號。
 */

export const UNKNOWN_TEXT = '未知';

/** 窄版（手機）分界，與 style.css `@container quest-cards (max-width: 479px)` 相同。 */
export const QUEST_CARDS_NARROW_BELOW = 480;
/** 寬版每張卡片的最小寬度與間距，與 style.css 的 `minmax(240px, 1fr)`／`gap: 10px` 相同。 */
export const QUEST_CARD_MIN_WIDTH = 240;
export const QUEST_CARD_GAP = 10;

export type QuestStatus = SnapshotQuestEntry['status'];

export const QUEST_STATUS_META: Record<QuestStatus, { text: string; cls: string }> = {
  AVAILABLE: { text: '可接取', cls: 'pill mode' },
  IN_PROGRESS: { text: '進行中', cls: 'pill warn' },
  READY: { text: '可回報', cls: 'pill ok' },
  COMPLETED: { text: '已完成', cls: 'pill' },
};

const STATUS_RANK: Record<string, number> = { READY: 0, IN_PROGRESS: 1, AVAILABLE: 2, COMPLETED: 3 };

export interface QuestCardsLayout {
  narrow: boolean;
  columns: number;
}

/** 容器寬度 → 欄數。量不到寬度（0／NaN）時當成窄版單欄。 */
export function questCardsLayout(width: number): QuestCardsLayout {
  if (!Number.isFinite(width) || width < QUEST_CARDS_NARROW_BELOW) return { narrow: true, columns: 1 };
  const columns = Math.max(1, Math.floor((width + QUEST_CARD_GAP) / (QUEST_CARD_MIN_WIDTH + QUEST_CARD_GAP)));
  return { narrow: false, columns };
}

export interface QuestCardGo {
  kind: 'NPC' | 'MAP';
  /** NPC：名稱查詢字串；MAP：地圖 id。 */
  target: string;
  /** 按鈕與日誌用的名稱。 */
  name: string;
}

export interface QuestCardObjective {
  text: string;
  progress: string;
  met: boolean;
}

export interface QuestCardOwner {
  /** 進行者的角色 id；沒人在做時為 null。 */
  characterId: string | null;
  text: string;
  /** AUTO＝family 自動推進中；PENDING＝派給角色、等視角切過去；MANUAL＝快照裡這位角色接著；NONE＝沒人接；DONE＝已完成。 */
  mode: 'AUTO' | 'PENDING' | 'MANUAL' | 'NONE' | 'DONE';
}

export interface QuestCardModel {
  questId: number;
  status: QuestStatus;
  statusText: string;
  statusCls: string;
  title: string;
  /** 委託人（NPC）。 */
  giver: string;
  /** 目標（第一個未完成的目標；都完成時寫回報對象）。 */
  goal: string;
  location: string;
  progress: string;
  objectives: QuestCardObjective[];
  minLevel: string;
  rewardExp: string;
  rewardCoins: string;
  owner: QuestCardOwner;
  /** 「前往」的目的地；沒有可走的目標（或已完成）時為 null。 */
  go: QuestCardGo | null;
  /** 這張卡片有沒有任何欄位顯示「未知」。 */
  hasUnknown: boolean;
}

export interface QuestCardContext {
  snapshot: Pick<SceneSnapshot, 'mapId' | 'mapName' | 'npcs' | 'nav'> | null;
  /** 這份任務清單屬於哪位角色（快照的視角角色）。 */
  viewCharacterId: string | null;
  /** 角色 id → 名稱。 */
  nameOf: (characterId: string) => string | null;
  /** family 自動推進中的任務。 */
  activeQuestId: number | null;
  /** 已派給角色、正在等視角切過去的任務。 */
  pendingAssign: { questId: number; characterId: string } | null;
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export const textOrUnknown = (v: unknown): string => (isText(v) ? v : UNKNOWN_TEXT);
export const numOrUnknown = (v: unknown, fmt: (n: number) => string = n => String(n)): string => (isNum(v) ? fmt(v) : UNKNOWN_TEXT);

function objectiveProgress(o: SnapshotQuestObjective): string {
  return isNum(o.current) && isNum(o.required) ? `${o.current}/${o.required}` : UNKNOWN_TEXT;
}

function mapNameFrom(ctx: QuestCardContext, mapId: string | undefined | null, hint?: string | null): string | null {
  if (isText(hint)) return hint;
  if (!isText(mapId)) return null;
  const snap = ctx.snapshot;
  if (snap && snap.mapId === mapId && isText(snap.mapName)) return snap.mapName;
  const reach = snap?.nav?.reachableMaps?.find(m => m.mapId === mapId);
  if (reach && isText(reach.name)) return reach.name;
  const node = snap?.nav?.portalGraph?.find(n => n.mapId === mapId);
  return node && isText(node.name) ? node.name : null;
}

function npcHere(ctx: QuestCardContext, npcId: string | undefined, npcName: string | undefined): boolean {
  const npcs = ctx.snapshot?.npcs ?? [];
  return npcs.some(n => (isText(npcId) && n.id === npcId) || (isText(npcName) && n.name === npcName));
}

/** 第一個未完成且宿主有指出地點的目標。 */
function nextObjective(q: SnapshotQuestEntry): SnapshotQuestObjective | undefined {
  return (q.objectives ?? []).find(o => !o.met);
}

function ownerOf(q: SnapshotQuestEntry, ctx: QuestCardContext): QuestCardOwner {
  const viewName = ctx.viewCharacterId ? ctx.nameOf(ctx.viewCharacterId) ?? ctx.viewCharacterId : null;
  if (ctx.pendingAssign && ctx.pendingAssign.questId === q.questId) {
    const id = ctx.pendingAssign.characterId;
    return { characterId: id, mode: 'PENDING', text: `派給 ${ctx.nameOf(id) ?? id}（等待切換視角）` };
  }
  if (ctx.activeQuestId === q.questId && ctx.viewCharacterId) {
    return { characterId: ctx.viewCharacterId, mode: 'AUTO', text: `${viewName}（自動推進中）` };
  }
  if (q.status === 'COMPLETED') {
    return { characterId: ctx.viewCharacterId, mode: 'DONE', text: viewName ? `${viewName}（已完成）` : '已完成' };
  }
  if ((q.status === 'IN_PROGRESS' || q.status === 'READY') && ctx.viewCharacterId) {
    return { characterId: ctx.viewCharacterId, mode: 'MANUAL', text: viewName ?? UNKNOWN_TEXT };
  }
  return { characterId: null, mode: 'NONE', text: '尚無角色接取' };
}

export function questCardModel(q: SnapshotQuestEntry, ctx: QuestCardContext): QuestCardModel {
  const meta = QUEST_STATUS_META[q.status] ?? { text: textOrUnknown(q.status), cls: 'pill' };
  const giver = textOrUnknown(q.npcName);
  const objectives: QuestCardObjective[] = (q.objectives ?? []).map(o => ({
    text: textOrUnknown(o.description),
    progress: objectiveProgress(o),
    met: o.met === true,
  }));
  const next = q.status === 'IN_PROGRESS' ? nextObjective(q) : undefined;

  let goal: string;
  let location: string;
  let go: QuestCardGo | null = null;
  if (q.status === 'COMPLETED') {
    goal = '已完成';
    location = '—';
  } else if (next) {
    goal = textOrUnknown(next.description);
    const hint = next.targetMaps?.find(h => isText(h.mapId));
    const mapId = isText(next.targetMapId) ? next.targetMapId : hint?.mapId;
    const mapName = mapNameFrom(ctx, mapId, isText(next.targetMapId) ? null : hint?.mapName ?? null);
    const npcName = isText(next.targetNpcName) ? next.targetNpcName : null;
    location = [npcName, mapName].filter(isText).join('｜') || UNKNOWN_TEXT;
    if (npcName && (!mapId || mapId === ctx.snapshot?.mapId)) go = { kind: 'NPC', target: npcName, name: npcName };
    else if (isText(mapId)) go = { kind: 'MAP', target: mapId, name: mapName ?? mapId };
    else if (npcName) go = { kind: 'NPC', target: npcName, name: npcName };
  } else {
    // 可接取、可回報（或進行中但目標都已達成）：找委託人。
    goal = q.status === 'AVAILABLE' ? `向 ${giver} 接取` : `向 ${giver} 回報`;
    const here = npcHere(ctx, q.npcId, q.npcName);
    const where = here ? mapNameFrom(ctx, ctx.snapshot?.mapId) : null;
    location = isText(q.npcName) ? (where ? `${q.npcName}｜${where}` : q.npcName) : UNKNOWN_TEXT;
    if (isText(q.npcName)) go = { kind: 'NPC', target: q.npcName, name: q.npcName };
  }

  const total = objectives.length;
  const metCount = objectives.filter(o => o.met).length;
  const progress = total === 0 ? (q.status === 'COMPLETED' ? '完成' : UNKNOWN_TEXT) : `${metCount}/${total} 項目標`;

  const model: QuestCardModel = {
    questId: q.questId,
    status: q.status,
    statusText: meta.text,
    statusCls: meta.cls,
    title: textOrUnknown(q.title),
    giver,
    goal,
    location,
    progress,
    objectives,
    minLevel: numOrUnknown(q.minLevel, n => `Lv.${n}`),
    rewardExp: numOrUnknown(q.rewardExp, n => `${n} EXP`),
    rewardCoins: numOrUnknown(q.rewardCoins, n => `${n} 金`),
    owner: ownerOf(q, ctx),
    go,
    hasUnknown: false,
  };
  model.hasUnknown = [model.title, model.giver, model.goal, model.location, model.progress, model.minLevel, model.rewardExp, model.rewardCoins]
    .concat(objectives.flatMap(o => [o.text, o.progress]))
    .some(t => t.includes(UNKNOWN_TEXT));
  return model;
}

/** 卡片順序：可回報 → 進行中 → 可接取 → 已完成，同狀態依任務編號。 */
export function questCardModels(quests: readonly SnapshotQuestEntry[] | undefined, ctx: QuestCardContext): QuestCardModel[] {
  return [...(quests ?? [])]
    .sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || a.questId - b.questId)
    .map(q => questCardModel(q, ctx));
}
