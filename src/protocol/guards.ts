// [sync-protocol] 自動產生，請勿手改；改協定請到 fairyland 修改後重新執行 npm run sync-protocol
// [sync-protocol] 來源：fairyland/packages/shared/src/protocol/guards.ts @ 710e78847a14404fddf6275e5a2b227a02d3f22b
/**
 * FX1：協定的執行期檢核（手寫型別守衛，不依賴任何套件）。
 * 宿主與外掛都用同一份：收到的訊息先過守衛，通過才當成型別化資料使用。
 */
import {
  BATTLE_ACTION_KINDS,
  COMPLETION_CODES,
  COMPLETION_OUTCOMES,
  GAME_EVENT_TYPES,
  PLUGIN_COMMAND_TYPES,
  PROTOCOL_VERSION,
  REJECT_REASON_CODES,
  SOURCE_TAGS,
  WORK_TYPES,
  type CommandMessage,
  type CommandResultMessage,
  type EventMessage,
  type GameEvent,
  type HeartbeatMessage,
  type PluginCommand,
  type PluginMessage,
  type SceneSnapshot,
  type SnapshotMessage,
} from './types.js';

type Rec = Record<string, unknown>;

const isRec = (x: unknown): x is Rec => typeof x === 'object' && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === 'string';
const isNonEmptyStr = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isBool = (x: unknown): x is boolean => typeof x === 'boolean';
const isArr = (x: unknown): x is unknown[] => Array.isArray(x);
const optNum = (x: unknown): boolean => x === undefined || isNum(x);
const strOrNull = (x: unknown): boolean => x === null || isStr(x);
const numOrNull = (x: unknown): boolean => x === null || isNum(x);
const isOption = (o: unknown): boolean => isRec(o) && isStr(o.id) && isStr(o.label);
const isShopGood = (w: unknown): boolean => isRec(w) && isNum(w.itemId) && strOrNull(w.name) && isNum(w.price)
  && (w.source === undefined || (SOURCE_TAGS as readonly string[]).includes(w.source as string));
const isItemQty = (i: unknown): boolean => isRec(i) && isNum(i.itemId) && strOrNull(i.name) && isNum(i.count);
const isWorkOutput = (o: unknown): boolean => isRec(o) && (WORK_TYPES as readonly string[]).includes(o.workType as string)
  && isStr(o.targetId) && isArr(o.gained) && o.gained.every(isItemQty) && isArr(o.consumed) && o.consumed.every(isItemQty)
  && isNum(o.staminaLeft) && numOrNull(o.toolDurabilityLeft) && isBool(o.toolBroken) && numOrNull(o.skillId) && numOrNull(o.skillLevel)
  && isNum(o.roll) && isNum(o.successRate) && isNum(o.inventorySlotsUsed) && isBool(o.inventoryFullAfter);
const isSrcTag = (t: unknown): boolean => (SOURCE_TAGS as readonly string[]).includes(t as string);
const isWorkBlock = (w: unknown): boolean => {
  if (!isRec(w) || !['AVAILABLE', 'UNAVAILABLE', 'RECONSTRUCTED_DEMO'].includes(w.status as string)) return false;
  if (!numOrNull(w.dataVersion) || !strOrNull(w.origin) || !isNum(w.missingCount)) return false;
  const inv = w.inventory, st = w.stamina;
  if (!isRec(inv) || !isNum(inv.slotsUsed) || !isNum(inv.slotLimit) || !isNum(inv.stackMax) || !isSrcTag(inv.source)) return false;
  if (!isRec(st) || !isNum(st.value) || !isNum(st.max) || !isNum(st.gatherCost) || !isNum(st.craftCost) || !isSrcTag(st.source)) return false;
  if (!isArr(w.tools) || !w.tools.every(t => isRec(t) && isNum(t.itemId) && isStr(t.name) && isNum(t.skillId) && isNum(t.count) && numOrNull(t.durability) && isNum(t.maxDurability))) return false;
  if (!isArr(w.stations) || !w.stations.every(t => isRec(t) && isStr(t.id) && isStr(t.name) && isStr(t.kind) && isNum(t.x) && isNum(t.y) && isNum(t.reach)
    && isArr(t.workTypes) && t.workTypes.every(k => (WORK_TYPES as readonly string[]).includes(k as string)) && isSrcTag(t.source))) return false;
  if (!isArr(w.vendors) || !w.vendors.every(v => isRec(v) && isStr(v.mapId) && isStr(v.npcName) && isNum(v.itemId) && strOrNull(v.itemName) && numOrNull(v.price) && isSrcTag(v.source))) return false;
  return isRec(w.skillLevels) && Object.values(w.skillLevels).every(isNum);
};
const isWorkInProgress = (w: unknown): boolean => isRec(w) && isNonEmptyStr(w.commandId) && (WORK_TYPES as readonly string[]).includes(w.workType as string)
  && isStr(w.targetId) && isNum(w.startedAt) && isNum(w.endsAt) && isNum(w.durationMs);
