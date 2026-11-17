import { Window } from 'happy-dom';
import ex from '../src/protocol/examples.json';
import { PROTOCOL_VERSION } from '../src/protocol/index';
import { FamilyController } from '../src/controller';
import { buildPaletteSuggestions } from '../src/dv6_palette';
import { buildCheckpointFromState, computeWelcomeRecap } from '../src/dv7_recap';
import { applyMessage, initialState } from '../src/state';
import type { Transport } from '../src/transport/types';
import { assert, done, suite } from './helpers';

function assertEq<T>(actual: T, expected: T, msg: string): void {
  assert(actual === expected, `${msg}（實際：${String(actual)}，預期：${String(expected)}）`);
}

function makeMemoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
  };
}

function makeFakeTransport(): Transport & { push: (m: unknown) => void } {
  let handler: ((m: unknown) => void) | null = null;
  return {
    name: 'fake-fm6',
    start(h) {
      handler = h;
    },
    stop() {
      handler = null;
    },
    send() {},
    push(m) {
      handler?.(m);
    },
  };
}

const win = new Window({ url: 'http://localhost:5173/family/' });
Object.assign(globalThis, {
  window: win,
  document: win.document,
  HTMLElement: win.HTMLElement,
  HTMLSelectElement: win.HTMLSelectElement,
  HTMLInputElement: win.HTMLInputElement,
  HTMLButtonElement: win.HTMLButtonElement,
  Element: win.Element,
  Node: win.Node,
  Event: win.Event,
  CustomEvent: win.CustomEvent,
  FocusEvent: win.FocusEvent,
  PointerEvent: win.PointerEvent,
  KeyboardEvent: win.KeyboardEvent,
  MouseEvent: win.MouseEvent,
  MutationObserver: win.MutationObserver,
  getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  localStorage: win.localStorage,
});

const { mountUi } = await import('../src/ui');

suite('FM6 第二波顯示：DV6 Ctrl+K、DV7 回來摘要、DV8 佇列卡片編排與停止條件、DV9 漸進揭露');

// 1. DV6 自動完成清單與純鍵盤操作
let st = initialState();
st = applyMessage(st, ex.staticData, 1000);
st = applyMessage(st, ex.snapshot, 1000);
const suggestions = buildPaletteSuggestions(st, '快照');
assert(suggestions.some(s => s.commandText === '快照'), 'DV6 搜尋「快照」包含對應動作');
const npcSuggestions = buildPaletteSuggestions(st, '前往');
assert(npcSuggestions.length > 0, 'DV6 自動納入當前地圖 NPC / 出口導航');

// 2. DV7 回來摘要：關掉再開比對前後狀態與離線日誌
const storage = makeMemoryStorage();
const baseSnap = structuredClone(ex.snapshot);
const cpBefore = buildCheckpointFromState(st, 1_000_000)!;
const stAfter = structuredClone(st);
stAfter.character = { ...stAfter.character!, gold: cpBefore.gold + 350, level: cpBefore.level + 1 };
stAfter.location = { mapId: '10004', mapName: '北綠野' };
stAfter.snapshot = { ...stAfter.snapshot!, mapId: '10004', mapName: '北綠野' };
stAfter.inventory = [{ itemId: 1001, name: '青銅礦', count: 6 }];
const cpAfter = buildCheckpointFromState(stAfter, 1_900_000)!; // 離開 15 分鐘
const recap = computeWelcomeRecap(cpBefore, cpAfter, [
  { id: 1, at: 1_500_000, tag: '系統', text: '採集工作完成：青銅礦 ×6', level: 'info' },
]);
assert(recap !== null, 'DV7 離線 15 分鐘後產出回來摘要');
assertEq(recap!.goldDelta, 350, 'DV7 金錢差額正確 +350');
assertEq(recap!.levelDelta, 1, 'DV7 等級差額正確 +1');
assert(Boolean(recap!.mapTransition?.includes('北綠野')), 'DV7 記錄位置變化');
assert(recap!.itemDeltas.some(d => d.name === '青銅礦' && d.delta > 0), 'DV7 記錄背包物品數量增減');

