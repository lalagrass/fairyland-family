// [sync-protocol] 自動產生，請勿手改；改協定請到 fairyland 修改後重新執行 npm run sync-protocol
// [sync-protocol] 來源：fairyland/packages/shared/src/protocol/guards.ts @ 1dfff18543e2d88d22d9b1827b3ab76c2a8950c3
/**
 * FX1：協定的執行期檢核（手寫型別守衛，不依賴任何套件）。
 * 宿主與外掛都用同一份：收到的訊息先過守衛，通過才當成型別化資料使用。
 */
import {
  GAME_EVENT_TYPES,
  PLUGIN_COMMAND_TYPES,
  PROTOCOL_VERSION,
  REJECT_REASON_CODES,
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
    case 'WORK_ONCE': return optNum(x.skillId) && optNum(x.recipeId) && (x.skillId !== undefined || x.recipeId !== undefined);
    case 'BATTLE_ACTION': return optNum(x.battleId) && isRec(x.actions);
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
        && isArr(x.options) && x.options.every(o => isRec(o) && isStr(o.id) && isStr(o.label)) && isBool(x.optionsAvailable);
    case 'DIALOG_CLOSED': return isStr(x.npcId);
    case 'BATTLE_STARTED':
      return isNum(x.battleId) && isNonEmptyStr(x.mapId) && isArr(x.enemies)
        && x.enemies.every(e => isRec(e) && isStr(e.id) && isStr(e.name) && numOrNull(e.level));
    case 'BATTLE_ENDED': return isNum(x.battleId) && ['WIN', 'LOSE', 'FLEE', 'UNKNOWN'].includes(x.outcome as string);
    case 'BATTLE_TURN_READY': return isNum(x.battleId) && isNum(x.round);
    case 'INVENTORY_CHANGED':
      return isArr(x.changes) && x.changes.every(c => isRec(c) && isNum(c.itemId) && isNum(c.delta) && isNum(c.count));
    case 'GOLD_CHANGED': return isNum(x.gold) && isNum(x.delta);
    case 'COMMAND_ACCEPTED': return isNonEmptyStr(x.commandId);
    case 'COMMAND_REJECTED':
      return isNonEmptyStr(x.commandId) && (REJECT_REASON_CODES as readonly string[]).includes(x.reasonCode as string)
        && (x.message === undefined || isStr(x.message));
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
    || !g.points.every(p => isRec(p) && isStr(p.id) && isStr(p.name) && isNum(p.x) && isNum(p.y) && numOrNull(p.skillId) && numOrNull(p.requiredToolItemId))) return false;
  if (!isArr(x.shops) || !x.shops.every(s => isRec(s) && isStr(s.npcId) && isStr(s.npcName) && AVAIL.includes(s.goodsStatus as string)
    && isArr(s.goods) && s.goods.every(w => isRec(w) && isNum(w.itemId) && strOrNull(w.name) && isNum(w.price)))) return false;
  const n = x.nav;
  if (!isRec(n) || !AVAIL.includes(n.status as string) || !isArr(n.reachableMaps)
    || !n.reachableMaps.every(m => isRec(m) && isNonEmptyStr(m.mapId) && strOrNull(m.name) && isNum(m.hops))
    || !numOrNull(n.pixelWidth) || !numOrNull(n.pixelHeight)) return false;
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