const isEnemyState = (e: unknown): boolean => isRec(e) && isNum(e.slot) && isStr(e.id) && isStr(e.name) && isNum(e.hp) && isNum(e.maxHp);

/** 指令內容（不含信封）。 */
export function isPluginCommand(x: unknown): x is PluginCommand {
  if (!isRec(x) || !isStr(x.type)) return false;
  if (!(PLUGIN_COMMAND_TYPES as readonly string[]).includes(x.type)) return false;
  switch (x.type) {
    case 'WALK_TO': return isNonEmptyStr(x.mapId) && isNum(x.x) && isNum(x.y);
    case 'TALK_TO_NPC': return isNonEmptyStr(x.npcId);
    case 'CHOOSE_DIALOG_OPTION': return isNonEmptyStr(x.optionId);
    case 'ACCEPT_QUEST': return isNum(x.questId);
    case 'BUY_ITEM':
    case 'SELL_ITEM': return isNum(x.itemId) && optNum(x.count);
    case 'WORK_ONCE': return (WORK_TYPES as readonly string[]).includes(x.workType as string) && isNonEmptyStr(x.targetId);
    case 'BATTLE_ACTION': {
      const a = x.action;
      return optNum(x.battleId) && isRec(a) && (BATTLE_ACTION_KINDS as readonly string[]).includes(a.kind as string)
        && optNum(a.targetSlot) && optNum(a.skillId) && optNum(a.spellId) && optNum(a.itemId) && optNum(a.sealStoneId);
    }
    case 'BATTLE_FLEE': return optNum(x.battleId);
    case 'REQUEST_SNAPSHOT': return true;
    case 'GAME_COMMAND': return isRec(x.command) && isNonEmptyStr(x.command.type);
    default: return false;
  }
}

/** 事件內容（不含信封）。 */
export function isGameEvent(x: unknown): x is GameEvent {
  if (!isRec(x) || !isStr(x.type)) return false;
  if (!(GAME_EVENT_TYPES as readonly string[]).includes(x.type)) return false;
  switch (x.type) {
    case 'GAME_STARTED': return isNonEmptyStr(x.sessionId);
    case 'GAME_STOPPED': return isNonEmptyStr(x.sessionId) && ['PAGE_HIDE', 'UNLOAD', 'SHUTDOWN'].includes(x.reason as string);
    case 'LOCATION_CHANGED':
      return isNonEmptyStr(x.mapId) && strOrNull(x.mapName) && strOrNull(x.fromMapId) && isNum(x.x) && isNum(x.y)
        && ['LOAD', 'MAP_CHANGE', 'WARP'].includes(x.cause as string);
    case 'MOVED': return isNonEmptyStr(x.mapId) && isNum(x.x) && isNum(x.y) && isNum(x.dir);
    case 'DIALOG_OPENED':
      return isStr(x.npcId) && isStr(x.npcName) && strOrNull(x.role) && isArr(x.lines) && x.lines.every(isStr)
        && isArr(x.options) && x.options.every(isOption) && isBool(x.optionsAvailable);
    case 'DIALOG_UPDATED': return isStr(x.npcId) && isArr(x.lines) && x.lines.every(isStr) && isArr(x.options) && x.options.every(isOption);
    case 'DIALOG_CLOSED': return isStr(x.npcId);
    case 'SHOP_OPENED':
      return isStr(x.npcId) && isStr(x.npcName) && isArr(x.goods)
        && x.goods.every(isShopGood);
    case 'SHOP_CLOSED': return isStr(x.npcId);
    case 'BATTLE_STARTED':
      return isNum(x.battleId) && isNonEmptyStr(x.mapId) && isArr(x.enemies)
        && x.enemies.every(e => isRec(e) && isStr(e.id) && isStr(e.name) && numOrNull(e.level));
    case 'BATTLE_ENDED': return isNum(x.battleId) && ['WIN', 'LOSE', 'FLEE', 'UNKNOWN'].includes(x.outcome as string);
    case 'BATTLE_TURN_READY': return isNum(x.battleId) && isNum(x.round) && isArr(x.enemies) && x.enemies.every(isEnemyState) && isBool(x.canFlee);
    case 'INVENTORY_CHANGED':
      return isArr(x.changes) && x.changes.every(c => isRec(c) && isNum(c.itemId) && isNum(c.delta) && isNum(c.count));
    case 'GOLD_CHANGED': return isNum(x.gold) && isNum(x.delta);
    case 'COMMAND_ACCEPTED': return isNonEmptyStr(x.commandId);
    case 'COMMAND_REJECTED':
      return isNonEmptyStr(x.commandId) && (REJECT_REASON_CODES as readonly string[]).includes(x.reasonCode as string)
        && (x.message === undefined || isStr(x.message));
    case 'COMMAND_COMPLETED':
      return isNonEmptyStr(x.commandId) && (COMPLETION_OUTCOMES as readonly string[]).includes(x.outcome as string)
        && (COMPLETION_CODES as readonly string[]).includes(x.code as string) && (x.message === undefined || isStr(x.message))
        && (x.output === undefined || isWorkOutput(x.output));
    default: return false;
  }
}

