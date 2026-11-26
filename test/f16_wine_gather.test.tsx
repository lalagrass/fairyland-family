import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { WineBridgeClient, type WineBridgeStatus } from '../src/wine/wineBridgeClient';
import { WineGatherPanel, loadGatherConfig, sanitizeGatherConfig } from '../src/panels/WineGatherPanel';
import {
  DEFAULT_GATHER_CONFIG,
  GatherLoopRunner,
  bagFullActionFromPolicy,
  bagPct,
  formatGatherStopReason,
  parseGatherStatus,
  startGather,
  stepGather,
  type GatherLoopConfig,
  type GatherPorts,
  type WineGatherStatus,
  type WorkObservation,
  type WorkPoint,
} from '../src/wine/gatherLoop';
import type { WineNavStatus } from '../src/wine/pathfinding';
import { assert, done, suite } from './helpers';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const win = new Window({ url: 'http://localhost:5173/family/' });
Object.assign(globalThis, {
  window: win, document: win.document, HTMLElement: win.HTMLElement,
  HTMLButtonElement: win.HTMLButtonElement, Node: win.Node, Event: win.Event, MouseEvent: win.MouseEvent,
});

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

// 全部是虛構的測試地圖與座標。
const SPOT: WorkPoint = { mapId: 'test-field', x: 10, y: 20 };
const HOME: WorkPoint = { mapId: 'test-town', x: 3, y: 4 };
const CFG: GatherLoopConfig = { ...DEFAULT_GATHER_CONFIG, spot: SPOT, home: HOME, maxMinutes: null };

function nav(patch: Partial<WineNavStatus> = {}): WineNavStatus {
  return {
    running: false, state: 'idle', mapId: null, currentPos: null, targetPos: null, waypoints: [],
    segmentIndex: 0, totalSegments: 0, replans: 0, clicksSent: 0, elapsedS: 0, stopReason: null, coordSource: null,
    ...patch,
  };
}
function gather(patch: Partial<WineGatherStatus> = {}): WineGatherStatus {
  return { running: false, state: 'idle', completedCount: 0, bagUsed: 2, bagCap: 10, lastDurationMs: null, stopReason: null, ...patch };
}
function obs(patch: Partial<WorkObservation> = {}): WorkObservation {
  return { nowMs: 1000, connected: true, scene: 'map', nav: nav(), gather: gather(), trainingRunning: false, ...patch };
}
const arrivedAt = (p: WorkPoint) => nav({ state: 'arrived', stopReason: 'arrived', mapId: p.mapId, targetPos: [p.x, p.y] });

suite('F16 開始條件');
{
  assert(startGather({ ...CFG, spot: null }, obs()).state.stopReason === 'no_spot', '沒設採集點不能開始');
  assert(startGather({ ...CFG, home: null }, obs()).state.stopReason === 'no_home', '要回村卻沒設回村點不能開始');
  assert(startGather({ ...CFG, home: null, onBagFull: 'stop' }, obs()).state.phase === 'to_spot', '背包滿就停的話不需要回村點');
  assert(startGather(CFG, obs({ trainingRunning: true })).state.stopReason === 'busy', '練功在跑就拒絕（互斥）');
  assert(startGather(CFG, obs({ nav: nav({ running: true }) })).state.stopReason === 'busy', '尋路在跑就拒絕（互斥）');
  assert(startGather(CFG, obs({ gather: gather({ running: true }) })).state.stopReason === 'busy', '橋接已有採集在跑就拒絕');
  assert(startGather(CFG, obs({ connected: false })).state.stopReason === 'disconnected', '沒連線就拒絕');
  assert(bagFullActionFromPolicy('SELL') === 'return_home' && bagFullActionFromPolicy('STOP') === 'stop' && bagFullActionFromPolicy('NOTIFY') === 'stop', 'F10 背包滿策略對應');
}

