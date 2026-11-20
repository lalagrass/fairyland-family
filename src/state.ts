import {
  HEARTBEAT_TIMEOUT_MS,
  isCommandResultMessage,
  isCompatibleVersion,
  isEventMessage,
  isHeartbeatMessage,
  isSnapshotMessage,
  isStaticDataMessage,
  type CommandMessage,
  type GameEvent,
  type BattleEnemyBrief,
  type BattleEnemyState,
  type BattleTimelineItem,
  type DialogOption,
  type PluginCommand,
  type SceneSnapshot,
  type SnapshotBattleUnitSummary,
  type SnapshotCharacter,
  type SnapshotFamilyMember,
  type SnapshotItem,
  type SnapshotShopGood,
  type StaticDataPayload,
} from './protocol/index';

export type LogTag = '連線' | '事件' | '快照' | '送出' | '結果' | '系統';

export interface LogEntry {
  id: number;
  at: number;
  tag: LogTag;
  text: string;
  commandId?: string;
  characterId?: string;
  level: 'info' | 'warn' | 'error';
}

export interface FamilyState {
  /** 最近一次心跳的「本機收到時間」（不信任對方時鐘）。 */
  lastHeartbeatAt: number | null;
  sessionId: string | null;
  /** 收到明確的 GAME_STOPPED 的那一個 session，在它之後的心跳不算數。 */
  stoppedSessionId: string | null;
  phase: 'OPENING' | 'PLAYING' | null;
  characterId: string | null;
  location: { mapId: string; mapName: string | null } | null;
  snapshot: SceneSnapshot | null;
  snapshotAt: number | null;
  /** FX15：連線時領取一次的靜態資料（配方、傳送圖、技能、素材清單）。 */
  staticData: StaticDataPayload | null;
  /** FX16：宿主是否處於 ?clock=1 無畫面時鐘模式。 */
  clockOnly: boolean;
  character: SnapshotCharacter | null;
  dialog: { npcId: string; npcName: string; lines: string[]; options: DialogOption[] } | null;
  shop: { npcId: string; npcName: string; goods: SnapshotShopGood[] } | null;
  battle: {
    battleId: number;
    round: number | null;
    enemies: string[];
    enemyStates: BattleEnemyState[];
    enemyVisuals?: BattleEnemyBrief[];
    allies?: SnapshotBattleUnitSummary[];
    player?: SnapshotBattleUnitSummary;
    pet?: SnapshotBattleUnitSummary | null;
    canFlee: boolean;
    ready: boolean;
    timeline?: {
      battleId: number;
      round: number;
      events: BattleTimelineItem[];
      receivedAt: number;
    } | null;
  } | null;
  /** 戰鬥後的勝敗結算視窗（要送 RETURN_TO_MAP／DEFEAT_RESCUE 才會關）。 */
  battleResult: 'VICTORY' | 'DEFEAT' | null;
  inventory: SnapshotItem[];
  /** FX4+FX7：家族成員清單、目前觀察角色 ID 與家族共用倉庫。 */
  members: SnapshotFamilyMember[];
  activeCharacterId: string | null;
  warehouse: { gold: number; cap: number; items: SnapshotItem[] } | null;
  /** 最新事件推導出的即時欄位，用來在 compare-panel 與最近快照做雙向比對。 */
  eventMirror: {
    mapId: string | null;
    mapName: string | null;
    gold: number | null;
    x: number | null;
    y: number | null;
    inventoryCount: number | null;
  };
  /** 已送出、還沒收到結果的指令。 */
  pending: Record<string, { label: string; sentAt: number; expect?: string }>;
  /** 已被接受、等待 COMMAND_COMPLETED 的指令（記著「預期」，完成時與「實際」對照）。 */
  inflight: Record<string, { label: string; sentAt: number; expect: string }>;
  log: LogEntry[];
  logSeq: number;
}

const LOG_CAP = 300;

