import { PROTOCOL_VERSION, type CommandMessage, type PluginMessage, type SceneSnapshot } from '../src/protocol/index';
import fx from '../fixtures/replay_village.json';
import { FamilyController } from '../src/controller';
import { appendSteps, emptyQueue, loadQueue, moveStep, planWork, removeStep, saveQueue, type PlanContext, type QueueState } from '../src/queue';
import { WORK_DATA, recipeOf } from '../src/workdata';
import type { Transport } from '../src/transport/types';
import { assert, done, suite } from './helpers';

const village = (fx.steps as any[]).find(s => s.message.kind === 'snapshot').message.snapshot as SceneSnapshot;
const B = { v: PROTOCOL_VERSION, characterId: 'c1' };
const COAL = 10201, BRONZE_ORE = 10234, PICK = 90001, BRONZE = 20901;
const SHOP_NPC = village.shops[0].npcId;

// ---------------------------------------------------------------- 假遊戲（一張圖、可非同步結算的工作、指令重複偵測）

interface WorldOpts { gold?: number; cap?: number; tools?: number; durability?: number; asyncWork?: boolean; inv?: Record<number, number> }
function makeWorld(o: WorldOpts = {}) {
  const w = {
    gold: o.gold ?? 1200, cap: o.cap ?? 6, x: village.character.x, y: village.character.y,
    inv: new Map<number, number>(Object.entries(o.inv ?? {}).map(([k, v]) => [Number(k), v])),
    tools: o.tools ?? 0, durability: o.durability ?? 30,
    seen: new Set<string>(), executed: [] as string[], active: null as null | { commandId: string; workType: string; targetId: string; endsAt: number },
    asyncWork: o.asyncWork ?? false, shopOpen: false, dialogOpen: false, now: 1000,
    sink: null as null | ((m: unknown) => void), seq: 1,
  };
  const total = () => [...w.inv.values()].reduce((a, b) => a + b, 0);
  const ev = (event: unknown) => w.sink?.({ ...B, ts: w.now, kind: 'event', seq: w.seq++, event } as PluginMessage);
  const res = (c: CommandMessage, status: 'ACCEPTED' | 'REJECTED', reasonCode?: string, duplicate = false) =>
    w.sink?.({ ...B, ts: w.now, kind: 'command-result', commandId: c.commandId, status, ...(reasonCode ? { reasonCode } : {}), ...(duplicate ? { duplicate: true } : {}) });
  const snapshot = (): SceneSnapshot => {
    const s = JSON.parse(JSON.stringify(village)) as SceneSnapshot;
    s.character = { ...s.character, x: w.x, y: w.y, gold: w.gold };
    s.inventory = [...w.inv.entries()].map(([itemId, count]) => ({ itemId, name: null, count }));
    s.work.tools = s.work.tools.map(t => (t.itemId === PICK ? { ...t, count: w.tools, durability: w.tools ? w.durability : null } : t));
    s.work.inventory = { ...s.work.inventory, slotsUsed: total(), slotLimit: w.cap };
    s.activity = { ...s.activity, work: w.active ? { commandId: w.active.commandId, workType: w.active.workType as 'GATHER', targetId: w.active.targetId, startedAt: w.now, endsAt: w.active.endsAt, durationMs: 2500 } : null };
    return s;
  };
  const change = (itemId: number, delta: number) => {
    const n = (w.inv.get(itemId) ?? 0) + delta;
    if (n <= 0) w.inv.delete(itemId); else w.inv.set(itemId, n);
    ev({ type: 'INVENTORY_CHANGED', changes: [{ itemId, delta, count: Math.max(0, n) }] });
  };
  const reasonFor = (cmd: { workType: string; targetId: string }): string | null => {
    if (cmd.workType === 'GATHER') {
      const p = village.gatherPoints.points.find(x => x.id === cmd.targetId)!;
      if (p.requiredToolItemId && w.tools <= 0) return 'MISSING_TOOL';
      if (Math.hypot(p.x - w.x, p.y - w.y) > 150) return 'TOO_FAR';
      if (total() >= w.cap) return 'INVENTORY_FULL';
      return null;
    }
    const r = recipeOf(Number(cmd.targetId))!;
    const st = village.work.stations[0];
    if (Math.hypot(st.x - w.x, st.y - w.y) > st.reach) return 'TOO_FAR';
    if (r.ingredients.some(i => (w.inv.get(i.itemId) ?? 0) < i.count)) return 'MISSING_MATERIAL';
    return null;
  };
  const settle = () => {
    const a = w.active;
    if (!a) return;
    w.active = null;
    const cmd = { commandId: a.commandId, workType: a.workType, targetId: a.targetId };
    w.executed.push(a.commandId);
    const bad = reasonFor(cmd);
    if (bad) { ev({ type: 'COMMAND_COMPLETED', commandId: a.commandId, outcome: 'FAILED', code: bad }); return; }
    const gained: Array<{ itemId: number; name: string | null; count: number }> = [];
    const consumed: Array<{ itemId: number; name: string | null; count: number }> = [];
    let broke = false;
    if (a.workType === 'GATHER') {
      const p = village.gatherPoints.points.find(x => x.id === a.targetId)!;
      change(p.itemId!, 1); gained.push({ itemId: p.itemId!, name: p.itemName ?? null, count: 1 });
      if (p.requiredToolItemId) { w.durability -= 1; if (w.durability <= 0) { w.tools = 0; broke = true; } }
    } else {
      const r = recipeOf(Number(a.targetId))!;
      for (const i of r.ingredients) { change(i.itemId, -i.count); consumed.push({ itemId: i.itemId, name: null, count: i.count }); }
      change(r.productId, 1); gained.push({ itemId: r.productId, name: r.name, count: 1 });
    }
    const out = { workType: a.workType, targetId: a.targetId, gained, consumed, staminaLeft: 50, toolDurabilityLeft: w.tools ? w.durability : null, toolBroken: broke, skillId: null, skillLevel: null, roll: 0.1, successRate: 0.9, inventorySlotsUsed: total(), inventoryFullAfter: total() >= w.cap };
    ev({ type: 'COMMAND_COMPLETED', commandId: a.commandId, outcome: 'DONE', code: broke ? 'TOOL_BROKEN' : 'WORK_DONE', output: out });
  };
  const handle = (cmd: CommandMessage) => {
    const c = cmd.command;
    if (c.type === 'REQUEST_SNAPSHOT') { res(cmd, 'ACCEPTED'); w.sink?.({ ...B, ts: w.now, kind: 'snapshot', seq: w.seq++, reason: 'REQUESTED', snapshot: snapshot() }); return; }
    if (w.seen.has(cmd.commandId)) { res(cmd, 'ACCEPTED', undefined, true); return; }
    if (c.type === 'WALK_TO') { w.seen.add(cmd.commandId); res(cmd, 'ACCEPTED'); w.x = c.x; w.y = c.y; ev({ type: 'MOVED', mapId: village.mapId, x: c.x, y: c.y, dir: 2 }); ev({ type: 'COMMAND_COMPLETED', commandId: cmd.commandId, outcome: 'DONE', code: 'ARRIVED' }); return; }
    if (c.type === 'TALK_TO_NPC') {
      w.seen.add(cmd.commandId); res(cmd, 'ACCEPTED'); w.dialogOpen = true;
      ev({ type: 'DIALOG_OPENED', npcId: c.npcId, npcName: '收破爛阿利', role: null, lines: ['要買什麼？'], options: [{ id: 'OPEN_SHOP', label: '買東西' }, { id: 'CLOSE', label: '告辭' }], optionsAvailable: true });
      ev({ type: 'COMMAND_COMPLETED', commandId: cmd.commandId, outcome: 'DONE', code: 'DIALOG_OPENED' }); return;
    }
    if (c.type === 'CHOOSE_DIALOG_OPTION') {
      w.seen.add(cmd.commandId); res(cmd, 'ACCEPTED');
      if (c.optionId === 'OPEN_SHOP') { w.shopOpen = true; ev({ type: 'SHOP_OPENED', npcId: SHOP_NPC, npcName: '收破爛阿利', goods: village.shops[0].goods }); }
      if (c.optionId === 'CLOSE_SHOP') { w.shopOpen = false; ev({ type: 'SHOP_CLOSED', npcId: SHOP_NPC }); }
      if (c.optionId === 'CLOSE') { w.dialogOpen = false; ev({ type: 'DIALOG_CLOSED', npcId: SHOP_NPC }); }
      ev({ type: 'COMMAND_COMPLETED', commandId: cmd.commandId, outcome: 'DONE', code: 'DONE' }); return;
    }
    if (c.type === 'BUY_ITEM') {
      w.seen.add(cmd.commandId);
      const g = village.shops[0].goods.find(x => x.itemId === c.itemId);
      if (!w.shopOpen) { res(cmd, 'REJECTED', 'NOT_AT_SHOP'); return; }
      if (!g) { res(cmd, 'REJECTED', 'ITEM_NOT_IN_SHOP'); return; }
      if (w.gold < g.price * (c.count ?? 1)) { res(cmd, 'REJECTED', 'CORE_REJECTED'); return; }
      res(cmd, 'ACCEPTED'); w.gold -= g.price * (c.count ?? 1); ev({ type: 'GOLD_CHANGED', gold: w.gold, delta: -g.price * (c.count ?? 1) });
      if (c.itemId === PICK) { w.tools += c.count ?? 1; w.durability = 30; }
      change(c.itemId, c.count ?? 1);
      ev({ type: 'COMMAND_COMPLETED', commandId: cmd.commandId, outcome: 'DONE', code: 'DONE' }); return;
    }
    if (c.type === 'WORK_ONCE') {
      w.seen.add(cmd.commandId);
      const bad = reasonFor(c);
      if (bad) { res(cmd, 'REJECTED', bad); return; }
      res(cmd, 'ACCEPTED');
      w.active = { commandId: cmd.commandId, workType: c.workType, targetId: c.targetId, endsAt: w.now + 2500 };
      if (!w.asyncWork) settle();
      return;
    }
    res(cmd, 'REJECTED', 'NOT_IMPLEMENTED');
  };
  return { w, handle, snapshot, settle };
}

