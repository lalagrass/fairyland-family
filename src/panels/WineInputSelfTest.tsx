import React, { useState } from 'react';
import { copyTextToClipboard } from '../wine/diagnosticReport';
import type { WineBridgeSnapshot, WineBridgeClient } from '../wine/wineBridgeClient';

/** #210：按鈕不能按的原因；null 代表可以測。 */
export function selfTestBlockedReason(connected: boolean, running: boolean, selfTestRunning: boolean): string | null {
  if (!connected) return '尚未連上本機橋接。';
  if (running) return '背景練功進行中，請先停止再測。';
  if (selfTestRunning) return '測試進行中…';
  return null;
}

/** 中文結論一行；沒有報告時 null。 */
export function selfTestSummary(snap: WineBridgeSnapshot): string | null {
  const rep = snap.status?.inputSelfTest?.report;
  if (!rep) return null;
  if (rep.verdict === 'moved') {
    return rep.workingVariant === 'plain'
      ? '角色有動：直接送點擊就行（先前不動不是送法問題）。'
      : `角色有動：有效送法「${rep.workingVariant}」，已設為預設。`;
  }
  if (rep.verdict === 'no_variant_moved') return '所有送法都沒讓角色移動，請複製報告給 Claude。';
  return `測試中止：${rep.abortReason ?? '未知'}。`;
}

/** 一鍵輸入自我測試：在地圖場景對角色旁的空地點一下，比對前後畫面，回報哪種送法有效。 */
export function WineInputSelfTest({
  client,
  snap,
  connected,
  running,
}: {
  client: WineBridgeClient;
  snap: WineBridgeSnapshot;
  connected: boolean;
  running: boolean;
}) {
  const [msg, setMsg] = useState<string | null>(null);
  const [fallbackText, setFallbackText] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const stt = snap.status?.inputSelfTest ?? null;
  const testing = pending || stt?.state === 'running';
  const blocked = selfTestBlockedReason(connected, running, testing);
  const summary = selfTestSummary(snap);
  const report = stt?.report ?? null;

  const onRun = async () => {
    setMsg(null);
    setFallbackText(null);
    setPending(true);
    try {
      await client.inputSelfTestStart();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };
  const onStop = async () => {
    try {
      await client.inputSelfTestStop();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    }
  };
  const onCopy = async () => {
    if (!report) return;
    if (await copyTextToClipboard(report.text)) setMsg('已複製輸入自我測試報告。');
    else {
      setFallbackText(report.text);
      setMsg('無法使用剪貼簿：請在下方文字框全選後複製。');
    }
  };

  return (
    <div className="wine-selftest" data-testid="wine-selftest">
      <button
        type="button"
        className="item"
        data-testid="wine-input-selftest"
        disabled={blocked !== null}
        onClick={() => void onRun()}
      >
        輸入自我測試
      </button>
      {stt?.state === 'running' && (
        <button type="button" className="item" data-testid="wine-input-selftest-stop" onClick={() => void onStop()}>
          停止測試
        </button>
      )}
      <span className="muted" data-testid="wine-selftest-hint">
        {blocked ?? ' 角色要在地圖上（不能在戰鬥或彈窗中）。會在角色旁約 120 px 的空地各種送法點一下，約半分鐘。'}
      </span>
      {stt?.state === 'running' && (
        <div className="muted" data-testid="wine-selftest-progress">{`測試中：${stt.current ?? '準備中'}`}</div>
      )}
      {summary && <div data-testid="wine-selftest-summary">{summary}</div>}
      {report && (
        <>
          <pre className="wine-diag-text" data-testid="wine-selftest-report">{report.text}</pre>
          <button type="button" data-testid="wine-selftest-copy" onClick={() => void onCopy()}>複製測試報告</button>
        </>
      )}
      {msg && <span className="muted" data-testid="wine-selftest-msg"> {msg}</span>}
      {fallbackText !== null && (
        <textarea className="wine-diag-text" readOnly value={fallbackText} rows={8} onFocus={e => e.currentTarget.select()} />
      )}
    </div>
  );
}