const AVAIL = ['AVAILABLE', 'UNAVAILABLE', 'RECONSTRUCTED_DEMO'];

/** 場景快照內容。只檢核外掛會用到的結構，不做資料語意檢查。 */
export function isSceneSnapshot(x: unknown): x is SceneSnapshot {
  if (!isRec(x) || x.schema !== 'scene-snapshot' || !isNonEmptyStr(x.mapId) || !strOrNull(x.mapName)) return false;
  const c = x.character;
  if (!isRec(c) || !strOrNull(c.name) || !isNum(c.level) || !numOrNull(c.hp) || !numOrNull(c.maxHp)
    || !numOrNull(c.mp) || !numOrNull(c.maxMp) || !isNum(c.gold) || !isNum(c.x) || !isNum(c.y) || !isNum(c.dir) || !isBool(c.inBattle)) return false;
  if (!isArr(x.npcs) || !x.npcs.every(n => isRec(n) && isStr(n.id) && isStr(n.name) && isNum(n.x) && isNum(n.y)
    && isNum(n.gridX) && isNum(n.gridY) && strOrNull(n.role) && isBool(n.talkable) && isBool(n.isAnimal) && isBool(n.isShop))) return false;
  if (!isArr(x.exits) || !x.exits.every(e => isRec(e) && isStr(e.id) && isStr(e.name) && isNum(e.x) && isNum(e.y)
    && isNonEmptyStr(e.targetMapId) && strOrNull(e.targetMapName))) return false;
  const g = x.gatherPoints;
  if (!isRec(g) || !AVAIL.includes(g.status as string) || !isArr(g.points)
    || !g.points.every(p => isRec(p) && isStr(p.id) && isStr(p.name) && isNum(p.x) && isNum(p.y) && numOrNull(p.skillId) && numOrNull(p.requiredToolItemId)
      && (p.source === undefined || isSrcTag(p.source)))
    || !isArr(g.nearby) || !g.nearby.every(n => isRec(n) && isStr(n.pointId) && isNum(n.distance) && isBool(n.withinReach) && numOrNull(n.requiredToolItemId) && isBool(n.haveTool))) return false;
  if (!isWorkBlock(x.work)) return false;
  if (!isArr(x.shops) || !x.shops.every(s => isRec(s) && isStr(s.npcId) && isStr(s.npcName) && AVAIL.includes(s.goodsStatus as string)
    && isArr(s.goods) && s.goods.every(isShopGood))) return false;
  const n = x.nav;
  if (!isRec(n) || !AVAIL.includes(n.status as string) || !isArr(n.reachableMaps)
    || !n.reachableMaps.every(m => isRec(m) && isNonEmptyStr(m.mapId) && strOrNull(m.name) && isNum(m.hops))
    || !numOrNull(n.pixelWidth) || !numOrNull(n.pixelHeight)
    || !isArr(n.portalGraph) || !n.portalGraph.every(p => isRec(p) && isNonEmptyStr(p.mapId) && strOrNull(p.name) && isArr(p.targets) && p.targets.every(isStr))) return false;
  if (!isArr(x.inventory) || !x.inventory.every(i => isRec(i) && isNum(i.itemId) && strOrNull(i.name) && isNum(i.count))) return false;
  const a = x.activity;
  if (!isRec(a)) return false;
  if (a.dialog !== null && !(isRec(a.dialog) && isStr(a.dialog.npcId) && isStr(a.dialog.npcName) && isArr(a.dialog.lines) && a.dialog.lines.every(isStr) && isArr(a.dialog.options) && a.dialog.options.every(isOption))) return false;
  if (a.battleResult !== null && a.battleResult !== 'VICTORY' && a.battleResult !== 'DEFEAT') return false;
  if (a.shop !== null && !(isRec(a.shop) && isStr(a.shop.npcId) && isStr(a.shop.npcName))) return false;
  if (a.battle !== null && !(isRec(a.battle) && isNum(a.battle.battleId) && isNum(a.battle.round) && isArr(a.battle.enemies) && a.battle.enemies.every(isEnemyState) && isBool(a.battle.canFlee))) return false;
  if (a.command !== null && !(isRec(a.command) && isStr(a.command.commandId) && isStr(a.command.type))) return false;
  if (a.work !== null && !isWorkInProgress(a.work)) return false;
  return true;
}