type World = ReturnType<typeof makeWorld>;

function connect(world: World, store: Map<string, string>) {
  let t = world.w.now;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const sent: CommandMessage[] = [];
  const transport: Transport = {
    name: 'fake-game', start: cb => { world.w.sink = cb; }, stop: () => { world.w.sink = null; },
    send(cmd) { sent.push(cmd); world.handle(cmd); },
  };
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  const c = new FamilyController(transport, { now: () => t, storage, after: (ms, fn) => { timers.push({ at: t + ms, fn }); } });
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift(); t = Math.max(t, next.at); next.fn();
    }
    t = end; world.w.now = t;
  };
  const hb = () => world.w.sink?.({ ...B, ts: t, kind: 'heartbeat', sessionId: 's1', seq: world.w.seq++, mapId: village.mapId, phase: 'PLAYING', inBattle: false });
  c.start();
  hb();
  world.w.sink?.({ ...B, ts: t, kind: 'event', seq: world.w.seq++, event: { type: 'GAME_STARTED', sessionId: 's1' } });
  world.w.sink?.({ ...B, ts: t, kind: 'snapshot', seq: world.w.seq++, reason: 'STARTED', snapshot: world.snapshot() });
  hb();
  // 每 500ms 一次心跳＋tick，模擬真實頁面（外掛逾時偵測與佇列的逾時重送都靠它）。
  const spin = (ms: number) => { for (let i = 0; i < ms / 500; i++) { advance(500); hb(); c.tick(); } };
  return { c, sent, advance, spin, hb, close: () => c.stop() };
}

