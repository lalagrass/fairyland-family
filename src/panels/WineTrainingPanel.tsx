import React, { useEffect, useState } from 'react';
import {
  DEFAULT_BRIDGE_URL,
  DEFAULT_WINE_CONFIG,
  WineBridgeClient,
  formatWineEventLine,
  formatWineStopReason,
  isLoopbackBridgeUrl,
  type WineBgConfig,
  type WineBridgeSnapshot,
  type WineHotkey,
  type WinePreferredAction,
} from '../wine/wineBridgeClient';

const SCENE_LABELS: Record<string, string> = {
  map: '地圖探索',
  battle: '戰鬥中',
  result: '戰鬥結算',
  unknown: '未知',
};

const PHASE_LABELS: Record<string, string> = {
  idle: '待機中',
  running: '背景練功中',
  paused: '暫停中',
  stopping: '停止中',
  stopped: '已停止',
};

function clampInt(raw: string, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function posIntOrNull(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function posFloatOrNull(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Number(n.toFixed(2));
}

export function WineTrainingPanel({ client }: { client: WineBridgeClient }) {
  const [snap, setSnap] = useState<WineBridgeSnapshot>(() => client.getSnapshot());
  const [urlInput, setUrlInput] = useState<string>(() => client.getSnapshot().baseUrl || DEFAULT_BRIDGE_URL);
  const [draft, setDraft] = useState<WineBgConfig>(() => client.getSnapshot().status?.config ?? DEFAULT_WINE_CONFIG);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [localMsg, setLocalMsg] = useState<string | null>(null);

  useEffect(() => {
    setSnap(client.getSnapshot());
    return client.subscribe(next => {
      setSnap(next);
    });
  }, [client]);

  useEffect(() => {
    if (!dirty && snap.status?.config) {
      setDraft(snap.status.config);
    }
  }, [dirty, snap.status?.config]);

  const connected = snap.connState === 'CONNECTED';
  const connecting = snap.connState === 'CONNECTING';
  const st = snap.status;
  const isRunning = Boolean(connected && st?.running);
  const validLoopback = isLoopbackBridgeUrl(urlInput);

  const patchDraft = (patch: Partial<WineBgConfig>) => {
    setDraft(prev => ({ ...prev, ...patch }));
    setDirty(true);
    setLocalMsg(null);
  };

  const handleConnect = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setLocalMsg(null);
    setBusy(true);
    try {
      const ok = await client.connect(urlInput);
      if (ok) {
        setDirty(false);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = () => {
    setLocalMsg(null);
    client.disconnect();
  };

  const handleApplyConfig = async () => {
    setLocalMsg(null);
    setBusy(true);
    try {
      await client.updateConfig(draft);
      setDirty(false);
      setLocalMsg('已套用背景練功策略');
    } catch (err) {
      setLocalMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleStart = async () => {
    setLocalMsg(null);
    setBusy(true);
    try {
      await client.start(draft);
      setDirty(false);
    } catch (err) {
      setLocalMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async () => {
    setLocalMsg(null);
    setBusy(true);
    try {
      await client.stop('user_clicked_stop');
    } catch (err) {
      setLocalMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleScanWindows = async () => {
    setLocalMsg(null);
    setBusy(true);
    try {
      const wins = await client.refreshWindows();
      if (wins.length === 0) {
        setLocalMsg('本機目前沒有偵測到可用的目標視窗（或未授予螢幕錄製權限）');
      } else {
        setLocalMsg(`已偵測到 ${wins.length} 個可用視窗，可點選下方按鈕帶入`);
      }
    } catch (err) {
      setLocalMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const connLabel = connected ? '已連線' : connecting ? '連線中…' : '已斷線';
  const connPillClass = connected ? 'pill run' : 'pill stop';
  const phaseLabel = st ? PHASE_LABELS[st.phase] ?? st.phase : '未連線';
  const sceneLabel = st ? SCENE_LABELS[st.scene] ?? st.scene : '—';
  const stopReasonText = formatWineStopReason(st?.stopReason);
  const eventsNewestFirst = [...snap.events].reverse();

  return (
    <section className="wine-panel" data-testid="wine-training-panel">
      <div className="wine-head">
        <h2>Wine 視窗背景自動練功</h2>
        <span className={connPillClass} data-testid="wine-conn-pill">
          {connLabel}
        </span>
      </div>
      <p className="muted wine-note">
        透過本機 loopback 橋接（僅限 127.0.0.1／localhost）控制 Wine 視窗背景練功，不搶焦點、不移動系統游標。
      </p>

      <form className="wine-conn-bar" onSubmit={handleConnect}>
        <input
          type="text"
          aria-label="本機橋接位址"
          data-testid="wine-bridge-url"
          value={urlInput}
          onChange={e => setUrlInput(e.currentTarget.value)}
          placeholder={DEFAULT_BRIDGE_URL}
        />
        {!connected ? (
          <button
            type="submit"
            className="item"
            data-testid="wine-connect-btn"
            disabled={busy || connecting || !validLoopback}
          >
            連線橋接
          </button>
        ) : (
          <>
            <button
              type="button"
              className="item"
              data-testid="wine-refresh-btn"
              disabled={busy}
              onClick={() => void client.refreshStatus().catch(() => undefined)}
            >
              重新整理
            </button>
            <button
              type="button"
              className="item"
              data-testid="wine-disconnect-btn"
              onClick={handleDisconnect}
            >
              中斷連線
            </button>
          </>
        )}
      </form>

      {!validLoopback && (
        <div className="err" data-testid="wine-url-warn">
          僅允許本機 loopback 位址（例如 http://127.0.0.1:4182）
        </div>
      )}
      {snap.error && (
        <div className="err" data-testid="wine-error">
          {snap.error}
        </div>
      )}
      {localMsg && !snap.error && (
        <div className="muted" data-testid="wine-info-msg">
          {localMsg}
        </div>
      )}

      <div className="wine-status-card" data-testid="wine-status-card">
        <div className="wine-status-row">
          <span>
            狀態：<b data-testid="wine-phase">{phaseLabel}</b>
          </span>
          <span>
            場景：<b data-testid="wine-scene">{sceneLabel}</b>
          </span>
          <span data-testid="wine-hp">{`HP ${st?.hpPct != null ? `${st.hpPct}%` : '—'}`}</span>
          <span data-testid="wine-mp">{`MP ${st?.mpPct != null ? `${st.mpPct}%` : '—'}`}</span>
        </div>
        <div className="wine-metrics" data-testid="wine-metrics">
          <span>{`往返 ${st?.roundTrips ?? 0} 趟`}</span>
          <span>{`遭遇 ${st?.encounters ?? 0} 戰`}</span>
          <span>{`回合 ${st?.turns ?? 0} 次`}</span>
          <span>{`動作 ${st?.actionsSent ?? 0} 次`}</span>
        </div>
        {stopReasonText && (
          <div className="wine-stop-reason" data-testid="wine-stop-reason">
            {`停機原因：${stopReasonText}`}
          </div>
        )}
      </div>

      <div className="wine-primary-actions">
        <button
          type="button"
          className="item wine-start-btn"
          data-testid="wine-start-btn"
          disabled={!connected || isRunning || busy}
          onClick={() => void handleStart()}
        >
          一鍵開始背景練功
        </button>
        <button
          type="button"
          className="item wine-stop-btn"
          data-testid="wine-stop-btn"
          disabled={!connected || !isRunning || busy}
          onClick={() => void handleStop()}
        >
          停止背景練功
        </button>
      </div>

      <div className="wine-config-form" data-testid="wine-config-form">
        <div className="wine-config-head">
          <h3>練功策略設定</h3>
          <button
            type="button"
            className="item"
            data-testid="wine-preset-micro"
            onClick={() => patchDraft({ patrolA: [390, 300], patrolB: [415, 300] })}
          >
            原地微移
          </button>
          <button
            type="button"
            className="item"
            data-testid="wine-apply-config"
            disabled={!connected || busy}
            onClick={() => void handleApplyConfig()}
          >
            {dirty ? '套用策略 *' : '套用策略'}
          </button>
        </div>

        <div className="wine-form-grid">
          <label>
            巡邏點 A X
            <input
              type="number"
              min={0}
              max={800}
              data-testid="wine-patrol-ax"
              value={draft.patrolA[0]}
              onChange={e => patchDraft({ patrolA: [clampInt(e.currentTarget.value, draft.patrolA[0], 0, 800), draft.patrolA[1]] })}
            />
          </label>
          <label>
            巡邏點 A Y
            <input
              type="number"
              min={0}
              max={600}
              data-testid="wine-patrol-ay"
              value={draft.patrolA[1]}
              onChange={e => patchDraft({ patrolA: [draft.patrolA[0], clampInt(e.currentTarget.value, draft.patrolA[1], 0, 600)] })}
            />
          </label>
          <label>
            巡邏點 B X
            <input
              type="number"
              min={0}
              max={800}
              data-testid="wine-patrol-bx"
              value={draft.patrolB[0]}
              onChange={e => patchDraft({ patrolB: [clampInt(e.currentTarget.value, draft.patrolB[0], 0, 800), draft.patrolB[1]] })}
            />
          </label>
          <label>
            巡邏點 B Y
            <input
              type="number"
              min={0}
              max={600}
              data-testid="wine-patrol-by"
              value={draft.patrolB[1]}
              onChange={e => patchDraft({ patrolB: [draft.patrolB[0], clampInt(e.currentTarget.value, draft.patrolB[1], 0, 600)] })}
            />
          </label>
          <label>
            招式熱鍵
            <select
              data-testid="wine-hotkey"
              value={draft.hotkey}
              onChange={e => patchDraft({ hotkey: e.currentTarget.value as WineHotkey })}
            >
              <option value="F7">F7（主招／技能）</option>
              <option value="F8">F8（備用／補血）</option>
            </select>
          </label>
          <label>
            戰鬥偏好
            <select
              data-testid="wine-preferred"
              value={draft.preferred}
              onChange={e => patchDraft({ preferred: e.currentTarget.value as WinePreferredAction })}
            >
              <option value="skill">技能優先</option>
              <option value="attack">普攻優先</option>
            </select>
          </label>
          <label>
            自動補血 (%)
            <input
              type="number"
              min={0}
              max={100}
              data-testid="wine-heal-pct"
              value={draft.healAtPct}
              onChange={e => patchDraft({ healAtPct: clampInt(e.currentTarget.value, draft.healAtPct, 0, 100) })}
            />
          </label>
          <label>
            低血停機 (%)
            <input
              type="number"
              min={0}
              max={99}
              data-testid="wine-stop-hp"
              value={draft.stopHpPct}
              onChange={e => patchDraft({ stopHpPct: clampInt(e.currentTarget.value, draft.stopHpPct, 0, 99) })}
            />
          </label>
          <label>
            時間上限 (分)
            <input
              type="number"
              min={1}
              data-testid="wine-max-minutes"
              value={draft.maxMinutes ?? ''}
              placeholder="不限"
              onChange={e => patchDraft({ maxMinutes: posFloatOrNull(e.currentTarget.value) })}
            />
          </label>
          <label>
            趟數上限
            <input
              type="number"
              min={1}
              data-testid="wine-max-trips"
              value={draft.maxRoundTrips ?? ''}
              placeholder="不限"
              onChange={e => patchDraft({ maxRoundTrips: posIntOrNull(e.currentTarget.value) })}
            />
          </label>
        </div>

        <div className="wine-window-row">
          <label>
            目標視窗標題（選填）
            <input
              type="text"
              data-testid="wine-window-title"
              value={draft.windowTitle}
              placeholder="留空自動偵測"
              onChange={e => patchDraft({ windowTitle: e.currentTarget.value, wid: null })}
            />
          </label>
          <button
            type="button"
            className="item"
            data-testid="wine-scan-windows"
            disabled={!connected || busy}
            onClick={() => void handleScanWindows()}
          >
            掃描視窗
          </button>
        </div>

        {snap.windows.length > 0 && (
          <div className="wine-window-list" data-testid="wine-window-list">
            {snap.windows.map(w => (
              <button
                key={w.wid}
                type="button"
                className={`item ${draft.wid === w.wid ? 'tab-active' : ''}`}
                onClick={() => patchDraft({ wid: w.wid, windowTitle: w.title })}
              >
                {`${w.title || `#${w.wid}`} (${w.width}×${w.height})`}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="wine-log-box">
        <h3>即時戰報與動作日誌</h3>
        <div className="wine-log" data-testid="wine-log">
          {eventsNewestFirst.length === 0 ? (
            <div className="muted">尚無練功事件；連線後按下「一鍵開始背景練功」即可即時回傳戰報。</div>
          ) : (
            eventsNewestFirst.map((ev, idx) => (
              <div key={`${ev.tsMs}-${ev.type}-${idx}`} className={ev.type === 'error' ? 'error' : ''}>
                {formatWineEventLine(ev)}
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
