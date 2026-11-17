// [sync-protocol] 自動產生，請勿手改；改協定請到 fairyland 修改後重新執行 npm run sync-protocol
// [sync-protocol] 來源：fairyland/packages/shared/src/protocol/guards.ts @ 78ea40f9b6fb792d0516c0af9144d4dbd520fa8b
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
  type CommandMessage,
  type CommandResultMessage,
  type EventMessage,
  type GameEvent,
  type HeartbeatMessage,
  type PluginCommand,
  type PluginMessage,
  type SceneSnapshot,
  type SnapshotMessage,
  type StaticDataMessage,
} from './types.js';

type Rec = Record<string, unknown>;

const isRec = (x: unknown): x is Rec => typeof x === 'object' && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === 'string';
const isNonEmptyStr = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isBool = (x: unknown): x is boolean => typeof x === 'boolean';
const isArr = (x: unknown): x is unknown[] => Array.isArray(x);
const optNum = (x: unknown): boolean => x === undefined || isNum(x);
const optStr = (x: unknown): boolean => x === undefined || isStr(x);
const strOrNull = (x: unknown): boolean => x === null || isStr(x);
const numOrNull = (x: unknown): boolean => x === null || isNum(x);
const isOption = (o: unknown): boolean => isRec(o) && isStr(o.id) && isStr(o.label);
const optBool = (x: unknown): boolean => x === undefined || isBool(x);
const VISUAL_ACTIONS = ['IDLE', 'WALK', 'WORK', 'BATTLE'];
const isVisualActionOrUndef = (x: unknown): boolean => x === undefined || VISUAL_ACTIONS.includes(x as string);
const isTriplet = (x: unknown): boolean => isArr(x) && x.length === 3 && x.every(isNum);
const isRampTintOrUndef = (x: unknown): boolean =>
  x === undefined || (isRec(x) && isTriplet(x.hair) && isTriplet(x.skin) && isTriplet(x.outfit));
const isMovePath = (p: unknown): boolean =>
  isRec(p)
  && isArr(p.waypoints)
  && p.waypoints.every(w => isRec(w) && isNum(w.x) && isNum(w.y))
  && isNum(p.startedAt)
  && isNum(p.endsAt)
  && optNum(p.speedPxPerSec);
const isMovePathOrNullOrUndef = (x: unknown): boolean => x === undefined || x === null || isMovePath(x);
const isBattleStatus = (s: unknown): boolean =>
  isRec(s) && isNonEmptyStr(s.type) && isNum(s.duration) && optNum(s.value) && optNum(s.stacks);
const isStatusArrayOrUndef = (x: unknown): boolean =>
  x === undefined || (isArr(x) && x.every(isBattleStatus));
const isBattleUnitSummary = (u: unknown): boolean =>
  isRec(u) && isStr(u.id) && isStr(u.name) && isNum(u.hp) && isNum(u.maxHp)
  && optNum(u.mp) && optNum(u.maxMp) && optNum(u.slot)
  && (u.row === undefined || u.row === 'FRONT' || u.row === 'BACK')
  && optStr(u.modelId) && optStr(u.weaponModel) && optStr(u.colorTint)
  && optBool(u.isDead) && optBool(u.isDefending) && optBool(u.isChanting)
  && isStatusArrayOrUndef(u.statuses);
const isEnemyState = (e: unknown): boolean =>
  isRec(e) && isNum(e.slot) && isStr(e.id) && isStr(e.name) && isNum(e.hp) && isNum(e.maxHp)
  && (e.row === undefined || e.row === 'FRONT' || e.row === 'BACK')
  && optStr(e.modelId) && optStr(e.colorTint)
  && optBool(e.isDead) && optBool(e.isDefending) && optBool(e.isChanting) && isStatusArrayOrUndef(e.statuses);
const isTimelineItem = (t: unknown): boolean =>
  isRec(t) && isNum(t.tMs) && isNonEmptyStr(t.type)
  && optStr(t.actorId) && optStr(t.targetId)
  && (t.targetIds === undefined || (isArr(t.targetIds) && t.targetIds.every(isStr)))
  && optStr(t.actionName) && optNum(t.skillId) && optStr(t.effectId)
  && optNum(t.damage) && optNum(t.heal) && optBool(t.isCrit) && optBool(t.isCombo)
  && optNum(t.comboIndex) && optNum(t.comboTotal) && optStr(t.statusType) && optBool(t.isCaptured) && optStr(t.message);
