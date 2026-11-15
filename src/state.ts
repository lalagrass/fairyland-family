import {
  HEARTBEAT_TIMEOUT_MS,
  isCommandResultMessage,
  isCompatibleVersion,
  isEventMessage,
  isHeartbeatMessage,
  isSnapshotMessage,
  type CommandMessage,
  type GameEvent,
  type SceneSnapshot,
  type SnapshotCharacter,
} from './protocol/index';

export type LogTag = '連線' | '事件' | '快照' | '送出' | '結果' | '系統';

export interface LogEntry {
  id: number;
  at: number;
  tag: LogTag;
  text: string;
  commandId?: string;
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
  character: SnapshotCharacter | null;
  dialog: { npcId: string; npcName: string; lines: string[] } | null;
  battle: { battleId: number; round: number | null; enemies: string[] } | null;
  /** 已送出、還沒收到結果的指令。 */
  pending: Record<string, { label: string; sentAt: number }>;
  log: LogEntry[];
  logSeq: number;
}

const LOG_CAP = 300;

export function initialState(): FamilyState {
  return {
    lastHeartbeatAt: null, sessionId: null, stoppedSessionId: null, phase: null, characterId: null, location: null,
    snapshot: null, snapshotAt: null, character: null, dialog: null, battle: null, pending: {}, log: [], logSeq: 0,
  };
}

/** 遊戲執行中＝最近 3 秒內收到心跳，且該 session 沒有被明確停止。 */
export function connectionStatus(s: FamilyState, now: number): 'RUNNING' | 'STOPPED' {
  if (s.lastHeartbeatAt === null) return 'STOPPED';
  if (s.sessionId !== null && s.sessionId === s.stoppedSessionId) return 'STOPPED';
  return now - s.lastHeartbeatAt <= HEARTBEAT_TIMEOUT_MS ? 'RUNNING' : 'STOPPED';
}

export function addLog(s: FamilyState, tag: LogTag, text: string, now: number, extra: { commandId?: string; level?: LogEntry['level'] } = {}): FamilyState {
  const entry: LogEntry = { id: s.logSeq + 1, at: now, tag, text, commandId: extra.commandId, level: extra.level ?? 'info' };
  const log = [...s.log, entry];
  if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP);
  return { ...s, log, logSeq: entry.id };
}

/** 把「我送出了一個指令」記進狀態（日誌與待回覆表）。 */
export function applySent(s: FamilyState, msg: CommandMessage, label: string, now: number): FamilyState {
  const next = addLog(s, '送出', `${label}　${JSON.stringify(msg.command)}`, now, { commandId: msg.commandId });
  return { ...next, pending: { ...next.pending, [msg.commandId]: { label, sentAt: now } } };
}

