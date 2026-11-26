/**
 * F16：視窗自動採集循環。
 *
 * 走到採集點 → 開始工作 → 等完成 → 背包滿就回村卸貨 → 再回採集點，周而復始。
 * 這裡只有狀態機與驅動器：地圖代號、座標、背包數字全部來自呼叫端（設定）或橋接回報，
 * 不放任何原版資料。只送指令，不改規則。停止原因沿用視窗練功／尋路的 stop_reason。
 *
 * 狀態機是純函式（`stepGather`），F17 補給在同一個 `WorkPhase` 上擴充，三種行為（練功、尋路、
 * 採集）不會同時搶視窗：開始前與執行中都檢查橋接回報的 running 旗標。
 */
import type { WineNavStatus } from './pathfinding';
import {
  DEFAULT_RESUPPLY,
  SUPPLY_STOP_LABELS,
  buildResupplyPlan,
  potionsLow,
  resupplyConfigured,
  type ResupplyConfig,
  type ResupplyPlan,
  type WineSupplyStatus,
} from './resupplyLoop';

export interface WorkPoint {
  mapId: string;
  x: number;
  y: number;
}

export type GatherBagAction = 'return_home' | 'stop';

export type WorkActivity = 'gather' | 'hunt';

export interface GatherLoopConfig {
  /** `gather`：採集循環；`hunt`：練功時藥水不足或背包快滿就回村補給再回原地（F17）。 */
  activity: WorkActivity;
  /** F17：補給設定（沿用 F10 角色策略）。 */
  resupply: ResupplyConfig;
  resupplyTimeoutMs: number;
  spot: WorkPoint | null;
  /** 回村卸貨／補給的位置（商店旁）。`onBagFull` 是 `return_home` 或練功補給時必填。 */
  home: WorkPoint | null;
  onBagFull: GatherBagAction;
  /** 背包使用率達到這個百分比視為滿。 */
  bagFullPct: number;
  /** 卸貨後背包使用率要降到這個百分比以下才回去採集。 */
  unloadBelowPct: number;
  walkTimeoutMs: number;
  workTimeoutMs: number;
  unloadTimeoutMs: number;
  maxMinutes: number | null;
  maxCycles: number | null;
  /** 連續幾次讀到不是地圖也不是戰鬥的畫面就當成異常彈窗。 */
  popupTicks: number;
}

export const DEFAULT_GATHER_CONFIG: GatherLoopConfig = {
  activity: 'gather',
  resupply: { ...DEFAULT_RESUPPLY },
  resupplyTimeoutMs: 180_000,
  spot: null,
  home: null,
  onBagFull: 'return_home',
  bagFullPct: 100,
  unloadBelowPct: 50,
  walkTimeoutMs: 180_000,
  workTimeoutMs: 120_000,
  unloadTimeoutMs: 120_000,
  maxMinutes: 30,
  maxCycles: null,
  popupTicks: 3,
};

/** 與 F10 `BagFullPolicy`（STOP／NOTIFY／SELL）對應：只有 SELL 會回村。 */
export function bagFullActionFromPolicy(policy: 'STOP' | 'NOTIFY' | 'SELL'): GatherBagAction {
  return policy === 'SELL' ? 'return_home' : 'stop';
}

/** 橋接 `/status` 的 `gather` 欄位。缺欄位代表橋接沒回，不是 0。 */
export interface WineGatherStatus {
  running: boolean;
  state: string;
  /** 橋接累計完成的採集次數；沒有就是 null，驅動器改用狀態變化判斷完成。 */
  completedCount: number | null;
  bagUsed: number | null;
  bagCap: number | null;
  lastDurationMs: number | null;
  stopReason: string | null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function parseGatherStatus(raw: unknown): WineGatherStatus | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.state !== 'string' && typeof row.running !== 'boolean') return null;
  return {
    running: row.running === true,
    state: typeof row.state === 'string' ? row.state : 'idle',
    completedCount: finiteOrNull(row.completedCount),
    bagUsed: finiteOrNull(row.bagUsed),
    bagCap: finiteOrNull(row.bagCap),
    lastDurationMs: finiteOrNull(row.lastDurationMs),
    stopReason: typeof row.stopReason === 'string' && row.stopReason ? row.stopReason : null,
  };
}