const isActiveWork = (w: unknown): boolean =>
  isRec(w) && (w.kind === 'GATHER' || w.kind === 'CRAFT')
  && optNum(w.skillId) && optNum(w.recipeId) && optNum(w.targetItemId)
  && isStr(w.label) && isNum(w.startedAt) && isNum(w.endsAt);
const isTargetMapHint = (h: unknown): boolean =>
  isRec(h) && isNonEmptyStr(h.mapId) && strOrNull(h.mapName)
  && (h.reason === 'ENCOUNTER_AREA' || h.reason === 'ENCOUNTER_POOL' || h.reason === 'GATHER_POINT')
  && optNum(h.x) && optNum(h.y)
  && (h.pools === undefined || (isArr(h.pools) && h.pools.every(isStr)));
const isQuestEntry = (q: unknown): boolean =>
  isRec(q) && isNum(q.questId) && isStr(q.title) && isStr(q.npcId) && isStr(q.npcName) && isNum(q.minLevel)
  && ['AVAILABLE', 'IN_PROGRESS', 'READY', 'COMPLETED'].includes(q.status as string)
  && (q.prerequisites === undefined || (isArr(q.prerequisites) && q.prerequisites.every(isNum)))
  && isArr(q.objectives)
  && q.objectives.every(o =>
    isRec(o) && isStr(o.type) && isStr(o.description) && isNum(o.current) && isNum(o.required) && isBool(o.met)
    && (o.targetMaps === undefined || (isArr(o.targetMaps) && o.targetMaps.every(isTargetMapHint))))
  && isNum(q.rewardExp) && isNum(q.rewardCoins);

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
    case 'WORK_ONCE': return optNum(x.skillId) && optNum(x.recipeId) && optNum(x.targetItemId) && (x.skillId !== undefined || x.recipeId !== undefined);
    case 'BATTLE_ACTION': {
      const a = x.action;
      return optNum(x.battleId) && isRec(a) && (BATTLE_ACTION_KINDS as readonly string[]).includes(a.kind as string)
        && optNum(a.targetSlot) && optNum(a.skillId) && optNum(a.spellId) && optNum(a.itemId) && optNum(a.sealStoneId);
    }
    case 'BATTLE_FLEE': return optNum(x.battleId);
    case 'REQUEST_SNAPSHOT': return optBool(x.includeStatic);
    case 'REQUEST_STATIC_DATA': return true;
    case 'SWITCH_VIEW_CHARACTER': return isNonEmptyStr(x.characterId);
    case 'WAREHOUSE_DEPOSIT':
    case 'WAREHOUSE_WITHDRAW':
      return optNum(x.itemId) && optNum(x.count) && optNum(x.gold) && (x.itemId !== undefined || x.gold !== undefined);
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
    case 'MOVED':
      return isNonEmptyStr(x.mapId) && isNum(x.x) && isNum(x.y) && isNum(x.dir)
        && isVisualActionOrUndef(x.action) && isMovePathOrNullOrUndef(x.movePath);
    case 'DIALOG_OPENED':
      return isStr(x.npcId) && isStr(x.npcName) && strOrNull(x.role) && isArr(x.lines) && x.lines.every(isStr)
        && isArr(x.options) && x.options.every(isOption) && isBool(x.optionsAvailable);
    case 'DIALOG_UPDATED': return isStr(x.npcId) && isArr(x.lines) && x.lines.every(isStr) && isArr(x.options) && x.options.every(isOption);
    case 'DIALOG_CLOSED': return isStr(x.npcId);
    case 'SHOP_OPENED':
      return isStr(x.npcId) && isStr(x.npcName) && isArr(x.goods)
        && x.goods.every(w => isRec(w) && isNum(w.itemId) && strOrNull(w.name) && isNum(w.price));
    case 'SHOP_CLOSED': return isStr(x.npcId);
    case 'BATTLE_STARTED':
      return isNum(x.battleId) && isNonEmptyStr(x.mapId) && isArr(x.enemies)
        && x.enemies.every(e => isRec(e) && isStr(e.id) && isStr(e.name) && numOrNull(e.level) && optNum(e.slot) && optStr(e.modelId) && optStr(e.colorTint))
        && (x.allies === undefined || (isArr(x.allies) && x.allies.every(isBattleUnitSummary)));
    case 'BATTLE_ENDED': return isNum(x.battleId) && ['WIN', 'LOSE', 'FLEE', 'UNKNOWN'].includes(x.outcome as string);
    case 'BATTLE_TIMELINE':
      return isNum(x.battleId) && isNum(x.round) && isArr(x.events) && x.events.every(isTimelineItem);
    case 'BATTLE_TURN_READY':
      return isNum(x.battleId) && isNum(x.round) && isArr(x.enemies) && x.enemies.every(isEnemyState) && isBool(x.canFlee)
        && (x.player === undefined || isBattleUnitSummary(x.player))
        && (x.pet === undefined || x.pet === null || isBattleUnitSummary(x.pet));
    case 'INVENTORY_CHANGED':
      return isArr(x.changes) && x.changes.every(c => isRec(c) && isNum(c.itemId) && isNum(c.delta) && isNum(c.count));
    case 'GOLD_CHANGED': return isNum(x.gold) && isNum(x.delta);
    case 'WAREHOUSE_CHANGED':
      return isArr(x.items) && x.items.every(i => isRec(i) && isNum(i.itemId) && strOrNull(i.name) && isNum(i.count)) && isNum(x.gold);
    case 'ACTIVE_CHARACTER_CHANGED':
      return isNonEmptyStr(x.characterId);
    case 'COMMAND_ACCEPTED': return isNonEmptyStr(x.commandId);
    case 'COMMAND_REJECTED':
      return isNonEmptyStr(x.commandId) && (REJECT_REASON_CODES as readonly string[]).includes(x.reasonCode as string)
        && (x.message === undefined || isStr(x.message));
    case 'COMMAND_COMPLETED':
      return isNonEmptyStr(x.commandId) && (COMPLETION_OUTCOMES as readonly string[]).includes(x.outcome as string)
        && (COMPLETION_CODES as readonly string[]).includes(x.code as string) && (x.message === undefined || isStr(x.message));
    default: return false;
  }
}