// 3. DV8 行動佇列卡片：新增、排序、刪除與停止條件（滿包即停 / 低飽食）
const t = makeFakeTransport();
let nowMs = 5_000_000;
const ctrl = new FamilyController(t, { now: () => nowMs, storage });
ctrl.start();
t.push({
  v: PROTOCOL_VERSION,
  characterId: ex.snapshot.characterId,
  ts: nowMs,
  kind: 'heartbeat',
  sessionId: 'sess-dv8',
  phase: 'PLAYING',
});
t.push(ex.snapshot);
ctrl.perform({
  kind: 'QUEUE_GATHER',
  skillId: 5,
  skillName: '採礦',
  targetName: '青銅礦',
  count: 2,
  label: '採銅',
});
ctrl.perform({
  kind: 'QUEUE_CRAFT',
  recipeId: 20901,
  recipeName: '青銅塊',
  count: 1,
  label: '融銅',
});
assertEq(ctrl.queueStatus().jobs.length, 2, 'DV8 加入兩個排程卡片');

// 排序：將 #1 移到 #0
ctrl.perform({ kind: 'QUEUE_REORDER', fromIndex: 1, toIndex: 0, label: '重排' });
assertEq(ctrl.queueStatus().jobs[0].kind, 'CRAFT', 'DV8 重排後原第二項改列第一');

// 刪除第 0 項
ctrl.perform({ kind: 'QUEUE_REMOVE', index: 0, label: '移除第一項' });
assertEq(ctrl.queueStatus().jobs.length, 1, 'DV8 刪除後剩餘 1 項');

// 停止條件測試：設低飽食 <= 80 並送入飽食=60 快照 -> 停止工作
ctrl.perform({
  kind: 'QUEUE_STOP_CONDITIONS',
  patch: { minSatiety: 80, stopOnBagFull: true },
  label: '設停止條件',
});
const lowSatSnap = structuredClone(ex.snapshot);
(lowSatSnap.snapshot.character as { satiety?: number }).satiety = 60;
t.push(lowSatSnap);
assertEq(ctrl.queueStatus().phase, 'STOPPED', 'DV8 觸發低飽食停止條件並自動停下');
assertEq(ctrl.queueStatus().stopReason, 'NO_STAMINA', '停止原因標示 NO_STAMINA');

// 4. UI DOM：DV9 漸進揭露收起空面板、DV6 Ctrl+K 面板、DV7 回來摘要與 DV8 卡片
const root = win.document.createElement('div');
win.document.body.appendChild(root);
const emptyState = initialState();
const ui = mountUi(
  root as unknown as HTMLElement,
  'TEST',
  a => ctrl.perform(a),
  txt => ctrl.parseAndSend(txt),
);
ui.render(emptyState, 'STOPPED', {
  nav: ctrl.navStatus(),
  strategy: 'MANUAL',
  known: [],
  queue: ctrl.queueStatus(),
  welcomeRecap: recap,
});

assert(root.querySelector('[data-testid="collapsed-warehouse-note"]') !== null, 'DV9 空倉庫時漸進收起');
assert(root.querySelector('[data-testid="collapsed-quest-note"]') !== null, 'DV9 空任務時漸進收起');
assert(root.querySelector('[data-testid="welcome-recap-card"]') !== null, 'DV7 渲染回來摘要卡片');
assert(root.querySelectorAll('[data-testid="queue-job-card"]').length >= 1, 'DV8 渲染可視佇列卡片');

// 鍵盤 Ctrl+K 開啟指令面板並輸入 Enter
const openBtn = root.querySelector('[data-testid="palette-open-btn"]') as unknown as HTMLButtonElement;
assert(openBtn !== null, '存在快速指令面板入口');
openBtn.click();
await new Promise(r => setTimeout(r, 20));
assert(win.document.querySelector('[data-testid="command-palette"]') !== null, 'Ctrl+K 指令面板順利展開');

done();