export function bagPct(gather: Pick<WineGatherStatus, 'bagUsed' | 'bagCap'> | null | undefined): number | null {
  if (!gather || gather.bagUsed === null || gather.bagCap === null || gather.bagCap <= 0) return null;
  return Math.max(0, Math.min(100, (gather.bagUsed / gather.bagCap) * 100));
}

export type WorkPhase =
  | 'idle'
  | 'to_spot'
  | 'working'
  | 'hunting'
  | 'to_home'
  | 'unloading'
  | 'to_origin'
  | 'stopped';

export interface WorkObservation {
  nowMs: number;
  /** 橋接已連線。斷線就停，不猜狀態。 */
  connected: boolean;
  /** 橋接回報的畫面：`map`、`battle` 或其他。null＝橋接沒回。 */
  scene: string | null;
  nav: WineNavStatus | null;
  gather: WineGatherStatus | null;
  /** F17：補給進度與藥水、背包。沒有就是橋接還沒提供。 */
  supply?: WineSupplyStatus | null;
  /** F17：練功時的目前地圖與位置（橋接回報），用來記住「原地」。 */
  here?: WorkPoint | null;
  /** 練功循環正在跑。 */
  trainingRunning: boolean;
  /** 練功循環上一次停下的原因。 */
  trainingStopReason?: string | null;
}

export interface GatherLoopState {
  phase: WorkPhase;
  startedAtMs: number;
  phaseSinceMs: number;
  /** 這個階段的指令已送出。 */
  commandIssued: boolean;
  /** 送出工作指令時橋接的累計次數，用來分辨上一輪留下的 done。 */
  workBaseline: number | null;
  sawWorking: boolean;
  /** 完成的採集次數。 */
  gathers: number;
  /** 完成的回村卸貨／補給次數。 */
  unloads: number;
  popupStreak: number;
  stopReason: string | null;
  lastDurationMs: number | null;
  /** F17：練功時記住的原地，補給完走回來。 */
  origin: WorkPoint | null;
  /** F17：這趟回村的原因。 */
  trigger: 'potions' | 'bag' | null;
}

export type GatherEffect =
  | { kind: 'walk_to'; target: WorkPoint }
  | { kind: 'walk_stop' }
  | { kind: 'gather_start'; spot: WorkPoint }
  | { kind: 'gather_stop' }
  | { kind: 'unload' }
  | { kind: 'hunt_start' }
  | { kind: 'hunt_stop' }
  | { kind: 'resupply'; plan: ResupplyPlan };

export interface StepResult {
  state: GatherLoopState;
  effects: GatherEffect[];
}

export function idleGatherState(nowMs = 0): GatherLoopState {
  return {
    phase: 'idle',
    startedAtMs: nowMs,
    phaseSinceMs: nowMs,
    commandIssued: false,
    workBaseline: null,
    sawWorking: false,
    gathers: 0,
    unloads: 0,
    popupStreak: 0,
    stopReason: null,
    lastDurationMs: null,
    origin: null,
    trigger: null,
  };
}

function stopped(state: GatherLoopState, reason: string, nowMs: number, effects: GatherEffect[] = []): StepResult {
  return {
    state: { ...state, phase: 'stopped', stopReason: reason, phaseSinceMs: nowMs, commandIssued: false },
    effects,
  };
}

function validPoint(p: WorkPoint | null | undefined): p is WorkPoint {
  return !!p && typeof p.mapId === 'string' && p.mapId.trim() !== '' && Number.isFinite(p.x) && Number.isFinite(p.y);
}

/** 背包讀數：採集狀態優先，沒有就用補給狀態。 */
function bagSource(obs: Pick<WorkObservation, 'gather' | 'supply'>): Pick<WineGatherStatus, 'bagUsed' | 'bagCap'> | null {
  if (bagPct(obs.gather) !== null) return obs.gather;
  return obs.supply ?? obs.gather;
}

