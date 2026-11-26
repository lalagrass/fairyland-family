import React from 'react';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { WineBridgeClient, type BridgeWebSocketLike, type WineBridgeSnapshot, type WineBridgeStatus } from '../src/wine/wineBridgeClient';
import { wineRosterCard } from '../src/wine/wineRosterCard';
import { assert, done, suite } from './helpers';

// 全部使用虛構測試資料。
const win = new Window({ url: 'http://localhost:5173/family/' });
Object.assign(globalThis, {
  window: win, document: win.document, HTMLElement: win.HTMLElement, Element: win.Element, Node: win.Node,
  Event: win.Event, MouseEvent: win.MouseEvent, localStorage: win.localStorage,
  requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { WineRosterCard, shouldProbeBridge } = await import('../src/panels/WineRosterCard');

function status(patch: Partial<WineBridgeStatus> = {}): WineBridgeStatus {
  return {
    ok: true, connected: true, running: false, phase: 'idle', scene: 'map', hpPct: 90, mpPct: 80,
    roundTrips: 0, encounters: 0, turns: 0, ticks: 0, actionsSent: 0, lastAction: null, stopReason: null,
    config: {} as WineBridgeStatus['config'], recentEvents: [], ...patch,
  };
}
function snap(patch: Partial<WineBridgeSnapshot> = {}): WineBridgeSnapshot {
  return { connState: 'CONNECTED', baseUrl: 'http://127.0.0.1:4999', status: status(), windows: [], events: [], error: null, lastUpdatedAt: 1, ...patch };
}
const NOW = 1_000_000_000;

suite('F19 卡片資料轉換：未連線不是錯誤');
{
  const off = wineRosterCard(snap({ connState: 'DISCONNECTED', status: null, error: '無法連線本機橋接（x）', lastUpdatedAt: null }), NOW);
  assert(off.state === 'offline' && off.stateLabel === '未連線', '斷線顯示「未連線」');
  assert(off.map === null && off.expChange === null && off.job === '—', '斷線時欄位留空');
  assert(!JSON.stringify(off).includes('無法連線'), '錯誤文字不進卡片');
  assert(wineRosterCard(snap({ connState: 'CONNECTING', status: null }), NOW).state === 'connecting', '連線中');
  assert(wineRosterCard(snap({ status: null }), NOW).state === 'offline', '已連線但沒有 status 視為未連線');
}

suite('F19 卡片資料轉換：閒置／練功／停機');
{
  const idle = wineRosterCard(snap(), NOW);
  assert(idle.state === 'idle' && idle.stateLabel === '閒置' && idle.job === '無', '閒置');
  assert(idle.expChange === null && idle.map === null, '橋接沒回的經驗與地圖不補值');
  assert(idle.scene === '地圖探索' && idle.hpPct === 90, '場景與 HP');

  const train = wineRosterCard(snap({ status: status({
    running: true, phase: 'running', expGained: 120,
    recentEvents: [{ tsMs: NOW - 3_600_000, type: 'started' }],
    nav: { running: false, state: 'idle', mapId: 'demo_map', currentPos: null, targetPos: null, waypoints: [], segmentIndex: 0, totalSegments: 0, replans: 0, clicksSent: 0, elapsedS: 0, stopReason: null, coordSource: null },
  }) }), NOW);
  assert(train.state === 'training' && train.stateLabel === '練功中' && train.job === '背景練功', '練功中');
  assert(train.expChange === '+120' && train.expPerHour === '120', '經驗變化與每小時經驗');
  assert(train.map === 'demo_map', '地圖來自 nav.mapId');

  const gather = wineRosterCard(snap({ status: status({
    running: true, gather: { running: true, state: 'walking', completedCount: 1, bagUsed: 1, bagCap: 10, lastDurationMs: null, stopReason: null },
  }) }), NOW);
  assert(gather.job === '採集（移動中）', '採集優先於背景練功');

  const stopped = wineRosterCard(snap({ status: status({ stopReason: 'hp_low', expGained: 0 }) }), NOW);
  assert(stopped.state === 'stopped' && stopped.reason === 'HP 低於停機門檻', '停機帶中文原因');
  assert(stopped.expChange === '+0', '經驗 0 照實顯示');
}

suite('F19 自動探測規則');
{
  const dis = (o: Partial<WineBridgeSnapshot>) => snap({ connState: 'DISCONNECTED', status: null, ...o });
  assert(!shouldProbeBridge(dis({ lastUpdatedAt: null }), false), '沒存過設定不主動連線');
  assert(shouldProbeBridge(dis({ lastUpdatedAt: null }), true), '存過設定才探測');
  assert(!shouldProbeBridge(dis({ lastUpdatedAt: 5, error: null }), true), '手動中斷不自動連回');
  assert(shouldProbeBridge(dis({ lastUpdatedAt: 5, error: '橋接連線中斷' }), false), '意外斷線會重連');
  assert(!shouldProbeBridge(snap(), true), '已連線不探測');
}

suite('F19 UI：未連線與已連線、點擊開面板');
{
  const calls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    calls.push(u.pathname);
    if (u.pathname === '/frame') return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), { status: 200 });
    return new Response(JSON.stringify(status({ running: true, expGained: 5 })), { status: 200 });
  }) as typeof fetch;
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => 'blob:test';
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
  class MockWs implements BridgeWebSocketLike {
    readyState = 1;
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    constructor(public url: string) { setTimeout(() => this.onopen?.({}), 0); }
    send() {}
    close() { this.readyState = 3; }
  }
  const client = new WineBridgeClient({ fetchFn, webSocketCtor: MockWs });
  const root = win.document.createElement('div');
  win.document.body.appendChild(root);
  let opened = 0;
  const r = createRoot(root as unknown as HTMLElement);
  await act(async () => { r.render(<WineRosterCard client={client} onOpen={() => { opened++; }} />); });
  const q = (id: string) => root.querySelector(`[data-testid="${id}"]`) as unknown as HTMLElement | null;
  assert(q('wine-roster-state')?.textContent === '未連線', '初始顯示「未連線」');
  assert(q('wine-roster-offline') !== null && q('wine-roster-map') === null, '未連線不顯示欄位也不顯示錯誤');
  assert(calls.length === 0, '沒存過設定時掛載不發任何請求');

  await act(async () => { await client.connect('http://127.0.0.1:4999'); });
  await act(async () => { await new Promise(res => setTimeout(res, 20)); });
  assert(q('wine-roster-state')?.textContent === '練功中', '連線後顯示練功中');
  assert(q('wine-roster-exp')?.textContent?.includes('+5') === true, '顯示經驗變化');
  await act(async () => { await new Promise(res => setTimeout(res, 2200)); });
  assert(root.querySelector('[data-testid="wine-roster-thumb"] img') !== null, '顯示 /frame 縮圖');
  assert(calls.every(p => p === '/status' || p === '/frame'), '只讀 /status 與 /frame');

  await act(async () => { (q('wine-roster-card') as unknown as HTMLButtonElement).click(); });
  assert(opened === 1, '點卡片觸發開啟視窗練功面板');
  await act(async () => { r.unmount(); });
}

done();