export function initialState(): FamilyState {
  return {
    lastHeartbeatAt: null, sessionId: null, stoppedSessionId: null, phase: null, characterId: null, location: null,
    snapshot: null, snapshotAt: null, staticData: null, clockOnly: false, character: null, dialog: null, shop: null, battle: null, battleResult: null, inventory: [],
    members: [], activeCharacterId: null, warehouse: null,
    eventMirror: { mapId: null, mapName: null, gold: null, x: null, y: null, inventoryCount: null },
    pending: {}, inflight: {}, log: [], logSeq: 0,
  };
}

/** 遊戲執行中＝最近 3 秒內收到心跳，且該 session 沒有被明確停止。 */
export function connectionStatus(s: FamilyState, now: number): 'RUNNING' | 'STOPPED' {
  if (s.lastHeartbeatAt === null) return 'STOPPED';
  if (s.sessionId !== null && s.sessionId === s.stoppedSessionId) return 'STOPPED';
  return now - s.lastHeartbeatAt <= HEARTBEAT_TIMEOUT_MS ? 'RUNNING' : 'STOPPED';
}

export function addLog(
  s: FamilyState,
  tag: LogTag,
  text: string,
  now: number,
  extra: { commandId?: string; characterId?: string; level?: LogEntry['level'] } = {},
): FamilyState {
  const entry: LogEntry = {
    id: s.logSeq + 1,
    at: now,
    tag,
    text,
    commandId: extra.commandId,
    ...(extra.characterId ? { characterId: extra.characterId } : {}),
    level: extra.level ?? 'info',
  };
  const log = [...s.log, entry];
  if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP);
  return { ...s, log, logSeq: entry.id };
}

/** 把「我送出了一個指令」記進狀態（日誌與待回覆表）。 */
export function applySent(s: FamilyState, msg: CommandMessage, label: string, now: number, expect?: string): FamilyState {
  const exp = expect ?? expectedCode(msg.command);
  const next = addLog(s, '送出', `${label}　${JSON.stringify(msg.command)}${exp ? `　（預期：${exp}）` : ''}`, now, {
    commandId: msg.commandId,
    characterId: msg.characterId,
  });
  let out: FamilyState = { ...next, pending: { ...next.pending, [msg.commandId]: { label, sentAt: now, ...(exp ? { expect: exp } : {}) } } };
  const c = msg.command;
  // 送出戰鬥動作後，這一回合就不能再送；結算視窗選項送出後視窗視為關閉（下一份快照會校正）。
  if ((c.type === 'BATTLE_ACTION' || c.type === 'BATTLE_FLEE') && out.battle) out = { ...out, battle: { ...out.battle, ready: false } };
  if (c.type === 'CHOOSE_DIALOG_OPTION' && (c.optionId === 'RETURN_TO_MAP' || c.optionId === 'DEFEAT_RESCUE')) out = { ...out, battleResult: null };
  return out;
}

/** 每種指令「正常情況下」會以哪個完成碼收場（導航走到出口時由呼叫端覆寫成 MAP_CHANGED）。 */
export function expectedCode(c: PluginCommand): string | undefined {
  switch (c.type) {
    case 'WALK_TO': return 'ARRIVED';
    case 'TALK_TO_NPC': return 'DIALOG_OPENED';
    case 'CHOOSE_DIALOG_OPTION': case 'ACCEPT_QUEST': case 'BUY_ITEM': case 'SELL_ITEM': return 'DONE';
    case 'BATTLE_ACTION': return 'TURN_SUBMITTED';
    case 'BATTLE_FLEE': return 'FLED';
    default: return undefined;
  }
}

