/** W-FamilyUI (#149): Loopback-only HTTP + WebSocket client for Wine background training bridge. */

export type WineHotkey = 'F7' | 'F8';
export type WinePreferredAction = 'skill' | 'attack';
export type BridgeConnState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED';

export interface WineBgConfig {
  patrolA: [number, number];
  patrolB: [number, number];
  hotkey: WineHotkey;
  preferred: WinePreferredAction;
  healAtPct: number;
  stopHpPct: number;
  stopMpPct: number;
  maxMinutes: number | null;
  maxRoundTrips: number | null;
  windowTitle: string;
  wid: number | null;
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

export interface WineBridgeStatus {
  ok: boolean;
  connected: boolean;
  running: boolean;
  phase: string;
  scene: string;
  hpPct: number | null;
  mpPct: number | null;
  roundTrips: number;
  encounters: number;
  turns: number;
  ticks: number;
  actionsSent: number;
  lastAction: Record<string, unknown> | null;
  stopReason: string | null;
  config: WineBgConfig;
  recentEvents: WineBridgeEvent[];
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

export const DEFAULT_WINE_CONFIG: WineBgConfig = {
  patrolA: [260, 300],
  patrolB: [540, 300],
  hotkey: 'F7',
  preferred: 'skill',
  healAtPct: 35,
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

export const WINE_STOP_REASON_LABELS: Record<string, string> = {
  manual_stop: '手動停止',
  user_clicked_stop: '手動停止',
  round_trip_limit: '已達來回次數上限',
  timeout: '已達時間上限',
  hp_low: 'HP 低於停機門檻',
  mp_low: 'MP 低於停機門檻',
  window_closed: '目標視窗已關閉',
  capture_error: '畫面擷取失敗',
  input_error: '背景輸入送出失敗',
  frames_exhausted: '測試影格結束',
  bridge_shutdown: '橋接服務已關閉',
  bridge_error: '橋接執行錯誤',
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
    this.emit({
      connState: 'CONNECTED',
      status: st,
      events,
      error: null,
      lastUpdatedAt: Date.now(),
    });
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

  disconnect(reason?: string): void {
    this.manualDisconnect = true;
    this.closeWs();
    this.emit({
      connState: 'DISCONNECTED',
      error: reason ?? null,
    });
  }

  async updateConfig(patch: Partial<WineBgConfig>): Promise<WineBridgeStatus> {
    const st = await this.postAndApply('/config', patch as Record<string, unknown>);
    return st;
  }

  async start(patch?: Partial<WineBgConfig>): Promise<WineBridgeStatus> {
    const st = await this.postAndApply('/start', (patch ?? {}) as Record<string, unknown>);
    return st;
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
    body?: Record<string, unknown>,
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
