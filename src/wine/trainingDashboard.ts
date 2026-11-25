/** F11：視窗練功儀表。數字只來自橋接狀態；缺欄位留空，不補 0、不估算經驗。 */

import type { WineBridgeStatus, WineTrainingSchedule } from './wineBridgeClient';

export interface TrainingStats {
  /** Hours between the bridge `started` event and now, or the matching `stopped` event. */
  hours: number | null;
  battles: number | null;
  expPerHour: number | null;
  potionUses: number | null;
  stopCount: number | null;
  stopReasons: string[];
}

export interface ScheduleStop {
  stop: boolean;
  reason: 'schedule_clock' | 'schedule_battles' | null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sessionHours(status: WineBridgeStatus, nowMs: number): number | null {
  const events = Array.isArray(status.recentEvents) ? status.recentEvents : [];
  let startMs: number | null = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ts = finite(events[i]?.tsMs);
    if (events[i]?.type === 'started' && ts !== null) {
      startMs = ts;
      break;
    }
  }
  if (startMs === null) return null;
  let endMs: number | null = status.running ? nowMs : null;
  if (!status.running) {
    for (const ev of events) {
      const ts = finite(ev.tsMs);
      if (ev.type === 'stopped' && ts !== null && ts >= startMs) {
        endMs = ts;
        break;
      }
    }
  }
  if (endMs === null) return null;
  return Math.max(0, (endMs - startMs) / 3_600_000);
}

export function trainingStats(status: WineBridgeStatus | null | undefined, nowMs: number): TrainingStats {
  if (!status) {
    return { hours: null, battles: null, expPerHour: null, potionUses: null, stopCount: null, stopReasons: [] };
  }
  const hours = sessionHours(status, nowMs);
  const battles = finite(status.encounters);
  const expGained = finite(status.expGained);
  const expPerHour = expGained !== null && hours !== null && hours > 0 ? expGained / hours : null;
  const events = Array.isArray(status.recentEvents) ? status.recentEvents : [];
  const stopReasons = events
    .filter(ev => ev.type === 'stopped' && typeof ev.reason === 'string' && ev.reason.length > 0)
    .map(ev => ev.reason as string);
  if (stopReasons.length === 0 && typeof status.stopReason === 'string' && status.stopReason) {
    stopReasons.push(status.stopReason);
  }
  return {
    hours,
    battles,
    expPerHour,
    potionUses: finite(status.potionUses),
    stopCount: stopReasons.length,
    stopReasons,
  };
}

/** True once local time reaches the armed clock. A time already passed when armed waits until tomorrow. */
export function clockReached(stopAt: string, armedAtMs: number, nowMs: number): boolean {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(stopAt);
  if (!match) return false;
  const now = new Date(nowMs);
  const target = new Date(now);
  target.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (armedAtMs >= target.getTime()) target.setDate(target.getDate() + 1);
  return nowMs >= target.getTime();
}

export function scheduleStopDecision(
  schedule: WineTrainingSchedule | null | undefined,
  status: { running?: boolean; encounters?: number | null } | null | undefined,
  nowMs: number,
): ScheduleStop {
  if (!schedule || !status?.running) return { stop: false, reason: null };
  const battles = finite(status.encounters);
  if (schedule.maxBattles !== null && battles !== null && battles >= schedule.maxBattles) {
    return { stop: true, reason: 'schedule_battles' };
  }
  if (schedule.stopAt && schedule.armedAtMs !== null && clockReached(schedule.stopAt, schedule.armedAtMs, nowMs)) {
    return { stop: true, reason: 'schedule_clock' };
  }
  return { stop: false, reason: null };
}

export function trainingStopSignature(status: WineBridgeStatus | null | undefined, nowMs: number): string | null {
  const stats = trainingStats(status, nowMs);
  if (stats.stopCount === null || stats.stopCount === 0) return null;
  return `${stats.stopCount}:${stats.stopReasons.join('|')}`;
}

export function shouldNotifyTrainingStop(input: {
  hidden: boolean;
  granted: boolean;
  enabled: boolean;
  previousSignature: string | null;
  nextSignature: string | null;
}): boolean {
  if (!input.hidden || !input.granted || !input.enabled) return false;
  if (!input.nextSignature) return false;
  return input.nextSignature !== input.previousSignature;
}

export function formatTrainingHours(hours: number | null): string {
  if (hours === null) return '—';
  const totalMinutes = Math.floor(hours * 60);
  if (totalMinutes <= 0) return '不到 1 分鐘';
  const wholeHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (wholeHours === 0) return `${minutes} 分鐘`;
  return `${wholeHours} 小時 ${minutes} 分鐘`;
}

export function formatExpPerHour(value: number | null): string {
  if (value === null) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
