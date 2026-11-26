import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { WineBridgeClient, type WineBridgeStatus } from '../src/wine/wineBridgeClient';
import { WineGatherPanel, sanitizeGatherConfig } from '../src/panels/WineGatherPanel';
import {
  DEFAULT_GATHER_CONFIG,
  GatherLoopRunner,
  formatGatherStopReason,
  startGather,
  stepGather,
  supplyTrigger,
  type GatherEffect,
  type GatherLoopConfig,
  type GatherPorts,
  type WineGatherStatus,
  type WorkObservation,
  type WorkPoint,
} from '../src/wine/gatherLoop';
import {
  buildResupplyPlan,
  parseSupplyStatus,
  potionsLow,
  resupplyConfigured,
  resupplyFromStrategy,
  sanitizeResupply,
  type WineSupplyStatus,
} from '../src/wine/resupplyLoop';
import type { WineNavStatus } from '../src/wine/pathfinding';
import { assert, done, suite } from './helpers';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
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
  window: win, document: win.document, HTMLElement: win.HTMLElement,
  HTMLButtonElement: win.HTMLButtonElement, Node: win.Node, Event: win.Event, MouseEvent: win.MouseEvent,
});

// 全部是虛構的測試地圖、座標與道具編號。
const SPOT: WorkPoint = { mapId: 'test-field', x: 10, y: 20 };
const SHOP: WorkPoint = { mapId: 'test-town', x: 3, y: 4 };
const HERE: WorkPoint = { mapId: 'test-field', x: 55, y: 66 };
const RESUPPLY = { potionItemId: 9001, potionMin: 3, potionTarget: 10, sellItemIds: [9002, 9003] };
const GATHER_CFG: GatherLoopConfig = { ...DEFAULT_GATHER_CONFIG, spot: SPOT, home: SHOP, maxMinutes: null, resupply: RESUPPLY };
const HUNT_CFG: GatherLoopConfig = { ...DEFAULT_GATHER_CONFIG, activity: 'hunt', home: SHOP, maxMinutes: null, resupply: RESUPPLY };

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
function supply(patch: Partial<WineSupplyStatus> = {}): WineSupplyStatus {
  return { running: false, state: 'idle', completedCount: 0, potionCount: 8, gold: 500, bagUsed: 2, bagCap: 10, stopReason: null, ...patch };
}
function obs(patch: Partial<WorkObservation> = {}): WorkObservation {
  return {
    nowMs: 1000, connected: true, scene: 'map', nav: nav(), gather: null, supply: supply(), here: HERE,
    trainingRunning: true, trainingStopReason: null, ...patch,
  };
}
const arrivedAt = (p: WorkPoint) => nav({ state: 'arrived', stopReason: 'arrived', mapId: p.mapId, targetPos: [p.x, p.y] });
const kinds = (effects: GatherEffect[]) => effects.map(e => e.kind).join(',');