const cmds = (h: ReturnType<typeof connect>, type: string) => h.sent.filter(m => m.command.type === type);
const qOf = (h: ReturnType<typeof connect>) => h.c.queue() as QueueState;
const statusText = (h: ReturnType<typeof connect>) => `${qOf(h).run}@${qOf(h).cursor} ${qOf(h).reason ?? ''}`;

// ---------------------------------------------------------------- 1. 規劃（純函式）

const ctx = (o: Partial<PlanContext> = {}): PlanContext => ({ snapshot: village, gold: 1200, inventory: [], mapId: '10001', mapName: id => (id === '10001' ? '吉恩村' : null), ...o });

suite('planner: missing tool → buy first (with price), money short and no stock explained');
{
  const r = planWork({ workType: 'GATHER', itemId: COAL, until: { kind: 'BAG_FULL' } }, ctx());
  assert(r.ok && r.steps.map(s => s.kind).join() === 'BUY,GOTO_POINT,WORK', '缺鐵鎬：買 → 前往採集點 → 採集');
  assert(r.ok && !!r.confirm && r.confirm.includes('鐵鎬') && r.confirm.includes('300') && r.confirm.includes('收破爛阿利'), '確認問句帶工具名稱、價格、賣的人');
  const own = planWork({ workType: 'GATHER', itemId: COAL, until: { kind: 'BAG_FULL' } }, ctx({ inventory: [{ itemId: PICK, count: 1 }] }));
  assert(own.ok && own.confirm === null && own.steps.map(s => s.kind).join() === 'GOTO_POINT,WORK', '已有工具：不買，不需要確認');
  const poor = planWork({ workType: 'GATHER', itemId: COAL, until: { kind: 'BAG_FULL' } }, ctx({ gold: 100 }));
  assert(!poor.ok && poor.error.includes('金錢不夠') && poor.error.includes('300') && poor.error.includes('100'), '錢不夠：說明價格與現有金額');
  const noStock = JSON.parse(JSON.stringify(village)) as SceneSnapshot;
  noStock.shops[0].goods = noStock.shops[0].goods.filter(g => g.itemId !== PICK);
  const ns = planWork({ workType: 'GATHER', itemId: COAL, until: { kind: 'BAG_FULL' } }, ctx({ snapshot: noStock }));
  assert(!ns.ok && ns.error.includes('沒有') && ns.error.includes('鐵鎬'), '本圖商店沒有這項商品：說明');
  const nodata = planWork({ workType: 'GATHER', itemId: 99999, until: { kind: 'BAG_FULL' } }, ctx());
  assert(!nodata.ok && nodata.error.includes('沒有'), '沒有採集點資料：說明');
}

