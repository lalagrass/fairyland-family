/** F20 (#95): plain-text diagnostic report built from the bridge /status snapshot (read-only). */
import { formatWineEventLine, formatWineStopReason, type WineBridgeSnapshot } from './wineBridgeClient';

const val = (v: unknown): string => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** True when the bridge reports a stop reason and the loop is no longer running. */
export function isStoppedWithReason(snap: WineBridgeSnapshot): boolean {
  const st = snap.status;
  return !!st && !st.running && !!st.stopReason;
}

export function buildDiagnosticReport(snap: WineBridgeSnapshot, now: number = Date.now()): string {
  const st = snap.status;
  const L: string[] = [];
  L.push('【視窗練功診斷報告】');
  L.push(`產生時間：${new Date(now).toISOString()}`);
  L.push(`橋接：${snap.baseUrl}（${snap.connState}）`);
  if (snap.error) L.push(`橋接錯誤：${snap.error}`);
  if (!st) {
    L.push('尚未取得橋接 /status。');
    return L.join('\n');
  }
  L.push('');
  L.push('== 停機 ==');
  L.push(st.stopReason ? `停機原因：${formatWineStopReason(st.stopReason)}（${st.stopReason}）` : '停機原因：無');
  L.push(`狀態：running=${st.running} phase=${st.phase} scene=${st.scene}`);
  const d = st.diagnostics ?? null;
  if (d && typeof d.hint === 'string') {
    L.push(`提示：${d.hint}${typeof d.hintCode === 'string' ? `（${d.hintCode}）` : ''}`);
  }
  L.push('== 診斷 ==');
  if (d) {
    L.push(`畫面尺寸：${val(d.source_size)}`);
    L.push(`縮放：${val(d.stage_scale)}`);
    L.push(`unknown_for_ms：${val(d.unknown_for_ms)}`);
    L.push(`targets_detected：${val(d.targets_detected)}`);
    L.push(`phase：${val(d.phase ?? st.phase)}`);
    const known = new Set(['source_size', 'stage_scale', 'unknown_for_ms', 'targets_detected', 'phase', 'hint']);
    for (const [k, v] of Object.entries(d)) if (!known.has(k)) L.push(`${k}：${val(v)}`);
  } else {
    L.push('（橋接沒有附診斷）');
  }
  L.push('');
  L.push('== 輸入自我測試 ==');
  const stt = st.inputSelfTest;
  if (!stt || stt.state === 'idle') L.push('（還沒測過；停機原因是 stalled 或點擊沒反應時請先按「輸入自我測試」）');
  else if (stt.state === 'running') L.push(`測試中（${stt.current ?? '…'}）`);
  else L.push(stt.report?.text ?? '（沒有報告）');
  L.push(`目前點擊送法 inputDelivery：${val((st.config as { inputDelivery?: string } | undefined)?.inputDelivery)}`);
  L.push('');
  L.push('== 數字 ==');
  L.push(`往返 ${st.roundTrips}／遭遇 ${st.encounters}／回合 ${st.turns}／動作 ${st.actionsSent}／tick ${st.ticks}`);
  L.push(`HP ${val(st.hpPct)}%／MP ${val(st.mpPct)}%／位置 ${val(st.position)}`);
  L.push(`辨識耗時 observeMs：${st.observeMs ? `last ${st.observeMs.last}／avg ${st.observeMs.avg}／max ${st.observeMs.max}` : '—'}`);
  L.push('');
  L.push('== 最近 10 場戰報 ==');
  const br = (st.battleReport ?? []).slice(-10);
  L.push(...(br.length ? br : ['（無）']));
  L.push('');
  L.push('== 橋接設定（不含 wid） ==');
  const { wid: _wid, ...cfg } = (st.config ?? {}) as unknown as Record<string, unknown>;
  void _wid;
  L.push(JSON.stringify(cfg));
  L.push('== 設定檔 configStore ==');
  L.push(st.configStore ? JSON.stringify(st.configStore) : '—');
  L.push('== 啟動 launch ==');
  L.push(st.launch ? JSON.stringify(st.launch) : '—');
  L.push('== 存幀資料夾 ==');
  L.push(st.frameDumpDir ?? '（橋接未提供）');
  L.push('');
  L.push('== 最近 20 筆事件 ==');
  const evs = (st.recentEvents?.length ? st.recentEvents : snap.events).slice(-20);
  L.push(...(evs.length ? evs.map(e => formatWineEventLine(e)) : ['（無）']));
  return L.join('\n');
}

export interface ClipboardLike {
  writeText?: (text: string) => Promise<void>;
}

/** Returns true when the text was placed on the clipboard; false means the caller should show a selectable box. */
export async function copyTextToClipboard(
  text: string,
  clipboard: ClipboardLike | null | undefined = typeof navigator !== 'undefined' ? navigator.clipboard : null,
): Promise<boolean> {
  if (!clipboard || typeof clipboard.writeText !== 'function') return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
