import ex from '../src/protocol/examples.json';
import { PROTOCOL_VERSION } from '../src/protocol/index';
import type { BehaviorModule } from '../src/automation/types';
import { FamilyController } from '../src/controller';
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

function makeFakeTransport(): Transport & { push: (msg: unknown) => void; sent: unknown[] } {
  let handler: ((msg: unknown) => void) | null = null;
  const sent: unknown[] = [];
  return {
    name: 'test-fake',
    sent,
    start(onMessage) {
      handler = onMessage;
    },
    stop() {
      handler = null;
    },
    send(msg) {
      sent.push(msg);
    },
    push(msg) {
      handler?.(msg);
    },
  };
}

suite('FM-A 自動化模組化、XState 協調、每角色策略與單模組擴充範例');

const storage = makeMemoryStorage();
let nowMs = 10_000;
const transport = makeFakeTransport();

// 新增一種行為只需加一個模組（範例：自訂金錢門檻提示模組）
let goldAlertTriggered = false;
const customGoldModule: BehaviorModule = {
  id: 'custom-gold-alert',
  label: '範例金錢檢查模組',
  priority: 99,
  category: 'IDLE',
  isActive: () => false,
  getSummary: () => '金錢監控中',
  onMessage(msg, ctx) {
    if (msg.kind === 'snapshot' && msg.snapshot.character.gold >= 500) {
      goldAlertTriggered = true;
      ctx.log('範例模組偵測到金錢達標，可回村採購');
    }
  },
};

const ctrl = new FamilyController(transport, {
  now: () => nowMs,
  storage,
  extraModules: [customGoldModule],
});
ctrl.start();

// 1. 模組已註冊並能查詢清單
const moduleIds = ctrl.automation.list().map(m => m.id);
assert(moduleIds.includes('battle'), '含戰鬥模組');
assert(moduleIds.includes('navigation'), '含尋路模組');
assert(moduleIds.includes('work-queue'), '含採集製造佇列模組');
assert(moduleIds.includes('quest'), '含自動任務模組');
assert(moduleIds.includes('example-rest-monitor'), '含示範自動休息模組');
assert(moduleIds.includes('custom-gold-alert'), '只需傳入即可掛載全新自訂行為模組');

// 2. XState 協調器初始 IDLE
assertEq(ctrl.coordinatorMode(), 'IDLE', 'XState 協調器初始狀態為 IDLE');

// 3. 每角色獨立策略設定（char_1 vs char_2 互不覆蓋且持久化）
ctrl.perform({
  kind: 'CHAR_STRATEGY_UPDATE',
  characterId: 'char_1',
  patch: { battleStrategy: 'ATTACK', lowHpRetreatPct: 15, bagFullPolicy: 'SELL' },
  label: '設定 char_1',
});
ctrl.perform({
  kind: 'CHAR_STRATEGY_UPDATE',
  characterId: 'char_2',
  patch: { battleStrategy: 'MANUAL', lowHpRetreatPct: 60, autoRestMinSatiety: 40 },
  label: '設定 char_2',
});

const c1Cfg = ctrl.strategyStore.get('char_1');
const c2Cfg = ctrl.strategyStore.get('char_2');
assertEq(c1Cfg.lowHpRetreatPct, 15, 'char_1 低血撤退 15%');
assertEq(c1Cfg.bagFullPolicy, 'SELL', 'char_1 滿包策略 SELL');
assertEq(c2Cfg.lowHpRetreatPct, 60, 'char_2 低血撤退 60%（不與 char_1 混用）');
assertEq(c2Cfg.autoRestMinSatiety, 40, 'char_2 低飽食提醒 40');

// 重開新實例仍能從 storage 還原各角色策略
const ctrlReloaded = new FamilyController(makeFakeTransport(), { storage });
assertEq(ctrlReloaded.strategyStore.get('char_1').battleStrategy, 'ATTACK', '重啟保留 char_1 戰鬥策略');
assertEq(ctrlReloaded.strategyStore.get('char_2').lowHpRetreatPct, 60, '重啟保留 char_2 低血門檻');

// 4. 傳送快照與戰鬥就緒事件 -> 觸發自訂模組 + 切換至 char_2 的低血保護 (50/100 <= 60%) 改為 FLEE + XState COMBAT
transport.push({
  v: PROTOCOL_VERSION,
  characterId: 'char_2',
  ts: nowMs,
  kind: 'heartbeat',
  sessionId: 'sess-fma',
  phase: 'PLAYING',
});
const snapCopy = structuredClone(ex.snapshot);
snapCopy.characterId = 'char_2';
snapCopy.snapshot.character.gold = 999;
transport.push(snapCopy);
assert(goldAlertTriggered, '外掛新模組順利於快照事件觸發');

transport.push({
  v: PROTOCOL_VERSION,
  characterId: 'char_2',
  ts: nowMs,
  kind: 'event',
  seq: 10,
  event: {
    type: 'BATTLE_STARTED',
    battleId: 88,
    mapId: '10001',
    enemies: [{ id: 'enemy-1', slot: 0, name: '史萊姆', level: 1 }],
  },
});
assertEq(ctrl.coordinatorMode(), 'COMBAT', '進入戰鬥後 XState 協調器狀態切換為 COMBAT');

transport.push({
  v: PROTOCOL_VERSION,
  characterId: 'char_2',
  ts: nowMs,
  kind: 'event',
  seq: 11,
  event: {
    type: 'BATTLE_TURN_READY',
    battleId: 88,
    round: 1,
    enemies: [{ slot: 0, id: 'enemy-1', name: '史萊姆', hp: 30, maxHp: 30 }],
    canFlee: true,
    player: { id: 'p1', name: '角色二', hp: 50, maxHp: 100 },
  },
});
assertEq(ctrl.strategy(), 'FLEE', 'char_2 血量 50% ≤ 設定 60%，戰鬥模組自動切換為 FLEE');

done();