suite('planner: smelt/forge chain expands raw materials and stations');
{
  const s = planWork({ workType: 'SMELT', productId: BRONZE, count: 2 }, ctx({ inventory: [{ itemId: PICK, count: 1 }] }));
  assert(s.ok, '青銅塊可規劃');
  if (s.ok) {
    const works = s.steps.filter(x => x.kind === 'WORK') as any[];
    assert(works.length === 3 && works[0].workType === 'GATHER' && works[2].workType === 'SMELT', '先採原料（青銅礦、煤）再冶煉');
    const coal = works.find(w => w.until.kind === 'HAVE' && w.until.itemId === COAL), ore = works.find(w => w.until.kind === 'HAVE' && w.until.itemId === BRONZE_ORE);
    assert(coal?.until.n === 6 && ore?.until.n === 2, '原料數量 = 配方 × 次數（煤 3×2、青銅礦 1×2）');
    assert(s.steps.some(x => x.kind === 'GOTO_POINT' && x.name === '打鐵舖前') && works[2].until.n === 2, '冶煉前先到站點');
  }
  const f = planWork({ workType: 'FORGE', productId: 40101, count: 1 }, ctx({ inventory: [{ itemId: PICK, count: 1 }, { itemId: 90002, count: 1 }] }));
  assert(f.ok && f.steps.filter(x => x.kind === 'WORK').map((x: any) => x.workType).join() === 'GATHER,GATHER,GATHER,SMELT,FORGE', '鍛造新手銅劍：採煤／青銅礦／白楊木 → 冶煉青銅塊 → 鍛造');
  const have = planWork({ workType: 'FORGE', productId: 40101, count: 1 }, ctx({ inventory: [{ itemId: BRONZE, count: 2 }, { itemId: 10103, count: 4 }] }));
  assert(have.ok && have.steps.filter(x => x.kind === 'WORK').length === 1, '原料都有了：只排鍛造');
  assert(WORK_DATA.dataVersion === village.work.dataVersion, '外掛資料副本版本與宿主快照一致');
}

suite('queue store: persist, reorder, delete');
{
  const store = new Map<string, string>();
  const st = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  const base = emptyQueue('c1');
  const steps = ['a', 'b', 'c'].map(n => ({ kind: 'GOTO_MAP' as const, mapId: n, name: n, label: `去 ${n}` }));
  let q = appendSteps(base, steps);
  q = moveStep(q, 2, -1) as QueueState;
  assert(q.steps.map(s => (s as any).name).join('') === 'acb', '上移');
  q = removeStep(q, 0) as QueueState;
  assert(q.steps.map(s => (s as any).name).join('') === 'cb', '刪除');
  saveQueue(st, q);
  const back = loadQueue(st, 'c1');
  assert(back.steps.length === 2 && back.qid === q.qid && loadQueue(st, 'other').steps.length === 0, '存檔讀回；不同角色各自一份');
  assert(typeof removeStep({ ...q, run: 'RUNNING', cursor: 0 }, 0) === 'string' && typeof moveStep(q, 5, 1) === 'string', '執行中的那一步不能刪；越界有說明');
}

// ---------------------------------------------------------------- 2. 整條鏈：缺工具 → 買 → 走 → 採到背包滿