const AVAIL = ['AVAILABLE', 'UNAVAILABLE', 'RECONSTRUCTED_DEMO'];

const isGatherPoint = (p: unknown): boolean =>
  isRec(p) && isStr(p.id) && isStr(p.name) && isNum(p.x) && isNum(p.y) && numOrNull(p.skillId) && numOrNull(p.requiredToolItemId)
  && (p.materials === undefined || (isArr(p.materials) && p.materials.every(m => isRec(m) && isNum(m.itemId) && isStr(m.name) && isNum(m.reqLevel))));

const isWorkRecipe = (r: unknown): boolean =>
  isRec(r) && isNum(r.recipeId) && isNum(r.resultItemId) && isStr(r.name) && isNum(r.skillId) && isNum(r.reqLevel)
  && isArr(r.ingredients) && isArr(r.unresolvedIngredients);

/** 場景快照內容。只檢核外掛會用到的結構，不做資料語意檢查。 */
export function isSceneSnapshot(x: unknown): x is SceneSnapshot {
  if (!isRec(x) || x.schema !== 'scene-snapshot' || !isNonEmptyStr(x.mapId) || !strOrNull(x.mapName)) return false;
  const c = x.character;
  if (!isRec(c) || !strOrNull(c.name) || !isNum(c.level) || !numOrNull(c.hp) || !numOrNull(c.maxHp)
    || !numOrNull(c.mp) || !numOrNull(c.maxMp) || !isNum(c.gold) || !isNum(c.x) || !isNum(c.y) || !isNum(c.dir) || !isBool(c.inBattle)
    || !optStr(c.modelId) || !optStr(c.weaponModel) || !isRampTintOrUndef(c.tint)
    || !isVisualActionOrUndef(c.action) || !isMovePathOrNullOrUndef(c.movePath)
    || !optNum(c.satiety) || !optNum(c.maxSatiety) || !optNum(c.inventoryCount) || !optNum(c.inventoryCap)
    || (c.workSkills !== undefined && !isRec(c.workSkills))
    || (c.activeWork !== undefined && c.activeWork !== null && !isActiveWork(c.activeWork))
    || (c.ruleset !== undefined && c.ruleset !== 'classic' && c.ruleset !== 'revamp')
    || !optStr(c.className)
    || (c.weaponFamily !== undefined && !isStr(c.weaponFamily))
    || !optNum(c.familyLevel) || !optNum(c.comboLevel)
    || (c.masteryLevels !== undefined && !isRec(c.masteryLevels))
    || !isStatusArrayOrUndef(c.statuses)
    || !optBool(c.isDefending)
    || !optBool(c.isChanting)
    || (c.activePet !== undefined && c.activePet !== null && !isBattleUnitSummary(c.activePet))) return false;
  if (!isArr(x.npcs) || !x.npcs.every(n => isRec(n) && isStr(n.id) && isStr(n.name) && isNum(n.x) && isNum(n.y)
    && isNum(n.gridX) && isNum(n.gridY) && strOrNull(n.role) && isBool(n.talkable) && isBool(n.isAnimal) && isBool(n.isShop))) return false;
  if (!isArr(x.exits) || !x.exits.every(e => isRec(e) && isStr(e.id) && isStr(e.name) && isNum(e.x) && isNum(e.y)
    && isNonEmptyStr(e.targetMapId) && strOrNull(e.targetMapName))) return false;
  const g = x.gatherPoints;
  if (!isRec(g) || !AVAIL.includes(g.status as string) || !isArr(g.points) || !g.points.every(isGatherPoint)) return false;
  if (x.nearbyGatherPoints !== undefined && (!isArr(x.nearbyGatherPoints) || !x.nearbyGatherPoints.every(isGatherPoint))) return false;
  if (x.recipes !== undefined && (!isArr(x.recipes) || !x.recipes.every(isWorkRecipe))) return false;
  if (!isArr(x.shops) || !x.shops.every(s => isRec(s) && isStr(s.npcId) && isStr(s.npcName) && AVAIL.includes(s.goodsStatus as string)
    && isArr(s.goods) && s.goods.every(w => isRec(w) && isNum(w.itemId) && strOrNull(w.name) && isNum(w.price)))) return false;
  const n = x.nav;
  if (!isRec(n) || !AVAIL.includes(n.status as string) || !isArr(n.reachableMaps)
    || !n.reachableMaps.every(m => isRec(m) && isNonEmptyStr(m.mapId) && strOrNull(m.name) && isNum(m.hops))
    || !numOrNull(n.pixelWidth) || !numOrNull(n.pixelHeight)
    || (n.portalGraph !== undefined && (!isArr(n.portalGraph) || !n.portalGraph.every(p => isRec(p) && isNonEmptyStr(p.mapId) && strOrNull(p.name) && isArr(p.targets) && p.targets.every(isStr))))) return false;
  if (!isArr(x.inventory) || !x.inventory.every(i => isRec(i) && isNum(i.itemId) && strOrNull(i.name) && isNum(i.count))) return false;
  if (x.family !== undefined) {
    const f = x.family;
    const isItem = (i: unknown): boolean => isRec(i) && isNum(i.itemId) && strOrNull(i.name) && isNum(i.count);
    const isMember = (m: unknown): boolean =>
      isRec(m) && isNonEmptyStr(m.characterId) && strOrNull(m.name) && isNum(m.level)
      && isNonEmptyStr(m.mapId) && strOrNull(m.mapName) && isNum(m.x) && isNum(m.y)
      && optNum(m.dir) && optStr(m.modelId) && optStr(m.weaponModel) && isRampTintOrUndef(m.tint)
      && isVisualActionOrUndef(m.action) && isMovePathOrNullOrUndef(m.movePath)
      && isNum(m.gold) && isNum(m.satiety) && isNum(m.inventoryCount) && isNum(m.inventoryCap)
      && isBool(m.inBattle) && isArr(m.inventory) && m.inventory.every(isItem) && isRec(m.workSkills)
      && (m.activeWork === undefined || m.activeWork === null || isActiveWork(m.activeWork));
    if (!isRec(f) || !isNonEmptyStr(f.activeCharacterId) || !isNum(f.maxSlots)
      || !isArr(f.members) || !f.members.every(isMember)
      || !isRec(f.warehouse) || !isNum(f.warehouse.gold) || !isNum(f.warehouse.cap)
      || !isArr(f.warehouse.items) || !f.warehouse.items.every(isItem)) return false;
  }
  const a = x.activity;
  if (!isRec(a)) return false;
  if (a.dialog !== null && !(isRec(a.dialog) && isStr(a.dialog.npcId) && isStr(a.dialog.npcName) && isArr(a.dialog.lines) && a.dialog.lines.every(isStr) && isArr(a.dialog.options) && a.dialog.options.every(isOption))) return false;
  if (a.battleResult !== null && a.battleResult !== 'VICTORY' && a.battleResult !== 'DEFEAT') return false;
  if (a.shop !== null && !(isRec(a.shop) && isStr(a.shop.npcId) && isStr(a.shop.npcName))) return false;
  if (a.battle !== null && !(isRec(a.battle) && isNum(a.battle.battleId) && isNum(a.battle.round) && isArr(a.battle.enemies) && a.battle.enemies.every(isEnemyState) && isBool(a.battle.canFlee)
    && (a.battle.player === undefined || isBattleUnitSummary(a.battle.player))
    && (a.battle.pet === undefined || a.battle.pet === null || isBattleUnitSummary(a.battle.pet)))) return false;
  if (a.command !== null && !(isRec(a.command) && isStr(a.command.commandId) && isStr(a.command.type))) return false;
  if (x.openingStage !== undefined && !isStr(x.openingStage)) return false;
  if (x.quests !== undefined && (!isArr(x.quests) || !x.quests.every(isQuestEntry))) return false;
  return true;
}