export function describeEvent(e: GameEvent): string {
  switch (e.type) {
    case 'GAME_STARTED': return '遊戲開始';
    case 'GAME_STOPPED': return `遊戲停止（${e.reason}）`;
    case 'LOCATION_CHANGED': return `移動到 ${e.mapName ?? e.mapId}（${e.cause === 'MAP_CHANGE' ? '換圖' : e.cause === 'WARP' ? '傳送' : '載入'}）(${e.x}, ${e.y})`;
    case 'MOVED': return `走到 (${e.x}, ${e.y})`;
    case 'DIALOG_OPENED': return `與 ${e.npcName} 對話：${e.lines[0] ?? '（沒有對白）'}${e.optionsAvailable ? `［選項：${e.options.map(o => o.label).join('／') || '無'}］` : '（選項未提供）'}`;
    case 'DIALOG_UPDATED': return `對話更新：${e.lines[0] ?? ''}［選項：${e.options.map(o => o.label).join('／') || '無'}］`;
    case 'DIALOG_CLOSED': return '對話結束';
    case 'SHOP_OPENED': return `商店開啟：${e.npcName}（${e.goods.length} 項商品）`;
    case 'SHOP_CLOSED': return '商店關閉';
    case 'BATTLE_STARTED': return `遭遇戰鬥 #${e.battleId}：${e.enemies.map(n => n.name).join('、') || '？'}`;
    case 'BATTLE_TIMELINE': return `戰鬥 #${e.battleId} 第 ${e.round} 回合演出（${e.events.length} 步）`;
    case 'BATTLE_ENDED': return `戰鬥 #${e.battleId} 結束：${e.outcome === 'WIN' ? '勝利' : e.outcome === 'LOSE' ? '落敗' : e.outcome === 'FLEE' ? '逃跑' : '未知'}`;
    case 'BATTLE_TURN_READY': return `戰鬥 #${e.battleId} 第 ${e.round} 回合就緒：${e.enemies.map(n => `${n.name}(${n.hp}/${n.maxHp})`).join('、')}${e.canFlee ? '' : '（不可逃跑）'}`;
    case 'INVENTORY_CHANGED': return `道具變動：${e.changes.map(c => `#${c.itemId} ${c.delta >= 0 ? '+' : ''}${c.delta}（共 ${c.count}）`).join('、')}`;
    case 'GOLD_CHANGED': return `金錢 ${e.delta >= 0 ? '+' : ''}${e.delta}，現有 ${e.gold}`;
    case 'WAREHOUSE_CHANGED': return `家族倉庫：金錢 ${e.gold}，物品 ${e.items.length} 種`;
    case 'ACTIVE_CHARACTER_CHANGED': return `切換視角角色：${e.characterId}`;
    case 'COMMAND_ACCEPTED': return '指令已接受';
    case 'COMMAND_REJECTED': return `指令被拒絕：${e.reasonCode}${e.message ? `（${e.message}）` : ''}`;
    case 'COMMAND_COMPLETED': return `指令完成：${e.outcome} ${e.code}${e.message ? `（${e.message}）` : ''}`;
  }
}

/**
 * 套用收到的一則原始訊息，回傳新狀態（純函式，`now` 由呼叫端提供）。
 * 通不過守衛或版本不符的訊息只記一筆警告，不改狀態。
 */