suite('chain: 採礦 煤 直到 背包滿 (no tool → buy → walk → gather until bag full)');
{
  const world = makeWorld({ gold: 1200, cap: 6 });
  const h = connect(world, new Map());
  const err = h.c.parseAndSend('採礦 煤 直到 背包滿');
  assert(err === null && h.c.pendingPlan !== null && h.c.pendingPlan.confirm.includes('鐵鎬'), '缺工具：先問要不要去買（不直接花錢）');
  assert(cmds(h, 'BUY_ITEM').length === 0 && (h.c.queue()?.steps.length ?? 0) === 0, '確認前沒有送出任何買賣、佇列是空的');
  h.c.parseAndSend('確認');
  h.spin(3000);
  const q = qOf(h);
  assert(q.run === 'DONE' && q.cursor === 3, `佇列跑完（${statusText(h)}）`);
  assert(world.w.gold === 900 && world.w.tools === 1, '買了一把鐵鎬（300 金）');
  assert([...world.w.inv.values()].reduce((a, b) => a + b, 0) === 6, '採到背包滿（容量 6）');
  const ids = h.sent.map(m => m.commandId);
  assert(new Set(ids).size === ids.length, '沒有任何 commandId 重複送出');
  const works = cmds(h, 'WORK_ONCE');
  assert(works.length === 5 && works.every(m => /^q[a-z0-9]+\.s3\.\d+\.0$/.test(m.commandId)), '5 次 WORK_ONCE（鐵鎬佔 1 格），commandId＝佇列.步驟.次數.重試');
  assert(h.c.state.log.some(l => l.text.includes('得到') && l.text.includes('消耗') && l.text.includes('體力')), '日誌顯示產出／消耗／體力');
  assert(q.log.some(l => l.kind === 'STOP' && l.text.includes('背包滿')), '停止原因記在工作紀錄');
}

suite('chain: N 次 / 缺料 / 工具壞 are natural stops; failures pause at the right step');
{
  const world = makeWorld({ cap: 99, tools: 1 });
  const h = connect(world, new Map());
  h.c.parseAndSend('採集 煤 3 次');
  h.spin(1000);
  assert(qOf(h).run === 'DONE' && cmds(h, 'WORK_ONCE').length === 3 && (world.w.inv.get(COAL) ?? 0) === 3, '採集 煤 3 次：剛好 3 次');

  const w2 = makeWorld({ cap: 99, tools: 1, durability: 2 });
  const h2 = connect(w2, new Map());
  h2.c.parseAndSend('採集 煤 直到 工具壞');
  h2.spin(1500);
  assert(qOf(h2).run === 'DONE' && cmds(h2, 'WORK_ONCE').length === 2 && qOf(h2).log.some(l => l.text.includes('工具已壞') || l.text.includes('工具壞了')), '直到工具壞：用完耐久自然結束');

  const w2b = makeWorld({ cap: 99, tools: 1, durability: 2 });
  const h2b = connect(w2b, new Map());
  h2b.c.parseAndSend('採集 煤 10 次');
  h2b.spin(1500);
  assert(qOf(h2b).run === 'PAUSED' && !!qOf(h2b).reason?.includes('工具壞了') && qOf(h2b).cursor === 1, `N 次還沒到工具就壞：暫停並說明（${statusText(h2b)}）`);

  const w3 = makeWorld({ cap: 99, tools: 1, inv: { [BRONZE_ORE]: 1, [COAL]: 3 } });
  const h3 = connect(w3, new Map());
  h3.c.parseAndSend('冶煉 青銅塊 2 次');
  h3.spin(3000);
  // 資料夠做 1 次；第 2 次的原料規劃會排採集（HAVE 目標），完成後再冶煉兩次
  assert(qOf(h3).run === 'DONE' && (w3.w.inv.get(BRONZE) ?? 0) === 2, `冶煉：缺的原料自動排採集後做完（${statusText(h3)}）`);
}

