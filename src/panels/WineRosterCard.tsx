import React, { useEffect, useState } from 'react';
import {
  WineBridgeClient,
  loadSavedWineBridgeSettings,
  type WineBridgeSnapshot,
} from '../wine/wineBridgeClient';
import { wineRosterCard } from '../wine/wineRosterCard';

/** 未連線時重試間隔；只送 GET /status，不寫入橋接。 */
export const WINE_ROSTER_RETRY_MS = 15_000;
export const WINE_ROSTER_THUMB_MS = 3_000;
export const WINE_ROSTER_FIRST_THUMB_MS = 2_000;

/** 測試環境（Node）的計時器不應擋住行程結束；瀏覽器回傳數字，沒有 unref。 */
function unref<T>(id: T): T {
  (id as { unref?: () => void } | null)?.unref?.();
  return id;
}

function readStorage(): { getItem(k: string): string | null; setItem(k: string, v: string): void } | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * 只有使用者在「視窗練功」存過橋接設定才自動探測；沒存過就維持「未連線」，不主動打任何連接埠。
 */
export function shouldProbeBridge(snap: WineBridgeSnapshot, hasSaved: boolean): boolean {
  if (snap.connState !== 'DISCONNECTED') return false;
  // 使用者手動中斷（有連過、沒有錯誤）就不再自動連回去。
  if (snap.lastUpdatedAt !== null && snap.error === null) return false;
  return hasSaved || snap.lastUpdatedAt !== null;
}

export function WineRosterCard({ client, onOpen }: { client: WineBridgeClient; onOpen: () => void }) {
  const [snap, setSnap] = useState<WineBridgeSnapshot>(() => client.getSnapshot());
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [thumb, setThumb] = useState<string | null>(null);
  const connected = snap.connState === 'CONNECTED';

  useEffect(() => {
    setSnap(client.getSnapshot());
    return client.subscribe(setSnap);
  }, [client]);

  useEffect(() => {
    const id = unref(setInterval(() => setNowMs(Date.now()), 5000));
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const saved = loadSavedWineBridgeSettings(readStorage());
    let cancelled = false;
    const probe = () => {
      const cur = client.getSnapshot();
      if (cancelled || !shouldProbeBridge(cur, saved.hasSaved)) return;
      void client.connect(saved.hasSaved && cur.lastUpdatedAt === null ? saved.settings.baseUrl : cur.baseUrl);
    };
    probe();
    const id = unref(setInterval(probe, WINE_ROSTER_RETRY_MS));
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [client]);

  useEffect(() => {
    setThumb(null);
    if (!connected) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let objectUrl: string | undefined;
    async function refresh() {
      try {
        if (typeof document === 'undefined' || !document.hidden) {
          const { image } = await client.fetchFrame(false, controller.signal);
          if (controller.signal.aborted) return;
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          objectUrl = URL.createObjectURL(image);
          setThumb(objectUrl);
        }
      } catch {
        if (!controller.signal.aborted) setThumb(null);
      } finally {
        if (!controller.signal.aborted) timer = unref(setTimeout(refresh, WINE_ROSTER_THUMB_MS));
      }
    }
    // 連線後先等一輪再抓縮圖，避免與視窗練功面板剛連線時的預覽請求同時打橋接。
    timer = unref(setTimeout(refresh, WINE_ROSTER_FIRST_THUMB_MS));
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, connected, snap.baseUrl]);

  const card = wineRosterCard(snap, nowMs);
  return (
    <button
      type="button"
      className={`wine-roster-card wine-roster-${card.state}`}
      data-testid="wine-roster-card"
      data-state={card.state}
      aria-label="官方 Wine 角色，開啟視窗練功面板"
      onClick={onOpen}
    >
      <span className="wine-roster-thumb" data-testid="wine-roster-thumb">
        {thumb ? <img src={thumb} alt="官方視窗即時縮圖" /> : <span className="muted">{connected ? '縮圖載入中' : '無畫面'}</span>}
      </span>
      <span className="wine-roster-body">
        <span className="wine-roster-head">
          <strong>官方 Wine 角色</strong>
          <span className={`pill ${card.state === 'training' ? 'run' : card.state === 'idle' ? 'ok' : 'stop'}`} data-testid="wine-roster-state">
            {card.stateLabel}
          </span>
        </span>
        {card.state === 'offline' || card.state === 'connecting' ? (
          <span className="muted" data-testid="wine-roster-offline">
            {card.state === 'offline' ? '橋接未開或尚未連線，點此到視窗練功連線。' : '正在連線本機橋接…'}
          </span>
        ) : (
          <>
            {card.reason && <span data-testid="wine-roster-reason">{`停機原因：${card.reason}`}</span>}
            <span data-testid="wine-roster-map">{`地圖：${card.map ?? '—'}${card.scene ? `（${card.scene}）` : ''}`}</span>
            <span data-testid="wine-roster-job">{`目前工作：${card.job}`}</span>
            <span data-testid="wine-roster-exp">
              {`經驗變化：${card.expChange ?? '—'}${card.expPerHour ? `（每小時 ${card.expPerHour}）` : ''}`}
            </span>
          </>
        )}
      </span>
    </button>
  );
}
