/** W-FamilyUI (#149): Loopback-only HTTP + WebSocket client for Wine background training bridge. */
import { parseGatherStatus, type WineGatherStatus } from './gatherLoop';
import { parseSupplyStatus, type ResupplyPlan, type WineSupplyStatus } from './resupplyLoop';
import { parseNavStatus, type WalkToCommand, type WineNavStatus } from './pathfinding';

export type { WalkToCommand, WineNavStatus };

export type WineHotkey = 'F7' | 'F8';
export type WineQuickKey = 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6' | 'F7' | 'F8';
export type WinePreferredAction = 'skill' | 'attack';
export type BridgeConnState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED';

export interface WineBgConfig {
  patrolA: [number, number];
  patrolB: [number, number];
  hotkey: WineHotkey;
  preferred: WinePreferredAction;
  healAtPct: number;
  healHotkey?: WineQuickKey | null;
  healUsesPotion?: boolean;
  mapHealHpPct?: number;
  mapHealMpPct?: number;
  mapHealHpKey?: WineQuickKey;
  mapHealMpKey?: WineQuickKey;
  stopHpPct: number;
  stopMpPct: number;
  maxMinutes: number | null;
  maxRoundTrips: number | null;
  windowTitle: string;
  wid: number | null;
  /** #210：橋接依輸入自我測試結果選的點擊送法（只讀；不存本機、不隨設定送出，避免蓋掉自我測試的結果）。 */
  inputDelivery?: string;
}

export interface WineBridgeStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Family-side stop schedule. It does not change host rules; the panel calls the bridge stop command. */
export interface WineTrainingSchedule {
  /** Local 24-hour "HH:MM", or null when the clock stop is off. */
  stopAt: string | null;
  /** Stop after this many bridge-reported encounters, or null when off. */
  maxBattles: number | null;
  /** When this schedule was armed. A clock time already passed waits until the next day. */
  armedAtMs: number | null;
}

export const DEFAULT_WINE_SCHEDULE: WineTrainingSchedule = {
  stopAt: null,
  maxBattles: null,
  armedAtMs: null,
};

const SCHEDULE_CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function sanitizeSchedule(raw: unknown): WineTrainingSchedule {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_WINE_SCHEDULE };
  const row = raw as Partial<WineTrainingSchedule>;
  const stopAt = typeof row.stopAt === 'string' && SCHEDULE_CLOCK.test(row.stopAt) ? row.stopAt : null;
  const maxBattles =
    typeof row.maxBattles === 'number' && Number.isInteger(row.maxBattles) && row.maxBattles >= 1
      ? row.maxBattles
      : null;
  const armedAtMs = typeof row.armedAtMs === 'number' && Number.isFinite(row.armedAtMs) ? Math.round(row.armedAtMs) : null;
  return { stopAt, maxBattles, armedAtMs };
}

export interface WineBridgeSavedSettings {
  baseUrl: string;
  config: WineBgConfig | null;
  previewEnabled: boolean;
  previewOverlay: boolean;
  previewIntervalMs: number;
  microDistance: number;
  schedule?: WineTrainingSchedule;
}

export interface WineBridgeEvent {
  tsMs: number;
  type: string;
  action?: Record<string, unknown>;
  reason?: string;
  roundTrips?: number;
  encounters?: number;
  turns?: number;
  error?: string;
  [k: string]: unknown;
}

export interface WineFrameInfo {
  scene: string | null;
  hpPct: number | null;
  mpPct: number | null;
  position: [number, number] | null;
}

/** Launch settings reported by the Wine bridge `/status` (not the game protocol). */
export interface WineLaunchStatus {
  scaleMode: string | null;
  windowWidth: number | null;
  windowHeight: number | null;
  bridgePort: number | null;
  windowSizeSource?: 'planned' | 'actual' | 'unknown' | null;
}

