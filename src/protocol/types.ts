// [sync-protocol] 自動產生，請勿手改；改協定請到 fairyland 修改後重新執行 npm run sync-protocol
// [sync-protocol] 來源：fairyland/packages/shared/src/protocol/types.ts @ 1dfff18543e2d88d22d9b1827b3ab76c2a8950c3
/**
 * FX1：fairyland（純淨宿主）與 fairyland-family（智慧外掛）之間的外掛協定型別。
 *
 * 規則：
 * - 這個資料夾自成一體（不得 import 本資料夾以外的檔案），因為 fairyland-family 會用
 *   `scripts/sync-protocol.mjs` 把整個資料夾原樣複製過去。
 * - 每則訊息都帶 `v`（`PROTOCOL_VERSION`）與 `characterId`；指令另外帶 `commandId`。
 *   P1–P3 只有單一角色，`characterId` 固定是目前角色；多角色之後不必升協定版本。
 * - P1 只實作「宿主 → 外掛」的快照／事件與 REQUEST_SNAPSHOT；其餘指令只定義型別，
 *   宿主一律回 COMMAND_REJECTED（`NOT_IMPLEMENTED_P1`），P2 才實作執行。
 */

/** 協定版本。欄位語意不相容地改變時才遞增。 */
export const PROTOCOL_VERSION = 1;

/** BroadcastChannel 名稱；遊戲與外掛兩個分頁必須同源才收得到。 */
export const PLUGIN_CHANNEL_NAME = 'fairyland.plugin';

/** 心跳間隔（宿主送出）與外掛判定「遊戲未執行」的逾時。 */
export const HEARTBEAT_INTERVAL_MS = 1000;
export const HEARTBEAT_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// 指令（外掛 → 宿主）
// ---------------------------------------------------------------------------

/** 同圖走到某點（遊戲畫面指令；跨圖由外掛拆成多段）。座標是世界像素座標。 */
export interface WalkToCommand { type: 'WALK_TO'; mapId: string; x: number; y: number }
/** 走到並與眼前的 NPC 對話。 */
export interface TalkToNpcCommand { type: 'TALK_TO_NPC'; npcId: string }
/** 在已開啟的對話中選一個選項。 */
export interface ChooseDialogOptionCommand { type: 'CHOOSE_DIALOG_OPTION'; optionId: string }
/** 對應 `GameCommand` 的 ACCEPT_QUEST。 */
export interface AcceptQuestCommand { type: 'ACCEPT_QUEST'; questId: number }
/** 對應 `GameCommand` 的 BUY_ITEM。 */
export interface BuyItemCommand { type: 'BUY_ITEM'; itemId: number; count?: number }
/** 對應 `GameCommand` 的 SELL_ITEM。 */
export interface SellItemCommand { type: 'SELL_ITEM'; itemId: number; count?: number }
/** 單次工作（採集／製作）。`skillId`＝採集技能；`recipeId`＝製作配方（二擇一）。 */
export interface WorkOnceCommand { type: 'WORK_ONCE'; skillId?: number; recipeId?: number }
/**
 * 單回合戰鬥指令。`actions` 以戰鬥單位 id 為鍵，值的形狀等同宿主的 `CombatCommand`
 * （P2 才定案，所以這裡不綁定型別）。
 */
export interface BattleActionCommand { type: 'BATTLE_ACTION'; battleId?: number; actions: Record<string, unknown> }
/** 戰鬥逃跑。 */
export interface BattleFleeCommand { type: 'BATTLE_FLEE'; battleId?: number }
/** 要求宿主立刻廣播一份完整場景快照（P1 唯一會被執行的指令）。 */
export interface RequestSnapshotCommand { type: 'REQUEST_SNAPSHOT' }
/**
 * 直通宿主既有 `GameCommand`（`game_core.ts`）的狀態指令；`command.type` 對應 `GameCommand['type']`。
 * 宿主端會再用 `GameCommand` 本身的檢核處理，所以這裡不重複列舉。
 */
export interface GameCommandPassthrough { type: 'GAME_COMMAND'; command: { type: string; [k: string]: unknown } }

export type PluginCommand =
  | WalkToCommand
  | TalkToNpcCommand
  | ChooseDialogOptionCommand
  | AcceptQuestCommand
  | BuyItemCommand
  | SellItemCommand
  | WorkOnceCommand
  | BattleActionCommand
  | BattleFleeCommand
  | RequestSnapshotCommand
  | GameCommandPassthrough;