suite('F16 狀態機一輪：走到採集點→採集→滿→回村→卸貨→再回去');
{
  let r = startGather(CFG, obs());
  let s = r.state;
  r = stepGather(s, obs({ nowMs: 1100 }), CFG); s = r.state;
  assert(r.effects.length === 1 && r.effects[0]!.kind === 'walk_to', '先送 walk_to 到採集點');
  r = stepGather(s, obs({ nowMs: 1200, nav: nav({ running: true, state: 'walking', targetPos: [10, 20] }) }), CFG); s = r.state;
  assert(s.phase === 'to_spot' && r.effects.length === 0, '走路中不重送');
  r = stepGather(s, obs({ nowMs: 1300, nav: nav({ state: 'arrived', stopReason: 'arrived', targetPos: [99, 99] }) }), CFG); s = r.state;
  assert(s.phase === 'to_spot', '上一趟留下、目標不同的 arrived 不算');
  r = stepGather(s, obs({ nowMs: 1400, nav: arrivedAt(SPOT) }), CFG); s = r.state;
  assert(s.phase === 'working', '到達採集點進入採集');
  r = stepGather(s, obs({ nowMs: 1500 }), CFG); s = r.state;
  assert(r.effects[0]?.kind === 'gather_start', '送出開始工作');
  r = stepGather(s, obs({ nowMs: 1600, gather: gather({ running: true, state: 'working' }) }), CFG); s = r.state;
  assert(s.sawWorking && s.gathers === 0, '工作中');
  r = stepGather(s, obs({ nowMs: 2000, gather: gather({ state: 'done', completedCount: 1, bagUsed: 5, lastDurationMs: 400 }) }), CFG); s = r.state;
  assert(s.gathers === 1 && s.phase === 'working' && s.commandIssued === false && s.lastDurationMs === 400, '完成一次、背包未滿就繼續採');
  r = stepGather(s, obs({ nowMs: 2100, gather: gather({ completedCount: 1, bagUsed: 5 }) }), CFG); s = r.state;
  assert(r.effects[0]?.kind === 'gather_start', '再送一次開始工作');
  r = stepGather(s, obs({ nowMs: 2200, gather: gather({ running: true, state: 'working', completedCount: 1, bagUsed: 5 }) }), CFG); s = r.state;
  r = stepGather(s, obs({ nowMs: 2600, gather: gather({ state: 'done', completedCount: 2, bagUsed: 10 }) }), CFG); s = r.state;
  assert(s.phase === 'to_home' && s.gathers === 2, '背包滿了回村');
  r = stepGather(s, obs({ nowMs: 2700, gather: gather({ completedCount: 2, bagUsed: 10 }) }), CFG); s = r.state;
  assert(r.effects[0]?.kind === 'walk_to' && (r.effects[0] as { target: WorkPoint }).target.mapId === 'test-town', '走回村點');
  r = stepGather(s, obs({ nowMs: 2800, nav: arrivedAt(HOME), gather: gather({ bagUsed: 10 }) }), CFG); s = r.state;
  assert(s.phase === 'unloading', '到村進入卸貨');
  r = stepGather(s, obs({ nowMs: 2900, gather: gather({ bagUsed: 10 }) }), CFG); s = r.state;
  assert(r.effects[0]?.kind === 'unload' && s.phase === 'unloading', '送出卸貨');
  r = stepGather(s, obs({ nowMs: 3000, gather: gather({ bagUsed: 2 }) }), CFG); s = r.state;
  assert(s.phase === 'to_spot' && s.unloads === 1, '背包降下來就回採集點');
}