function supplyOn(cfg: GatherLoopConfig): boolean {
  return resupplyConfigured(cfg.resupply) || cfg.resupply.potionMin > 0;
}

/** 開始前檢查。回 null 表示可以開始；否則是停止原因。 */
export function gatherStartBlocker(cfg: GatherLoopConfig, obs: WorkObservation): string | null {
  if (!obs.connected) return 'disconnected';
  if (cfg.activity === 'gather') {
    if (!validPoint(cfg.spot)) return 'no_spot';
    if (cfg.onBagFull === 'return_home' && !validPoint(cfg.home)) return 'no_home';
    if (obs.trainingRunning || obs.nav?.running || obs.gather?.running || obs.supply?.running) return 'busy';
    return null;
  }
  // 練功補給：商店（回村點）必填；練功循環可以已經在跑，由這個循環接手。
  if (!validPoint(cfg.home)) return 'no_home';
  if (!supplyOn(cfg)) return 'no_supply_rule';
  if (obs.nav?.running || obs.gather?.running || obs.supply?.running) return 'busy';
  return null;
}

export function startGather(cfg: GatherLoopConfig, obs: WorkObservation): StepResult {
  const base = idleGatherState(obs.nowMs);
  const blocker = gatherStartBlocker(cfg, obs);
  if (blocker) return stopped(base, blocker, obs.nowMs);
  if (cfg.activity === 'hunt') {
    return { state: { ...base, phase: 'hunting', commandIssued: obs.trainingRunning, sawWorking: obs.trainingRunning }, effects: [] };
  }
  return { state: { ...base, phase: 'to_spot' }, effects: [] };
}

function samePoint(pos: [number, number] | null, p: WorkPoint): boolean {
  return pos !== null && Math.abs(pos[0] - p.x) < 1 && Math.abs(pos[1] - p.y) < 1;
}

type WalkOutcome = { kind: 'wait' } | { kind: 'arrived' } | { kind: 'failed'; reason: string };

function walkOutcome(nav: WineNavStatus | null, target: WorkPoint): WalkOutcome {
  if (!nav) return { kind: 'wait' };
  if (nav.running) return { kind: 'wait' };
  const reason = nav.stopReason;
  // 同一個目標才算數，避免把上一趟走路留下的 arrived 當成這一趟。
  if (nav.state === 'arrived' || reason === 'arrived') {
    return samePoint(nav.targetPos, target) ? { kind: 'arrived' } : { kind: 'wait' };
  }
  if (nav.state === 'stopped' && reason && samePoint(nav.targetPos, target)) return { kind: 'failed', reason };
  return { kind: 'wait' };
}

function bagIsFull(g: Pick<WineGatherStatus, 'bagUsed' | 'bagCap'> | null, cfg: GatherLoopConfig): boolean | null {
  const pct = bagPct(g);
  return pct === null ? null : pct >= cfg.bagFullPct;
}

/** 補給觸發：藥水不足優先，其次背包滿（只有設定回村才算）。讀不到藥水回 'unreadable'。 */
export function supplyTrigger(
  cfg: GatherLoopConfig,
  obs: Pick<WorkObservation, 'gather' | 'supply'>,
): 'potions' | 'bag' | 'unreadable' | null {
  const low = potionsLow(cfg.resupply, obs.supply ?? null);
  if (low === true) return 'potions';
  if (low === null) return 'unreadable';
  if (cfg.onBagFull === 'return_home' && bagIsFull(bagSource(obs), cfg) === true) return 'bag';
  return null;
}

const SUPPLY_WAIT_IDLE_MS = 15_000;
const NON_POPUP_SCENES = new Set(['map', 'battle', 'result']);

/**
 * 一個 tick。純函式：輸入狀態與觀察，回新狀態與要送出的指令。
 * `stopRequested` 帶使用者的停止原因（例如 `user_stopped`）。
 */
