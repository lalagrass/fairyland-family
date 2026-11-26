import React, { useEffect, useRef, useState } from 'react';
import { WineDiagnosticsBar } from './WineDiagnosticsBar';
import { getNotificationPermission, notificationsEnabled, notifyWhenHidden } from '../notify';
import {
  DEFAULT_BRIDGE_URL,
  DEFAULT_WINE_CONFIG,
  DEFAULT_WINE_SCHEDULE,
  WineBridgeClient,
  formatWineEventLine,
  formatWineStopReason,
  MAX_MICRO_DISTANCE,
  MICRO_PATROL_START_X,
  isLoopbackBridgeUrl,
  loadSavedWineBridgeSettings,
  sanitizeSchedule,
  saveWineBridgeSettings,
  type WineBgConfig,
  type WineBridgeSnapshot,
  type WineBridgeSavedSettings,
  type WineBridgeStorageLike,
  type WineFrameInfo,
  type WineHotkey,
  type WineLaunchStatus,
  type WinePreferredAction,
  type WineQuickKey,
  type WineTrainingSchedule,
} from '../wine/wineBridgeClient';
import {
  formatExpPerHour,
  formatTrainingHours,
  scheduleStopDecision,
  shouldNotifyTrainingStop,
  trainingStats,
  trainingStopSignature,
} from '../wine/trainingDashboard';

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

function formatLaunchWindow(launch: WineLaunchStatus | null | undefined): string {
  if (launch?.windowWidth == null || launch.windowHeight == null) return '視窗 —';
  const source = launch.windowSizeSource === 'actual' ? '（實際）' : launch.windowSizeSource === 'planned' ? '（預計）' : '';
  return `視窗 ${launch.windowWidth}×${launch.windowHeight}${source}`;
}

function defaultBrowserStorage(): WineBridgeStorageLike | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

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

/** 為什麼「一鍵開始」現在按不了；可以按時回傳 null。 */
export function startBlockedReason(connected: boolean, connecting: boolean, running: boolean): string | null {
  if (running) return '背景練功進行中，要重跑請先停止。';
  if (connecting) return '正在連線本機橋接…';
  if (!connected) return '尚未連上本機橋接：請先開啟官方視窗（FairylandLauncher），或按「連線橋接」。';
  return null;
}