suite('F16 停止條件');
{
  const working = (patch: Partial<ReturnType<typeof startGather>['state']> = {}) =>
    ({ ...startGather(CFG, obs()).state, phase: 'working' as const, commandIssued: true, phaseSinceMs: 1000, ...patch });
  assert(stepGather(working(), obs({ scene: 'battle' }), CFG).state.stopReason === 'entered_battle', '遇敵停下');
  const r = stepGather(working(), obs({ scene: 'battle' }), CFG);
  assert(r.effects[0]?.kind === 'gather_stop', '停下時收尾送 gather_stop');
  let s = working();
  for (let i = 0; i < 3; i += 1) s = stepGather(s, obs({ nowMs: 1100 + i, scene: 'dialog' }), CFG).state;
  assert(s.stopReason === 'unexpected_popup', '連續讀到非地圖畫面視為異常彈窗');
  let blip = working();
  blip = stepGather(blip, obs({ scene: 'dialog' }), CFG).state;
  blip = stepGather(blip, obs({ scene: 'map' }), CFG).state;
  assert(blip.phase === 'working' && blip.popupStreak === 0, '偶發一次不算彈窗');
  assert(stepGather(working(), obs({ nowMs: 1000 + 125_000 }), CFG).state.stopReason === 'work_timeout', '採集等太久停下');
  assert(stepGather(working(), obs({ nowMs: 1000 + 61_000 }), { ...CFG, maxMinutes: 1 }).state.stopReason === 'timeout', '超過最長分鐘停下');
  assert(stepGather(working(), obs({ trainingRunning: true }), CFG).state.stopReason === 'busy', '執行中練功啟動就讓出視窗');
  assert(stepGather(working(), obs({ connected: false }), CFG).state.stopReason === 'disconnected', '斷線停下');
  assert(stepGather(working(), obs(), CFG, 'user_stopped').state.stopReason === 'user_stopped', '手動停止');
  const full = stepGather(working({ sawWorking: true, workBaseline: 0 }), obs({ gather: gather({ state: 'done', completedCount: 1, bagUsed: 10 }) }), { ...CFG, onBagFull: 'stop' });
  assert(full.state.stopReason === 'bag_full', '設定為停下時背包滿就停');
  const unread = stepGather(working({ sawWorking: true, workBaseline: 0 }), obs({ gather: gather({ state: 'done', completedCount: 1, bagUsed: null }) }), CFG);
  assert(unread.state.stopReason === 'bag_unreadable', '讀不到背包不猜，直接停');
  const maxed = stepGather(working({ sawWorking: true, workBaseline: 0 }), obs({ gather: gather({ state: 'done', completedCount: 1 }) }), { ...CFG, maxCycles: 1 });
  assert(maxed.state.stopReason === 'max_cycles', '達到循環次數停下');
  const bridgeStop = stepGather(working({ commandIssued: true }), obs({ gather: gather({ state: 'stopped', stopReason: 'popup_x' }) }), CFG);
  assert(bridgeStop.state.stopReason === 'popup_x', '橋接自己停下就沿用它的原因');
  const toHome = { ...startGather(CFG, obs()).state, phase: 'to_home' as const, commandIssued: true, phaseSinceMs: 1000 };
  const blocked = stepGather(toHome, obs({ nav: nav({ state: 'stopped', stopReason: 'path_blocked', targetPos: [3, 4] }) }), CFG);
  assert(blocked.state.stopReason === 'path_blocked', '尋路失敗沿用尋路的停下原因');
  assert(stepGather(toHome, obs({ nowMs: 1000 + 200_000 }), CFG).state.stopReason === 'timeout', '走太久停下');
  const unloading = { ...startGather(CFG, obs()).state, phase: 'unloading' as const, commandIssued: true, phaseSinceMs: 1000 };
  assert(stepGather(unloading, obs({ nowMs: 1000 + 130_000, gather: gather({ bagUsed: 10 }) }), CFG).state.stopReason === 'bag_still_full', '卸貨後背包還是滿的就停');
  assert(formatGatherStopReason('bag_full') === '背包已滿' && formatGatherStopReason('x_new') === 'x_new', '停止原因文字，未知原因原樣顯示');
}