export function stepGather(
  state: GatherLoopState,
  obs: WorkObservation,
  cfg: GatherLoopConfig,
  stopRequested: string | null = null,
): StepResult {
  const now = obs.nowMs;
  if (state.phase === 'idle' || state.phase === 'stopped') return { state, effects: [] };
  const hunt = cfg.activity === 'hunt';

  const cleanup: GatherEffect[] = [];
  if (state.phase === 'to_spot' || state.phase === 'to_home' || state.phase === 'to_origin') cleanup.push({ kind: 'walk_stop' });
  if (state.phase === 'working') cleanup.push({ kind: 'gather_stop' });
  if (state.phase === 'hunting' && stopRequested) cleanup.push({ kind: 'hunt_stop' });

  if (stopRequested) return stopped(state, stopRequested, now, cleanup);

  // 全域條件
  if (!obs.connected) return stopped(state, 'disconnected', now, []);
  if (cfg.maxMinutes !== null && now - state.startedAtMs >= cfg.maxMinutes * 60_000) {
    return stopped(state, 'timeout', now, state.phase === 'hunting' ? [{ kind: 'hunt_stop' }] : cleanup);
  }
  // 練功時遇敵是常態；採集時遇敵就停。
  if (!hunt && obs.scene === 'battle') return stopped(state, 'entered_battle', now, cleanup);
  let popupStreak = 0;
  if (obs.scene !== null && (hunt ? !NON_POPUP_SCENES.has(obs.scene) : obs.scene !== 'map')) popupStreak = state.popupStreak + 1;
  if (popupStreak >= cfg.popupTicks) {
    return stopped(state, 'unexpected_popup', now, state.phase === 'hunting' ? [{ kind: 'hunt_stop' }] : cleanup);
  }
  if (!hunt && obs.trainingRunning) return stopped(state, 'busy', now, cleanup);
  let s: GatherLoopState = { ...state, popupStreak };

  const enter = (phase: WorkPhase, patch: Partial<GatherLoopState> = {}): GatherLoopState => ({
    ...s,
    ...patch,
    phase,
    phaseSinceMs: now,
    commandIssued: false,
    workBaseline: null,
    sawWorking: false,
  });
  const elapsed = now - s.phaseSinceMs;
  const shop = cfg.home;

  /** 走去 `target`。回 walk effect、等待、到達或失敗。練功循環還沒停乾淨時先等。 */
  const walkStep = (target: WorkPoint, onArrive: () => StepResult): StepResult => {
    if (!s.commandIssued) {
      if (hunt && obs.trainingRunning) {
        if (elapsed >= SUPPLY_WAIT_IDLE_MS) return stopped(s, 'busy', now, [{ kind: 'hunt_stop' }]);
        return { state: s, effects: [] };
      }
      return { state: { ...s, commandIssued: true }, effects: [{ kind: 'walk_to', target }] };
    }
    const out = walkOutcome(obs.nav, target);
    if (out.kind === 'failed') return stopped(s, out.reason, now);
    if (out.kind === 'arrived') return onArrive();
    if (elapsed >= cfg.walkTimeoutMs) return stopped(s, 'timeout', now, [{ kind: 'walk_stop' }]);
    return { state: s, effects: [] };
  };

  switch (s.phase) {
    case 'to_spot': {
      const spot = cfg.spot;
      if (!validPoint(spot)) return stopped(s, 'no_spot', now);
      return walkStep(spot, () => ({ state: enter('working'), effects: [] }));
    }
    case 'working': {
      const spot = cfg.spot;
      if (!validPoint(spot)) return stopped(s, 'no_spot', now);
      const g = obs.gather;
      if (!s.commandIssued) {
        return {
          state: { ...s, commandIssued: true, workBaseline: g?.completedCount ?? null, sawWorking: false },
          effects: [{ kind: 'gather_start', spot }],
        };
      }
      if (g?.stopReason && !g.running && (g.state === 'stopped' || g.state === 'error')) {
        return stopped(s, g.stopReason, now);
      }
      if (g?.running || g?.state === 'working') s = { ...s, sawWorking: true };
      const finished = !!g && !g.running && g.state !== 'working' && (
        g.completedCount !== null && s.workBaseline !== null
          ? g.completedCount > s.workBaseline
          : s.sawWorking && (g.state === 'done' || g.state === 'idle')
      );
      if (finished) {
        const gathers = s.gathers + 1;
        const lastDurationMs = g?.lastDurationMs ?? now - s.phaseSinceMs;
        const done = { ...s, gathers, lastDurationMs };
        if (cfg.maxCycles !== null && gathers >= cfg.maxCycles) return stopped(done, 'max_cycles', now);
        const full = bagIsFull(bagSource(obs), cfg);
        if (full === null) return stopped(done, 'bag_unreadable', now);
        const trig = supplyOn(cfg) ? supplyTrigger(cfg, obs) : null;
        if (trig === 'unreadable') return stopped(done, 'potion_unreadable', now);
        if (full || trig === 'potions') {
          if (!full && cfg.onBagFull === 'stop') return stopped(done, 'potions_low', now);
          if (full && cfg.onBagFull === 'stop') return stopped(done, 'bag_full', now);
          return { state: enter('to_home', { ...done, trigger: full ? 'bag' : 'potions' }), effects: [] };
        }
        // 繼續採同一個點。
        return { state: { ...done, phaseSinceMs: now, commandIssued: false, workBaseline: null, sawWorking: false }, effects: [] };
      }
      if (elapsed >= cfg.workTimeoutMs) return stopped(s, 'work_timeout', now, [{ kind: 'gather_stop' }]);
      return { state: s, effects: [] };
    }
    case 'hunting': {
      if (!s.commandIssued) {
        return { state: { ...s, commandIssued: true, sawWorking: false }, effects: [{ kind: 'hunt_start' }] };
      }
      if (obs.trainingRunning) s = { ...s, sawWorking: true };
      if (s.sawWorking && !obs.trainingRunning) return stopped(s, obs.trainingStopReason || 'training_stopped', now);
      if (!s.sawWorking && elapsed >= SUPPLY_WAIT_IDLE_MS) return stopped(s, obs.trainingStopReason || 'training_stopped', now);
      // 戰鬥中不打斷，等回到地圖再判斷。
      if (obs.scene !== 'map') return { state: s, effects: [] };
      const trig = supplyTrigger(cfg, obs);
      if (trig === 'unreadable') return stopped(s, 'potion_unreadable', now, [{ kind: 'hunt_stop' }]);
      if (trig === null) return { state: s, effects: [] };
      if (!validPoint(obs.here)) return stopped(s, 'origin_unknown', now, [{ kind: 'hunt_stop' }]);
      if (!validPoint(shop)) return stopped(s, 'no_home', now, [{ kind: 'hunt_stop' }]);
      return {
        state: enter('to_home', { origin: { ...obs.here }, trigger: trig }),
        effects: [{ kind: 'hunt_stop' }],
      };
    }
    case 'to_home': {
      if (!validPoint(shop)) return stopped(s, 'no_home', now);
      return walkStep(shop, () => ({ state: enter('unloading'), effects: [] }));
    }
    case 'unloading': {
      const effects: GatherEffect[] = [];
      const useSupply = supplyOn(cfg);
      const sup = obs.supply ?? null;
      if (!s.commandIssued) {
        s = { ...s, commandIssued: true, workBaseline: sup?.completedCount ?? null, sawWorking: false };
        effects.push(useSupply ? { kind: 'resupply', plan: buildResupplyPlan(cfg.resupply) } : { kind: 'unload' });
        return { state: s, effects };
      }
      if (useSupply) {
        if (sup?.stopReason && !sup.running && (sup.state === 'stopped' || sup.state === 'error')) {
          return stopped(s, sup.stopReason, now);
        }
        if (sup?.running) s = { ...s, sawWorking: true };
        const finished = !!sup && !sup.running && (
          sup.completedCount !== null && s.workBaseline !== null
            ? sup.completedCount > s.workBaseline
            : s.sawWorking && (sup.state === 'done' || sup.state === 'idle')
        );
        if (!finished) {
          if (elapsed >= cfg.resupplyTimeoutMs) return stopped(s, 'resupply_timeout', now, [{ kind: 'walk_stop' }]);
          return { state: s, effects: [] };
        }
        // 補完後再讀一次：藥水還是不足就停，不在原地反覆補。
        if (s.trigger === 'potions' && potionsLow(cfg.resupply, sup) !== false) {
          return stopped(s, 'resupply_failed', now);
        }
        const pctAfter = bagPct(bagSource(obs));
        if (hunt === false && pctAfter !== null && pctAfter > cfg.unloadBelowPct && s.trigger === 'bag') {
          return stopped(s, 'bag_still_full', now);
        }
      } else {
        const pct = bagPct(bagSource(obs));
        if (pct === null) return stopped(s, 'bag_unreadable', now);
        if (pct > cfg.unloadBelowPct) {
          if (elapsed >= cfg.unloadTimeoutMs) return stopped(s, 'bag_still_full', now);
          return { state: s, effects: [] };
        }
      }
      const unloads = s.unloads + 1;
      if (hunt) {
        return { state: enter('to_origin', { unloads }), effects: [] };
      }
      return { state: enter('to_spot', { unloads }), effects: [] };
    }
    case 'to_origin': {
      const origin = s.origin;
      if (!validPoint(origin)) return stopped(s, 'origin_unknown', now);
      return walkStep(origin, () => ({ state: enter('hunting', { origin: null, trigger: null }), effects: [] }));
    }
    default:
      return { state: s, effects: [] };
  }
}

