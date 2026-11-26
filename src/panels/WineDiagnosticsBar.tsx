import React, { useState } from 'react';
import { buildDiagnosticReport, copyTextToClipboard, isStoppedWithReason } from '../wine/diagnosticReport';
import { formatWineStopReason, type WineBridgeSnapshot } from '../wine/wineBridgeClient';

/** F20 (#95): stopped banner + one-click diagnostic report copy. Read-only. */
export function WineDiagnosticsBar({ snap }: { snap: WineBridgeSnapshot }) {
  const [fallbackText, setFallbackText] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const st = snap.status;
  const onCopy = async () => {
    const text = buildDiagnosticReport(snap);
    const ok = await copyTextToClipboard(text);
    if (ok) { setFallbackText(null); setMsg('已複製診斷報告，直接貼給 Claude 即可。'); }
    else { setFallbackText(text); setMsg('無法使用剪貼簿：請在下方文字框全選後複製。'); }
  };
  return (
    <div className="wine-diag" data-testid="wine-diag">
      {isStoppedWithReason(snap) && st && (
        <div className="wine-stop-banner" role="alert" data-testid="wine-stop-banner">
          {`已停機：${formatWineStopReason(st.stopReason)}（${st.stopReason}）`}
        </div>
      )}
      <button type="button" onClick={onCopy} data-testid="wine-copy-diag">複製診斷報告</button>
      {msg && <span className="muted" data-testid="wine-copy-msg"> {msg}</span>}
      {fallbackText !== null && (
        <textarea
          className="wine-diag-text"
          data-testid="wine-diag-text"
          readOnly
          value={fallbackText}
          rows={10}
          onFocus={e => e.currentTarget.select()}
        />
      )}
    </div>
  );
}