export interface WineBridgeStatus {
  ok: boolean;
  connected: boolean;
  running: boolean;
  phase: string;
  scene: string;
  hpPct: number | null;
  mpPct: number | null;
  position?: [number, number] | null;
  roundTrips: number;
  encounters: number;
  turns: number;
  ticks: number;
  actionsSent: number;
  /** Present only when the bridge reports potion uses. Missing means unknown, not zero. */
  potionUses?: number | null;
  /** Present only when the bridge reports experience gained this session. */
  expGained?: number | null;
  lastAction: Record<string, unknown> | null;
  stopReason: string | null;
  config: WineBgConfig;
  recentEvents: WineBridgeEvent[];
  launch?: WineLaunchStatus | null;
  /** W-Nav：同一條 `/status` 裡的尋路進度。沒有這個欄位代表橋接還沒回。 */
  nav?: WineNavStatus | null;
  /** F16：同一條 `/status` 裡的採集進度。沒有這個欄位代表橋接還沒提供採集。 */
  gather?: WineGatherStatus | null;
  /** F17：同一條 `/status` 裡的補給進度與藥水數量。沒有這個欄位代表橋接還沒提供補給。 */
  supply?: WineSupplyStatus | null;
  /** WL-B1：停機或未知場景時橋接附上的診斷（來源尺寸、縮放、辨識耗時等）。 */
  diagnostics?: Record<string, unknown> | null;
  /** F20：這次練功存幀的資料夾路徑（橋接較舊時沒有此欄位；選填）。 */
  frameDumpDir?: string | null;
  /** WL-B1：每場戰鬥各階段時間（文字，橋接產生）。 */
  battleReport?: string[] | null;
  /** WL-B1：每 tick 辨識耗時（毫秒）。 */
  observeMs?: { last: number; avg: number; max: number } | null;
  /** WL-B1：橋接設定檔狀態（存在使用者資料夾，重啟後保留）。 */
  configStore?: { path: string; loaded: boolean; savedAt: number | null; error: string | null; migratedFrom?: number | null } | null;
  /** #210：輸入自我測試進度與報告（橋接較舊時沒有此欄位）。 */
  inputSelfTest?: WineInputSelfTestStatus | null;
}

export interface WineInputSelfTestAttempt {
  id: string;
  flags: string;
  label?: string;
  direction: string;
  stageSpot: [number, number];
  moved: boolean;
  changedFraction?: number;
  noiseFraction?: number;
  coordBefore?: [number, number] | null;
  coordAfter?: [number, number] | null;
  error?: string | null;
}

export interface WineInputSelfTestReport {
  verdict: 'moved' | 'no_variant_moved' | 'aborted';
  abortReason?: string | null;
  workingVariant?: string | null;
  workingFlags?: string | null;
  attempts: WineInputSelfTestAttempt[];
  frameDir?: string | null;
  /** 橋接產生的中文報告全文。 */
  text: string;
}

export interface WineInputSelfTestStatus {
  state: 'idle' | 'running' | 'done';
  current?: string | null;
  report: WineInputSelfTestReport | null;
}

export interface WineBridgeWindowInfo {
  wid: number;
  width: number;
  height: number;
  title: string;
}

export interface WineBridgeSnapshot {
  connState: BridgeConnState;
  baseUrl: string;
  status: WineBridgeStatus | null;
  windows: WineBridgeWindowInfo[];
  events: WineBridgeEvent[];
  error: string | null;
  lastUpdatedAt: number | null;
}

export interface BridgeWebSocketLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface WineBridgeTransport {
  fetchFn?: typeof fetch;
  webSocketCtor?: new (url: string) => BridgeWebSocketLike;
}

export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:4182';
export const WINE_SETTINGS_STORAGE_KEY = 'fairyland_family:wine_bridge_settings:v1';
/** 本機設定格式版本。v1（沒有 `v` 欄位）存的 `preferred` 分不出是使用者選的還是舊預設「技能優先」，載入時改回預設「普攻優先」。 */
export const WINE_SETTINGS_VERSION = 2;
export const DEFAULT_PREVIEW_INTERVAL_MS = 1000;
export const DEFAULT_MICRO_DISTANCE = 25;
export const MICRO_PATROL_START_X = 390;
export const MAX_MICRO_DISTANCE = 800 - MICRO_PATROL_START_X;

export const DEFAULT_WINE_CONFIG: WineBgConfig = {
  patrolA: [260, 300],
  patrolB: [540, 300],
  hotkey: 'F7',
  preferred: 'attack',
  healAtPct: 35,
  healHotkey: null,
  healUsesPotion: false,
  mapHealHpPct: 0,
  mapHealMpPct: 0,
  mapHealHpKey: 'F1',
  mapHealMpKey: 'F2',
  stopHpPct: 15,
  stopMpPct: 0,
  maxMinutes: 30,
  maxRoundTrips: null,
  windowTitle: '',
  wid: null,
};

const MAX_CLIENT_EVENTS = 120;

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Verify and normalize a bridge URL so requests never leave loopback. */
export function normalizeLoopbackBridgeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    if (!LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())) return null;
    const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch {
    return null;
  }
}

export function isLoopbackBridgeUrl(raw: string): boolean {
  return normalizeLoopbackBridgeUrl(raw) !== null;
}

export function bridgeWebSocketUrl(baseHttpUrl: string): string | null {
  const norm = normalizeLoopbackBridgeUrl(baseHttpUrl);
  if (!norm) return null;
  return norm.replace(/^http/, 'ws') + '/events';
}

