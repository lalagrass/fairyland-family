import type { FamilyState, LogEntry } from './state';

export interface SessionCheckpoint {
  savedAt: number;
  characterId: string;
  characterName: string;
  mapId: string;
  mapName: string;
  level: number;
  gold: number;
  items: Record<string, number>;
}

export interface AutomationRecapDetails {
  completedQuests: string[];
  /** 這次跑完的任務在快照上標的獎勵經驗合計（不含打怪經驗）。 */
  questExp: number;
  stopReason: string;
}

export interface WelcomeRecapSummary {
  characterId: string;
  characterName: string;
  awayMs: number;
  awayText: string;
  mapTransition: string | null;
  levelDelta: number;
  goldDelta: number;
  itemDeltas: Array<{ name: string; delta: number }>;
  highlights: string[];
  /** FM8：無人任務結束時附上完成的任務、任務經驗與停止原因。 */
  automation?: AutomationRecapDetails;
}

interface KvStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

const CHECKPOINT_KEY = 'fairyland_family:recap_checkpoint:v1';

export function formatAwayDuration(ms: number): string {
  const sec = Math.max(1, Math.floor(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分鐘`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr} 小時 ${remMin} 分` : `${hr} 小時`;
}

export function buildCheckpointFromState(state: FamilyState, nowMs: number): SessionCheckpoint | null {
  const snap = state.snapshot;
  const c = state.character;
  const cid = state.characterId ?? state.activeCharacterId;
  if (!snap || !c || !cid) return null;

  const items: Record<string, number> = {};
  for (const it of state.inventory) {
    const key = it.name || `#${it.itemId}`;
    items[key] = (items[key] ?? 0) + it.count;
  }

  return {
    savedAt: nowMs,
    characterId: cid,
    characterName: c.name ?? cid,
    mapId: snap.mapId,
    mapName: snap.mapName ?? snap.mapId,
    level: c.level,
    gold: c.gold,
    items,
  };
}

/** 比對重開前的本機快照與目前狀態，產出「回來摘要」卡片資料。 */
export function computeWelcomeRecap(
  prev: SessionCheckpoint,
  curr: SessionCheckpoint,
  logs: readonly LogEntry[] = [],
  minAwayMs = 60_000,
): WelcomeRecapSummary | null {
  if (prev.characterId !== curr.characterId) return null;
  const awayMs = Math.max(0, curr.savedAt - prev.savedAt);
  const goldDelta = curr.gold - prev.gold;
  const levelDelta = curr.level - prev.level;
  const mapChanged = prev.mapId !== curr.mapId;

  const itemDeltas: Array<{ name: string; delta: number }> = [];
  const allNames = new Set([...Object.keys(prev.items), ...Object.keys(curr.items)]);
  for (const name of allNames) {
    const delta = (curr.items[name] ?? 0) - (prev.items[name] ?? 0);
    if (delta !== 0) itemDeltas.push({ name, delta });
  }
  itemDeltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const hasDiff = mapChanged || goldDelta !== 0 || levelDelta !== 0 || itemDeltas.length > 0;
  if (awayMs < minAwayMs && !hasDiff) return null;

  const highlights = logs
    .filter(l => l.at >= prev.savedAt && (l.level === 'warn' || l.text.includes('完成') || l.text.includes('停止')))
    .slice(-4)
    .map(l => l.text);

  return {
    characterId: curr.characterId,
    characterName: curr.characterName,
    awayMs,
    awayText: formatAwayDuration(awayMs),
    mapTransition: mapChanged ? `${prev.mapName} → ${curr.mapName}` : null,
    levelDelta,
    goldDelta,
    itemDeltas: itemDeltas.slice(0, 6),
    highlights,
  };
}

/** 無人任務停下時的摘要。離開時間再短也要看得到停止原因。 */
export function buildStopRecap(
  prev: SessionCheckpoint,
  curr: SessionCheckpoint,
  logs: readonly LogEntry[],
  automation: AutomationRecapDetails,
): WelcomeRecapSummary {
  const recap = computeWelcomeRecap(prev, curr, logs, 0);
  if (recap) return { ...recap, automation };
  return {
    characterId: curr.characterId,
    characterName: curr.characterName,
    awayMs: Math.max(0, curr.savedAt - prev.savedAt),
    awayText: formatAwayDuration(Math.max(0, curr.savedAt - prev.savedAt)),
    mapTransition: prev.mapId !== curr.mapId ? `${prev.mapName} → ${curr.mapName}` : null,
    levelDelta: curr.level - prev.level,
    goldDelta: curr.gold - prev.gold,
    itemDeltas: [],
    highlights: [],
    automation,
  };
}

export class RecapTracker {
  private prevCheckpoints = new Map<string, SessionCheckpoint>();
  private consumedRecap = new Set<string>();
  private lastSavedAt = 0;

  constructor(private storage: KvStorage | null = null, private minAwayMs = 60_000) {
    this.load();
  }

  private load(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(CHECKPOINT_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, SessionCheckpoint>;
      for (const [cid, cp] of Object.entries(parsed)) {
        if (cid && cp && typeof cp.savedAt === 'number') this.prevCheckpoints.set(cid, cp);
      }
    } catch {
      // 忽略損毀資料
    }
  }

  private persistAll(): void {
    if (!this.storage) return;
    try {
      const out: Record<string, SessionCheckpoint> = {};
      for (const [k, v] of this.prevCheckpoints.entries()) out[k] = v;
      this.storage.setItem(CHECKPOINT_KEY, JSON.stringify(out));
    } catch {
      // 忽略寫入失敗
    }
  }

  evaluateOnState(state: FamilyState, nowMs: number): WelcomeRecapSummary | null {
    const curr = buildCheckpointFromState(state, nowMs);
    if (!curr) return null;

    let recap: WelcomeRecapSummary | null = null;
    if (!this.consumedRecap.has(curr.characterId)) {
      this.consumedRecap.add(curr.characterId);
      const prev = this.prevCheckpoints.get(curr.characterId);
      if (prev) {
        recap = computeWelcomeRecap(prev, curr, state.log, this.minAwayMs);
      }
    }

    if (nowMs - this.lastSavedAt >= 3000 || recap !== null) {
      this.lastSavedAt = nowMs;
      this.prevCheckpoints.set(curr.characterId, curr);
      this.persistAll();
    }
    return recap;
  }
}