suite('F17 補給設定與解析');
{
  const rs = sanitizeResupply({ potionItemId: 5, potionMin: 3, potionTarget: 1, sellItemIds: [1, 1, -2, 'x', 7] });
  assert(rs.potionTarget === 3 && rs.sellItemIds.join() === '1,7', '目標不低於門檻、賣出清單去重並丟掉無效編號');
  assert(sanitizeResupply(null).potionItemId === null, '空設定回預設');
  const fromF10 = resupplyFromStrategy({ hpItem: 11, deposit: [21, 22] }, 'SELL', { ...RESUPPLY });
  assert(fromF10.potionItemId === 11 && fromF10.sellItemIds.join() === '21,22' && fromF10.potionMin === 3, 'F10 策略：補藥道具與賣出清單，門檻沿用目前設定');
  assert(resupplyFromStrategy({ hpItem: 11, deposit: [21] }, 'STOP', RESUPPLY).sellItemIds.length === 0, '背包滿策略不是 SELL 就不賣');
  const plan = buildResupplyPlan(RESUPPLY);
  assert(plan.buy[0]?.itemId === 9001 && plan.buy[0].targetCount === 10 && plan.sellItemIds.length === 2, '指令只帶編號與數量，不帶價格');
  assert(!resupplyConfigured({ potionItemId: null, potionMin: 0, potionTarget: 0, sellItemIds: [] }), '沒有買賣就是沒設定');
  assert(potionsLow(RESUPPLY, supply({ potionCount: 2 })) === true && potionsLow(RESUPPLY, supply({ potionCount: 3 })) === false, '低於門檻才觸發');
  assert(potionsLow(RESUPPLY, supply({ potionCount: null })) === null && potionsLow(RESUPPLY, null) === null, '讀不到藥水回 null，不猜');
  assert(potionsLow({ ...RESUPPLY, potionMin: 0 }, null) === false, '門檻 0＝不依藥水觸發');
  const parsed = parseSupplyStatus({ running: true, state: 'buying', potionCount: 4, gold: 'x', completedCount: 2 });
  assert(parsed?.potionCount === 4 && parsed.gold === null && parsed.completedCount === 2, '補給回報：非數字欄位不補 0');
  assert(parseSupplyStatus({}) === null, '空資料回 null');
  assert(supplyTrigger(HUNT_CFG, { gather: null, supply: supply({ potionCount: 1 }) }) === 'potions', '藥水不足觸發');
  assert(supplyTrigger(HUNT_CFG, { gather: null, supply: supply({ bagUsed: 10 }) }) === 'bag', '背包滿觸發');
  assert(supplyTrigger({ ...HUNT_CFG, onBagFull: 'stop' }, { gather: null, supply: supply({ bagUsed: 10 }) }) === null, '背包滿策略是停下就不回村補給');
  assert(supplyTrigger(HUNT_CFG, { gather: null, supply: supply({ potionCount: null }) }) === 'unreadable', '藥水讀不到');
  assert(formatGatherStopReason('no_money') === '錢不夠買補給' && formatGatherStopReason('shop_not_found') === '商店對不到', '補給停止原因文字');
}

suite('F17 開始條件');
{
  assert(startGather(HUNT_CFG, obs()).state.phase === 'hunting', '練功補給可接手已在跑的練功');
  assert(startGather({ ...HUNT_CFG, home: null }, obs()).state.stopReason === 'no_home', '沒設商店位置不能開始');
  assert(startGather({ ...HUNT_CFG, resupply: { ...RESUPPLY, potionMin: 0, potionItemId: null, sellItemIds: [] } }, obs()).state.stopReason === 'no_supply_rule', '沒有任何補給條件不開始');
  assert(startGather(HUNT_CFG, obs({ nav: nav({ running: true }) })).state.stopReason === 'busy', '尋路在跑就拒絕');
  assert(startGather(HUNT_CFG, obs({ supply: supply({ running: true }) })).state.stopReason === 'busy', '補給在跑就拒絕');
  assert(startGather(HUNT_CFG, obs({ connected: false })).state.stopReason === 'disconnected', '沒連線就拒絕');
}