/** /frame answered without an image (503 = the bridge could not capture the window). */
export class FrameUnavailableError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string | null,
    readonly screenRecordingSuspected: boolean,
  ) {
    super(`HTTP ${status}`);
    this.name = 'FrameUnavailableError';
  }
}

/** Chinese hint for the preview box; null when the error is not a known /frame failure. */
export function frameErrorHint(err: unknown): string | null {
  if (!(err instanceof FrameUnavailableError)) return null;
  if (err.status === 503 && err.screenRecordingSuspected) {
    return '橋接抓不到遊戲畫面（/frame 503）：多半是 macOS 缺少「螢幕錄製」權限。'
      + '請開 系統設定 → 隱私權與安全性 → 螢幕與系統錄音，打開啟動橋接的程式（「終端機」或 FairylandLauncher），'
      + '然後重新啟動遊戲。'
      + (err.reason ? `（橋接回報：${err.reason}）` : '');
  }
  if (err.status === 503 && err.reason) return `橋接目前沒有影格（${err.reason}），請確認遊戲視窗已開啟。`;
  return null;
}

export function framePreviewUrl(
  baseHttpUrl: string,
  overlay: boolean,
): string | null {
  const base = normalizeLoopbackBridgeUrl(baseHttpUrl);
  return base ? `${base}/frame?overlay=${overlay ? '1' : '0'}&w=480` : null;
}

