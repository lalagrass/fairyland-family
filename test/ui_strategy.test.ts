import { Window } from 'happy-dom';
import ex from '../src/protocol/examples.json';
import { applyMessage, initialState } from '../src/state';
import { PROTOCOL_VERSION } from '../src/protocol/index';
import { assert, done, suite } from './helpers';

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
  MouseEvent: win.MouseEvent,
  localStorage: win.localStorage,
});

const { mountUi } = await import('../src/ui');

suite('UI 戰鬥策略選單穩定性（React 實機 DOM）');

const root = win.document.createElement('div');
win.document.body.appendChild(root);

const actions: string[] = [];
const ui = mountUi(
  root as unknown as HTMLElement,
  'TEST',
  a => {
    actions.push(a.kind);
    return null;
  },
  () => null,
);

const firstSel = root.querySelector('[data-testid="strategy"]') as unknown as HTMLSelectElement | null;
assert(firstSel !== null && firstSel.tagName.toLowerCase() === 'select', '初次掛載有 strategy select');

const auxManual = {
  nav: { phase: 'IDLE' as const, goal: null, route: [], text: '閒置' },
  strategy: 'MANUAL' as const,
  known: [],
};
const auxAttack = { ...auxManual, strategy: 'ATTACK' as const };

ui.render(initialState(), 'RUNNING', auxManual);
ui.render(initialState(), 'RUNNING', auxManual);
const afterRendersSel = root.querySelector('[data-testid="strategy"]');
assert(afterRendersSel === firstSel, '連續快照 render() 不得重建或替換 <select> DOM 節點');

// 模擬切換手機版分頁：不得卸載 strategy <select>
const tabBtns = root.querySelectorAll('[data-testid="mobile-tabs"] button');
(tabBtns[0] as unknown as HTMLElement).click();
const afterTabSel = root.querySelector('[data-testid="strategy"]');
assert(afterTabSel === firstSel, '切換手機版頁籤時不得重建 <select> DOM 節點');
(tabBtns[1] as unknown as HTMLElement).click();

// 模擬使用者展開並操作下拉選單（focus 中）
firstSel!.focus();
firstSel!.value = 'ATTACK';
ui.render(initialState(), 'RUNNING', auxManual);
assert(firstSel!.value === 'ATTACK', 'focus 期間快照重繪不得把已選值洗回 MANUAL');

// 觸發 change -> 通知 controller，之後非 focus 狀態下同步
firstSel!.dispatchEvent(new win.Event('change', { bubbles: true }) as unknown as Event);
assert(actions.includes('STRATEGY'), 'change 事件正確送出 STRATEGY action');

(firstSel as unknown as HTMLElement).blur();
ui.render(initialState(), 'RUNNING', auxAttack);
assert(firstSel!.value === 'ATTACK', '非 focus 狀態會同步 aux.strategy');

suite('UI 戰鬥狀態與任務面板渲染');
let s = applyMessage(
  initialState(),
  {
    v: PROTOCOL_VERSION,
    characterId: 'char-demo-1',
    ts: 1,
    kind: 'heartbeat',
    sessionId: 's1',
    seq: 1,
    mapId: '10001',
    phase: 'PLAYING',
    inBattle: true,
  },
  10,
);
const snapWithQuests = JSON.parse(JSON.stringify(ex.snapshot));
snapWithQuests.snapshot.openingStage = 'GO_BASEMENT';
snapWithQuests.snapshot.character.statuses = [{ type: 'ATK_UP', duration: 3, value: 20 }];
snapWithQuests.snapshot.character.activePet = {
  id: 'pet1',
  name: '土來姆',
  hp: 40,
  maxHp: 45,
  mp: 20,
  maxMp: 20,
  isDefending: true,
  statuses: [{ type: 'SHIELD', duration: 2, value: 15 }],
};
snapWithQuests.snapshot.activity.battle = {
  battleId: 5,
  round: 1,
  canFlee: true,
  enemies: [{ slot: 0, id: 'e0', name: '軟軟史萊姆', hp: 18, maxHp: 20, isChanting: true, statuses: [{ type: 'POISON', duration: 2, stacks: 1 }] }],
  player: { id: 'p1', name: '阿草', hp: 90, maxHp: 136, mp: 40, maxMp: 75, statuses: [{ type: 'ATK_UP', duration: 3, value: 20 }] },
  pet: snapWithQuests.snapshot.character.activePet,
};
snapWithQuests.snapshot.quests = [
  {
    questId: 13,
    title: '[重建示範] 佛洛的南綠野警戒巡邏',
    npcId: 'npc_10001_02_佛洛',
    npcName: '佛洛',
    minLevel: 1,
    status: 'READY',
    objectives: [
      {
        type: 'KILL_MONSTERS',
        description: '於吉恩村外圍草地討伐魔物 (2場)',
        current: 2,
        required: 2,
        met: true,
        targetMaps: [{ mapId: '10004', mapName: '吉恩村南綠野', reason: 'ENCOUNTER_AREA', x: 640, y: 640 }],
      },
    ],
    rewardExp: 180,
    rewardCoins: 400,
  },
];
s = applyMessage(s, snapWithQuests, 20);
ui.render(s, 'RUNNING', auxAttack);
assert(root.querySelector('[data-testid="char-status-row"]') !== null, '主角狀態列已渲染');
assert(root.querySelector('[data-testid="pet-status-row"]') !== null, '出戰寵狀態列已渲染');
assert(
  root.querySelector('[data-testid="battle-player-status-row"]') !== null &&
    root.querySelector('[data-testid="battle-pet-status-row"]') !== null,
  '戰鬥面板含主角與出戰寵即時狀態',
);
assert(root.querySelector('[data-testid="battle-enemy-status-row"]') !== null, '戰鬥面板含敵方即時狀態標籤');
assert(root.querySelector('[data-testid="opening-stage-badge"]') !== null, '顯示主線階段提示');
const qEntry = root.querySelector('[data-testid="quest-entry"]');
assert(qEntry !== null && qEntry.getAttribute('data-quest-status') === 'READY', '任務面板顯示 READY 任務');
const qAutoBtn = root.querySelector('[data-testid="quest-auto-btn"]') as unknown as HTMLElement | null;
assert(qAutoBtn !== null, '可回報任務顯示自動推進按鈕');
qAutoBtn!.click();
assert(actions.includes('QUEST_AUTO'), '點擊任務自動推進會觸發 QUEST_AUTO action');

// FL1: classic ruleset shows 職業 instead of revamp weaponFamily/comboLevel
const snapClassic = JSON.parse(JSON.stringify(snapWithQuests));
snapClassic.snapshot.character.ruleset = 'classic';
snapClassic.snapshot.character.className = '武鬥家';
delete snapClassic.snapshot.character.weaponFamily;
delete snapClassic.snapshot.character.comboLevel;
const sc = applyMessage(s, snapClassic, 25);
ui.render(sc, 'RUNNING', auxAttack);
assert(root.querySelector('[data-testid="class-name"]')?.textContent === '職業 武鬥家', 'classic 模式顯示職業名稱');
assert(root.querySelector('[data-testid="mastery"]') === null, 'classic 模式不顯示武器熟練／連擊');

win.close();
done();