suite('F17 練功 → 補給 → 回原地');
{
  let s = startGather(HUNT_CFG, obs()).state;
  let r = stepGather(s, obs({ nowMs: 1100, scene: 'battle', supply: supply({ potionCount: 1 }) }), HUNT_CFG); s = r.state;
  assert(s.phase === 'hunting' && r.effects.length === 0, '戰鬥中不打斷（也不把戰鬥當異常）');
  r = stepGather(s, obs({ nowMs: 1200 }), HUNT_CFG); s = r.state;
  assert(s.phase === 'hunting' && r.effects.length === 0, '藥水夠就繼續練');
  r = stepGather(s, obs({ nowMs: 1300, supply: supply({ potionCount: 2 }) }), HUNT_CFG); s = r.state;
  assert(s.phase === 'to_home' && s.trigger === 'potions' && kinds(r.effects) === 'hunt_stop', '藥水不足：停練功、回村');
  assert(s.origin?.mapId === 'test-field' && s.origin.x === 55, '記住原地');
  r = stepGather(s, obs({ nowMs: 1400, trainingRunning: true }), HUNT_CFG); s = r.state;
  assert(r.effects.length === 0, '練功還沒停乾淨先不走路');
  r = stepGather(s, obs({ nowMs: 1500, trainingRunning: false }), HUNT_CFG); s = r.state;
  assert(kinds(r.effects) === 'walk_to' && (r.effects[0] as { target: WorkPoint }).target.mapId === 'test-town', '走去商店旁');
  r = stepGather(s, obs({ nowMs: 1600, trainingRunning: false, nav: arrivedAt(SHOP) }), HUNT_CFG); s = r.state;
  assert(s.phase === 'unloading', '到商店旁');
  r = stepGather(s, obs({ nowMs: 1700, trainingRunning: false, supply: supply({ potionCount: 2, completedCount: 4 }) }), HUNT_CFG); s = r.state;
  const eff = r.effects[0] as { kind: string; plan: { buy: Array<{ itemId: number; targetCount: number }>; sellItemIds: number[] } };
  assert(eff.kind === 'resupply' && eff.plan.buy[0]?.itemId === 9001 && eff.plan.sellItemIds.length === 2, '送出補給指令（買藥＋賣物）');
  r = stepGather(s, obs({ nowMs: 1800, trainingRunning: false, supply: supply({ running: true, state: 'buying', potionCount: 2, completedCount: 4 }) }), HUNT_CFG); s = r.state;
  assert(s.phase === 'unloading', '補給進行中');
  r = stepGather(s, obs({ nowMs: 2000, trainingRunning: false, supply: supply({ state: 'done', potionCount: 10, completedCount: 5 }) }), HUNT_CFG); s = r.state;
  assert(s.phase === 'to_origin' && s.unloads === 1, '補給完成，回原地');
  r = stepGather(s, obs({ nowMs: 2100, trainingRunning: false, nav: arrivedAt(SHOP) }), HUNT_CFG); s = r.state;
  assert(kinds(r.effects) === 'walk_to' && (r.effects[0] as { target: WorkPoint }).target.x === 55, '走回記住的原地');
  r = stepGather(s, obs({ nowMs: 2200, trainingRunning: false, nav: arrivedAt(HERE) }), HUNT_CFG); s = r.state;
  assert(s.phase === 'hunting' && s.origin === null, '回到原地');
  r = stepGather(s, obs({ nowMs: 2300, trainingRunning: false }), HUNT_CFG); s = r.state;
  assert(kinds(r.effects) === 'hunt_start', '重新開始練功');
  r = stepGather(s, obs({ nowMs: 2400, trainingRunning: true }), HUNT_CFG); s = r.state;
  assert(s.phase === 'hunting' && s.sawWorking, '回到練功');
}

