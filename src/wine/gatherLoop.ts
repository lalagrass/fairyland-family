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

export interface WorkPoint {
  mapId: string;
  x: number;
  y: number;
}

export type GatherBagAction = 'return_home' | 'stop';

export interface GatherLoopConfig {
  spot: WorkPoint | null;
  /** 回村卸貨的位置。`onBagFull` 是 `return_home` 時必填。 */
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

export type WorkPhase = 'idle' | 'to_spot' | 'working' | 'to_home' | 'unloading' | 'stopped';

export interface WorkObservation {
  nowMs: number;
  /** 橋接已連線。斷線就停，不猜狀態。 */
  connected: boolean;
  /** 橋接回報的畫面：`map`、`battle` 或其他。null＝橋接沒回。 */
  scene: string | null;
  nav: WineNavStatus | null;
  gather: WineGatherStatus | null;
  /** 練功循環正在跑。 */
  trainingRunning: boolean;
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
  /** 完成的回村卸貨次數。 */
  unloads: number;
  popupStreak: number;
  stopReason: string | null;
  lastDurationMs: number | null;
}

export type GatherEffect =
  | { kind: 'walk_to'; target: WorkPoint }
  | { kind: 'walk_stop' }
  | { kind: 'gather_start'; spot: WorkPoint }
  | { kind: 'gather_stop' }
  | { kind: 'unload' };

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
  };
}

function stopped(state: GatherLoopState, reason: string, nowMs: number, effects: GatherEffect[] = []): StepResult {
  return {
    state: { ...state, phase: 'stopped', stopReason: reason, phaseSinceMs: nowMs, commandIssued: false },
    effects,
  };
}

function validPoint(p: WorkPoint | null): p is WorkPoint {
  return !!p && typeof p.mapId === 'string' && p.mapId.trim() !== '' && Number.isFinite(p.x) && Number.isFinite(p.y);
}

/** 開始前檢查。回 null 表示可以開始；否則是停止原因。 */
export function gatherStartBlocker(cfg: GatherLoopConfig, obs: WorkObservation): string | null {
  if (!obs.connected) return 'disconnected';
  if (!validPoint(cfg.spot)) return 'no_spot';
  if (cfg.onBagFull === 'return_home' && !validPoint(cfg.home)) return 'no_home';
  if (obs.trainingRunning || obs.nav?.running || obs.gather?.running) return 'busy';
  return null;
}

export function startGather(cfg: GatherLoopConfig, obs: WorkObservation): StepResult {
  const base = idleGatherState(obs.nowMs);
  const blocker = gatherStartBlocker(cfg, obs);
  if (blocker) return stopped(base, blocker, obs.nowMs);
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

function bagIsFull(g: WineGatherStatus | null, cfg: GatherLoopConfig): boolean | null {
  const pct = bagPct(g);
  return pct === null ? null : pct >= cfg.bagFullPct;
}

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

  const cleanup: GatherEffect[] = [];
  if (state.phase === 'to_spot' || state.phase === 'to_home') cleanup.push({ kind: 'walk_stop' });
  if (state.phase === 'working') cleanup.push({ kind: 'gather_stop' });

  if (stopRequested) return stopped(state, stopRequested, now, cleanup);

  // 全域條件
  if (!obs.connected) return stopped(state, 'disconnected', now, []);
  if (cfg.maxMinutes !== null && now - state.startedAtMs >= cfg.maxMinutes * 60_000) {
    return stopped(state, 'timeout', now, cleanup);
  }
  if (obs.scene === 'battle') return stopped(state, 'entered_battle', now, cleanup);
  let popupStreak = 0;
  if (obs.scene !== null && obs.scene !== 'map') popupStreak = state.popupStreak + 1;
  if (popupStreak >= cfg.popupTicks) return stopped(state, 'unexpected_popup', now, cleanup);
  if (obs.trainingRunning) return stopped(state, 'busy', now, cleanup);
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

  switch (s.phase) {
    case 'to_spot': {
      const spot = cfg.spot;
      if (!validPoint(spot)) return stopped(s, 'no_spot', now);
      if (!s.commandIssued) {
        return { state: { ...s, commandIssued: true }, effects: [{ kind: 'walk_to', target: spot }] };
      }
      const out = walkOutcome(obs.nav, spot);
      if (out.kind === 'failed') return stopped(s, out.reason, now);
      if (out.kind === 'arrived') return { state: enter('working'), effects: [] };
      if (elapsed >= cfg.walkTimeoutMs) return stopped(s, 'timeout', now, [{ kind: 'walk_stop' }]);
      return { state: s, effects: [] };
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
        const full = bagIsFull(g, cfg);
        if (full === null) return stopped(done, 'bag_unreadable', now);
        if (full) {
          if (cfg.onBagFull === 'stop') return stopped(done, 'bag_full', now);
          return { state: { ...enter('to_home', done) }, effects: [] };
        }
        // 繼續採同一個點。
        return { state: { ...done, phaseSinceMs: now, commandIssued: false, workBaseline: null, sawWorking: false }, effects: [] };
      }
      if (elapsed >= cfg.workTimeoutMs) return stopped(s, 'work_timeout', now, [{ kind: 'gather_stop' }]);
      return { state: s, effects: [] };
    }
    case 'to_home': {
      const home = cfg.home;
      if (!validPoint(home)) return stopped(s, 'no_home', now);
      if (!s.commandIssued) {
        return { state: { ...s, commandIssued: true }, effects: [{ kind: 'walk_to', target: home }] };
      }
      const out = walkOutcome(obs.nav, home);
      if (out.kind === 'failed') return stopped(s, out.reason, now);
      if (out.kind === 'arrived') return { state: enter('unloading'), effects: [] };
      if (elapsed >= cfg.walkTimeoutMs) return stopped(s, 'timeout', now, [{ kind: 'walk_stop' }]);
      return { state: s, effects: [] };
    }
    case 'unloading': {
      const effects: GatherEffect[] = [];
      if (!s.commandIssued) {
        s = { ...s, commandIssued: true };
        effects.push({ kind: 'unload' });
      }
      const pct = bagPct(obs.gather);
      if (pct === null) return stopped(s, 'bag_unreadable', now, effects);
      if (pct <= cfg.unloadBelowPct) {
        const unloads = s.unloads + 1;
        return { state: enter('to_spot', { unloads }), effects };
      }
      if (elapsed >= cfg.unloadTimeoutMs) return stopped(s, 'bag_still_full', now, effects);
      return { state: s, effects };
    }
    default:
      return { state: s, effects: [] };
  }
}

export const GATHER_STOP_LABELS: Record<string, string> = {
  disconnected: '遊戲連線中斷安全停機',
  no_spot: '還沒設定採集點',
  no_home: '還沒設定回村點',
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
  return GATHER_STOP_LABELS[reason] ?? reason;
}

export const WORK_PHASE_LABELS: Record<WorkPhase, string> = {
  idle: '尚未開始',
  to_spot: '前往採集點',
  working: '採集中',
  to_home: '回村中',
  unloading: '卸貨中',
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
    }
  }
}
