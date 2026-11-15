import ex from '../src/protocol/examples.json';
import { applyMessage, initialState } from '../src/state';
import { mountUi, type UiAux } from '../src/ui';
import { assert, done, suite } from './helpers';

class FakeElement {
  tagName: string;
  attrs: Record<string, string> = {};
  children: (FakeElement | string)[] = [];
  className = '';
  textContent = '';
  value = 'MANUAL';
  disabled = false;
  lastElementChild: FakeElement | null = null;
  ownerDocument: FakeDocument;
  listeners: Record<string, Array<() => void>> = {};

  constructor(tag: string, doc: FakeDocument) {
    this.tagName = tag.toLowerCase();
    this.ownerDocument = doc;
  }

  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }

  append(...nodes: (FakeElement | string)[]) {
    for (const n of nodes) {
      this.children.push(n);
      if (n instanceof FakeElement) this.lastElementChild = n;
    }
  }

  replaceChildren(...nodes: (FakeElement | string)[]) {
    this.children = [];
    this.lastElementChild = null;
    this.append(...nodes);
  }

  addEventListener(ev: string, fn: () => void) {
    (this.listeners[ev] ??= []).push(fn);
  }

  findByTestId(id: string): FakeElement | null {
    if (this.attrs['data-testid'] === id) return this;
    for (const c of this.children) {
      if (c instanceof FakeElement) {
        const hit = c.findByTestId(id);
        if (hit) return hit;
      }
    }
    return null;
  }

  querySelector(sel: string): FakeElement | null {
    const m = /^\[data-testid=([^\]]+)\]$/.exec(sel);
    return m ? this.findByTestId(m[1]) : null;
  }
}

class FakeDocument {
  activeElement: FakeElement | null = null;
  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }
}

suite('UI 戰鬥策略選單穩定性');

const doc = new FakeDocument();
(globalThis as unknown as { document: FakeDocument }).document = doc;
const root = new FakeElement('div', doc);

const actions: string[] = [];
const ui = mountUi(
  root as unknown as HTMLElement,
  'TEST',
  a => { actions.push(a.kind); return null; },
  () => null,
);

const firstSel = root.findByTestId('strategy');
assert(firstSel !== null && firstSel.tagName === 'select', '初次掛載有 strategy select');

const auxManual: UiAux = { nav: { phase: 'IDLE', goal: null, route: [], text: '閒置' }, strategy: 'MANUAL', known: [] };
const auxAttack: UiAux = { ...auxManual, strategy: 'ATTACK' };

ui.render(initialState(), 'RUNNING', auxManual);
ui.render(initialState(), 'RUNNING', auxManual);
const afterRendersSel = root.findByTestId('strategy');
assert(afterRendersSel === firstSel, '連續快照 render() 不得重建或替換 <select> DOM 節點');

// 模擬使用者展開並操作下拉選單（focus 中）
doc.activeElement = firstSel;
firstSel!.value = 'ATTACK';
ui.render(initialState(), 'RUNNING', auxManual);
assert(firstSel!.value === 'ATTACK', 'focus 期間快照重繪不得把已選值洗回 MANUAL');

// 觸發 change -> 通知 controller，之後非 focus 狀態下同步
for (const fn of firstSel!.listeners.change ?? []) fn();
assert(actions.includes('STRATEGY'), 'change 事件正確送出 STRATEGY action');

doc.activeElement = null;
ui.render(initialState(), 'RUNNING', auxAttack);
assert(firstSel!.value === 'ATTACK', '非 focus 狀態會同步 aux.strategy');

suite('UI 戰鬥狀態與任務面板渲染');
let s = applyMessage(initialState(), { v: 2, characterId: 'char-demo-1', ts: 1, kind: 'heartbeat', sessionId: 's1', seq: 1, mapId: '10001', phase: 'PLAYING', inBattle: true }, 10);
const snapWithQuests = JSON.parse(JSON.stringify(ex.snapshot));
snapWithQuests.snapshot.openingStage = 'GO_BASEMENT';
snapWithQuests.snapshot.character.statuses = [{ type: 'ATK_UP', duration: 3, value: 20 }];
snapWithQuests.snapshot.character.activePet = { id: 'pet1', name: '土來姆', hp: 40, maxHp: 45, mp: 20, maxMp: 20, isDefending: true, statuses: [{ type: 'SHIELD', duration: 2, value: 15 }] };
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
    objectives: [{ type: 'KILL_MONSTERS', description: '於吉恩村外圍草地討伐魔物 (2場)', current: 2, required: 2, met: true }],
    rewardExp: 180,
    rewardCoins: 400,
  },
];
s = applyMessage(s, snapWithQuests, 20);
ui.render(s, 'RUNNING', auxAttack);
assert(root.findByTestId('char-status-row') !== null, '主角狀態列已渲染');
assert(root.findByTestId('pet-status-row') !== null, '出戰寵狀態列已渲染');
assert(root.findByTestId('battle-player-status-row') !== null && root.findByTestId('battle-pet-status-row') !== null, '戰鬥面板含主角與出戰寵即時狀態');
assert(root.findByTestId('battle-enemy-status-row') !== null, '戰鬥面板含敵方即時狀態標籤');
assert(root.findByTestId('opening-stage-badge') !== null, '顯示主線階段提示');
const qEntry = root.findByTestId('quest-entry');
assert(qEntry !== null && qEntry.attrs['data-quest-status'] === 'READY', '任務面板顯示 READY 任務');
const qAutoBtn = root.findByTestId('quest-auto-btn');
assert(qAutoBtn !== null, '可回報任務顯示自動推進按鈕');
for (const fn of qAutoBtn!.listeners.click ?? []) fn();
assert(actions.includes('QUEST_AUTO'), '點擊任務自動推進會觸發 QUEST_AUTO action');

done();