suite('F17 練功補給失敗停機');
{
  const hunting = () => ({ ...startGather(HUNT_CFG, obs()).state });
  const unloadingIssued = () => ({ ...hunting(), phase: 'unloading' as const, commandIssued: true, phaseSinceMs: 1000, workBaseline: 4, trigger: 'potions' as const, origin: HERE });
  assert(stepGather(hunting(), obs({ here: null, supply: supply({ potionCount: 0 }) }), HUNT_CFG).state.stopReason === 'origin_unknown', '讀不到原地就停，不猜座標');
  assert(stepGather(hunting(), obs({ supply: supply({ potionCount: null }) }), HUNT_CFG).state.stopReason === 'potion_unreadable', '讀不到藥水就停');
  assert(stepGather(hunting(), obs({ trainingRunning: false, trainingStopReason: 'hp_low' }), HUNT_CFG).state.stopReason === 'hp_low', '練功自己停下（例如 HP 低）沿用原因');
  assert(stepGather(hunting(), obs({ scene: 'dialog' }), { ...HUNT_CFG, popupTicks: 1 }).state.stopReason === 'unexpected_popup', '練功時異常彈窗停下');
  assert(stepGather(hunting(), obs({ nowMs: 1000 + 61_000 }), { ...HUNT_CFG, maxMinutes: 1 }).state.stopReason === 'timeout', '超時停下');
  const noMoney = stepGather(unloadingIssued(), obs({ trainingRunning: false, supply: supply({ state: 'stopped', stopReason: 'no_money', completedCount: 4 }) }), HUNT_CFG);
  assert(noMoney.state.stopReason === 'no_money', '錢不夠：沿用橋接停止原因');
  const noShop = stepGather(unloadingIssued(), obs({ trainingRunning: false, supply: supply({ state: 'stopped', stopReason: 'shop_not_found', completedCount: 4 }) }), HUNT_CFG);
  assert(noShop.state.stopReason === 'shop_not_found', '商店對不到：沿用橋接停止原因');
  assert(stepGather(unloadingIssued(), obs({ trainingRunning: false, nowMs: 1000 + 200_000, supply: supply({ running: true, completedCount: 4 }) }), HUNT_CFG).state.stopReason === 'resupply_timeout', '補給等太久停下');
  const stillLow = stepGather(unloadingIssued(), obs({ trainingRunning: false, supply: supply({ state: 'done', completedCount: 5, potionCount: 1 }) }), HUNT_CFG);
  assert(stillLow.state.stopReason === 'resupply_failed', '補完藥水還是不足就停，不原地反覆補');
  const toHome = { ...hunting(), phase: 'to_home' as const, commandIssued: true, phaseSinceMs: 1000, origin: HERE, trigger: 'potions' as const };
  assert(stepGather(toHome, obs({ trainingRunning: false, nav: nav({ state: 'stopped', stopReason: 'path_blocked', targetPos: [3, 4] }) }), HUNT_CFG).state.stopReason === 'path_blocked', '回村尋路失敗沿用尋路原因');
  const stuck = { ...toHome, commandIssued: false };
  assert(stepGather(stuck, obs({ nowMs: 1000 + 20_000, trainingRunning: true }), HUNT_CFG).state.stopReason === 'busy', '練功停不下來就讓出（busy）');
  const userStop = stepGather(hunting(), obs(), HUNT_CFG, 'user_stopped');
  assert(userStop.state.stopReason === 'user_stopped' && kinds(userStop.effects) === 'hunt_stop', '手動停止時一併停練功');
}

suite('F17 採集循環的補給');
{
  const working = { ...startGather(GATHER_CFG, obs({ trainingRunning: false })).state, phase: 'working' as const, commandIssued: true, phaseSinceMs: 1000, sawWorking: true, workBaseline: 0 };
  const lowPotions = stepGather(working, obs({ trainingRunning: false, gather: gather({ state: 'done', completedCount: 1, bagUsed: 3 }), supply: supply({ potionCount: 1 }) }), GATHER_CFG);
  assert(lowPotions.state.phase === 'to_home' && lowPotions.state.trigger === 'potions', '採完藥水不足：背包沒滿也回村補給');
  const bagFull = stepGather(working, obs({ trainingRunning: false, gather: gather({ state: 'done', completedCount: 1, bagUsed: 10 }), supply: supply() }), GATHER_CFG);
  assert(bagFull.state.phase === 'to_home' && bagFull.state.trigger === 'bag', '背包滿回村賣物');
  const stopOnLow = stepGather(working, obs({ trainingRunning: false, gather: gather({ state: 'done', completedCount: 1, bagUsed: 3 }), supply: supply({ potionCount: 1 }) }), { ...GATHER_CFG, onBagFull: 'stop' });
  assert(stopOnLow.state.stopReason === 'potions_low', '策略是不回村時藥水不足就停');
  const unreadable = stepGather(working, obs({ trainingRunning: false, gather: gather({ state: 'done', completedCount: 1, bagUsed: 3 }), supply: supply({ potionCount: null }) }), GATHER_CFG);
  assert(unreadable.state.stopReason === 'potion_unreadable', '有設藥水門檻卻讀不到就停');
  const noRule = stepGather(working, obs({ trainingRunning: false, gather: gather({ state: 'done', completedCount: 1, bagUsed: 3 }), supply: null }), { ...GATHER_CFG, resupply: { potionItemId: null, potionMin: 0, potionTarget: 0, sellItemIds: [] } });
  assert(noRule.state.phase === 'working', '沒設補給條件時維持 F16 行為');
  const atShop = { ...working, phase: 'unloading' as const, commandIssued: true, workBaseline: 2, trigger: 'bag' as const };
  const stillFull = stepGather(atShop, obs({ trainingRunning: false, gather: gather({ bagUsed: 10 }), supply: supply({ state: 'done', completedCount: 3, bagUsed: 10 }) }), GATHER_CFG);
  assert(stillFull.state.stopReason === 'bag_still_full', '補給完背包還是滿的就停');
  const ok = stepGather(atShop, obs({ trainingRunning: false, gather: gather({ bagUsed: 2 }), supply: supply({ state: 'done', completedCount: 3, bagUsed: 2 }) }), GATHER_CFG);
  assert(ok.state.phase === 'to_spot', '補給完回採集點');
}

