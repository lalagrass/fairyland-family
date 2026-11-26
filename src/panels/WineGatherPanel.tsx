import React, { useEffect, useState } from 'react';
import type { WineBridgeClient, WineBridgeSnapshot } from '../wine/wineBridgeClient';
import {
  DEFAULT_GATHER_CONFIG,
  GatherLoopRunner,
  WORK_PHASE_LABELS,
  bagPct,
  formatGatherStopReason,
  type GatherLoopConfig,
  type GatherRunnerSnapshot,
  type WorkPoint,
} from '../wine/gatherLoop';
import { clientGatherPorts } from '../wine/gatherPorts';

export const GATHER_CONFIG_STORAGE_KEY = 'fairyland_family:wine_gather_config:v1';
const TICK_MS = 1000;

export function createGatherRunner(client: WineBridgeClient, storage?: Pick<Storage, 'getItem'> | null): GatherLoopRunner {
  return new GatherLoopRunner(clientGatherPorts(client), loadGatherConfig(storage));
}

function point(raw: unknown): WorkPoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.mapId !== 'string' || !p.mapId.trim()) return null;
  if (typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return { mapId: p.mapId.trim(), x: p.x, y: p.y };
}

export function sanitizeGatherConfig(raw: unknown): GatherLoopConfig {
  const base = { ...DEFAULT_GATHER_CONFIG };
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<GatherLoopConfig>;
  const num = (v: unknown, min: number, max: number, fb: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : fb;
  return {
    ...base,
    spot: point(r.spot),
    home: point(r.home),
    onBagFull: r.onBagFull === 'stop' ? 'stop' : 'return_home',
    bagFullPct: num(r.bagFullPct, 1, 100, base.bagFullPct),
    unloadBelowPct: num(r.unloadBelowPct, 0, 99, base.unloadBelowPct),
    maxMinutes: r.maxMinutes === null ? null : typeof r.maxMinutes === 'number' && r.maxMinutes > 0 ? r.maxMinutes : base.maxMinutes,
    maxCycles: r.maxCycles === null || r.maxCycles === undefined ? null : typeof r.maxCycles === 'number' && r.maxCycles >= 1 ? Math.round(r.maxCycles) : null,
  };
}

export function loadGatherConfig(storage?: Pick<Storage, 'getItem'> | null): GatherLoopConfig {
  try {
    const raw = storage?.getItem(GATHER_CONFIG_STORAGE_KEY);
    return sanitizeGatherConfig(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_GATHER_CONFIG };
  }
}

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function PointRow({
  label, value, current, testId, onChange,
}: {
  label: string;
  value: WorkPoint | null;
  current: WorkPoint | null;
  testId: string;
  onChange: (p: WorkPoint | null) => void;
}) {
  return (
    <div className="wine-gather-point" data-testid={testId}>
      <span>{label}</span>
      <b data-testid={`${testId}-value`}>{value ? `${value.mapId} (${Math.round(value.x)}, ${Math.round(value.y)})` : '未設定'}</b>
      <button type="button" className="item" data-testid={`${testId}-set`} disabled={!current} onClick={() => onChange(current)}>
        用目前位置
      </button>
      {value && (
        <button type="button" className="item" data-testid={`${testId}-clear`} onClick={() => onChange(null)}>
          清除
        </button>
      )}
    </div>
  );
}

/**
 * 視窗自動採集。採集點與回村點取自宿主快照上的目前位置，由使用者按鈕設定；
 * 背包與採集進度來自橋接回報。只送指令，不改規則。
 */
export function WineGatherPanel({
  client,
  runner,
  current,
}: {
  client: WineBridgeClient;
  active: boolean;
  runner: GatherLoopRunner;
  /** 宿主快照上的目前地圖與位置。沒有就不能用「用目前位置」。 */
  current: WorkPoint | null;
}) {
  const [bridge, setBridge] = useState<WineBridgeSnapshot>(() => client.getSnapshot());
  const [snap, setSnap] = useState<GatherRunnerSnapshot>(() => runner.getSnapshot());

  useEffect(() => {
    setBridge(client.getSnapshot());
    return client.subscribe(setBridge);
  }, [client]);
  useEffect(() => {
    setSnap(runner.getSnapshot());
    return runner.subscribe(setSnap);
  }, [runner]);

  const running = snap.state.phase !== 'idle' && snap.state.phase !== 'stopped';
  useEffect(() => {
    if (!running) return;
    let alive = true;
    const timer = setInterval(() => {
      void (async () => {
        try { await client.refreshStatus(); } catch { /* 斷線由循環停下 */ }
        if (alive) await runner.tick();
      })();
    }, TICK_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [client, runner, running]);

  const cfg = snap.config;
  const patch = (p: Partial<GatherLoopConfig>) => {
    const next = sanitizeGatherConfig({ ...cfg, ...p });
    runner.setConfig(next);
    try { browserStorage()?.setItem(GATHER_CONFIG_STORAGE_KEY, JSON.stringify(next)); } catch { /* 儲存失敗就只留在記憶體 */ }
  };

  const connected = bridge.connState === 'CONNECTED';
  const gather = connected ? bridge.status?.gather ?? null : null;
  const pct = bagPct(gather);
  const st = snap.state;

  return (
    <section className="wine-panel" data-testid="wine-gather-panel">
      <div className="wine-head">
        <h2>視窗自動採集</h2>
      </div>
      <p className="muted wine-note">
        走到採集點、開始工作、等完成；背包滿了回村卸貨再回來。只送指令，與練功、尋路互斥。
      </p>
      {!connected && <p className="muted" data-testid="wine-gather-offline">尚未連上視窗橋接。請先在「視窗練功」連線。</p>}
      <PointRow label="採集點" value={cfg.spot} current={current} testId="wine-gather-spot" onChange={spot => patch({ spot })} />
      <PointRow label="回村點" value={cfg.home} current={current} testId="wine-gather-home" onChange={home => patch({ home })} />
      <div className="wine-form-grid wine-gather-grid">
        <label>
          背包滿時
          <select
            data-testid="wine-gather-onfull"
            value={cfg.onBagFull}
            disabled={running}
            onChange={e => patch({ onBagFull: e.target.value === 'stop' ? 'stop' : 'return_home' })}
          >
            <option value="return_home">回村卸貨再回來</option>
            <option value="stop">停下</option>
          </select>
        </label>
        <label>
          滿的門檻 %
          <input type="number" min={1} max={100} value={cfg.bagFullPct} disabled={running}
            data-testid="wine-gather-fullpct" onChange={e => patch({ bagFullPct: Number(e.target.value) })} />
        </label>
        <label>
          卸貨後低於 %
          <input type="number" min={0} max={99} value={cfg.unloadBelowPct} disabled={running}
            data-testid="wine-gather-unloadpct" onChange={e => patch({ unloadBelowPct: Number(e.target.value) })} />
        </label>
        <label>
          最長分鐘（空白＝不限）
          <input type="number" min={1} value={cfg.maxMinutes ?? ''} disabled={running}
            data-testid="wine-gather-maxmin"
            onChange={e => patch({ maxMinutes: e.target.value.trim() === '' ? null : Number(e.target.value) })} />
        </label>
      </div>
      <div className="wine-status-card" data-testid="wine-gather-status" data-phase={st.phase}>
        <div className="wine-status-row">
          <span>狀態：<b data-testid="wine-gather-phase">{WORK_PHASE_LABELS[st.phase]}</b></span>
          <span>採集 <b data-testid="wine-gather-count">{st.gathers}</b> 次</span>
          <span>回村 <b data-testid="wine-gather-unloads">{st.unloads}</b> 趟</span>
          <span>背包 <b data-testid="wine-gather-bag">{pct === null ? '—' : `${Math.round(pct)}%`}</b></span>
        </div>
        {st.stopReason && (
          <div className="wine-stop-reason" data-testid="wine-gather-stop-reason">停下原因：{formatGatherStopReason(st.stopReason)}</div>
        )}
      </div>
      <div className="wine-primary-actions">
        <button type="button" className="item wine-start-btn" data-testid="wine-gather-start"
          disabled={!connected || running}
          onClick={() => { runner.start(); }}>
          開始採集
        </button>
        <button type="button" className="item wine-stop-btn" data-testid="wine-gather-stop"
          disabled={!running} onClick={() => { runner.requestStop(); void runner.tick(); }}>
          停止
        </button>
      </div>
      {snap.log.length > 0 && (
        <pre className="wine-log" data-testid="wine-gather-log">{snap.log.slice(-8).join('\n')}</pre>
      )}
    </section>
  );
}