export function describeEvent(e: GameEvent): string {
  switch (e.type) {
    case 'GAME_STARTED': return '遊戲開始';
    case 'GAME_STOPPED': return `遊戲停止（${e.reason}）`;
    case 'LOCATION_CHANGED': return `移動到 ${e.mapName ?? e.mapId}（${e.cause === 'MAP_CHANGE' ? '換圖' : e.cause === 'WARP' ? '傳送' : '載入'}）(${e.x}, ${e.y})`;
    case 'MOVED': return `走到 (${e.x}, ${e.y})`;
    case 'DIALOG_OPENED': return `與 ${e.npcName} 對話：${e.lines[0] ?? '（沒有對白）'}${e.optionsAvailable ? '' : '（選項未提供）'}`;
    case 'DIALOG_CLOSED': return '對話結束';
    case 'BATTLE_STARTED': return `遭遇戰鬥 #${e.battleId}：${e.enemies.map(n => n.name).join('、') || '？'}`;
    case 'BATTLE_ENDED': return `戰鬥 #${e.battleId} 結束：${e.outcome === 'WIN' ? '勝利' : e.outcome === 'LOSE' ? '落敗' : e.outcome === 'FLEE' ? '逃跑' : '未知'}`;
    case 'BATTLE_TURN_READY': return `戰鬥 #${e.battleId} 第 ${e.round} 回合就緒`;
    case 'INVENTORY_CHANGED': return `道具變動：${e.changes.map(c => `#${c.itemId} ${c.delta >= 0 ? '+' : ''}${c.delta}（共 ${c.count}）`).join('、')}`;
    case 'GOLD_CHANGED': return `金錢 ${e.delta >= 0 ? '+' : ''}${e.delta}，現有 ${e.gold}`;
    case 'COMMAND_ACCEPTED': return '指令已接受';
    case 'COMMAND_REJECTED': return `指令被拒絕：${e.reasonCode}${e.message ? `（${e.message}）` : ''}`;
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
    next = { ...next, characterId: raw.characterId, phase: raw.phase, sessionId: raw.sessionId, lastHeartbeatAt: now };
    if (fresh && raw.sessionId !== next.stoppedSessionId) next = { ...next, stoppedSessionId: null };
    if (raw.mapId && !next.location) next = { ...next, location: { mapId: raw.mapId, mapName: null } };
    if (wasDown && connectionStatus(next, now) === 'RUNNING') next = addLog(next, '連線', '遊戲執行中', now);
    return next;
  }
  if (isSnapshotMessage(raw)) {
    let next = s.characterId !== null && s.characterId !== raw.characterId ? resetForNewCharacter(s, raw.characterId) : s;
    next = {
      ...next, characterId: raw.characterId, snapshot: raw.snapshot, snapshotAt: now, character: raw.snapshot.character,
      location: { mapId: raw.snapshot.mapId, mapName: raw.snapshot.mapName },
    };
    const why = { STARTED: '開機', MAP_CHANGED: '換圖', SCENE_RELOADED: '場景重載', REQUESTED: '應要求', PHASE_CHANGED: '階段改變' }[raw.reason];
    return addLog(next, '快照', `${raw.snapshot.mapName ?? raw.snapshot.mapId}：NPC ${raw.snapshot.npcs.length}／出口 ${raw.snapshot.exits.length}（${why}）`, now, { commandId: raw.inReplyTo });
  }
  if (isEventMessage(raw)) return applyEvent(s, raw.characterId, raw.event, now);
  if (isCommandResultMessage(raw)) {
    const { [raw.commandId]: _gone, ...rest } = s.pending;
    void _gone;
    const ok = raw.status === 'ACCEPTED';
    const text = ok ? '結果：已接受' : `結果：被拒絕 ${raw.reasonCode ?? ''}${raw.message ? `（${raw.message}）` : ''}`;
    return addLog({ ...s, pending: rest }, '結果', `${text}${raw.duplicate ? '（重送，沿用先前結果）' : ''}`, now, { commandId: raw.commandId, level: ok ? 'info' : 'warn' });
  }
  return s; // 自己送出的指令回音或其他人的訊息：忽略
}

function resetForNewCharacter(s: FamilyState, characterId: string): FamilyState {
  return { ...s, characterId, snapshot: null, snapshotAt: null, character: null, location: null, dialog: null, battle: null };
}

function applyEvent(s: FamilyState, characterId: string, e: GameEvent, now: number): FamilyState {
  let next: FamilyState = s.characterId !== null && s.characterId !== characterId ? resetForNewCharacter(s, characterId) : { ...s, characterId };
  const commandId = 'commandId' in e ? e.commandId : undefined;
  let level: LogEntry['level'] = 'info';
  switch (e.type) {
    case 'GAME_STARTED': next = { ...next, sessionId: e.sessionId, stoppedSessionId: null, dialog: null, battle: null }; break;
    case 'GAME_STOPPED': next = { ...next, stoppedSessionId: e.sessionId, dialog: null, battle: null }; break;
    case 'LOCATION_CHANGED': next = { ...next, location: { mapId: e.mapId, mapName: e.mapName }, character: next.character && { ...next.character, x: e.x, y: e.y }, dialog: null }; break;
    case 'MOVED': next = { ...next, character: next.character && { ...next.character, x: e.x, y: e.y, dir: e.dir } }; break;
    case 'DIALOG_OPENED': next = { ...next, dialog: { npcId: e.npcId, npcName: e.npcName, lines: e.lines } }; break;
    case 'DIALOG_CLOSED': next = { ...next, dialog: null }; break;
    case 'BATTLE_STARTED': next = { ...next, battle: { battleId: e.battleId, round: null, enemies: e.enemies.map(n => n.name) }, character: next.character && { ...next.character, inBattle: true } }; break;
    case 'BATTLE_TURN_READY': next = { ...next, battle: next.battle && { ...next.battle, round: e.round } }; break;
    case 'BATTLE_ENDED': next = { ...next, battle: null, character: next.character && { ...next.character, inBattle: false } }; break;
    case 'GOLD_CHANGED': next = { ...next, character: next.character && { ...next.character, gold: e.gold } }; break;
    case 'COMMAND_REJECTED': level = 'warn'; break;
    default: break;
  }
  // COMMAND_* 事件與 command-result 重複，只留 command-result 在日誌（避免同一件事列兩行），但保留對 pending 的清理由 result 處理。
  if (e.type === 'COMMAND_ACCEPTED' || e.type === 'COMMAND_REJECTED') return next;
  return addLog(next, '事件', describeEvent(e), now, { commandId, level });
}