export const GATHER_STOP_LABELS: Record<string, string> = {
  disconnected: '遊戲連線中斷安全停機',
  no_spot: '還沒設定採集點',
  no_home: '還沒設定回村點',
  no_supply_rule: '還沒設定補給條件',
  potions_low: '藥水不足',
  busy: '練功、尋路或採集已有一項在跑',
  bag_full: '背包已滿',
  bag_unreadable: '讀不到背包狀態',
  bag_still_full: '回村後背包還是滿的',
  work_timeout: '採集等太久',
  max_cycles: '已達循環次數上限',
  bridge_unsupported: '橋接尚未提供採集指令',
  bridge_error: '橋接錯誤',
  timeout: '已達時間上限',
  user_stopped: '手動停止',
  entered_battle: '遇到戰鬥，已停下',
  unexpected_popup: '偵測到未知彈窗安全停機',
  arrived: '已到達',
  path_blocked: '沒有可走的路',
  stuck: '卡住後停下',
  map_mismatch: '地圖不符，已停下',
  coord_read_failed: '讀不到座標，已停下',
  coord_box_unsourced: '座標框尚無出處',
};

export function formatGatherStopReason(reason: string | null | undefined): string {
  if (!reason) return '';
  return GATHER_STOP_LABELS[reason] ?? SUPPLY_STOP_LABELS[reason] ?? reason;
}