export const PLUGIN_COMMAND_TYPES = [
  'WALK_TO', 'TALK_TO_NPC', 'CHOOSE_DIALOG_OPTION', 'ACCEPT_QUEST', 'BUY_ITEM', 'SELL_ITEM',
  'WORK_ONCE', 'BATTLE_ACTION', 'BATTLE_FLEE', 'REQUEST_SNAPSHOT', 'GAME_COMMAND',
] as const;
export type PluginCommandType = (typeof PLUGIN_COMMAND_TYPES)[number];

/** 指令被拒絕的原因碼。 */
export type RejectReasonCode =
  | 'NOT_IMPLEMENTED_P1'
  | 'INVALID_COMMAND'
  | 'UNKNOWN_COMMAND'
  | 'WRONG_CHARACTER'
  | 'PROTOCOL_VERSION_MISMATCH'
  | 'GAME_NOT_READY'
  | 'GAME_BUSY';

export const REJECT_REASON_CODES: readonly RejectReasonCode[] = [
  'NOT_IMPLEMENTED_P1', 'INVALID_COMMAND', 'UNKNOWN_COMMAND', 'WRONG_CHARACTER',
  'PROTOCOL_VERSION_MISMATCH', 'GAME_NOT_READY', 'GAME_BUSY',
];

// ---------------------------------------------------------------------------
// 場景快照（宿主 → 外掛，FX10）
// ---------------------------------------------------------------------------

/** 欄位資料的可得性：沒有資料時明確標示，而不是回空陣列讓外掛誤會「本區沒有」。 */
export type DataAvailability =
  | 'AVAILABLE'
  | 'UNAVAILABLE'          // 宿主端目前沒有這項資料（附 reason）
  | 'RECONSTRUCTED_DEMO';  // 有資料，但屬於重建／示範內容，不是原版提取

export interface SnapshotCharacter {
  name: string | null;
  level: number;
  hp: number | null;
  maxHp: number | null;
  mp: number | null;
  maxMp: number | null;
  gold: number;
  x: number;
  y: number;
  dir: number;
  inBattle: boolean;
}

export interface SnapshotShopGood {
  itemId: number;
  name: string | null;
  price: number;
  category?: string;
}

export interface SnapshotNpc {
  id: string;
  name: string;
  x: number;
  y: number;
  gridX: number;
  gridY: number;
  role: string | null;
  /** 玩家點下去會開對話框。 */
  talkable: boolean;
  isAnimal: boolean;
  /** 依宿主既有的商店判斷（角色或名稱）。 */
  isShop: boolean;
}

export interface SnapshotExit {
  id: string;
  /** 傳送點在畫面上的名稱（例如「雜貨店」「往北綠野」）。 */
  name: string;
  x: number;
  y: number;
  targetMapId: string;
  targetMapName: string | null;
}

export interface SnapshotGatherPoint {
  id: string;
  name: string;
  x: number;
  y: number;
  skillId: number | null;
  requiredToolItemId: number | null;
}

export interface SnapshotReachableMap {
  mapId: string;
  name: string | null;
  /** 從目前地圖經過幾個傳送點可到（1＝直接出口）。 */
  hops: number;
}

export interface SnapshotShop {
  npcId: string;
  npcName: string;
  goodsStatus: DataAvailability;
  goods: SnapshotShopGood[];
}

export interface SceneSnapshot {
  schema: 'scene-snapshot';
  mapId: string;
  mapName: string | null;
  character: SnapshotCharacter;
  npcs: SnapshotNpc[];
  exits: SnapshotExit[];
  /** 採集點：P1 沒有可用資料（FX6 之後才有），`status` 會是 UNAVAILABLE。 */
  gatherPoints: { status: DataAvailability; reason?: string; points: SnapshotGatherPoint[] };
  shops: SnapshotShop[];
  nav: {
    status: DataAvailability;
    reason?: string;
    /** 以傳送點相連可到達的地圖（含直接出口，hops 由近到遠）。 */
    reachableMaps: SnapshotReachableMap[];
    /** 地圖像素寬高，供外掛估距離。 */
    pixelWidth: number | null;
    pixelHeight: number | null;
  };
}

// ---------------------------------------------------------------------------
// 事件（宿主 → 外掛）
// ---------------------------------------------------------------------------