function sanitizeConfig(raw: Partial<WineBgConfig> | null | undefined): WineBgConfig {
  const base = { ...DEFAULT_WINE_CONFIG };
  if (!raw || typeof raw !== 'object') return base;
  const validPt = (p: unknown): p is [number, number] =>
    Array.isArray(p) &&
    p.length === 2 &&
    typeof p[0] === 'number' &&
    Number.isFinite(p[0]) &&
    typeof p[1] === 'number' &&
    Number.isFinite(p[1]);
  if (validPt(raw.patrolA)) {
    base.patrolA = [Math.max(0, Math.min(800, Math.round(raw.patrolA[0]))), Math.max(0, Math.min(600, Math.round(raw.patrolA[1])))];
  }
  if (validPt(raw.patrolB)) {
    base.patrolB = [Math.max(0, Math.min(800, Math.round(raw.patrolB[0]))), Math.max(0, Math.min(600, Math.round(raw.patrolB[1])))];
  }
  if (raw.hotkey === 'F7' || raw.hotkey === 'F8') base.hotkey = raw.hotkey;
  if (raw.preferred === 'skill' || raw.preferred === 'attack') base.preferred = raw.preferred;
  const clamp = (v: unknown, min: number, max: number, fb: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : fb;
  base.healAtPct = clamp(raw.healAtPct, 0, 100, base.healAtPct);
  base.mapHealHpPct = clamp(raw.mapHealHpPct, 0, 100, base.mapHealHpPct ?? 0);
  base.mapHealMpPct = clamp(raw.mapHealMpPct, 0, 100, base.mapHealMpPct ?? 0);
  base.stopHpPct = clamp(raw.stopHpPct, 0, 99, base.stopHpPct);
  base.stopMpPct = clamp(raw.stopMpPct, 0, 99, base.stopMpPct);
  const validQk = (k: unknown): k is WineQuickKey =>
    typeof k === 'string' && /^F[1-8]$/.test(k);
  if (raw.healHotkey === null || validQk(raw.healHotkey)) base.healHotkey = raw.healHotkey;
  if (typeof raw.healUsesPotion === 'boolean') base.healUsesPotion = raw.healUsesPotion;
  if (validQk(raw.mapHealHpKey)) base.mapHealHpKey = raw.mapHealHpKey;
  if (validQk(raw.mapHealMpKey)) base.mapHealMpKey = raw.mapHealMpKey;
  if (raw.maxMinutes === null || (typeof raw.maxMinutes === 'number' && Number.isFinite(raw.maxMinutes) && raw.maxMinutes > 0)) {
    base.maxMinutes = raw.maxMinutes;
  }
  if (raw.maxRoundTrips === null || (typeof raw.maxRoundTrips === 'number' && Number.isFinite(raw.maxRoundTrips) && raw.maxRoundTrips >= 1)) {
    base.maxRoundTrips = raw.maxRoundTrips === null ? null : Math.round(raw.maxRoundTrips);
  }
  if (typeof raw.windowTitle === 'string') base.windowTitle = raw.windowTitle;
  // CGWindow identifiers can be reassigned after the game restarts. Restore selection by title.
  return base;
}

export function loadSavedWineBridgeSettings(storage?: WineBridgeStorageLike | null): {
  settings: WineBridgeSavedSettings;
  hasSaved: boolean;
} {
  const defaults: WineBridgeSavedSettings = {
    baseUrl: DEFAULT_BRIDGE_URL,
    config: null,
    previewEnabled: true,
    previewOverlay: true,
    previewIntervalMs: DEFAULT_PREVIEW_INTERVAL_MS,
    microDistance: DEFAULT_MICRO_DISTANCE,
    schedule: { ...DEFAULT_WINE_SCHEDULE },
  };
  if (!storage) return { settings: defaults, hasSaved: false };
  try {
    const raw = storage.getItem(WINE_SETTINGS_STORAGE_KEY);
    if (!raw) return { settings: defaults, hasSaved: false };
    const parsed = JSON.parse(raw) as Partial<WineBridgeSavedSettings>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { settings: defaults, hasSaved: false };
    const normUrl = typeof parsed.baseUrl === 'string' ? normalizeLoopbackBridgeUrl(parsed.baseUrl) : null;
    const savedConfig = parsed.config && typeof parsed.config === 'object' && !Array.isArray(parsed.config)
      ? sanitizeConfig(parsed.config) : null;
    if (savedConfig && (parsed as { v?: unknown }).v !== WINE_SETTINGS_VERSION) {
      savedConfig.preferred = DEFAULT_WINE_CONFIG.preferred;
    }
    const interval =
      typeof parsed.previewIntervalMs === 'number' && [0, 500, 1000, 2000].includes(parsed.previewIntervalMs)
        ? parsed.previewIntervalMs
        : DEFAULT_PREVIEW_INTERVAL_MS;
    return {
      hasSaved: true,
      settings: {
        baseUrl: normUrl ?? DEFAULT_BRIDGE_URL,
        config: savedConfig,
        previewEnabled: typeof parsed.previewEnabled === 'boolean' ? parsed.previewEnabled : true,
        previewOverlay: typeof parsed.previewOverlay === 'boolean' ? parsed.previewOverlay : true,
        previewIntervalMs: interval,
        microDistance: typeof parsed.microDistance === 'number' && Number.isInteger(parsed.microDistance)
          && parsed.microDistance >= 1 && parsed.microDistance <= MAX_MICRO_DISTANCE
          ? parsed.microDistance : DEFAULT_MICRO_DISTANCE,
        schedule: sanitizeSchedule(parsed.schedule),
      },
    };
  } catch {
    return { settings: defaults, hasSaved: false };
  }
}

export function saveWineBridgeSettings(
  storage: WineBridgeStorageLike | null | undefined,
  settings: WineBridgeSavedSettings,
): void {
  if (!storage) return;
  try {
    const baseUrl = normalizeLoopbackBridgeUrl(settings.baseUrl);
    if (!baseUrl) return;
    const encoded = JSON.stringify({
      ...settings,
      v: WINE_SETTINGS_VERSION,
      baseUrl,
      config: settings.config ? sanitizeConfig(settings.config) : null,
      schedule: sanitizeSchedule(settings.schedule),
    });
    if (storage.getItem(WINE_SETTINGS_STORAGE_KEY) !== encoded) {
      storage.setItem(WINE_SETTINGS_STORAGE_KEY, encoded);
    }
  } catch {
    // ignore storage quota errors
  }
}

export const WINE_STOP_REASON_LABELS: Record<string, string> = {
  manual_stop: '手動停止',
  user_clicked_stop: '手動停止',
  schedule_clock: '已到設定的停機時間',
  schedule_battles: '已達設定的場數',
  round_trip_limit: '已達來回次數上限',
  timeout: '已達時間上限',
  hp_low: 'HP 低於停機門檻',
  mp_low: 'MP 低於停機門檻',
  low_hp_critical: 'HP 低於停機門檻',
  low_mp_critical: 'MP 低於停機門檻',
  unexpected_popup: '偵測到未知彈窗安全停機',
  disconnected: '遊戲連線中斷安全停機',
  hospital_or_dead: '偵測到角色死亡／醫院安全停機',
  screen_frozen: '畫面長時間靜止停機',
  stalled: '巡走卡住停機',
  window_closed: '目標視窗已關閉',
  capture_error: '畫面擷取失敗',
  input_error: '背景輸入送出失敗',
  frames_exhausted: '測試影格結束',
  bridge_shutdown: '橋接服務已關閉',
  bridge_error: '橋接執行錯誤',
  unrecognized_scene: '畫面無法辨識（不是地圖也不是戰鬥）',
  unknown_scene: '畫面無法辨識',
  unknown_target: '戰鬥中找不到可點選的敵人',
  unknown_vitals: '戰鬥中讀不到血魔量',
  unknown_phase: '戰鬥階段無法判斷',
  unknown_turn: '回合數異常',
  unknown_battle: '戰鬥編號異常',
  unexpected_battle: '戰鬥狀態不符預期',
  missing_result: '戰鬥結束後沒看到結算畫面',
  unknown_result: '結算畫面無法判斷勝負',
  unexpected_result: '沒有戰鬥卻出現結算畫面',
  no_available_action: '沒有可用的戰鬥動作',
  defeat: '戰敗停機',
};

export function formatWineStopReason(reason: string | null | undefined): string {
  if (!reason) return '';
  return WINE_STOP_REASON_LABELS[reason] ?? reason;
}

export function formatWineEventLine(ev: WineBridgeEvent): string {
  const t = new Date(ev.tsMs);
  const p = (n: number) => String(n).padStart(2, '0');
  const ts = `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
  if (ev.type === 'action' && ev.action) {
    const kind = String(ev.action.kind ?? 'action');
    if (kind === 'move' && Array.isArray(ev.action.point)) {
      return `${ts} 巡邏移動 (${ev.action.point[0]}, ${ev.action.point[1]})`;
    }
    if (kind === 'hotkey') {
      return `${ts} 戰鬥施放熱鍵 ${String(ev.action.hotkey ?? '')}（${String(ev.action.role ?? 'main')}）`;
    }
    if (kind === 'map_heal') {
      return `${ts} 待機補${ev.action.stat === 'mp' ? '魔' : '血'}：熱鍵 ${String(ev.action.hotkey ?? '')}`;
    }
    if (kind === 'click') {
      return `${ts} 點擊戰鬥目標 (${String(ev.action.x ?? '?')}, ${String(ev.action.y ?? '?')})`;
    }
    return `${ts} 動作 ${kind}`;
  }
  if (ev.type === 'stopped') {
    return `${ts} 停機：${formatWineStopReason(ev.reason)}（${ev.roundTrips ?? 0} 趟／${ev.encounters ?? 0} 戰／${ev.turns ?? 0} 回合）`;
  }
  if (ev.type === 'error') {
    return `${ts} 錯誤：${ev.error ?? '未知錯誤'}`;
  }
  return `${ts} ${ev.type}`;
}

export function parseInputSelfTest(raw: unknown): WineInputSelfTestStatus | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.state !== 'idle' && r.state !== 'running' && r.state !== 'done') return null;
  const rep = r.report && typeof r.report === 'object' ? (r.report as Record<string, unknown>) : null;
  return {
    state: r.state,
    current: typeof r.current === 'string' ? r.current : null,
    report: rep && typeof rep.text === 'string' ? (rep as unknown as WineInputSelfTestReport) : null,
  };
}

function withoutInputDelivery(patch: Partial<WineBgConfig>): Record<string, unknown> {
  const { inputDelivery: _ignored, ...rest } = patch;
  void _ignored;
  return rest as Record<string, unknown>;
}

export class WineBridgeClient {
  private snapshot: WineBridgeSnapshot = {
    connState: 'DISCONNECTED',
    baseUrl: DEFAULT_BRIDGE_URL,
    status: null,
    windows: [],
    events: [],
    error: null,
    lastUpdatedAt: null,
  };
  private listeners = new Set<(snap: WineBridgeSnapshot) => void>();
  private ws: BridgeWebSocketLike | null = null;
  private manualDisconnect = false;
  private fetchFn: typeof fetch;
  private webSocketCtor: (new (url: string) => BridgeWebSocketLike) | null;

  constructor(transport?: WineBridgeTransport) {
    this.fetchFn = transport?.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
    this.webSocketCtor =
      transport?.webSocketCtor ??
      (typeof WebSocket !== 'undefined' ? (WebSocket as unknown as new (url: string) => BridgeWebSocketLike) : null);
  }

  getSnapshot(): WineBridgeSnapshot {
    return this.snapshot;
  }

  subscribe(fn: (snap: WineBridgeSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(patch: Partial<WineBridgeSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const fn of this.listeners) fn(this.snapshot);
  }

  private applyStatus(st: WineBridgeStatus, extraEvent?: WineBridgeEvent): void {
    let events = this.snapshot.events;
    if (Array.isArray(st.recentEvents)) {
      if (st.recentEvents.length > 0 || !extraEvent) {
        events = st.recentEvents.slice(-MAX_CLIENT_EVENTS);
      } else {
        events = [...events, extraEvent].slice(-MAX_CLIENT_EVENTS);
      }
    } else if (extraEvent) {
      events = [...events, extraEvent].slice(-MAX_CLIENT_EVENTS);
    }
    const status: WineBridgeStatus = {
      ...st,
      ...(st.nav === undefined ? {} : { nav: parseNavStatus(st.nav) }),
      ...(st.gather === undefined ? {} : { gather: parseGatherStatus(st.gather) }),
      ...(st.supply === undefined ? {} : { supply: parseSupplyStatus(st.supply) }),
    };
    this.emit({
      connState: 'CONNECTED',
      status,
      events,
      error: null,
      lastUpdatedAt: Date.now(),
    });
  }

  private mergeNav(nav: WineNavStatus): void {
    const prev = this.snapshot.status;
    if (!prev) return;
    this.applyStatus({ ...prev, nav });
  }

  async walkTo(command: WalkToCommand): Promise<WineNavStatus> {
    const url = normalizeLoopbackBridgeUrl(this.snapshot.baseUrl);
    if (!url) {
      const err = new Error('僅允許本機 loopback 位址');
      this.emit({ error: err.message });
      throw err;
    }
    try {
      const parsed = await this.requestJson<Record<string, unknown>>(url, 'POST', '/walk_to', command);
      const nav = parseNavStatus(parsed);
      if (!nav) throw new Error('橋接沒有回尋路狀態');
      this.mergeNav(nav);
      return nav;
    } catch (err) {
      this.notePostError(err);
      throw err;
    }
  }

  async walkStop(reason = 'user_stopped'): Promise<WineNavStatus> {
    const url = normalizeLoopbackBridgeUrl(this.snapshot.baseUrl);
    if (!url) {
      const err = new Error('僅允許本機 loopback 位址');
      this.emit({ error: err.message });
      throw err;
    }
    try {
      const parsed = await this.requestJson<Record<string, unknown>>(url, 'POST', '/walk_stop', { reason });
      const nav = parseNavStatus(parsed);
      if (!nav) throw new Error('橋接沒有回尋路狀態');
      this.mergeNav(nav);
      return nav;
    } catch (err) {
      this.notePostError(err);
      throw err;
    }
  }

  /** F16：開始在目前位置採集。橋接沒有這個指令時回 404（`not found`）。 */
  async gatherStart(spot: { mapId: string; x: number; y: number }): Promise<WineGatherStatus> {
    return this.postGather('/gather_start', { mapId: spot.mapId, targetX: spot.x, targetY: spot.y });
  }

  async gatherStop(reason = 'user_stopped'): Promise<WineGatherStatus> {
    return this.postGather('/gather_stop', { reason });
  }

  /** F17：在商店買藥賣物。橋接沒有這個指令時回 404（`not found`）。 */
  async resupplyStart(plan: ResupplyPlan): Promise<WineSupplyStatus> {
    return this.postSupply('/resupply_start', { buy: plan.buy, sell: plan.sellItemIds });
  }

  async resupplyStop(reason = 'user_stopped'): Promise<WineSupplyStatus> {
    return this.postSupply('/resupply_stop', { reason });
  }

  private async postSupply(path: string, body: Record<string, unknown>): Promise<WineSupplyStatus> {
    const url = normalizeLoopbackBridgeUrl(this.snapshot.baseUrl);
    if (!url) {
      const err = new Error('僅允許本機 loopback 位址');
      this.emit({ error: err.message });
      throw err;
    }
    try {
      const parsed = await this.requestJson<Record<string, unknown>>(url, 'POST', path, body);
      const supply = parseSupplyStatus(parsed);
      if (!supply) throw new Error('橋接沒有回補給狀態');
      const prev = this.snapshot.status;
      if (prev) {
        // 指令回應不一定帶藥水與金額，讀不到的欄位沿用上一次的 `/status` 回報。
        const old = prev.supply;
        const merged = old
          ? {
              ...supply,
              potionCount: supply.potionCount ?? old.potionCount,
              gold: supply.gold ?? old.gold,
              bagUsed: supply.bagUsed ?? old.bagUsed,
              bagCap: supply.bagCap ?? old.bagCap,
            }
          : supply;
        this.applyStatus({ ...prev, supply: merged });
      }
      return supply;
    } catch (err) {
      if (!(err instanceof Error && err.message === 'not found')) this.notePostError(err);
      throw err;
    }
  }

  private async postGather(path: string, body: Record<string, unknown>): Promise<WineGatherStatus> {
    const url = normalizeLoopbackBridgeUrl(this.snapshot.baseUrl);
    if (!url) {
      const err = new Error('僅允許本機 loopback 位址');
      this.emit({ error: err.message });
      throw err;
    }
    try {
      const parsed = await this.requestJson<Record<string, unknown>>(url, 'POST', path, body);
      const gather = parseGatherStatus(parsed);
      if (!gather) throw new Error('橋接沒有回採集狀態');
      const prev = this.snapshot.status;
      if (prev) this.applyStatus({ ...prev, gather });
      return gather;
    } catch (err) {
      // 橋接沒有採集指令是能力缺口，由循環顯示停止原因，不當成連線錯誤。
      if (!(err instanceof Error && err.message === 'not found')) this.notePostError(err);
      throw err;
    }
  }

  private notePostError(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('ECONNREFUSED')) {
      this.closeWs();
      this.emit({ connState: 'DISCONNECTED', error: `橋接連線中斷（${msg}）` });
    } else {
      this.emit({ error: msg });
    }
  }

  async connect(rawUrl = this.snapshot.baseUrl): Promise<boolean> {
    const norm = normalizeLoopbackBridgeUrl(rawUrl);
    if (!norm) {
      this.emit({
        connState: 'DISCONNECTED',
        error: '僅允許連線本機 loopback 位址（127.0.0.1 / localhost）',
      });
      return false;
    }

    this.closeWs();
    this.manualDisconnect = false;
    this.emit({ connState: 'CONNECTING', baseUrl: norm, error: null });

    try {
      const st = await this.requestJson<WineBridgeStatus>(norm, 'GET', '/status');
      this.applyStatus(st);
      this.openWs(norm);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit({
        connState: 'DISCONNECTED',
        status: null,
        error: `無法連線本機橋接（${msg}）`,
      });
      return false;
    }
  }

  /** 靜默探測：橋接的 /status 有回應才回 true；不改任何連線狀態，也不留錯誤訊息。 */
  async probe(rawUrl = this.snapshot.baseUrl): Promise<boolean> {
    const norm = normalizeLoopbackBridgeUrl(rawUrl);
    if (!norm) return false;
    try {
      await this.requestJson<WineBridgeStatus>(norm, 'GET', '/status');
      return true;
    } catch {
      return false;
    }
  }

  disconnect(reason?: string): void {
    this.manualDisconnect = true;
    this.closeWs();
    this.emit({
      connState: 'DISCONNECTED',
      error: reason ?? null,
    });
  }

  async updateConfig(patch: Partial<WineBgConfig>): Promise<WineBridgeStatus> {
    const st = await this.postAndApply('/config', withoutInputDelivery(patch));
    return st;
  }

  async start(patch?: Partial<WineBgConfig>): Promise<WineBridgeStatus> {
    const st = await this.postAndApply('/start', withoutInputDelivery(patch ?? {}));
    return st;
  }

  /** #210：在地圖場景依序試各種點擊送法；結果會出現在 `/status` 的 inputSelfTest。 */
  async inputSelfTestStart(): Promise<WineInputSelfTestStatus> {
    return this.postSelfTest('/input_selftest');
  }

  async inputSelfTestStop(): Promise<WineInputSelfTestStatus> {
    return this.postSelfTest('/input_selftest_stop');
  }

  private async postSelfTest(path: string): Promise<WineInputSelfTestStatus> {
    const url = normalizeLoopbackBridgeUrl(this.snapshot.baseUrl);
    if (!url) {
      const err = new Error('僅允許本機 loopback 位址');
      this.emit({ error: err.message });
      throw err;
    }
    try {
      const parsed = await this.requestJson<Record<string, unknown>>(url, 'POST', path, {});
      const st = parseInputSelfTest(parsed);
      const prev = this.snapshot.status;
      if (prev && st) this.applyStatus({ ...prev, inputSelfTest: st });
      if (!st) throw new Error('橋接沒有回輸入自我測試狀態');
      return st;
    } catch (err) {
      this.notePostError(err);
      throw err;
    }
  }

  async stop(reason = 'manual_stop'): Promise<WineBridgeStatus> {
    const st = await this.postAndApply('/stop', { reason });
    return st;
  }

  async refreshStatus(): Promise<WineBridgeStatus> {
    const url = normalizeLoopbackBridgeUrl(this.snapshot.baseUrl);
    if (!url) throw new Error('橋接位址無效');
    try {
      const st = await this.requestJson<WineBridgeStatus>(url, 'GET', '/status');
      this.applyStatus(st);
      return st;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit({ connState: 'DISCONNECTED', error: `橋接連線中斷（${msg}）` });
      throw err;
    }
  }

  async fetchFrame(overlay: boolean, signal: AbortSignal): Promise<{ image: Blob; info: WineFrameInfo }> {
    const url = framePreviewUrl(this.snapshot.baseUrl, overlay);
    if (!url) throw new Error('橋接位址無效');
    const response = await this.fetchFn(url, { signal, cache: 'no-store', redirect: 'error' });
    if (!response.ok) {
      let body: { reason?: unknown; screenRecordingSuspected?: unknown } | null = null;
      try { body = await response.json(); } catch { /* not JSON: keep the plain HTTP error */ }
      if (response.status === 503) {
        throw new FrameUnavailableError(
          response.status,
          typeof body?.reason === 'string' ? body.reason : null,
          body?.screenRecordingSuspected === true,
        );
      }
      throw new Error(`HTTP ${response.status}`);
    }
    const image = await response.blob();
    if (!['image/png', 'image/jpeg'].includes(image.type)) throw new Error('橋接回應缺少預覽圖片');
    const getPercent = (header: string) => {
      const raw = response.headers.get(header)?.trim();
      if (!raw) return null;
      const value = Number(raw);
      return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
    };
    const rawPoint = response.headers.get('X-Frame-Position')?.match(/^(-?\d+),\s*(-?\d+)$/);
    return {
      image,
      info: {
        scene: response.headers.get('X-Frame-Scene'),
        hpPct: getPercent('X-Frame-HP-Pct'),
        mpPct: getPercent('X-Frame-MP-Pct'),
        position: rawPoint ? [Number(rawPoint[1]), Number(rawPoint[2])] : null,
      },
    };
  }

  async refreshWindows(): Promise<WineBridgeWindowInfo[]> {
    const url = normalizeLoopbackBridgeUrl(this.snapshot.baseUrl);
    if (!url) throw new Error('橋接位址無效');
    const res = await this.requestJson<{ ok: boolean; windows?: WineBridgeWindowInfo[] }>(url, 'GET', '/windows');
    const windows = Array.isArray(res.windows) ? res.windows : [];
    this.emit({ windows, error: null });
    return windows;
  }

  private async postAndApply(path: string, body: Record<string, unknown>): Promise<WineBridgeStatus> {
    const url = normalizeLoopbackBridgeUrl(this.snapshot.baseUrl);
    if (!url) {
      const err = new Error('僅允許本機 loopback 位址');
      this.emit({ error: err.message });
      throw err;
    }
    try {
      const st = await this.requestJson<WineBridgeStatus>(url, 'POST', path, body);
      this.applyStatus(st);
      return st;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('ECONNREFUSED')) {
        this.closeWs();
        this.emit({ connState: 'DISCONNECTED', error: `橋接連線中斷（${msg}）` });
      } else {
        this.emit({ error: msg });
      }
      throw err;
    }
  }

  private async requestJson<T>(
    baseUrl: string,
    method: 'GET' | 'POST',
    path: string,
    body?: object,
  ): Promise<T> {
    const resp = await this.fetchFn(`${baseUrl}${path}`, {
      method,
      headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    });
    const text = await resp.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      parsed = {};
    }
    if (!resp.ok || parsed.ok === false) {
      throw new Error(typeof parsed.error === 'string' ? parsed.error : `HTTP ${resp.status}`);
    }
    return parsed as unknown as T;
  }

  private openWs(baseUrl: string): void {
    if (!this.webSocketCtor) return;
    const wsUrl = bridgeWebSocketUrl(baseUrl);
    if (!wsUrl) return;
    try {
      const sock = new this.webSocketCtor(wsUrl);
      this.ws = sock;
      sock.onmessage = ev => {
        try {
          const msg = JSON.parse(ev.data) as {
            kind?: string;
            status?: WineBridgeStatus;
            event?: WineBridgeEvent;
            error?: string;
          };
          if (msg.status) {
            this.applyStatus(msg.status, msg.event);
          } else if (msg.kind === 'error' && msg.error) {
            this.emit({ error: msg.error });
          }
        } catch {
          // ignore malformed frames
        }
      };
      sock.onerror = () => {
        if (this.ws !== sock || this.manualDisconnect) return;
        this.ws = null;
        this.emit({
          connState: 'DISCONNECTED',
          error: 'WebSocket 橋接連線發生錯誤或已中斷',
        });
      };
      sock.onclose = () => {
        if (this.ws !== sock) return;
        this.ws = null;
        if (this.manualDisconnect) return;
        this.emit({
          connState: 'DISCONNECTED',
          error: '本機橋接已斷線，請確認橋接程序是否仍在執行',
        });
      };
    } catch {
      // Fallback gracefully to manual refresh if WebSocket ctor rejects
    }
  }

  private closeWs(): void {
    const cur = this.ws;
    this.ws = null;
    if (!cur) return;
    cur.onopen = null;
    cur.onmessage = null;
    cur.onclose = null;
    cur.onerror = null;
    try {
      cur.close();
    } catch {
      // ignore close errors
    }
  }
}