export function applyMessage(s: FamilyState, raw: unknown, now: number): FamilyState {
  const v = (raw as { v?: unknown } | null)?.v;
  if (typeof v === 'number' && !isCompatibleVersion(v)) {
    return addLog(s, '系統', `忽略不相容的協定版本 ${v}`, now, { level: 'warn' });
  }
  if (isHeartbeatMessage(raw)) {
    let next = s;
    if (s.characterId !== null && s.characterId !== raw.characterId) next = resetForNewCharacter(next, raw.characterId);
    const fresh = raw.sessionId !== s.sessionId;
    const wasDown = connectionStatus(s, now) === 'STOPPED';
    next = { ...next, characterId: raw.characterId, phase: raw.phase, sessionId: raw.sessionId, clockOnly: Boolean(raw.clockOnly), lastHeartbeatAt: now };
    if (fresh && raw.sessionId !== next.stoppedSessionId) next = { ...next, stoppedSessionId: null };
    if (raw.mapId && !next.location) next = { ...next, location: { mapId: raw.mapId, mapName: null } };
    if (wasDown && connectionStatus(next, now) === 'RUNNING') next = addLog(next, '連線', '遊戲執行中', now, { characterId: raw.characterId });
    return next;
  }
  if (isStaticDataMessage(raw)) {
    const next = { ...s, staticData: raw.staticData };
    return addLog(
      next,
      '快照',
      `靜態資料已同步（配方 ${raw.staticData.recipes.length}、地圖 ${raw.staticData.portalGraph.length}、技能 ${raw.staticData.skills.length}）`,
      now,
      { commandId: raw.inReplyTo, characterId: raw.characterId },
    );
  }
  if (isSnapshotMessage(raw)) {
    let next = s.characterId !== null && s.characterId !== raw.characterId ? resetForNewCharacter(s, raw.characterId) : s;
    const invCount = raw.snapshot.character.inventoryCount ?? raw.snapshot.inventory.reduce((sum, i) => sum + i.count, 0);
    next = {
      ...next, characterId: raw.characterId, snapshot: raw.snapshot, snapshotAt: now, character: raw.snapshot.character,
      location: { mapId: raw.snapshot.mapId, mapName: raw.snapshot.mapName },
      members: raw.snapshot.family?.members ?? next.members,
      activeCharacterId: raw.snapshot.family?.activeCharacterId ?? raw.characterId,
      warehouse: raw.snapshot.family?.warehouse ?? next.warehouse,
      eventMirror: {
        mapId: raw.snapshot.mapId,
        mapName: raw.snapshot.mapName,
        gold: raw.snapshot.character.gold,
        x: raw.snapshot.character.x,
        y: raw.snapshot.character.y,
        inventoryCount: invCount,
      },
      ...fromActivity(raw.snapshot),
    };
    const why = { STARTED: '開機', MAP_CHANGED: '換圖', SCENE_RELOADED: '場景重載', REQUESTED: '應要求', PHASE_CHANGED: '階段改變' }[raw.reason];
    return addLog(next, '快照', `${raw.snapshot.mapName ?? raw.snapshot.mapId}：NPC ${raw.snapshot.npcs.length}／出口 ${raw.snapshot.exits.length}（${why}）`, now, { commandId: raw.inReplyTo, characterId: raw.characterId });
  }
  if (isEventMessage(raw)) return applyEvent(s, raw.characterId, raw.event, now);
  if (isCommandResultMessage(raw)) {
    const { [raw.commandId]: sent, ...rest } = s.pending;
    const ok = raw.status === 'ACCEPTED';
    const inflight = ok && sent?.expect && !raw.duplicate ? { ...s.inflight, [raw.commandId]: { label: sent.label, sentAt: sent.sentAt, expect: sent.expect } } : s.inflight;
    const text = ok ? '結果：已接受' : `結果：被拒絕 ${raw.reasonCode ?? ''}${raw.message ? `（${raw.message}）` : ''}`;
    return addLog({ ...s, pending: rest, inflight }, '結果', `${text}${raw.duplicate ? '（重送，沿用先前結果）' : ''}`, now, { commandId: raw.commandId, characterId: raw.characterId, level: ok ? 'info' : 'warn' });
  }
  return s; // 自己送出的指令回音或其他人的訊息：忽略
}

function resetForNewCharacter(s: FamilyState, characterId: string): FamilyState {
  return {
    ...s, characterId, snapshot: null, snapshotAt: null, character: null, location: null, dialog: null, shop: null, battle: null, battleResult: null, inventory: [],
    eventMirror: { mapId: null, mapName: null, gold: null, x: null, y: null, inventoryCount: null },
    inflight: {},
  };
}