export interface DialogOption { id: string; label: string }

export interface BattleEnemyBrief { id: string; name: string; level: number | null }

export type LocationChangeCause = 'LOAD' | 'MAP_CHANGE' | 'WARP';
export type BattleOutcome = 'WIN' | 'LOSE' | 'FLEE' | 'UNKNOWN';

export type GameEvent =
  | { type: 'GAME_STARTED'; sessionId: string }
  | { type: 'GAME_STOPPED'; sessionId: string; reason: 'PAGE_HIDE' | 'UNLOAD' | 'SHUTDOWN' }
  | { type: 'LOCATION_CHANGED'; mapId: string; mapName: string | null; fromMapId: string | null; x: number; y: number; cause: LocationChangeCause }
  | { type: 'MOVED'; mapId: string; x: number; y: number; dir: number }
  | { type: 'DIALOG_OPENED'; npcId: string; npcName: string; role: string | null; lines: string[]; options: DialogOption[]; optionsAvailable: boolean }
  | { type: 'DIALOG_CLOSED'; npcId: string }
  | { type: 'BATTLE_STARTED'; battleId: number; mapId: string; enemies: BattleEnemyBrief[] }
  | { type: 'BATTLE_ENDED'; battleId: number; outcome: BattleOutcome }
  | { type: 'BATTLE_TURN_READY'; battleId: number; round: number }
  | { type: 'INVENTORY_CHANGED'; changes: Array<{ itemId: number; delta: number; count: number }> }
  | { type: 'GOLD_CHANGED'; gold: number; delta: number }
  | { type: 'COMMAND_ACCEPTED'; commandId: string }
  | { type: 'COMMAND_REJECTED'; commandId: string; reasonCode: RejectReasonCode; message?: string };

export const GAME_EVENT_TYPES = [
  'GAME_STARTED', 'GAME_STOPPED', 'LOCATION_CHANGED', 'MOVED', 'DIALOG_OPENED', 'DIALOG_CLOSED',
  'BATTLE_STARTED', 'BATTLE_ENDED', 'BATTLE_TURN_READY', 'INVENTORY_CHANGED', 'GOLD_CHANGED',
  'COMMAND_ACCEPTED', 'COMMAND_REJECTED',
] as const;
export type GameEventType = (typeof GAME_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// 信封（BroadcastChannel / window.__fl.plugin 上實際傳的訊息）
// ---------------------------------------------------------------------------

export interface EnvelopeBase {
  /** 協定版本。 */
  v: number;
  characterId: string;
  /** 送出時間（epoch ms，送出端時鐘）。 */
  ts: number;
}

export interface HeartbeatMessage extends EnvelopeBase {
  kind: 'heartbeat';
  /** 每次載入遊戲頁面產生一個，外掛用來分辨「同一個分頁」與「重開」。 */
  sessionId: string;
  seq: number;
  /** 目前所在地圖；開場／登入畫面時為 null。 */
  mapId: string | null;
  phase: 'OPENING' | 'PLAYING';
  inBattle: boolean;
}

export type SnapshotReason = 'STARTED' | 'MAP_CHANGED' | 'SCENE_RELOADED' | 'REQUESTED' | 'PHASE_CHANGED';

export interface SnapshotMessage extends EnvelopeBase {
  kind: 'snapshot';
  seq: number;
  reason: SnapshotReason;
  /** 回應 REQUEST_SNAPSHOT 時帶該指令的 commandId。 */
  inReplyTo?: string;
  snapshot: SceneSnapshot;
}

export interface EventMessage extends EnvelopeBase {
  kind: 'event';
  seq: number;
  event: GameEvent;
}

export interface CommandMessage extends EnvelopeBase {
  kind: 'command';
  commandId: string;
  command: PluginCommand;
}

export interface CommandResultMessage extends EnvelopeBase {
  kind: 'command-result';
  commandId: string;
  status: 'ACCEPTED' | 'REJECTED';
  reasonCode?: RejectReasonCode;
  message?: string;
  /** 重送同一 commandId 時回傳先前的結果（不重複執行）。 */
  duplicate?: boolean;
}

export type PluginMessage =
  | HeartbeatMessage
  | SnapshotMessage
  | EventMessage
  | CommandMessage
  | CommandResultMessage;

export const MESSAGE_KINDS = ['heartbeat', 'snapshot', 'event', 'command', 'command-result'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
