import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { flushSync } from 'react-dom';
import { WineBridgeClient, type WineBridgeStatus } from '../src/wine/wineBridgeClient';
import { WinePathPanel } from '../src/panels/WinePathPanel';
import {
  buildWalkToBody,
  clickToWorld,
  formatNavProgress,
  navStopPresentation,
  parseNavStatus,
  pathMapFromSnapshot,
  type WineNavStatus,
  type WinePathMap,
} from '../src/wine/pathfinding';
import type { SceneSnapshot } from '../src/protocol/index';
import { assert, done, suite } from './helpers';

class FakeSocket {
  readyState = 1;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(_url: string) {}
  send(_data: string) {}
  close() { this.readyState = 3; }
}

const win = new Window({ url: 'http://localhost:5173/family/' });
Object.assign(globalThis, {
  window: win,
  document: win.document,
  HTMLElement: win.HTMLElement,
  HTMLButtonElement: win.HTMLButtonElement,
  Node: win.Node,
  Event: win.Event,
  MouseEvent: win.MouseEvent,
});

function nav(patch: Partial<WineNavStatus> = {}): WineNavStatus {
  return {
    running: false,
    state: 'idle',
    mapId: null,
    currentPos: null,
    targetPos: null,
    waypoints: [],
    segmentIndex: 0,
    totalSegments: 0,
    replans: 0,
    clicksSent: 0,
    elapsedS: 0,
    stopReason: null,
    coordSource: null,
    ...patch,
  };
}

function bridgeStatus(extra: Partial<WineBridgeStatus> = {}): WineBridgeStatus {
  return {
    ok: true,
    connected: true,
    running: false,
    phase: 'idle',
    scene: 'map',
    hpPct: null,
    mpPct: null,
    roundTrips: 0,
    encounters: 0,
    turns: 0,
    ticks: 0,
    actionsSent: 0,
    lastAction: null,
    stopReason: null,
    config: {
      patrolA: [1, 1], patrolB: [2, 2], hotkey: 'F7', preferred: 'attack',
      healAtPct: 30, stopHpPct: 10, stopMpPct: 0, maxMinutes: null, maxRoundTrips: null,
      windowTitle: '', wid: null,
    },
    recentEvents: [],
    nav: nav(),
    ...extra,
  };
}

suite('F15 指令組裝與座標換算');
{
  const body = buildWalkToBody({ mapId: ' map-a ', targetX: 12.5, targetY: 0 });
  assert(body.mapId === 'map-a' && body.targetX === 12.5 && body.targetY === 0, '保留呼叫端座標，只去掉地圖代號空白');
  let missing = false;
  try { buildWalkToBody({ mapId: '  ', targetX: 1, targetY: 1 }); } catch { missing = true; }
  assert(missing, '沒有地圖代號就拒絕');
  let bad = false;
  try { buildWalkToBody({ mapId: 'map-a', targetX: Number.NaN, targetY: 1 }); } catch { bad = true; }
  assert(bad, '非有限座標就拒絕');

  const world = clickToWorld({ clickX: 10, clickY: 20, viewW: 100, viewH: 50, pixelWidth: 200, pixelHeight: 100 });
  assert(world?.x === 20 && world.y === 40, '點擊依畫面與地圖寬高換算');
  assert(clickToWorld({ clickX: 10, clickY: 10, viewW: 100, viewH: 50, pixelWidth: 0, pixelHeight: 100 }) === null, '沒有地圖寬度就不換算');
  assert(clickToWorld({ clickX: 120, clickY: 10, viewW: 100, viewH: 50, pixelWidth: 200, pixelHeight: 100 }) === null, '點在畫面外就不換算');

  const bare = { mapId: 'map-a', mapName: '測試圖', character: { x: 3, y: 4 }, nav: { pixelWidth: null, pixelHeight: null } } as unknown as SceneSnapshot;
  assert(pathMapFromSnapshot(bare) === null, '宿主沒給寬高就不畫地圖');
  const sized = {
    ...bare,
    nav: { pixelWidth: 200, pixelHeight: 100, terrain: undefined },
  } as unknown as SceneSnapshot;
  const parsed = pathMapFromSnapshot(sized);
  assert(parsed?.mapId === 'map-a' && parsed.pixelWidth === 200 && parsed.characterX === 3 && parsed.terrain === null, '地圖尺寸與角色位置沿用快照');
}

suite('F15 停下原因');
{
  const unsourced = navStopPresentation('coord_box_unsourced');
  assert(unsourced.text === '座標框尚無出處' && unsourced.tone === 'notice', '座標框缺出處顯示成提示，不是錯誤');
  assert(navStopPresentation('arrived').tone === 'notice', '到達是提示');
  assert(navStopPresentation('capture_error').tone === 'error', '擷取失敗才是錯誤');
  assert(navStopPresentation('brand_new_reason').tone === 'notice', '不認得的原因不當成錯誤');
  assert(formatNavProgress(null) === '尚未開始', '沒有尋路狀態時顯示尚未開始');
  const moving = formatNavProgress(nav({
    running: true,
    state: 'walking',
    segmentIndex: 0,
    totalSegments: 4,
    currentPos: [8, 9],
    targetPos: [30, 40],
  }));
  assert(moving.includes('移動中') && moving.includes('第 1/4 段') && moving.includes('(8, 9)') && moving.includes('(30, 40)'), '進度含狀態、段數與橋接座標');
  const parsed = parseNavStatus({ ok: true, running: true, state: 'walking', mapId: 'map-a', stopReason: null, waypoints: [[1, 2], ['no']] });
  assert(parsed?.running === true && parsed.waypoints.length === 1 && parsed.waypoints[0]?.[0] === 1, '尋路回報只留下有限座標的路點');
}

