/**
 * F17：補給的設定、橋接回報解析與指令組裝。
 * 道具編號與數量只來自使用者設定（沿用 F10 角色策略）或橋接回報；價格、商店位置不在這裡，
 * 由橋接在商店畫面讀取。repo 不放任何原版資料。
 */
import type { BagFullPolicy, InventoryPolicy } from '../automation/strategyStore';

export interface ResupplyConfig {
  /** 要補的藥水道具編號（F10 `inventoryPolicy.hpItem`）。null＝不補藥。 */
  potionItemId: number | null;
  /** 藥水數量低於這個值就回村補給。0＝不依藥水觸發。 */
  potionMin: number;
  /** 補到幾個。 */
  potionTarget: number;
  /** 回村時要賣的道具編號（F10 `inventoryPolicy.deposit`，且背包滿策略是 SELL）。 */
  sellItemIds: number[];
}

export const DEFAULT_RESUPPLY: ResupplyConfig = {
  potionItemId: null,
  potionMin: 0,
  potionTarget: 0,
  sellItemIds: [],
};

const int = (v: unknown, min: number, max: number, fb: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : fb;
const itemId = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;

export function sanitizeResupply(raw: unknown): ResupplyConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_RESUPPLY, sellItemIds: [] };
  const r = raw as Partial<ResupplyConfig>;
  const potionMin = int(r.potionMin, 0, 999, 0);
  const potionTarget = Math.max(potionMin, int(r.potionTarget, 0, 999, 0));
  const sell = Array.isArray(r.sellItemIds)
    ? [...new Set(r.sellItemIds.map(itemId).filter((id): id is number => id !== null))]
    : [];
  return { potionItemId: itemId(r.potionItemId), potionMin, potionTarget, sellItemIds: sell };
}

/** 沿用 F10：補藥用 `hpItem`；賣出清單只有背包滿策略是 SELL 時才採用 `deposit`。數量門檻 F10 沒有，沿用目前設定。 */
export function resupplyFromStrategy(
  policy: Pick<InventoryPolicy, 'hpItem' | 'deposit'> | undefined,
  bagFullPolicy: BagFullPolicy,
  current: ResupplyConfig = DEFAULT_RESUPPLY,
): ResupplyConfig {
  return sanitizeResupply({
    ...current,
    potionItemId: policy?.hpItem ?? null,
    sellItemIds: bagFullPolicy === 'SELL' ? policy?.deposit ?? [] : [],
  });
}

/** 橋接 `/status` 的 `supply` 欄位。缺欄位代表橋接沒回，不是 0。 */
export interface WineSupplyStatus {
  running: boolean;
  state: string;
  completedCount: number | null;
  /** 目前藥水數量；讀不到就是 null。 */
  potionCount: number | null;
  gold: number | null;
  bagUsed: number | null;
  bagCap: number | null;
  stopReason: string | null;
}

const finiteOrNull = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;

export function parseSupplyStatus(raw: unknown): WineSupplyStatus | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.state !== 'string' && typeof row.running !== 'boolean') return null;
  return {
    running: row.running === true,
    state: typeof row.state === 'string' ? row.state : 'idle',
    completedCount: finiteOrNull(row.completedCount),
    potionCount: finiteOrNull(row.potionCount),
    gold: finiteOrNull(row.gold),
    bagUsed: finiteOrNull(row.bagUsed),
    bagCap: finiteOrNull(row.bagCap),
    stopReason: typeof row.stopReason === 'string' && row.stopReason ? row.stopReason : null,
  };
}

export interface ResupplyPlan {
  buy: Array<{ itemId: number; targetCount: number }>;
  sellItemIds: number[];
}

export function buildResupplyPlan(cfg: ResupplyConfig): ResupplyPlan {
  const buy = cfg.potionItemId !== null && cfg.potionTarget > 0
    ? [{ itemId: cfg.potionItemId, targetCount: cfg.potionTarget }]
    : [];
  return { buy, sellItemIds: [...cfg.sellItemIds] };
}

/** 設定裡有任何要買或要賣的東西。 */
export function resupplyConfigured(cfg: ResupplyConfig): boolean {
  const plan = buildResupplyPlan(cfg);
  return plan.buy.length > 0 || plan.sellItemIds.length > 0;
}

/** 藥水不足。數量讀不到回 null（不猜）；沒設定藥水觸發回 false。 */
export function potionsLow(cfg: ResupplyConfig, supply: Pick<WineSupplyStatus, 'potionCount'> | null): boolean | null {
  if (cfg.potionItemId === null || cfg.potionMin <= 0) return false;
  if (!supply || supply.potionCount === null) return null;
  return supply.potionCount < cfg.potionMin;
}

export const SUPPLY_STOP_LABELS: Record<string, string> = {
  no_money: '錢不夠買補給',
  shop_not_found: '商店對不到',
  origin_unknown: '讀不到原地座標，無法回原地',
  potion_unreadable: '讀不到藥水數量',
  resupply_failed: '補給後藥水還是不足',
  training_stopped: '練功循環已停',
  resupply_timeout: '補給等太久',
};
