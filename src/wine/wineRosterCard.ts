/** F19：家族名冊的官方 Wine 角色卡片。只轉換橋接 `/status` 已有的欄位；缺欄位留空，不補數值。 */

import type { WineBridgeSnapshot } from './wineBridgeClient';
import { formatWineStopReason } from './wineBridgeClient';
import { formatExpPerHour, trainingStats } from './trainingDashboard';

export type WineRosterState = 'offline' | 'connecting' | 'idle' | 'training' | 'stopped';

export interface WineRosterCardData {
  state: WineRosterState;
  /** 狀態標籤，未連線固定為「未連線」。 */
  stateLabel: string;
  /** 停機原因（只有 stopped 才有）。 */
  reason: string | null;
  /** 橋接回報的地圖識別；沒有時為 null。 */
  map: string | null;
  /** 場景（地圖探索／戰鬥中…）；沒有時為 null。 */
  scene: string | null;
  job: string;
  /** 本次經驗變化，例如 `+120`；橋接沒回就是 null。 */
  expChange: string | null;
  expPerHour: string | null;
  hpPct: number | null;
  mpPct: number | null;
}

const SCENE_LABELS: Record<string, string> = {
  map: '地圖探索',
  battle: '戰鬥中',
  result: '戰鬥結算',
  unknown: '未知',
};

const JOB_STATE_LABELS: Record<string, string> = {
  idle: '待機',
  planning: '規劃路線',
  walking: '移動中',
  replanning: '重新規劃',
  arrived: '已到達',
  stopped: '已停下',
};

function jobState(state: string): string {
  return JOB_STATE_LABELS[state] ?? state;
}

function pct(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function wineRosterCard(snap: WineBridgeSnapshot, nowMs: number): WineRosterCardData {
  const blank: WineRosterCardData = {
    state: 'offline', stateLabel: '未連線', reason: null, map: null, scene: null,
    job: '—', expChange: null, expPerHour: null, hpPct: null, mpPct: null,
  };
  if (snap.connState === 'CONNECTING') return { ...blank, state: 'connecting', stateLabel: '連線中…' };
  const st = snap.status;
  if (snap.connState !== 'CONNECTED' || !st) return blank;

  const stats = trainingStats(st, nowMs);
  const stopReason = st.stopReason ?? stats.stopReasons[stats.stopReasons.length - 1] ?? null;
  let state: WineRosterState;
  if (st.running) state = 'training';
  else if (stopReason) state = 'stopped';
  else state = 'idle';

  let job = '無';
  if (st.gather?.running) job = `採集（${jobState(st.gather.state)}）`;
  else if (st.supply?.running) job = `補給（${jobState(st.supply.state)}）`;
  else if (st.nav?.running) job = `尋路（${jobState(st.nav.state)}）`;
  else if (st.running) job = '背景練功';

  const exp = typeof st.expGained === 'number' && Number.isFinite(st.expGained) ? st.expGained : null;
  return {
    state,
    stateLabel: state === 'training' ? '練功中' : state === 'stopped' ? '已停機' : '閒置',
    reason: state === 'stopped' ? formatWineStopReason(stopReason) : null,
    map: st.nav?.mapId ?? null,
    scene: typeof st.scene === 'string' ? (SCENE_LABELS[st.scene] ?? st.scene) : null,
    job,
    expChange: exp === null ? null : `${exp >= 0 ? '+' : ''}${exp}`,
    expPerHour: stats.expPerHour === null ? null : formatExpPerHour(stats.expPerHour),
    hpPct: pct(st.hpPct),
    mpPct: pct(st.mpPct),
  };
}