suite('F17 驅動器：模擬橋接跑完整練功補給循環');
{
  const calls: string[] = [];
  let clock = 0;
  let training = true;
  let navState = nav();
  let sup = supply({ potionCount: 6 });
  let here: WorkPoint | null = HERE;
  const ports: GatherPorts = {
    observe: () => ({ nowMs: clock, connected: true, scene: 'map', nav: navState, gather: null, supply: sup, here, trainingRunning: training }),
    walkTo: async t => { calls.push(`walk:${t.mapId}`); navState = arrivedAt(t); here = t; },
    walkStop: async () => undefined,
    gatherStart: async () => undefined,
    gatherStop: async () => undefined,
    huntStart: async () => { calls.push('hunt_start'); training = true; },
    huntStop: async () => { calls.push('hunt_stop'); training = false; },
    resupply: async () => { calls.push('resupply'); sup = { ...sup, state: 'done', completedCount: (sup.completedCount ?? 0) + 1, potionCount: 10 }; },
  };
  const runner = new GatherLoopRunner(ports, HUNT_CFG);
  runner.start();
  let cycles = 0;
  for (let i = 0; i < 40 && runner.active; i += 1) {
    clock += 1000;
    if (training && i === 2) sup = { ...sup, potionCount: 1 };
    await runner.tick();
    if (calls.filter(c => c === 'hunt_start').length >= 1) cycles += 1;
    if (cycles >= 3) runner.requestStop();
  }
  await runner.tick();
  assert(calls.join(',').startsWith('hunt_stop,walk:test-town,resupply,walk:test-field,hunt_start'), '停練功→走商店→補給→走原地→重新練功，順序正確');
  const snap = runner.getSnapshot();
  assert(snap.state.stopReason === 'user_stopped' && snap.state.unloads === 1, '補給一趟後可手動停止');

  const noShop = new GatherLoopRunner({ ...ports, resupply: undefined }, HUNT_CFG);
  training = true; sup = supply({ potionCount: 1 }); here = HERE; navState = nav();
  noShop.start();
  for (let i = 0; i < 10 && noShop.active; i += 1) { clock += 1000; await noShop.tick(); }
  assert(noShop.getSnapshot().state.stopReason === 'bridge_unsupported', '橋接沒有補給指令就明確停下');
  const busy = new GatherLoopRunner({ ...ports, resupply: async () => { throw new Error('already_running'); } }, HUNT_CFG);
  training = true; sup = supply({ potionCount: 1 }); here = HERE; navState = nav();
  busy.start();
  for (let i = 0; i < 10 && busy.active; i += 1) { clock += 1000; await busy.tick(); }
  assert(busy.getSnapshot().state.stopReason === 'busy', '橋接 409 對應成 busy');
}