export const WORK_PHASE_LABELS: Record<WorkPhase, string> = {
  idle: '尚未開始',
  to_spot: '前往採集點',
  working: '採集中',
  hunting: '練功中',
  to_home: '回村中',
  unloading: '補給／卸貨中',
  to_origin: '回原地中',
  stopped: '已停下',
};

// ---- 驅動器 ----

export interface GatherPorts {
  observe(): WorkObservation;
  walkTo(target: WorkPoint): Promise<unknown>;
  walkStop(): Promise<unknown>;
  gatherStart(spot: WorkPoint): Promise<unknown>;
  gatherStop(): Promise<unknown>;
  /** 回村後的卸貨動作（賣出、存倉）。沒提供就只等背包使用率降下來。 */
  unload?(): Promise<unknown>;
  /** F17：停止練功循環／重新開始。 */
  huntStart?(): Promise<unknown>;
  huntStop?(): Promise<unknown>;
  /** F17：在商店買藥賣物。沒提供就停在 `bridge_unsupported`。 */
  resupply?(plan: ResupplyPlan): Promise<unknown>;
}

export interface GatherRunnerSnapshot {
  state: GatherLoopState;
  config: GatherLoopConfig;
  log: string[];
}

const MAX_LOG = 40;

/** 把橋接的 HTTP 錯誤訊息換成停止原因。 */
export function reasonFromPortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === 'already_running' || msg.includes('409')) return 'busy';
  if (msg === 'not found' || msg.includes('404')) return 'bridge_unsupported';
  return 'bridge_error';
}