suite('F15 送出與停止');
{
  const calls: Array<{ method: string; url: string; body: Record<string, unknown> | null }> = [];
  let posted: WineNavStatus = nav({ running: true, state: 'walking', mapId: 'map-a', targetPos: [20, 40] });
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ method: init?.method ?? 'GET', url, body });
    if (url.endsWith('/walk_to')) posted = nav({ ...posted, ...(body ? {} : {}), running: true, state: 'walking', mapId: 'map-a', targetPos: [body?.targetX as number, body?.targetY as number] });
    if (url.endsWith('/walk_stop')) posted = nav({ ...posted, running: false, state: 'stopped', stopReason: 'user_stopped' });
    const payload = url.endsWith('/status') ? bridgeStatus() : { ok: true, ...posted };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const client = new WineBridgeClient({ fetchFn, webSocketCtor: FakeSocket });
  const connected = await client.connect('http://127.0.0.1:4182');
  assert(connected, '連上本機橋接');
  const started = await client.walkTo(buildWalkToBody({ mapId: 'map-a', targetX: 20, targetY: 40 }));
  assert(started.state === 'walking' && started.targetPos?.[0] === 20 && started.targetPos?.[1] === 40, 'walk_to 回報目標');
  const walkCall = calls.find(call => call.url.endsWith('/walk_to'));
  assert(walkCall?.method === 'POST' && walkCall.body?.mapId === 'map-a' && walkCall.body?.targetX === 20, 'POST /walk_to 帶上組好的指令');
  assert(client.getSnapshot().status?.nav?.state === 'walking', '狀態併進目前橋接快照，不覆蓋練功欄位');
  assert(client.getSnapshot().status?.phase === 'idle', '尋路回報沒有清掉原本的練功狀態');
  const stopped = await client.walkStop();
  assert(stopped.stopReason === 'user_stopped' && stopped.running === false, 'walk_stop 帶回停下');
  const stopCall = calls.find(call => call.url.endsWith('/walk_stop'));
  assert(stopCall?.body?.reason === 'user_stopped', '停止請求帶 user_stopped');

  const map: WinePathMap = {
    mapId: 'map-a',
    mapName: '測試圖',
    pixelWidth: 200,
    pixelHeight: 100,
    characterX: 10,
    characterY: 20,
    terrain: null,
  };
  const host = win.document.createElement('div');
  win.document.body.appendChild(host);
  const mounts: Array<{ unmount(): void }> = [];
  const show = (next: WineBridgeClient) => {
    mounts.at(-1)?.unmount();
    const view = createRoot(host as unknown as HTMLElement);
    mounts.push(view);
    flushSync(() => {
      view.render(<WinePathPanel client={next} active map={map} />);
    });
  };

  const idle = new WineBridgeClient({
    webSocketCtor: FakeSocket,
    fetchFn: async () => new Response(JSON.stringify(bridgeStatus({ nav: nav() })), { status: 200 }),
  });
  await idle.connect('http://127.0.0.1:4182');
  show(idle);
  assert(host.querySelector('[data-testid="wine-nav-notice"]') === null, '尚未尋路時不顯示座標框提示');

  const withUnsourced = new WineBridgeClient({
    webSocketCtor: FakeSocket,
    fetchFn: async (input) => {
      const url = String(input);
      const payload = url.endsWith('/status')
        ? bridgeStatus({ nav: nav({ mapId: 'map-a', state: 'stopped', stopReason: 'coord_box_unsourced' }) })
        : { ok: true };
      return new Response(JSON.stringify(payload), { status: 200 });
    },
  });
  await withUnsourced.connect('http://127.0.0.1:4182');
  show(withUnsourced);
  const shown = host.querySelector('[data-testid="wine-nav-notice"]');
  const err = host.querySelector('[data-testid="wine-nav-error"], [data-testid="wine-nav-stop-error"]');
  assert(shown?.textContent === '座標框尚無出處', '面板把缺出處顯示成提示');
  assert(err === null, '缺出處不進錯誤欄');

  const clickCalls: string[] = [];
  const clicking = new WineBridgeClient({
    webSocketCtor: FakeSocket,
    fetchFn: async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
      if (url.endsWith('/walk_to')) clickCalls.push(`${body?.targetX},${body?.targetY}`);
      if (url.endsWith('/walk_stop')) clickCalls.push('stop');
      const payload = url.endsWith('/walk_to')
        ? { ok: true, ...nav({ running: true, state: 'walking', mapId: 'map-a', targetPos: [Number(body?.targetX), Number(body?.targetY)] }) }
        : url.endsWith('/walk_stop')
          ? { ok: true, ...nav({ running: false, state: 'stopped', stopReason: 'user_stopped', mapId: 'map-a' }) }
          : bridgeStatus({ nav: nav({ running: true, state: 'walking', mapId: 'map-a' }) });
      return new Response(JSON.stringify(payload), { status: 200 });
    },
  });
  await clicking.connect('http://127.0.0.1:4182');
  show(clicking);
  const mapBtn = host.querySelector('[data-testid="wine-nav-map"]') as unknown as HTMLButtonElement;
  mapBtn.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 50, width: 100, height: 50, toJSON() { return {}; },
  });
  await act(async () => {
    mapBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true, clientX: 10, clientY: 20 }) as unknown as Event);
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert(clickCalls[0] === '20,40', '點地圖送出換算後的目的地');
  const stopBtn = host.querySelector('[data-testid="wine-nav-stop"]') as unknown as HTMLButtonElement;
  assert(!stopBtn.disabled, '移動中可以停止');
  await act(async () => {
    stopBtn.click();
  });
  assert(clickCalls.includes('stop'), '停止鈕送出 walk_stop');
  mounts.at(-1)?.unmount();
}

done();