suite('F16 橋接狀態解析');
{
  assert(parseGatherStatus(null) === null && parseGatherStatus({}) === null, '空資料回 null');
  const g = parseGatherStatus({ running: true, state: 'working', bagUsed: 3, bagCap: 12, completedCount: 'x' });
  assert(g?.running === true && g.bagUsed === 3 && g.completedCount === null, '非數字欄位不補 0');
  assert(bagPct(g) === 25 && bagPct(gather({ bagCap: 0 })) === null && bagPct(null) === null, '背包百分比，缺值為 null');
}

suite('F16 驅動器：模擬橋接跑完整循環');
{
  // 模擬橋接：每次呼叫指令後，下一次觀察給出對應結果。
  const calls: string[] = [];
  let navState = nav();
  let g = gather({ bagUsed: 0, bagCap: 4 });
  let scene = 'map';
  const ports: GatherPorts = {
    observe: () => ({ nowMs: clock, connected: true, scene, nav: navState, gather: g, trainingRunning: false }),
    walkTo: async t => { calls.push(`walk:${t.mapId}`); navState = arrivedAt(t); },
    walkStop: async () => { calls.push('walk_stop'); },
    gatherStart: async () => { calls.push('gather'); g = { ...g, running: true, state: 'working' }; },
    gatherStop: async () => { calls.push('gather_stop'); },
    unload: async () => { calls.push('unload'); g = { ...g, bagUsed: 0 }; },
  };
  let clock = 0;
  const runner = new GatherLoopRunner(ports, { ...CFG, maxCycles: 5 });
  runner.start();
  const finishWork = () => { g = { ...g, running: false, state: 'done', completedCount: (g.completedCount ?? 0) + 1, bagUsed: (g.bagUsed ?? 0) + 2 }; };
  let guard = 0;
  while (runner.active && guard++ < 60) {
    clock += 1000;
    await runner.tick();
    if (g.running) { clock += 500; await runner.tick(); finishWork(); }
  }
  const final = runner.getSnapshot().state;
  assert(final.stopReason === 'max_cycles', '跑到循環上限才停');
  assert(calls[0] === 'walk:test-field' && calls.includes('walk:test-town') && calls.includes('unload'), '走採集點、回村、卸貨都有送');
  assert(calls.filter(c => c === 'gather').length >= 4, '背包滿前連續採集');
  assert(final.unloads >= 1 && final.gathers >= 4, '計數正確');

  // 互斥：橋接回 409。
  const busy = new GatherLoopRunner({ ...ports, walkTo: async () => { throw new Error('already_running'); } }, CFG);
  busy.start();
  await busy.tick();
  assert(busy.getSnapshot().state.stopReason === 'busy', '橋接 409 對應成 busy');
  const nosup = new GatherLoopRunner({ ...ports, gatherStart: async () => { throw new Error('not found'); } }, CFG);
  nosup.start();
  navState = nav();
  await nosup.tick();
  navState = arrivedAt(SPOT);
  await nosup.tick();
  await nosup.tick();
  assert(nosup.getSnapshot().state.stopReason === 'bridge_unsupported', '橋接沒有採集指令就明確停下');
  const stopper = new GatherLoopRunner(ports, CFG);
  stopper.start();
  stopper.requestStop();
  await stopper.tick();
  assert(stopper.getSnapshot().state.stopReason === 'user_stopped' && !stopper.active, '手動停止後不再 tick');
}