suite('failure mid-chain: money short at the buy step, bag full at a gather step');
{
  const world = makeWorld({ gold: 1200, cap: 6 });
  const h = connect(world, new Map());
  h.c.parseAndSend('採礦 煤 直到 背包滿');
  world.w.gold = 100; // 確認前後被花掉了
  h.c.state = { ...h.c.state, character: h.c.state.character && { ...h.c.state.character, gold: 100 } };
  h.c.parseAndSend('確認');
  h.spin(2000);
  assert(qOf(h).run === 'PAUSED' && qOf(h).cursor === 0 && !!qOf(h).reason?.includes('金錢不夠'), `買不起：停在「買」這一步並說明（${statusText(h)}）`);
  assert(cmds(h, 'WORK_ONCE').length === 0 && cmds(h, 'WALK_TO').length >= 1, '後面的採集沒有被送出');
  world.w.gold = 1200;
  h.c.state = { ...h.c.state, character: h.c.state.character && { ...h.c.state.character, gold: 1200 } };
  h.c.parseAndSend('繼續');
  h.spin(3000);
  assert(qOf(h).run === 'DONE' && world.w.tools === 1, '補了錢按「繼續」：重試這一步，之後接著跑完');

  const w2 = makeWorld({ cap: 4, tools: 1, inv: { 10103: 3 } });
  const h2 = connect(w2, new Map());
  h2.c.parseAndSend('採集 煤 10 次');
  h2.spin(2000);
  assert(qOf(h2).run === 'PAUSED' && qOf(h2).cursor === 1 && !!qOf(h2).reason?.includes('背包滿'), `背包滿但沒要求「直到背包滿」：停在採集步驟並說明（${statusText(h2)}）`);
}

// ---------------------------------------------------------------- 3. 重開外掛頁面續跑、遊戲分頁關閉不重複結算

suite('resume: close and reopen the family tab mid-work (host still working) → no double send');
{
  const world = makeWorld({ cap: 99, tools: 1, asyncWork: true });
  const store = new Map<string, string>();
  const h1 = connect(world, store);
  h1.c.parseAndSend('採集 煤 3 次');
  h1.spin(500);
  const firstId = cmds(h1, 'WORK_ONCE')[0]?.commandId;
  assert(!!firstId && world.w.active?.commandId === firstId, '第一個工作送出、宿主正在做');
  h1.close();
  const h2 = connect(world, store);
  h2.spin(500);
  assert(qOf(h2).run === 'RUNNING' && cmds(h2, 'WORK_ONCE').length === 0, '重開後接上進行中的工作，沒有重送');
  assert(qOf(h2).log.some(l => l.text.includes('接上進行中的工作')), '紀錄寫明是接上而不是重做');
  world.settle();
  h2.spin(1000);
  const second = cmds(h2, 'WORK_ONCE')[0];
  assert(world.w.executed[0] === firstId && !!second && second.commandId !== firstId, '第一個結算後才送下一個（新的 commandId）');
  for (let i = 0; i < 3; i++) { world.settle(); h2.spin(500); }
  world.settle(); h2.spin(500);
  assert(qOf(h2).run === 'DONE' && world.w.executed.length === 3 && new Set(world.w.executed).size === 3, `共執行 3 次、沒有重複結算（${statusText(h2)}，executed ${world.w.executed.length}）`);
}

suite('resume: host finished while the family tab was closed → resend same commandId, host answers duplicate');
{
  const world = makeWorld({ cap: 99, tools: 1, asyncWork: true });
  const store = new Map<string, string>();
  const h1 = connect(world, store);
  h1.c.parseAndSend('採集 煤 2 次');
  h1.spin(500);
  const firstId = cmds(h1, 'WORK_ONCE')[0].commandId;
  h1.close();
  world.settle(); // 外掛離線時宿主做完了
  const h2 = connect(world, store);
  h2.spin(1000);
  const again = cmds(h2, 'WORK_ONCE').filter(m => m.commandId === firstId);
  assert(again.length === 1, '用同一個 commandId 重送一次');
  assert(world.w.executed.filter(x => x === firstId).length === 1, '宿主只結算一次（重複的 id 不會再做）');
  assert(qOf(h2).log.some(l => l.text.includes('離線時已完成')), '紀錄寫明沿用先前結果');
  for (let i = 0; i < 4; i++) { world.settle(); h2.spin(500); }
  assert(qOf(h2).run === 'DONE' || qOf(h2).run === 'RUNNING', '之後接著做');
  assert(new Set(world.w.executed).size === world.w.executed.length, '整個過程沒有任何 commandId 被結算兩次');
}

suite('manual stop: pause lets the in-flight work finish but starts no new one');
{
  const world = makeWorld({ cap: 99, tools: 1, asyncWork: true });
  const h = connect(world, new Map());
  h.c.parseAndSend('採礦 煤 直到 手動停止');
  h.spin(500);
  h.c.parseAndSend('暫停');
  world.settle();
  h.spin(1000);
  assert(qOf(h).run === 'PAUSED' && cmds(h, 'WORK_ONCE').length === 1 && (world.w.inv.get(COAL) ?? 0) === 1, '暫停後進行中的做完、不再送下一個');
  assert(qOf(h).reason === '手動暫停', '原因顯示手動暫停');
}

done();
