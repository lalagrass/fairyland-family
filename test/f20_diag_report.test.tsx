import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildDiagnosticReport, copyTextToClipboard, isStoppedWithReason } from '../src/wine/diagnosticReport';
import { WineDiagnosticsBar } from '../src/panels/WineDiagnosticsBar';
import { DEFAULT_WINE_CONFIG, type WineBridgeSnapshot, type WineBridgeStatus } from '../src/wine/wineBridgeClient';
import { assert, done, suite } from './helpers';

function snap(patch: Partial<WineBridgeStatus> = {}): WineBridgeSnapshot {
  const status = {
    ok: true, connected: true, running: false, phase: 'stopped', scene: 'unknown',
    hpPct: 50, mpPct: 40, position: [3, 4], roundTrips: 1, encounters: 5, turns: 9, ticks: 100, actionsSent: 20,
    lastAction: null, stopReason: 'unrecognized_scene',
    config: { ...DEFAULT_WINE_CONFIG, wid: 4242 },
    recentEvents: Array.from({ length: 30 }, (_, i) => ({ tsMs: 1_700_000_000_000 + i * 1000, type: 'tick', n: i })),
    diagnostics: { source_size: [1512, 982], stage_scale: 1.5, unknown_for_ms: 3200, targets_detected: [], phase: 'unknown' },
    battleReport: Array.from({ length: 12 }, (_, i) => `戰報${i}`),
    observeMs: { last: 10, avg: 12, max: 30 },
    configStore: { path: '/x/cfg.json', loaded: true, savedAt: 1, error: null },
    launch: { scaleMode: 'fit', windowWidth: 800, windowHeight: 600, bridgePort: 4182 },
    frameDumpDir: '/home/u/fairyland-captures/live/loop-1',
    ...patch,
  } as WineBridgeStatus;
  return { connState: 'CONNECTED', baseUrl: 'http://127.0.0.1:4182', status, windows: [], events: [], error: null, lastUpdatedAt: 1 };
}

suite('F20 報告格式');
{
  const r = buildDiagnosticReport(snap(), 1_700_000_100_000);
  assert(r.includes('停機原因：畫面無法辨識（不是地圖也不是戰鬥）（unrecognized_scene）'), '停機原因中文加原碼');
  assert(r.includes('[1512,982]') && r.includes('縮放：1.5') && r.includes('unknown_for_ms：3200'), '診斷欄位');
  assert(r.includes('targets_detected：[]') && r.includes('phase：unknown'), 'targets 與 phase');
  assert(r.includes('戰報11') && r.includes('戰報2') && !r.includes('戰報1\n') && !r.includes('戰報0'), '只留最後 10 場');
  assert(r.includes('avg 12'), 'observeMs');
  assert(!r.includes('4242') && !r.includes('"wid"'), '橋接設定不含 wid');
  assert(r.includes('"healAtPct"'), '橋接設定其他欄位保留');
  assert(r.includes('/x/cfg.json') && r.includes('"scaleMode":"fit"'), 'configStore 與 launch');
  assert(r.includes('/home/u/fairyland-captures/live/loop-1'), '存幀資料夾');
  const evLines = r.split('== 最近 20 筆事件 ==\n')[1].split('\n').filter(Boolean);
  assert(evLines.length === 20, '事件最多 20 筆');
  assert(buildDiagnosticReport(snap({ frameDumpDir: undefined })).includes('（橋接未提供）'), '舊橋接沒有存幀欄位也能產生');
  assert(buildDiagnosticReport({ ...snap(), status: null }).includes('尚未取得'), '沒有 status 時不爆');
}

suite('F20 剪貼簿與備援');
{
  assert((await copyTextToClipboard('x', null)) === false, '沒有 clipboard 回 false');
  assert((await copyTextToClipboard('x', {})) === false, '沒有 writeText 回 false');
  assert((await copyTextToClipboard('x', { writeText: async () => { throw new Error('denied'); } })) === false, '拒絕時回 false');
  let got = '';
  assert((await copyTextToClipboard('hello', { writeText: async t => { got = t; } })) === true && got === 'hello', '成功寫入');
}

suite('F20 停機提示與按鈕');
{
  assert(isStoppedWithReason(snap()) === true, '停機有原因');
  assert(isStoppedWithReason(snap({ running: true })) === false, '執行中不是停機');
  const html = renderToStaticMarkup(<WineDiagnosticsBar snap={snap()} />);
  assert(html.includes('wine-stop-banner') && html.includes('複製診斷報告'), '停機時有橫幅與按鈕');
  const html2 = renderToStaticMarkup(<WineDiagnosticsBar snap={snap({ running: true, stopReason: null })} />);
  assert(!html2.includes('wine-stop-banner') && html2.includes('wine-copy-diag'), '執行中沒有橫幅');
}

done();