suite('F16 設定與用戶端');
{
  const cfg = sanitizeGatherConfig({ spot: { mapId: ' a ', x: 1, y: 2 }, home: { mapId: '', x: 1, y: 1 }, bagFullPct: 500, maxCycles: 0, onBagFull: 'bogus' });
  assert(cfg.spot?.mapId === 'a' && cfg.home === null && cfg.bagFullPct === 100 && cfg.maxCycles === null && cfg.onBagFull === 'return_home', '設定清洗：夾住範圍、丟掉無效點');
  assert(loadGatherConfig({ getItem: () => { throw new Error('blocked'); } }).spot === null, '儲存不可用時回預設');

  const posts: Array<{ url: string; body: unknown }> = [];
  const status: WineBridgeStatus = {
    ok: true, connected: true, running: false, phase: 'idle', scene: 'map', hpPct: null, mpPct: null, roundTrips: 0, encounters: 0,
    turns: 0, ticks: 0, actionsSent: 0, lastAction: null, stopReason: null,
    config: { patrolA: [1, 1], patrolB: [2, 2], hotkey: 'F7', preferred: 'attack', healAtPct: 30, stopHpPct: 10, stopMpPct: 0, maxMinutes: null, maxRoundTrips: null, windowTitle: '', wid: null },
    recentEvents: [], gather: { running: false, state: 'idle', bagUsed: 1, bagCap: 5 } as unknown as WineGatherStatus,
  };
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      if (url.endsWith('/gather_start')) return new Response(JSON.stringify({ ok: true, running: true, state: 'working' }), { status: 200 });
      return new Response(JSON.stringify({ ok: false, error: 'not found' }), { status: 404 });
    }
    return new Response(JSON.stringify(status), { status: 200 });
  };
  const client = new WineBridgeClient({ fetchFn, webSocketCtor: FakeSocket });
  await client.connect('http://127.0.0.1:4182');
  assert(client.getSnapshot().status?.gather?.bagCap === 5, '/status 的 gather 欄位被解析');
  const g = await client.gatherStart(SPOT);
  assert(g.running && posts[0]?.url.endsWith('/gather_start'), '送出 gather_start');
  let msg = '';
  try { await client.gatherStop(); } catch (e) { msg = (e as Error).message; }
  assert(msg === 'not found' && client.getSnapshot().error === null, '橋接沒有指令時丟 not found，不污染連線錯誤');
}

suite('F16 面板');
{
  const status: WineBridgeStatus = {
    ok: true, connected: true, running: false, phase: 'idle', scene: 'map', hpPct: null, mpPct: null, roundTrips: 0, encounters: 0,
    turns: 0, ticks: 0, actionsSent: 0, lastAction: null, stopReason: null,
    config: { patrolA: [1, 1], patrolB: [2, 2], hotkey: 'F7', preferred: 'attack', healAtPct: 30, stopHpPct: 10, stopMpPct: 0, maxMinutes: null, maxRoundTrips: null, windowTitle: '', wid: null },
    recentEvents: [],
  };
  const fetchFn: typeof fetch = async () => new Response(JSON.stringify(status), { status: 200 });
  const client = new WineBridgeClient({ fetchFn, webSocketCtor: FakeSocket });
  const runner = new GatherLoopRunner({
    observe: () => ({ nowMs: Date.now(), connected: true, scene: 'map', nav: null, gather: null, trainingRunning: false }),
    walkTo: async () => null, walkStop: async () => null, gatherStart: async () => null, gatherStop: async () => null,
  }, { ...DEFAULT_GATHER_CONFIG });
  const root = document.createElement('div');
  document.body.appendChild(root);
  const reactRoot = createRoot(root);
  await act(async () => {
    reactRoot.render(<WineGatherPanel client={client} active runner={runner} current={{ mapId: 'test-field', x: 7.4, y: 8.6 }} />);
  });
  const q = (id: string) => root.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  assert(q('wine-gather-offline') !== null, '沒連線時顯示提示');
  assert((q('wine-gather-start') as HTMLButtonElement).disabled, '沒連線不能開始');
  await act(async () => { q('wine-gather-spot-set')!.dispatchEvent(new win.MouseEvent('click', { bubbles: true }) as unknown as Event); });
  assert(q('wine-gather-spot-value')!.textContent === 'test-field (7, 9)', '用目前位置設定採集點');
  assert(runner.getSnapshot().config.spot?.x === 7.4, '設定寫進驅動器');
  await act(async () => { await client.connect('http://127.0.0.1:4182'); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  assert(q('wine-gather-offline') === null, '連線後提示消失');
  await act(async () => { reactRoot.unmount(); });
}

done();