function isEnvelope(x: unknown): x is Rec & { v: number; characterId: string; ts: number; kind: string } {
  return isRec(x) && isNum(x.v) && isNonEmptyStr(x.characterId) && isNum(x.ts) && isStr(x.kind);
}

const isPortalNode = (p: unknown): boolean =>
  isRec(p) && isNonEmptyStr(p.mapId) && strOrNull(p.name) && isArr(p.targets) && p.targets.every(isStr);

const isStaticSkillSummary = (s: unknown): boolean =>
  isRec(s) && isNum(s.id) && isStr(s.name) && (s.kind === 'SKILL' || s.kind === 'SPELL')
  && isNum(s.mpCost) && isStr(s.targetScope) && optNum(s.maxTargets) && optStr(s.element)
  && optStr(s.animId) && optStr(s.weaponFamily) && optNum(s.reqLevel);

const isStaticAssetManifest = (a: unknown): boolean =>
  isRec(a) && isStr(a.version) && isStr(a.baseUrl) && a.readOnly === true && isRec(a.paths)
  && isStr(a.paths.spriteManifest) && isStr(a.paths.spriteAtlas) && isStr(a.paths.mapScene) && isStr(a.paths.mapAsset)
  && isStr(a.paths.spellManifest) && isStr(a.paths.spellAtlas) && isStr(a.paths.worldCatalog)
  && isStr(a.paths.battleBg) && isStr(a.paths.itemIcon) && isStr(a.paths.digitsManifest)
  && isArr(a.spriteLayerOrder) && a.spriteLayerOrder.every(isStr)
  && isArr(a.supportedBlendModes) && a.supportedBlendModes.every(b => ['normal', 'additive', 'screen', 'luma_alpha'].includes(b as string));