export function WineTrainingPanel({
  client,
  active,
  autoConnect = false,
}: {
  client: WineBridgeClient;
  active: boolean;
  /** 以前連線成功過（本機有存設定）時，開著面板會自動連線並每 3 秒重試，免去手動按「連線橋接」。 */
  autoConnect?: boolean;
}) {
  const [storage] = useState(defaultBrowserStorage);
  const [initialLoaded] = useState(() => loadSavedWineBridgeSettings(storage));
  const [snap, setSnap] = useState<WineBridgeSnapshot>(() => client.getSnapshot());
  const [urlInput, setUrlInput] = useState<string>(() =>
    initialLoaded.hasSaved ? initialLoaded.settings.baseUrl : client.getSnapshot().baseUrl || DEFAULT_BRIDGE_URL,
  );
  const [settings, setSettings] = useState(initialLoaded.settings);
  const [dirty, setDirty] = useState(settings.config !== null);
  const [busy, setBusy] = useState(false);
  const [localMsg, setLocalMsg] = useState<string | null>(null);
  const { previewEnabled, previewOverlay, previewIntervalMs, microDistance } = settings;
  const draft = (dirty ? settings.config : snap.status?.config) ?? settings.config ?? DEFAULT_WINE_CONFIG;
  const [refreshId, setRefreshId] = useState(0);
  const [frame, setFrame] = useState<{ src: string; info: WineFrameInfo } | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const scheduleStopSent = useRef<string | null>(null);
  const previousStopSignature = useRef<string | null>(null);
  const userDisconnected = useRef(false);
  const lastAutoConnectAt = useRef(0);

  useEffect(() => {
    setSnap(client.getSnapshot());
    return client.subscribe(next => {
      setSnap(next);
    });
  }, [client]);

  useEffect(() => {
    if (settings !== initialLoaded.settings) saveWineBridgeSettings(storage, settings);
  }, [storage, settings, initialLoaded]);

  const patchSettings = (patch: Partial<WineBridgeSavedSettings>) => {
    setSettings(prev => ({ ...prev, ...patch }));
  };

  const connected = snap.connState === 'CONNECTED';
  const connecting = snap.connState === 'CONNECTING';
  const st = snap.status;
  const isRunning = Boolean(connected && st?.running);
  const schedule = settings.schedule ?? DEFAULT_WINE_SCHEDULE;
  const stats = trainingStats(connected ? st : null, nowMs);
  const validLoopback = isLoopbackBridgeUrl(urlInput);

  useEffect(() => {
    if (!autoConnect || !initialLoaded.hasSaved || !active || connected || connecting || userDisconnected.current || !validLoopback) return;
    // 兩次自動連線至少間隔 3 秒，避免橋接不在時快速重試。
    const wait = Math.max(0, lastAutoConnectAt.current + 3000 - Date.now());
    const timer = setTimeout(() => {
      lastAutoConnectAt.current = Date.now();
      void client.connect(urlInput).catch(() => undefined);
    }, wait);
    return () => clearTimeout(timer);
  }, [autoConnect, initialLoaded.hasSaved, active, connected, connecting, validLoopback, urlInput, client, snap]);

  useEffect(() => {
    setFrame(null);
    setPreviewError(false);
    if (!active || !connected || !previewEnabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let objectUrl: string | undefined;
    async function refresh() {
      try {
        const { image, info } = await client.fetchFrame(previewOverlay, controller.signal);
        if (controller.signal.aborted) return;
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = URL.createObjectURL(image);
        setFrame({ src: objectUrl, info });
        setPreviewError(false);
      } catch {
        if (!controller.signal.aborted) {
          setFrame(null);
          setPreviewError(true);
        }
      } finally {
        if (!controller.signal.aborted && previewIntervalMs > 0) {
          timer = setTimeout(refresh, previewIntervalMs);
        }
      }
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, snap.baseUrl, active, connected, previewEnabled, previewIntervalMs, previewOverlay, refreshId]);

  useEffect(() => {
    if (!isRunning) return;
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [isRunning]);

  useEffect(() => {
    if (!connected || !st?.running) return;
    const decision = scheduleStopDecision(schedule, st, Date.now());
    if (!decision.stop || !decision.reason) return;
    const signature = `${schedule.armedAtMs}:${decision.reason}:${st.encounters}`;
    if (scheduleStopSent.current === signature) return;
    scheduleStopSent.current = signature;
    void client.stop(decision.reason).catch(err => {
      setLocalMsg(err instanceof Error ? err.message : String(err));
    });
  }, [client, connected, schedule, st]);

  useEffect(() => {
    const next = trainingStopSignature(connected ? st : null, nowMs);
    const previous = previousStopSignature.current;
    previousStopSignature.current = next;
    if (!shouldNotifyTrainingStop({
      hidden: typeof document !== 'undefined' && document.hidden,
      granted: getNotificationPermission() === 'granted',
      enabled: notificationsEnabled(),
      previousSignature: previous,
      nextSignature: next,
    })) return;
    const reason = stats.stopReasons.at(-1);
    notifyWhenHidden('童話家族：視窗練功已停', formatWineStopReason(reason) || '練功已停止');
  }, [connected, nowMs, st, stats.stopReasons]);

  const patchSchedule = (patch: Partial<WineTrainingSchedule>) => {
    patchSettings({
      schedule: sanitizeSchedule({ ...schedule, ...patch, armedAtMs: Date.now() }),
    });
    scheduleStopSent.current = null;
  };

  const patchDraft = (patch: Partial<WineBgConfig>) => {
    patchSettings({ config: { ...draft, ...patch } });
    setDirty(true);
    setLocalMsg(null);
  };

  const handleConnect = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setLocalMsg(null);
    userDisconnected.current = false;
    setBusy(true);
    try {
      if (await client.connect(urlInput) && isLoopbackBridgeUrl(urlInput)) patchSettings({ baseUrl: urlInput });
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = () => {
    setLocalMsg(null);
    userDisconnected.current = true;
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
  const previewActive = connected && previewEnabled;
  const recognition = frame?.info ?? (connected ? st : null);
  const previewScene = recognition?.scene;
  const position = recognition?.position;

  return (
    <section className="wine-panel" data-testid="wine-training-panel">
      <div className="wine-head">
        <h2>Wine 視窗背景自動練功</h2>
        <span className={connPillClass} data-testid="wine-conn-pill">
          {connLabel}
        </span>
      </div>
      <p className="muted wine-note">
        透過本機 loopback 橋接（僅限 127.0.0.1／localhost）控制 Wine 視窗背景練功，不搶焦點、不移動系統游標；策略設定自動儲存在本機瀏覽器。
      </p>

      <form className="wine-conn-bar" onSubmit={handleConnect}>
        <input
          type="text"
          aria-label="本機橋接位址"
          data-testid="wine-bridge-url"
          value={urlInput}
          onChange={e => {
            const value = e.currentTarget.value;
            setUrlInput(value);
            if (isLoopbackBridgeUrl(value)) patchSettings({ baseUrl: value });
          }}
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
        <WineDiagnosticsBar snap={snap} />
        {stopReasonText && (
          <div className="wine-stop-reason" data-testid="wine-stop-reason">
            {`停機原因：${stopReasonText}`}
            {st?.diagnostics?.source_size ? `（畫面 ${JSON.stringify(st.diagnostics.source_size)}，縮放 ${String(st.diagnostics.stage_scale ?? '?')}）` : ''}
          </div>
        )}
        {st?.observeMs && (
          <div className="muted" data-testid="wine-observe-ms">{`辨識耗時 平均 ${st.observeMs.avg} ms／最長 ${st.observeMs.max} ms`}</div>
        )}
        {st?.battleReport && st.battleReport.length > 0 && (
          <details open data-testid="wine-battle-details">
            <summary>最近戰報</summary>
            <pre className="wine-battle-report" data-testid="wine-battle-report">{st.battleReport.slice(-10).join('\n')}</pre>
          </details>
        )}
        {st?.configStore && (
          <div className="muted" data-testid="wine-config-store">
            {st.configStore.error ? `設定檔：${st.configStore.error}` : st.configStore.loaded ? '設定已從橋接設定檔還原' : '設定會自動存到橋接設定檔'}
          </div>
        )}
        <div className="wine-launch" data-testid="wine-launch">
          <span>{`縮放 ${st?.launch?.scaleMode || '—'}`}</span>
          <span>{formatLaunchWindow(st?.launch)}</span>
          <span>{`橋接埠 ${st?.launch?.bridgePort ?? '—'}`}</span>
        </div>
      </div>

      <section className="wine-dashboard" data-testid="wine-dashboard" aria-label="練功儀表">
        <div className="wine-dash-card">
          <span>時數</span>
          <b data-testid="wine-stat-hours">{formatTrainingHours(stats.hours)}</b>
        </div>
        <div className="wine-dash-card">
          <span>場數</span>
          <b data-testid="wine-stat-battles">{stats.battles === null ? '—' : String(stats.battles)}</b>
        </div>
        <div className="wine-dash-card">
          <span>每小時經驗</span>
          <b data-testid="wine-stat-exp-hour">{formatExpPerHour(stats.expPerHour)}</b>
        </div>
        <div className="wine-dash-card">
          <span>吃補次數</span>
          <b data-testid="wine-stat-potions">{stats.potionUses === null ? '—' : String(stats.potionUses)}</b>
        </div>
        <div className="wine-dash-card">
          <span>停機</span>
          <b data-testid="wine-stat-stops">
            {stats.stopCount === null ? '—' : `${stats.stopCount} 次`}
            {stats.stopReasons.length > 0 ? `（${stats.stopReasons.map(reason => formatWineStopReason(reason)).join('、')}）` : ''}
          </b>
        </div>
      </section>
      <p className="muted wine-note">時數、場數、吃補與停機只顯示橋接回報。橋接沒有回報經驗時，每小時經驗留空。</p>
      <div className="wine-schedule" data-testid="wine-schedule">
        <label>
          練到幾點
          <input
            type="time"
            data-testid="wine-stop-at"
            value={schedule.stopAt ?? ''}
            onChange={e => patchSchedule({ stopAt: e.currentTarget.value || null })}
          />
        </label>
        <label>
          練幾場
          <input
            type="number"
            min={1}
            inputMode="numeric"
            data-testid="wine-max-battles"
            value={schedule.maxBattles ?? ''}
            placeholder="不限"
            onChange={e => patchSchedule({ maxBattles: posIntOrNull(e.currentTarget.value) })}
          />
        </label>
      </div>

      <div className="wine-preview-box" data-testid="wine-preview-box">
        <div className="wine-preview-head">
          <h3>背景即時畫面預覽</h3>
          <button
            type="button"
            className="item"
            data-testid="wine-preview-toggle"
            onClick={() => patchSettings({ previewEnabled: !previewEnabled })}
          >
            {previewEnabled ? '暫停預覽' : '開啟預覽'}
          </button>
          <label className="wine-inline-check">
            <input
              type="checkbox"
              data-testid="wine-preview-overlay"
              checked={previewOverlay}
              onChange={e => patchSettings({ previewOverlay: e.currentTarget.checked })}
            />
            顯示辨識框
          </label>
          <select
            aria-label="預覽更新頻率"
            data-testid="wine-preview-interval"
            value={String(previewIntervalMs)}
            onChange={e => patchSettings({ previewIntervalMs: Number(e.currentTarget.value) })}
          >
            <option value="500">0.5 秒</option>
            <option value="1000">1 秒</option>
            <option value="2000">2 秒</option>
            <option value="0">手動更新</option>
          </select>
          <button
            type="button"
            className="item"
            data-testid="wine-preview-refresh"
            disabled={!connected || !previewEnabled}
            onClick={() => setRefreshId(id => id + 1)}
          >
            更新畫面
          </button>
        </div>
        <div className="wine-preview-frame">
          {previewActive && frame && !previewError ? (
            <img
              src={frame.src}
              alt="Wine 背景即時畫面預覽"
              data-testid="wine-preview-img"
              onError={() => setPreviewError(true)}
            />
          ) : (
            <div className="wine-preview-empty muted" data-testid="wine-preview-empty">
              {!connected ? '連線本機橋接後即可預覽背景視窗。'
                : !previewEnabled ? '預覽已暫停'
                : previewError ? '尚未取得視窗影格，請確認目標視窗與螢幕錄製權限。'
                : '正在讀取畫面…'}
            </div>
          )}
          <div className="wine-preview-hud" data-testid="wine-preview-hud">
            <span>場景 {previewScene ? SCENE_LABELS[previewScene] ?? previewScene : '—'}</span>
            <span>HP {recognition?.hpPct != null ? `${recognition.hpPct}%` : '—'}</span>
            <span>MP {recognition?.mpPct != null ? `${recognition.mpPct}%` : '—'}</span>
            <span>座標 {position ? `(${position[0]},${position[1]})` : '—'}</span>
          </div>
        </div>
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
      {startBlockedReason(connected, connecting, isRunning) && (
        <div className="muted" data-testid="wine-start-hint">{startBlockedReason(connected, connecting, isRunning)}</div>
      )}

      <div className="wine-config-form" data-testid="wine-config-form">
        <div className="wine-config-head">
          <h3>練功策略設定</h3>
          <label>
            原地微移距離
            <input
              type="number" min={1} max={MAX_MICRO_DISTANCE}
              data-testid="wine-micro-distance" value={microDistance}
              onChange={e => patchSettings({ microDistance: clampInt(e.currentTarget.value, microDistance, 1, MAX_MICRO_DISTANCE) })}
            />
          </label>
          <button
            type="button"
            className="item"
            data-testid="wine-preset-micro"
            onClick={() => patchDraft({ patrolA: [MICRO_PATROL_START_X, 300], patrolB: [MICRO_PATROL_START_X + microDistance, 300] })}
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
            戰中補血 (%)
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
            戰後待機補血 (%)
            <input
              type="number"
              min={0}
              max={100}
              data-testid="wine-map-heal-hp"
              value={draft.mapHealHpPct ?? 0}
              onChange={e => patchDraft({ mapHealHpPct: clampInt(e.currentTarget.value, draft.mapHealHpPct ?? 0, 0, 100) })}
            />
          </label>
          <label>
            補血熱鍵
            <select
              data-testid="wine-map-heal-hp-key"
              value={draft.mapHealHpKey ?? 'F1'}
              onChange={e => patchDraft({ mapHealHpKey: e.currentTarget.value as WineQuickKey })}
            >
              {(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'] as WineQuickKey[]).map(k => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
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
            低魔停機 (%)
            <input
              type="number"
              min={0}
              max={99}
              data-testid="wine-stop-mp"
              value={draft.stopMpPct}
              onChange={e => patchDraft({ stopMpPct: clampInt(e.currentTarget.value, draft.stopMpPct, 0, 99) })}
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
