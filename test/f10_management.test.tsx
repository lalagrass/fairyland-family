import { Window } from 'happy-dom';
import ex from '../src/protocol/examples.json';
import { PROTOCOL_VERSION, type PluginCommand, type SnapshotMessage, type StaticSkillSummary } from '../src/protocol';
import { inventoryAction, InventoryModule } from '../src/automation/modules/inventoryModule';
import { DEFAULT_CHARACTER_STRATEGY, DEFAULT_INVENTORY_POLICY, CharacterStrategyStore } from '../src/automation/strategyStore';
import type { AutomationHostContext } from '../src/automation/types';
import { AutoBattler } from '../src/battler';
import { applyMessage, initialState } from '../src/state';
import { assert, done, suite } from './helpers';

const msg = structuredClone(ex.snapshot) as unknown as SnapshotMessage;
msg.characterId = 'testerA';
const me = msg.snapshot.character;
Object.assign(me, { name: 'A', hp: 10, maxHp: 100, satiety: 15, maxSatiety: 100, activeWork: null, inBattle: false });
msg.snapshot.activity = { dialog: null, shop: null, battle: null, battleResult: null, command: null };
msg.snapshot.inventory = [{ itemId: 1, name: '補給甲', count: 3 }, { itemId: 2, name: '補給乙', count: 3 }];
let state = applyMessage(initialState(), msg, 1);
state.warehouse = { gold: 0, cap: 2, items: [] };
const policy = { ...DEFAULT_INVENTORY_POLICY, hpItem: 1, hpThreshold: 50, staminaItem: 2, staminaThreshold: 30 };
suite('F10 背包規則只派發宿主指令');
const actions: PluginCommand[] = [];
const ctx: AutomationHostContext = {
  state: () => state, status: () => 'RUNNING', now: () => 100,
  getStrategyConfig: () => ({ ...DEFAULT_CHARACTER_STRATEGY, inventoryPolicy: policy }),
  send: cmd => { actions.push(cmd); return `cmd${actions.length}`; }, onChange() {}, log() {},
};
const module = new InventoryModule();
module.onMessage(msg, ctx);
module.onMessage(msg, ctx);
assert(actions.length === 1 && actions[0].type === 'GAME_COMMAND' && actions[0].command.itemId === 1, '低生命優先使用設定的道具，重複快照只送一次');
assert(state.inventory[0].count === 3 && me.hp === 10, '等待宿主結算時不更動生命或背包');
me.hp = 50;
assert(inventoryAction(state, policy)?.command.type === 'GAME_COMMAND' &&
  inventoryAction(state, policy)?.signature.startsWith('use/2/') === true, '生命到達門檻後改檢查體力');
me.satiety = 90;
assert(inventoryAction(state, policy) === null, '體力生命足夠時不消耗道具');
const depositPolicy = { ...DEFAULT_INVENTORY_POLICY, keep: [1], deposit: [1, 2] };
const deposit = inventoryAction(state, depositPolicy)?.command;
assert(deposit?.type === 'WAREHOUSE_DEPOSIT' && deposit.itemId === 2 && deposit.count === 2, '留存優先並依宿主倉庫空位存放');
assert(inventoryAction({ ...state, warehouse: null }, depositPolicy) === null, '倉庫未知時等待快照');
assert(inventoryAction({ ...state, character: { ...me, inBattle: true } }, depositPolicy) === null, '戰鬥中暫停存倉與消耗');

const data = new Map<string, string>();
const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
const store = new CharacterStrategyStore(storage);
store.update('testerA', { inventoryPolicy: depositPolicy });
const restored = new CharacterStrategyStore(storage);
assert(restored.get('testerA').inventoryPolicy?.deposit.join() === '2' && !restored.get('testerB').inventoryPolicy, '保存時消除衝突規則，重開後角色設定仍隔離');