/** 快照裡的進行中互動（重連時用它重建「現在正在對話／戰鬥」）與背包。 */
function fromActivity(snap: SceneSnapshot): Pick<FamilyState, 'dialog' | 'shop' | 'battle' | 'battleResult' | 'inventory'> {
  const a = snap.activity;
  return {
    dialog: a.dialog ? { npcId: a.dialog.npcId, npcName: a.dialog.npcName, lines: a.dialog.lines, options: a.dialog.options } : null,
    shop: a.shop ? { npcId: a.shop.npcId, npcName: a.shop.npcName, goods: snap.shops.find(x => x.npcId === a.shop!.npcId)?.goods ?? [] } : null,
    battle: a.battle ? {
      battleId: a.battle.battleId,
      round: a.battle.round,
      enemies: a.battle.enemies.map(e => e.name),
      enemyStates: a.battle.enemies,
      ...(a.battle.player ? { player: a.battle.player } : {}),
      ...(a.battle.pet !== undefined ? { pet: a.battle.pet } : {}),
      canFlee: a.battle.canFlee,
      ready: true,
    } : null,
    battleResult: a.battleResult,
    inventory: snap.inventory,
  };
}

function applyInventory(inv: SnapshotItem[], changes: Array<{ itemId: number; delta: number; count: number }>): SnapshotItem[] {
  let out = inv;
  for (const c of changes) {
    const had = out.find(i => i.itemId === c.itemId);
    out = c.count <= 0 ? out.filter(i => i.itemId !== c.itemId)
      : had ? out.map(i => (i.itemId === c.itemId ? { ...i, count: c.count } : i))
      : [...out, { itemId: c.itemId, name: null, count: c.count }];
  }
  return out;
}

/** 背景角色事件中仍要照常套用的類型（背包、金錢、倉庫、指令完成都是以角色或指令編號歸屬）。 */
const BG_SHARED_EVENTS = new Set<GameEvent['type']>([
  'INVENTORY_CHANGED', 'GOLD_CHANGED', 'WAREHOUSE_CHANGED', 'COMMAND_COMPLETED', 'COMMAND_ACCEPTED', 'COMMAND_REJECTED',
]);