export class GatherLoopRunner {
  private snap: GatherRunnerSnapshot;
  private listeners = new Set<(s: GatherRunnerSnapshot) => void>();
  private pendingStop: string | null = null;
  private ticking = false;

  constructor(private readonly ports: GatherPorts, config: GatherLoopConfig = DEFAULT_GATHER_CONFIG) {
    this.snap = { state: idleGatherState(), config, log: [] };
  }

  getSnapshot(): GatherRunnerSnapshot {
    return this.snap;
  }

  subscribe(fn: (s: GatherRunnerSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  get active(): boolean {
    const p = this.snap.state.phase;
    return p !== 'idle' && p !== 'stopped';
  }

  setConfig(config: GatherLoopConfig): void {
    this.emit({ config });
  }

  private emit(patch: Partial<GatherRunnerSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn(this.snap);
  }

  private log(line: string): void {
    this.snap = { ...this.snap, log: [...this.snap.log, line].slice(-MAX_LOG) };
  }

  start(): GatherLoopState {
    this.pendingStop = null;
    const res = startGather(this.snap.config, this.ports.observe());
    this.log(res.state.phase === 'stopped' ? `不能開始：${formatGatherStopReason(res.state.stopReason)}` : '開始採集循環');
    this.emit({ state: res.state });
    return res.state;
  }

  /** 要求停止；下一個 tick 會送出收尾指令。 */
  requestStop(reason = 'user_stopped'): void {
    this.pendingStop = reason;
  }

  async tick(): Promise<GatherLoopState> {
    if (this.ticking || !this.active) return this.snap.state;
    this.ticking = true;
    try {
      const before = this.snap.state;
      const res = stepGather(before, this.ports.observe(), this.snap.config, this.pendingStop);
      this.snap = { ...this.snap, state: res.state };
      if (res.state.phase !== before.phase) {
        this.log(`${WORK_PHASE_LABELS[before.phase]} → ${WORK_PHASE_LABELS[res.state.phase]}${res.state.stopReason ? `（${formatGatherStopReason(res.state.stopReason)}）` : ''}`);
      }
      for (const eff of res.effects) {
        try {
          await this.run(eff);
        } catch (err) {
          const reason = reasonFromPortError(err);
          // 收尾指令失敗不覆蓋原本的停止原因。
          if (this.snap.state.phase !== 'stopped') {
            this.snap = { ...this.snap, state: { ...this.snap.state, phase: 'stopped', stopReason: reason } };
            this.log(`指令失敗：${formatGatherStopReason(reason)}`);
          }
          break;
        }
      }
      this.emit({});
      return this.snap.state;
    } finally {
      this.ticking = false;
    }
  }

  private run(eff: GatherEffect): Promise<unknown> {
    switch (eff.kind) {
      case 'walk_to': return this.ports.walkTo(eff.target);
      case 'walk_stop': return this.ports.walkStop();
      case 'gather_start': return this.ports.gatherStart(eff.spot);
      case 'gather_stop': return this.ports.gatherStop();
      case 'unload': return this.ports.unload ? this.ports.unload() : Promise.resolve(null);
      case 'hunt_start': return this.ports.huntStart ? this.ports.huntStart() : Promise.reject(new Error('not found'));
      case 'hunt_stop': return this.ports.huntStop ? this.ports.huntStop() : Promise.resolve(null);
      case 'resupply': return this.ports.resupply ? this.ports.resupply(eff.plan) : Promise.reject(new Error('not found'));
    }
  }
}