suite('F10 戰鬥優先序');
const skills: StaticSkillSummary[] = [
  { id: 3, name: '主攻', kind: 'SKILL', targetScope: 'SINGLE', mpCost: 2 },
  { id: 3, name: '補血', kind: 'SPELL', targetScope: 'ALLY_SINGLE', mpCost: 5 },
];
const battle = new AutoBattler({ ...ctx, after() {} }, null, () => ({ attack: 'SKILL:3', heal: 'SPELL:3', healThreshold: 60 }));
state.staticData = { ...structuredClone(ex.staticData.staticData), skills } as typeof state.staticData;
state.battle = {
  battleId: 7, ready: false, round: null, enemies: ['目標'], enemyStates: [
    { id: 'enemy', name: '目標', slot: 5, hp: 10, maxHp: 10 },
  ], canFlee: true, player: { id: 'controlled', name: 'A', slot: 3, hp: 10, maxHp: 100, mp: 10 },
};
battle.setStrategy('ATTACK');
function turn(round: number, hp: number, mp: number) {
  Object.assign(state.battle!.player!, { hp, mp });
  battle.onMessage({ v: PROTOCOL_VERSION, characterId: 'testerA', ts: round, kind: 'event', seq: round,
    event: { type: 'BATTLE_TURN_READY', battleId: 7, round, enemies: state.battle!.enemyStates, canFlee: true } });
  const cmd = actions.at(-1);
  return cmd?.type === 'BATTLE_ACTION' ? cmd.action : null;
}
const heal = turn(1, 10, 10);
assert(heal?.kind === 'SPELL' && heal.spellId === 3 && heal.targetSlot === undefined, '低血時優先補血，使用宿主自身目標且不傳敵方位置');
assert(turn(2, 80, 10)?.targetSlot === 5 && actions.at(-1)?.type === 'BATTLE_ACTION', '血量充足時主攻存活敵人');
assert(turn(3, 10, 3)?.kind === 'SKILL', '補血 MP 不足改用主攻');
assert(turn(4, 10, 0)?.kind === 'ATTACK', '兩種技能 MP 都不足時用普攻');

suite('F10 工作台角色切換與設定');
const win = new Window({ url: 'http://localhost/family/' });
Object.assign(globalThis, { window: win, document: win.document, localStorage: win.localStorage,
  HTMLElement: win.HTMLElement, HTMLInputElement: win.HTMLInputElement, Element: win.Element, Node: win.Node,
  getComputedStyle: win.getComputedStyle.bind(win), requestAnimationFrame: win.requestAnimationFrame.bind(win),
  cancelAnimationFrame: win.cancelAnimationFrame.bind(win) });
const { mountUi } = await import('../src/ui');
const { flushSync } = await import('react-dom');
const mount = win.document.createElement('div');
win.document.body.appendChild(mount);
const ui = mountUi(mount as unknown as HTMLElement, 'TEST', action => {
  if (action.kind === 'COMMAND') actions.push(action.command);
  return null;
}, () => null);
const aux = { nav: { phase: 'IDLE' as const, goal: null, route: [], text: '', skipped: [] }, strategy: 'MANUAL' as const, known: [] };
const member = { ...me, satiety: 90, inventoryCount: 6, inventoryCap: 12, workSkills: {}, region: null, mapId: 'test-map', mapName: '測試地圖', inventory: msg.snapshot.inventory, characterId: 'testerA' };
state = { ...state, battle: null, members: [member, { ...member, name: 'B', characterId: 'testerB' }] };
ui.render(state, 'RUNNING', aux);
const id = (key: string) => mount.querySelector(`[data-testid="${key}"]`);
flushSync(() => (id('f10-member-testerB') as unknown as HTMLButtonElement).click());
const switchCommand = actions.at(-1);
assert(switchCommand?.type === 'SWITCH_VIEW_CHARACTER' && switchCommand.characterId === 'testerB', '頂部角色鈕送出切換視角指令');
assert(id('character')?.textContent.includes('A') ?? false, '先保留宿主確認的角色畫面');
const next = { ...state, characterId: 'testerB', activeCharacterId: 'testerB', character: { ...me, name: 'B' }, inventory: [] };
ui.render(next, 'RUNNING', aux);
assert(id('f10-member-testerB')?.getAttribute('aria-pressed') === 'true' && Boolean(id('f10-character-skills')?.textContent.includes('B')), '宿主確認後技能頁與頂部角色同步');
assert(!id('f10-keep-1') && Boolean(id('f10-queue-state')), '物品策略改用新角色背包，系統頁顯示佇列儲存狀態');
done();