export function isHeartbeatMessage(x: unknown): x is HeartbeatMessage {
  return isEnvelope(x) && x.kind === 'heartbeat' && isNonEmptyStr(x.sessionId) && isNum(x.seq)
    && strOrNull(x.mapId) && (x.phase === 'OPENING' || x.phase === 'PLAYING') && isBool(x.inBattle) && optBool(x.clockOnly);
}

export function isSnapshotMessage(x: unknown): x is SnapshotMessage {
  return isEnvelope(x) && x.kind === 'snapshot' && isNum(x.seq)
    && ['STARTED', 'MAP_CHANGED', 'SCENE_RELOADED', 'REQUESTED', 'PHASE_CHANGED'].includes(x.reason as string)
    && (x.inReplyTo === undefined || isStr(x.inReplyTo)) && isSceneSnapshot(x.snapshot);
}

export function isStaticDataMessage(x: unknown): x is StaticDataMessage {
  if (!isEnvelope(x) || x.kind !== 'static-data' || !isNum(x.seq) || !(x.inReplyTo === undefined || isStr(x.inReplyTo))) return false;
  const d = x.staticData;
  return isRec(d) && d.schema === 'static-data' && isStr(d.version)
    && isArr(d.recipes) && d.recipes.every(isWorkRecipe)
    && isArr(d.portalGraph) && d.portalGraph.every(isPortalNode)
    && isArr(d.skills) && d.skills.every(isStaticSkillSummary)
    && isStaticAssetManifest(d.assets);
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
  return isHeartbeatMessage(x) || isSnapshotMessage(x) || isStaticDataMessage(x) || isEventMessage(x) || isCommandMessage(x) || isCommandResultMessage(x);
}

/** 目前只有一版；日後相容規則改在這裡。 */
export function isCompatibleVersion(v: number): boolean {
  return v === PROTOCOL_VERSION;
}