function isEnvelope(x: unknown): x is Rec & { v: number; characterId: string; ts: number; kind: string } {
  return isRec(x) && isNum(x.v) && isNonEmptyStr(x.characterId) && isNum(x.ts) && isStr(x.kind);
}

export function isHeartbeatMessage(x: unknown): x is HeartbeatMessage {
  return isEnvelope(x) && x.kind === 'heartbeat' && isNonEmptyStr(x.sessionId) && isNum(x.seq)
    && strOrNull(x.mapId) && (x.phase === 'OPENING' || x.phase === 'PLAYING') && isBool(x.inBattle);
}

export function isSnapshotMessage(x: unknown): x is SnapshotMessage {
  return isEnvelope(x) && x.kind === 'snapshot' && isNum(x.seq)
    && ['STARTED', 'MAP_CHANGED', 'SCENE_RELOADED', 'REQUESTED', 'PHASE_CHANGED'].includes(x.reason as string)
    && (x.inReplyTo === undefined || isStr(x.inReplyTo)) && isSceneSnapshot(x.snapshot);
}

export function isEventMessage(x: unknown): x is EventMessage {
  return isEnvelope(x) && x.kind === 'event' && isNum(x.seq) && isGameEvent(x.event);
}

export function isCommandMessage(x: unknown): x is CommandMessage {
  return isEnvelope(x) && x.kind === 'command' && isNonEmptyStr(x.commandId) && isPluginCommand(x.command);
}

export function isCommandResultMessage(x: unknown): x is CommandResultMessage {
  return isEnvelope(x) && x.kind === 'command-result' && isNonEmptyStr(x.commandId)
    && (x.status === 'ACCEPTED' || x.status === 'REJECTED')
    && (x.reasonCode === undefined || (REJECT_REASON_CODES as readonly string[]).includes(x.reasonCode as string))
    && (x.message === undefined || isStr(x.message)) && (x.duplicate === undefined || isBool(x.duplicate));
}

/** 任一種協定訊息（不檢查版本號是否相容，見 `isCompatibleVersion`）。 */
export function isPluginMessage(x: unknown): x is PluginMessage {
  return isHeartbeatMessage(x) || isSnapshotMessage(x) || isEventMessage(x) || isCommandMessage(x) || isCommandResultMessage(x);
}

/** 目前只有一版；日後相容規則改在這裡。 */
export function isCompatibleVersion(v: number): boolean {
  return v === PROTOCOL_VERSION;
}