suite('F17 用戶端與面板');
{
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const status: WineBridgeStatus = {
    ok: true, connected: true, running: false, phase: 'idle', scene: 'map', hpPct: null, mpPct: null, roundTrips: 0, encounters: 0,
    turns: 0, ticks: 0, actionsSent: 0, lastAction: null, stopReason: null,
    config: { patrolA: [1, 1], patrolB: [2, 2], hotkey: 'F7', preferred: 'attack', healAtPct: 30, stopHpPct: 10, stopMpPct: 0, maxMinutes: null, maxRoundTrips: null, windowTitle: '', wid: null },
    recentEvents: [], supply: { running: false, state: 'idle', potionCount: 4, gold: 99 } as unknown as WineSupplyStatus,
  };
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      if (url.endsWith('/resupply_start')) return new Response(JSON.stringify({ ok: true, running: true, state: 'buying' }), { status: 200 });
      return new Response(JSON.stringify({ ok: false, error: 'not found' }), { status: 404 });
    }
    return new Response(JSON.stringify(status), { status: 200 });
  };
  const client = new WineBridgeClient({ fetchFn, webSocketCtor: FakeSocket });
  await client.connect('http://127.0.0.1:4182');
  assert(client.getSnapshot().status?.supply?.potionCount === 4 && client.getSnapshot().status?.supply?.gold === 99, '/status 的 supply 欄位被解析');
  const res = await client.resupplyStart(buildResupplyPlan(RESUPPLY));
  assert(res.running && posts[0]?.url.endsWith('/resupply_start'), '送出 resupply_start');
  const body = posts[0]!.body as { buy: Array<{ itemId: number; targetCount: number }>; sell: number[] };
  assert(body.buy[0]?.itemId === 9001 && body.sell.length === 2 && !('price' in body), '請求只有編號與數量');
  let msg = '';
  try { await client.resupplyStop(); } catch (e) { msg = (e as Error).message; }
  assert(msg === 'not found' && client.getSnapshot().error === null, '橋接沒有指令時丟 not found，不污染連線錯誤');

  const cfg = sanitizeGatherConfig({ activity: 'hunt', resupply: { potionItemId: 3, potionMin: 2, potionTarget: 5, sellItemIds: [8] } });
  assert(cfg.activity === 'hunt' && cfg.resupply.potionTarget === 5 && sanitizeGatherConfig({ activity: 'x' }).activity === 'gather', '設定清洗含活動與補給');

  const runner = new GatherLoopRunner({
    observe: () => ({ nowMs: Date.now(), connected: true, scene: 'map', nav: null, gather: null, trainingRunning: false }),
    walkTo: async () => null, walkStop: async () => null, gatherStart: async () => null, gatherStop: async () => null,
  }, { ...DEFAULT_GATHER_CONFIG });
  const root = document.createElement('div');
  document.body.appendChild(root);
  const reactRoot = createRoot(root);
  const strategy = { inventoryPolicy: { hpItem: 41, deposit: [51, 52] }, bagFullPolicy: 'SELL' as const };
  await act(async () => {
    reactRoot.render(<WineGatherPanel client={client} active runner={runner} current={{ mapId: 'test-field', x: 1, y: 2 }} strategy={strategy} />);
  });
  const q = (id: string) => root.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  assert(q('wine-gather-spot') !== null, '採集模式顯示採集點');
  const sel = q('wine-gather-activity') as unknown as HTMLSelectElement;
  await act(async () => {
    sel.value = 'hunt';
    sel.dispatchEvent(new win.Event('change', { bubbles: true }) as unknown as Event);
  });
  assert(runner.getSnapshot().config.activity === 'hunt' && q('wine-gather-spot') === null, '切到練功補給：不需要採集點');
  await act(async () => { q('wine-supply-from-strategy')!.dispatchEvent(new win.MouseEvent('click', { bubbles: true }) as unknown as Event); });
  const applied = runner.getSnapshot().config;
  assert(applied.resupply.potionItemId === 41 && applied.resupply.sellItemIds.join() === '51,52' && applied.onBagFull === 'return_home', '沿用角色策略（F10）');
  assert((q('wine-supply-potion-id') as unknown as HTMLInputElement).value === '41', '欄位顯示套用結果');
  assert(q('wine-supply-potions')!.textContent === '4' && q('wine-supply-gold')!.textContent === '99', '顯示橋接回報的藥水與金額');
  await act(async () => { reactRoot.unmount(); });
}

done();
