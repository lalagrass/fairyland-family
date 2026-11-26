import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildDiagnosticReport } from '../src/wine/diagnosticReport';
import { WineDiagnosticsBar } from '../src/panels/WineDiagnosticsBar';
import { WineInputSelfTest, selfTestBlockedReason, selfTestSummary } from '../src/panels/WineInputSelfTest';
import {
  DEFAULT_WINE_CONFIG,
  WINE_SETTINGS_STORAGE_KEY,
  WineBridgeClient,
  loadSavedWineBridgeSettings,
  parseInputSelfTest,
  saveWineBridgeSettings,
  type WineBridgeSnapshot,
  type WineBridgeStatus,
} from '../src/wine/wineBridgeClient';
import { assert, done, suite } from './helpers';

function snap(patch: Partial<WineBridgeStatus> = {}): WineBridgeSnapshot {
  const status = {
    ok: true, connected: true, running: false, phase: 'stopped', scene: 'map',
    hpPct: 100, mpPct: 98, position: null, roundTrips: 0, encounters: 0, turns: 0, ticks: 200, actionsSent: 1,
    lastAction: null, stopReason: 'stalled',
    config: { ...DEFAULT_WINE_CONFIG },
    recentEvents: [],
    diagnostics: { hintCode: 'no_movement_after_click', hint: '點擊後角色沒有移動（no movement after click）。請按輸入自我測試。', moveClicksSent: 1, suggest: 'input_selftest' },
    ...patch,
  } as WineBridgeStatus;
  return { connState: 'CONNECTED', baseUrl: 'http://127.0.0.1:4182', status, windows: [], events: [], error: null, lastUpdatedAt: 1 };
}

suite('210 預設普攻優先');
{
  assert(DEFAULT_WINE_CONFIG.preferred === 'attack', '預設 attack');
}

suite('210 本機設定 v1 的技能優先不保留，v2 選的保留');
{
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
  mem.set(WINE_SETTINGS_STORAGE_KEY, JSON.stringify({
    baseUrl: 'http://127.0.0.1:4182',
    config: { ...DEFAULT_WINE_CONFIG, preferred: 'skill', healAtPct: 50 },
  }));
  const old = loadSavedWineBridgeSettings(storage);
  assert(old.settings.config?.preferred === 'attack', 'v1 存的 skill 改回 attack');
  assert(old.settings.config?.healAtPct === 50, '其他欄位照舊');
  saveWineBridgeSettings(storage, { ...old.settings, config: { ...old.settings.config!, preferred: 'skill' } });
  assert(JSON.parse(mem.get(WINE_SETTINGS_STORAGE_KEY)!).v === 2, '存檔帶版本 2');
  assert(loadSavedWineBridgeSettings(storage).settings.config?.preferred === 'skill', '使用者在 v2 選的技能優先保留');
  assert(!('inputDelivery' in JSON.parse(mem.get(WINE_SETTINGS_STORAGE_KEY)!).config), '點擊送法不存本機');
}

suite('210 停機報告含 stalled 提示與輸入自我測試');
{
  const r = buildDiagnosticReport(snap());
  assert(r.includes('提示：點擊後角色沒有移動') && r.includes('no_movement_after_click'), '診斷報告帶 stalled 提示');
  assert(r.includes('== 輸入自我測試 ==') && r.includes('還沒測過'), '沒測過時說明');
  const r2 = buildDiagnosticReport(snap({
    inputSelfTest: { state: 'done', report: { verdict: 'moved', workingVariant: 'activate', attempts: [], text: '輸入自我測試報告\n結果：角色有移動。' } },
    config: { ...DEFAULT_WINE_CONFIG, inputDelivery: 'activate,hover' },
  }));
  assert(r2.includes('結果：角色有移動。') && r2.includes('inputDelivery：activate,hover'), '報告含自我測試全文與目前送法');
  const html = renderToStaticMarkup(<WineDiagnosticsBar snap={snap()} />);
  assert(html.includes('wine-stop-hint') && html.includes('輸入自我測試'), '停機橫幅顯示提示');
}

suite('210 自我測試按鈕狀態');
{
  assert(selfTestBlockedReason(false, false, false) !== null, '未連線不能測');
  assert(selfTestBlockedReason(true, true, false)?.includes('停止') === true, '練功中不能測');
  assert(selfTestBlockedReason(true, false, true) !== null, '測試中不能再按');
  assert(selfTestBlockedReason(true, false, false) === null, '可以測');
  const client = new WineBridgeClient({ fetchFn: (async () => new Response('{}')) as typeof fetch });
  const html = renderToStaticMarkup(<WineInputSelfTest client={client} snap={snap()} connected running={false} />);
  assert(html.includes('wine-input-selftest') && !/wine-input-selftest"[^>]*disabled/.test(html), '按鈕可按');
  const htmlRun = renderToStaticMarkup(<WineInputSelfTest client={client} snap={snap({ running: true })} connected running />);
  assert(htmlRun.includes('disabled'), '練功中按鈕停用');
  const done1 = snap({ inputSelfTest: { state: 'done', report: { verdict: 'moved', workingVariant: 'plain', attempts: [], text: 'T' } } });
  assert(selfTestSummary(done1)?.includes('不是送法問題') === true, 'plain 有效的結論');
  const done2 = snap({ inputSelfTest: { state: 'done', report: { verdict: 'no_variant_moved', attempts: [], text: 'T' } } });
  assert(selfTestSummary(done2)?.includes('複製報告') === true, '全失敗的結論');
  assert(selfTestSummary(snap()) === null, '沒報告沒結論');
}

suite('210 客戶端打 /input_selftest，不送 inputDelivery');
{
  const calls: Array<{ url: string; body: string | undefined }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body as string | undefined });
    if (String(url).endsWith('/input_selftest')) return new Response(JSON.stringify({ ok: true, state: 'running', current: null, report: null }));
    return new Response(JSON.stringify({ ok: true, ...snap().status }));
  }) as typeof fetch;
  const c = new WineBridgeClient({ fetchFn });
  (c as unknown as { snapshot: { baseUrl: string } }).snapshot.baseUrl = 'http://127.0.0.1:4182';
  const st = await c.inputSelfTestStart();
  assert(st.state === 'running' && calls[0].url === 'http://127.0.0.1:4182/input_selftest', 'POST /input_selftest');
  await c.updateConfig({ ...DEFAULT_WINE_CONFIG, inputDelivery: 'activate' });
  assert(!calls[1].body!.includes('inputDelivery'), '設定更新不帶 inputDelivery');
  assert(parseInputSelfTest({ state: 'bogus' }) === null, '壞資料回 null');
}

done();