function applyEvent(s: FamilyState, characterId: string, e: GameEvent, now: number): FamilyState {
  const isKnownMember = s.members.some(m => m.characterId === characterId);
  const isBgEvent = isKnownMember && s.characterId !== null && s.characterId !== characterId && e.type !== 'ACTIVE_CHARACTER_CHANGED';
  let next: FamilyState = isBgEvent
    ? { ...s }
    : s.characterId !== null && s.characterId !== characterId
      ? resetForNewCharacter(s, characterId)
      : { ...s, characterId };
  const isViewed = !isBgEvent && (!next.activeCharacterId || characterId === next.activeCharacterId);
  const commandId = 'commandId' in e ? e.commandId : undefined;
  let level: LogEntry['level'] = 'info';
  // F2：背景角色的事件不能改動目前視角角色的對話、商店、戰鬥、位置；只更新名冊上屬於它自己的欄位。
  if (isBgEvent) {
    const patchMember = (patch: Partial<SnapshotFamilyMember>): FamilyState => ({
      ...next,
      members: next.members.map(m => (m.characterId === characterId ? { ...m, ...patch } : m)),
    });
    switch (e.type) {
      case 'LOCATION_CHANGED': next = patchMember({ mapId: e.mapId, mapName: e.mapName, x: e.x, y: e.y }); break;
      case 'MOVED': next = patchMember({ x: e.x, y: e.y }); break;
      case 'BATTLE_STARTED': next = patchMember({ inBattle: true }); break;
      case 'BATTLE_ENDED': next = patchMember({ inBattle: false }); break;
      case 'DIALOG_OPENED': case 'DIALOG_UPDATED': case 'DIALOG_CLOSED': case 'SHOP_OPENED': case 'SHOP_CLOSED':
      case 'BATTLE_TIMELINE': case 'BATTLE_TURN_READY': case 'GAME_STARTED': case 'GAME_STOPPED':
        // 只留日誌，不動視角角色的畫面狀態。GAME_* 由視角角色的訊息處理。
        break;
      default: break;
    }
  }
  if (isBgEvent && !BG_SHARED_EVENTS.has(e.type)) {
    return addLog(next, '事件', describeEvent(e), now, { commandId, characterId, level });
  }
  switch (e.type) {
    case 'GAME_STARTED': next = { ...next, sessionId: e.sessionId, stoppedSessionId: null, dialog: null, shop: null, battle: null, battleResult: null, pending: {}, inflight: {} }; break;
    case 'GAME_STOPPED': next = { ...next, stoppedSessionId: e.sessionId, dialog: null, shop: null, battle: null, inflight: {} }; break;
    case 'LOCATION_CHANGED': next = { ...next, location: { mapId: e.mapId, mapName: e.mapName }, character: next.character && { ...next.character, x: e.x, y: e.y }, eventMirror: { ...next.eventMirror, mapId: e.mapId, mapName: e.mapName, x: e.x, y: e.y }, dialog: null, shop: null }; break;
    case 'MOVED':
      next = {
        ...next,
        character: next.character && {
          ...next.character,
          x: e.x,
          y: e.y,
          dir: e.dir,
          ...(e.action !== undefined ? { action: e.action } : {}),
          ...(e.movePath !== undefined ? { movePath: e.movePath } : {}),
        },
        eventMirror: { ...next.eventMirror, x: e.x, y: e.y },
      };
      break;
    case 'DIALOG_OPENED': next = { ...next, dialog: { npcId: e.npcId, npcName: e.npcName, lines: e.lines, options: e.options } }; break;
    case 'DIALOG_UPDATED': next = { ...next, dialog: next.dialog && { ...next.dialog, lines: e.lines, options: e.options } }; break;
    case 'DIALOG_CLOSED': next = { ...next, dialog: null }; break;
    case 'SHOP_OPENED': next = { ...next, dialog: null, shop: { npcId: e.npcId, npcName: e.npcName, goods: e.goods } }; break;
    case 'SHOP_CLOSED': next = { ...next, shop: null }; break;
    case 'BATTLE_STARTED':
      next = {
        ...next,
        battle: {
          battleId: e.battleId,
          round: null,
          enemies: e.enemies.map(n => n.name),
          enemyStates: [],
          enemyVisuals: e.enemies,
          ...(e.allies ? { allies: e.allies } : {}),
          canFlee: true,
          ready: false,
          timeline: null,
        },
        battleResult: null,
        character: next.character && { ...next.character, inBattle: true },
      };
      break;
    case 'BATTLE_TIMELINE':
      if (!next.battle || next.battle.battleId === e.battleId) {
        next = {
          ...next,
          battle: {
            battleId: e.battleId,
            round: e.round,
            enemies: next.battle?.enemies ?? [],
            enemyStates: next.battle?.enemyStates ?? [],
            ...(next.battle?.enemyVisuals ? { enemyVisuals: next.battle.enemyVisuals } : {}),
            ...(next.battle?.allies ? { allies: next.battle.allies } : {}),
            ...(next.battle?.player ? { player: next.battle.player } : {}),
            ...(next.battle?.pet !== undefined ? { pet: next.battle.pet } : {}),
            canFlee: next.battle?.canFlee ?? true,
            ready: false,
            timeline: { battleId: e.battleId, round: e.round, events: e.events, receivedAt: now },
          },
        };
      }
      break;
    case 'BATTLE_TURN_READY':
      next = {
        ...next,
        battle: {
          battleId: e.battleId,
          round: e.round,
          enemies: e.enemies.map(n => n.name),
          enemyStates: e.enemies,
          ...(next.battle?.enemyVisuals ? { enemyVisuals: next.battle.enemyVisuals } : {}),
          ...(next.battle?.allies ? { allies: next.battle.allies } : {}),
          ...(e.player ? { player: e.player } : {}),
          ...(e.pet !== undefined ? { pet: e.pet } : {}),
          canFlee: e.canFlee,
          ready: true,
          timeline: next.battle?.timeline ?? null,
        },
        character: next.character && {
          ...next.character,
          inBattle: true,
          ...(e.player ? {
            hp: e.player.hp,
            maxHp: e.player.maxHp,
            ...(e.player.mp !== undefined ? { mp: e.player.mp } : {}),
            ...(e.player.maxMp !== undefined ? { maxMp: e.player.maxMp } : {}),
            ...(e.player.statuses ? { statuses: e.player.statuses } : {}),
            ...(e.player.isDefending !== undefined ? { isDefending: e.player.isDefending } : {}),
            ...(e.player.isChanting !== undefined ? { isChanting: e.player.isChanting } : {}),
          } : {}),
          ...(e.pet !== undefined ? { activePet: e.pet } : {}),
        },
      };
      break;
    case 'BATTLE_ENDED':
      next = {
        ...next,
        battle: null,
        battleResult: e.outcome === 'WIN' ? 'VICTORY' : e.outcome === 'LOSE' ? 'DEFEAT' : null,
        character: next.character && {
          ...next.character,
          inBattle: false,
          statuses: [],
          isDefending: false,
          isChanting: false,
        },
      };
      break;
    case 'INVENTORY_CHANGED': {
      const members = next.members.map(m => {
        if (m.characterId !== characterId) return m;
        const inv = applyInventory(m.inventory, e.changes);
        return { ...m, inventory: inv, inventoryCount: inv.reduce((sum, i) => sum + i.count, 0) };
      });
      if (isViewed) {
        const updatedInv = applyInventory(next.inventory, e.changes);
        const count = updatedInv.reduce((sum, i) => sum + i.count, 0);
        next = { ...next, members, inventory: updatedInv, eventMirror: { ...next.eventMirror, inventoryCount: count } };
      } else {
        next = { ...next, members };
      }
      break;
    }
    case 'GOLD_CHANGED': {
      const members = next.members.map(m => (m.characterId === characterId ? { ...m, gold: e.gold } : m));
      next = isViewed
        ? { ...next, members, character: next.character && { ...next.character, gold: e.gold }, eventMirror: { ...next.eventMirror, gold: e.gold } }
        : { ...next, members };
      break;
    }
    case 'WAREHOUSE_CHANGED': next = { ...next, warehouse: { gold: e.gold, cap: next.warehouse?.cap ?? 200, items: e.items } }; break;
    case 'ACTIVE_CHARACTER_CHANGED': next = { ...next, activeCharacterId: e.characterId, characterId: e.characterId }; break;
    case 'COMMAND_REJECTED': level = 'warn'; break;
    case 'COMMAND_COMPLETED': {
      const sent = next.inflight[e.commandId];
      const { [e.commandId]: _done, ...rest } = next.inflight;
      void _done;
      next = { ...next, inflight: rest };
      // 預期 vs 實際：完成碼和送出時預期的不同，標成警告（例如走路預期 ARRIVED，實際被遇敵打斷 ENCOUNTER）。
      const match = !sent || sent.expect === e.code;
      const text = sent
        ? `${sent.label}　預期 ${sent.expect}／實際 ${e.code}（${e.outcome}）${match ? ' ✓' : ' ✗ 與預期不同'}${e.message ? `　${e.message}` : ''}`
        : describeEvent(e);
      return addLog(next, '結果', text, now, { commandId, characterId, level: match && e.outcome !== 'FAILED' ? 'info' : 'warn' });
    }
    default: break;
  }
  // COMMAND_* 事件與 command-result 重複，只留 command-result 在日誌（避免同一件事列兩行），但保留對 pending 的清理由 result 處理。
  if (e.type === 'COMMAND_ACCEPTED' || e.type === 'COMMAND_REJECTED') return next;
  return addLog(next, '事件', describeEvent(e), now, { commandId, characterId, level });
}
