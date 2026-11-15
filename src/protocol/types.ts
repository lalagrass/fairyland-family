// [sync-protocol] 自動產生，請勿手改；改協定請到 fairyland 修改後重新執行 npm run sync-protocol
// [sync-protocol] 來源：fairyland/packages/shared/src/protocol/types.ts @ 710e78847a14404fddf6275e5a2b227a02d3f22b
/**
 * FX1：fairyland（純淨宿主）與 fairyland-family（智慧外掛）之間的外掛協定型別。
 *
 * 規則：
 * - 這個資料夾自成一體（不得 import 本資料夾以外的檔案），因為 fairyland-family 會用
 *   `scripts/sync-protocol.mjs` 把整個資料夾原樣複製過去。
 * - 每則訊息都帶 `v`（`PROTOCOL_VERSION`）與 `characterId`；指令另外帶 `commandId`。
 *   P1–P3 只有單一角色，`characterId` 固定是目前角色；多角色之後不必升協定版本。
 * - P3（協定版本 3）：WORK_ONCE 改為 `{ workType, targetId }`（原 skillId／recipeId 作廢）並真的執行；COMMAND_COMPLETED 可帶 `output`；
 *   快照新增 `work`（工作資料、背包格數、體力、工具、站點、販售處、進行中的工作）與 `gatherPoints` 附近可採；
 *   商店商品帶 `source` 標記；新增工作相關原因碼（MISSING_TOOL、MISSING_MATERIAL、INVENTORY_FULL、TOO_FAR、TOOL_BROKEN、
 *   NO_STAMINA、FAILED_ROLL、NOT_AVAILABLE_DATA、LEVEL_TOO_LOW）。
 * - P2（協定版本 2）：宿主執行 WALK_TO／TALK_TO_NPC／CHOOSE_DIALOG_OPTION／ACCEPT_QUEST／BUY_ITEM／SELL_ITEM／
 *   BATTLE_ACTION／BATTLE_FLEE（WORK_ONCE 仍是 `NOT_IMPLEMENTED`，P3 才做）。每個指令先回 COMMAND_ACCEPTED 或
 *   COMMAND_REJECTED（附原因碼），需要時間的指令（走路、戰鬥回合）完成或被中斷時再送 COMMAND_COMPLETED。
 * - 版本 2 相對版本 1 的不相容變更：BATTLE_ACTION 改為單一角色的 `action`；`NOT_IMPLEMENTED_P1` 改名
 *   `NOT_IMPLEMENTED`；快照新增 `inventory`／`activity`／`nav.portalGraph`；事件新增 COMMAND_COMPLETED、
 *   DIALOG_UPDATED、SHOP_OPENED、SHOP_CLOSED；BATTLE_TURN_READY 帶敵人與可否逃跑。
 */

/** 協定版本。欄位語意不相容地改變時才遞增。 */
export const PROTOCOL_VERSION = 3;

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
/** 資料來源標記（FX6）：每個資料欄位都標明是原版提取、重建示範還是本專案自訂。 */
export type SourceTag = 'ORIGINAL_EXTRACTED' | 'RECONSTRUCTED_DEMO' | 'CUSTOM';
export const SOURCE_TAGS: readonly SourceTag[] = ['ORIGINAL_EXTRACTED', 'RECONSTRUCTED_DEMO', 'CUSTOM'];

/** 單次工作類型：GATHER 採集（targetId＝採集點 id）；SMELT 冶煉、FORGE 鍛造、CRAFT 其他製作（targetId＝配方產物的道具 id，字串）。 */
export type WorkType = 'GATHER' | 'SMELT' | 'FORGE' | 'CRAFT';
export const WORK_TYPES: readonly WorkType[] = ['GATHER', 'SMELT', 'FORGE', 'CRAFT'];
/**
 * 單次原子工作：檢核工具、材料、距離（採集點／站點）、背包空間、體力，通過後角色忙碌 `durationMs`（遊戲時鐘），
 * 結束時一次結算（扣材料、給產出、耗損工具）。同一 commandId 只會結算一次。
 */
export interface WorkOnceCommand { type: 'WORK_ONCE'; workType: WorkType; targetId: string }
/** 單回合戰鬥動作（主人角色）；幻獸與其他單位由宿主既有的 AI 代出，與玩家在畫面上只點主人指令相同。 */
export type BattleActionKind = 'ATTACK' | 'SKILL' | 'SPELL' | 'ITEM' | 'CAPTURE' | 'DEFEND';
export const BATTLE_ACTION_KINDS: readonly BattleActionKind[] = ['ATTACK', 'SKILL', 'SPELL', 'ITEM', 'CAPTURE', 'DEFEND'];
export interface BattleActionSpec {
  kind: BattleActionKind;
  /** 目標敵人的 slot（BATTLE_TURN_READY.enemies[].slot）；ITEM 對自己可省略。 */
  targetSlot?: number;
  skillId?: number;
  spellId?: number;
  itemId?: number;
  /** CAPTURE 使用的封印石道具 id。 */
  sealStoneId?: number;
}
/** 單回合戰鬥指令：送出後宿主結算這一回合；`battleId` 帶了而與目前場次不同會被拒絕（STALE_BATTLE）。 */
export interface BattleActionCommand { type: 'BATTLE_ACTION'; battleId?: number; action: BattleActionSpec }
/** 戰鬥逃跑（單回合）：成功與否由宿主逃跑引擎擲骰，結果見 BATTLE_ENDED（outcome FLEE）或下一個 BATTLE_TURN_READY。 */
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
  | 'NOT_IMPLEMENTED'
  | 'INVALID_COMMAND'
  | 'UNKNOWN_COMMAND'
  | 'WRONG_CHARACTER'
  | 'PROTOCOL_VERSION_MISMATCH'
  | 'GAME_NOT_READY'
  /** 遊戲畫面正被別的流程占住（遇敵轉場、勝敗視窗、開場畫面…）。 */
  | 'GAME_BUSY'
  /** WALK_TO 的 mapId 不是目前地圖（跨圖由外掛拆成多段）。 */
  | 'WRONG_MAP'
  | 'TOO_FAR'
  | 'NPC_NOT_FOUND'
  | 'UNREACHABLE'
  | 'IN_BATTLE'
  | 'NOT_IN_BATTLE'
  | 'STALE_BATTLE'
  | 'DIALOG_OPEN'
  | 'NOT_IN_DIALOG'
  | 'OPTION_NOT_FOUND'
  | 'NOT_AT_SHOP'
  | 'ITEM_NOT_IN_SHOP'
  | 'COMMAND_NOT_ALLOWED'
  /** 宿主核心（`dispatchGameCommand`）拒絕；`message` 帶核心的原因文字。 */
  | 'CORE_REJECTED'
  | 'BATTLE_NOT_READY'
  | 'INVALID_BATTLE_ACTION'
  // P3：WORK_ONCE 的起始檢核（沒有任何東西被消耗）
  | 'MISSING_TOOL'
  | 'MISSING_MATERIAL'
  | 'INVENTORY_FULL'
  | 'TOOL_BROKEN'
  | 'NO_STAMINA'
  | 'NOT_AVAILABLE_DATA'
  | 'LEVEL_TOO_LOW';

/** WORK_ONCE 可能回報的原因碼（起始檢核以 COMMAND_REJECTED、結算時以 COMMAND_COMPLETED 送出，用同一組代碼）。 */
export type WorkReasonCode =
  | 'MISSING_TOOL' | 'MISSING_MATERIAL' | 'INVENTORY_FULL' | 'TOO_FAR' | 'TOOL_BROKEN' | 'NO_STAMINA' | 'FAILED_ROLL'
  | 'NOT_AVAILABLE_DATA' | 'LEVEL_TOO_LOW' | 'WRONG_MAP';
export const WORK_REASON_CODES: readonly WorkReasonCode[] = [
  'MISSING_TOOL', 'MISSING_MATERIAL', 'INVENTORY_FULL', 'TOO_FAR', 'TOOL_BROKEN', 'NO_STAMINA', 'FAILED_ROLL',
  'NOT_AVAILABLE_DATA', 'LEVEL_TOO_LOW', 'WRONG_MAP',
];

export const REJECT_REASON_CODES: readonly RejectReasonCode[] = [
  'NOT_IMPLEMENTED', 'INVALID_COMMAND', 'UNKNOWN_COMMAND', 'WRONG_CHARACTER', 'PROTOCOL_VERSION_MISMATCH', 'GAME_NOT_READY',
  'GAME_BUSY', 'WRONG_MAP', 'TOO_FAR', 'NPC_NOT_FOUND', 'UNREACHABLE', 'IN_BATTLE', 'NOT_IN_BATTLE', 'STALE_BATTLE',
  'DIALOG_OPEN', 'NOT_IN_DIALOG', 'OPTION_NOT_FOUND', 'NOT_AT_SHOP', 'ITEM_NOT_IN_SHOP', 'COMMAND_NOT_ALLOWED',
  'CORE_REJECTED', 'BATTLE_NOT_READY', 'INVALID_BATTLE_ACTION',
  'MISSING_TOOL', 'MISSING_MATERIAL', 'INVENTORY_FULL', 'TOOL_BROKEN', 'NO_STAMINA', 'NOT_AVAILABLE_DATA', 'LEVEL_TOO_LOW',
];

/**
 * 已被接受的指令完成（或中斷）時的結果碼（COMMAND_COMPLETED.code）。
 * - 走路：ARRIVED＝走到目的點（或夠近）；MAP_CHANGED＝走路途中換圖（走到出口時這是預期結果）；
 *   ENCOUNTER＝被暗雷遇敵打斷；SUPERSEDED＝被新的走路／手動操作取代；BLOCKED＝路徑走不通或被障礙擋下；TIMEOUT。
 * - 其他：DIALOG_OPENED（TALK_TO_NPC）、DONE（狀態指令與選項）、TURN_SUBMITTED（戰鬥動作已送出並結算）、
 *   FLED／FLEE_FAILED（逃跑結果）。
 * - WORK_ONCE：WORK_DONE（產出在 `output`）、TOOL_BROKEN（這次仍完成並有產出，但工具壞了；outcome 為 DONE）、
 *   FAILED_ROLL（擲骰失敗；採集沒有產出，製作會消耗材料）、CANCELLED（玩家取消，沒有任何消耗）、
 *   以及結算時發現條件已變的 WorkReasonCode（MISSING_*／INVENTORY_FULL／TOO_FAR／NO_STAMINA…，outcome FAILED，沒有任何消耗）。
 */
export type CompletionCode =
  | 'ARRIVED' | 'MAP_CHANGED' | 'ENCOUNTER' | 'SUPERSEDED' | 'BLOCKED' | 'TIMEOUT'
  | 'DIALOG_OPENED' | 'DONE' | 'TURN_SUBMITTED' | 'FLED' | 'FLEE_FAILED' | 'BATTLE_ENDED' | 'GAME_STOPPED'
  | 'WORK_DONE' | 'CANCELLED' | WorkReasonCode;

export const COMPLETION_CODES: readonly CompletionCode[] = [
  'ARRIVED', 'MAP_CHANGED', 'ENCOUNTER', 'SUPERSEDED', 'BLOCKED', 'TIMEOUT',
  'DIALOG_OPENED', 'DONE', 'TURN_SUBMITTED', 'FLED', 'FLEE_FAILED', 'BATTLE_ENDED', 'GAME_STOPPED',
  'WORK_DONE', 'CANCELLED', ...WORK_REASON_CODES,
];
export type CompletionOutcome = 'DONE' | 'INTERRUPTED' | 'FAILED';
export const COMPLETION_OUTCOMES: readonly CompletionOutcome[] = ['DONE', 'INTERRUPTED', 'FAILED'];

/**
 * 對話選項 id 約定（DIALOG_OPENED／DIALOG_UPDATED 的 options[].id，CHOOSE_DIALOG_OPTION 的 optionId）：
 *   `ACCEPT_QUEST:<id>`、`COMPLETE_QUEST:<id>`、`OPEN_SHOP`（商店）、`OPEN_FACILITY:<名稱>`（醫院／打鐵舖）、
 *   `ENABLE_DEMO_MODE`（忠實模式下啟用重建示範，等同對話框內的按鈕）、`CLOSE`（告辭離開）。
 * 商店開啟後（SHOP_OPENED）可用的選項：`CLOSE_SHOP`。
 * 戰鬥結算視窗開著時（BATTLE_ENDED 之後的勝利／敗北視窗，`activity.battleResult` 非 null）可用的選項：
 *   `RETURN_TO_MAP`（勝利：返回地圖探索）、`DEFEAT_RESCUE`（敗北：送回醫院）。
 */
export const DIALOG_OPTION_CLOSE = 'CLOSE';
export const SHOP_OPTION_CLOSE = 'CLOSE_SHOP';

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

export interface SnapshotItem {
  itemId: number;
  name: string | null;
  count: number;
}

export interface SnapshotShopGood {
  itemId: number;
  name: string | null;
  price: number;
  category?: string;
  /** 這個商品／價格的資料來源（P3 起）；沒有標記＝舊資料。 */
  source?: SourceTag;
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
  /** P3：產出道具、名稱、單次耗時／成功率／數量範圍，與資料來源（座標、產出、耗時各欄來源見 work 資料檔的 fieldSources）。 */
  itemId?: number;
  itemName?: string | null;
  requiredToolName?: string | null;
  durationMs?: number;
  successRate?: number;
  countMin?: number;
  countMax?: number;
  source?: SourceTag;
}

/** 「附近可採」：本圖採集點由近到遠，含離角色的距離、是否已在採集範圍內、是否持有所需工具。 */
export interface SnapshotNearbyGather {
  pointId: string;
  distance: number;
  withinReach: boolean;
  requiredToolItemId: number | null;
  haveTool: boolean;
}

export interface SnapshotWorkTool {
  itemId: number;
  name: string;
  skillId: number;
  count: number;
  /** 目前使用中那把的剩餘耐久；沒有這項道具為 null。 */
  durability: number | null;
  maxDurability: number;
}

export interface SnapshotWorkStation {
  id: string;
  name: string;
  kind: string;
  x: number;
  y: number;
  reach: number;
  workTypes: WorkType[];
  source: SourceTag;
}

/** 工具販售處（全世界已知；只有本圖的商店 NPC 在對話後才會真的賣）。 */
export interface SnapshotVendor {
  mapId: string;
  npcName: string;
  itemId: number;
  itemName: string | null;
  price: number | null;
  source: SourceTag;
}

export interface WorkInProgress {
  commandId: string;
  workType: WorkType;
  targetId: string;
  /** 宿主時鐘（performance.now 換算成 epoch ms）開始時間與預計結束時間。 */
  startedAt: number;
  endsAt: number;
  durationMs: number;
}

/** 工作資料與角色工作狀態（P3 / FX6）。外掛用它決定要不要先買工具、背包滿了沒有、站點在哪。 */
export interface SnapshotWork {
  status: DataAvailability;
  reason?: string;
  /** 宿主載入的 work_data 版本與來源（repo-extracted-json｜p00.adf）；外掛的資料副本版本不同時要警告。 */
  dataVersion: number | null;
  origin: string | null;
  inventory: { slotsUsed: number; slotLimit: number; stackMax: number; source: SourceTag };
  stamina: { value: number; max: number; gatherCost: number; craftCost: number; source: SourceTag };
  tools: SnapshotWorkTool[];
  stations: SnapshotWorkStation[];
  vendors: SnapshotVendor[];
  /** 「客戶端找不到」清單的項目數（清單全文在 docs/data/WORK_DATA_MISSING.md）。 */
  missingCount: number;
  /** 工作技能等級（技能 id → 等級）。 */
  skillLevels: Record<string, number>;
}

/** WORK_ONCE 結算輸出（COMMAND_COMPLETED.output）。 */
export interface WorkOutput {
  workType: WorkType;
  targetId: string;
  gained: Array<{ itemId: number; name: string | null; count: number }>;
  consumed: Array<{ itemId: number; name: string | null; count: number }>;
  staminaLeft: number;
  /** 使用的工具剩餘耐久；沒用工具為 null。 */
  toolDurabilityLeft: number | null;
  toolBroken: boolean;
  skillId: number | null;
  skillLevel: number | null;
  roll: number;
  successRate: number;
  inventorySlotsUsed: number;
  /** 背包裡沒有再裝一份同樣產出的空間（外掛可用來預先停工）。 */
  inventoryFullAfter: boolean;
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

/** 世界地圖鄰接（每張地圖通往哪些地圖）；外掛用它規劃跨圖路線，各地圖的出口座標到了該圖再從 `exits` 取得。 */
export interface SnapshotPortalNode {
  mapId: string;
  name: string | null;
  targets: string[];
}

/** 進行中的互動狀態：外掛重連時用它重建「現在正在對話／戰鬥」。 */
export interface SnapshotActivity {
  dialog: { npcId: string; npcName: string; lines: string[]; options: DialogOption[] } | null;
  shop: { npcId: string; npcName: string } | null;
  /** 戰鬥結束後的勝敗結算視窗（需要 RETURN_TO_MAP／DEFEAT_RESCUE 才會回到地圖）。 */
  battleResult: 'VICTORY' | 'DEFEAT' | null;
  battle: { battleId: number; round: number; enemies: BattleEnemyState[]; canFlee: boolean } | null;
  /** 宿主正在執行的畫面指令（走路中）。 */
  command: { commandId: string; type: string } | null;
  /** P3：進行中的單次工作（角色忙碌中）；外掛重開時用它與自己的佇列比對，不重送。 */
  work: WorkInProgress | null;
}

export interface SceneSnapshot {
  schema: 'scene-snapshot';
  mapId: string;
  mapName: string | null;
  character: SnapshotCharacter;
  npcs: SnapshotNpc[];
  exits: SnapshotExit[];
  /**
   * 採集點：本圖的採集點。P3 起來自 work_data（目前全是 CUSTOM 自訂位置，`status` 為 RECONSTRUCTED_DEMO 表示「有資料但不是原版提取」）；
   * 沒有工作資料（或這張圖沒資料）時 UNAVAILABLE，外掛不得當成「本區沒有採集點」。`nearby`＝附近可採（由近到遠）。
   */
  gatherPoints: { status: DataAvailability; reason?: string; points: SnapshotGatherPoint[]; nearby: SnapshotNearbyGather[] };
  /** P3：工作資料、背包格數、體力、工具、站點與販售處。 */
  work: SnapshotWork;
  shops: SnapshotShop[];
  /** 背包（含數量）；賣東西與戰鬥用道具要從這裡選。 */
  inventory: SnapshotItem[];
  activity: SnapshotActivity;
  nav: {
    status: DataAvailability;
    reason?: string;
    /** 以傳送點相連可到達的地圖（含直接出口，hops 由近到遠）。 */
    reachableMaps: SnapshotReachableMap[];
    /** 地圖像素寬高，供外掛估距離。 */
    pixelWidth: number | null;
    pixelHeight: number | null;
    /** 世界目錄的地圖鄰接（沒有世界目錄時只有目前地圖與其直接出口）。 */
    portalGraph: SnapshotPortalNode[];
  };
}

// ---------------------------------------------------------------------------
// 事件（宿主 → 外掛）
// ---------------------------------------------------------------------------

export interface DialogOption { id: string; label: string }

export interface BattleEnemyBrief { id: string; name: string; level: number | null }
/** 回合就緒時敵人的即時狀態（只列存活者）。 */
export interface BattleEnemyState { slot: number; id: string; name: string; hp: number; maxHp: number }

export type LocationChangeCause = 'LOAD' | 'MAP_CHANGE' | 'WARP';
export type BattleOutcome = 'WIN' | 'LOSE' | 'FLEE' | 'UNKNOWN';

export type GameEvent =
  | { type: 'GAME_STARTED'; sessionId: string }
  | { type: 'GAME_STOPPED'; sessionId: string; reason: 'PAGE_HIDE' | 'UNLOAD' | 'SHUTDOWN' }
  | { type: 'LOCATION_CHANGED'; mapId: string; mapName: string | null; fromMapId: string | null; x: number; y: number; cause: LocationChangeCause }
  | { type: 'MOVED'; mapId: string; x: number; y: number; dir: number }
  | { type: 'DIALOG_OPENED'; npcId: string; npcName: string; role: string | null; lines: string[]; options: DialogOption[]; optionsAvailable: boolean }
  | { type: 'DIALOG_UPDATED'; npcId: string; lines: string[]; options: DialogOption[] }
  | { type: 'DIALOG_CLOSED'; npcId: string }
  | { type: 'SHOP_OPENED'; npcId: string; npcName: string; goods: SnapshotShopGood[] }
  | { type: 'SHOP_CLOSED'; npcId: string }
  | { type: 'BATTLE_STARTED'; battleId: number; mapId: string; enemies: BattleEnemyBrief[] }
  | { type: 'BATTLE_ENDED'; battleId: number; outcome: BattleOutcome }
  | { type: 'BATTLE_TURN_READY'; battleId: number; round: number; enemies: BattleEnemyState[]; canFlee: boolean }
  | { type: 'INVENTORY_CHANGED'; changes: Array<{ itemId: number; delta: number; count: number }> }
  | { type: 'GOLD_CHANGED'; gold: number; delta: number }
  | { type: 'COMMAND_ACCEPTED'; commandId: string }
  | { type: 'COMMAND_REJECTED'; commandId: string; reasonCode: RejectReasonCode; message?: string }
  | { type: 'COMMAND_COMPLETED'; commandId: string; outcome: CompletionOutcome; code: CompletionCode; message?: string; output?: WorkOutput };

export const GAME_EVENT_TYPES = [
  'GAME_STARTED', 'GAME_STOPPED', 'LOCATION_CHANGED', 'MOVED', 'DIALOG_OPENED', 'DIALOG_UPDATED', 'DIALOG_CLOSED',
  'SHOP_OPENED', 'SHOP_CLOSED', 'BATTLE_STARTED', 'BATTLE_ENDED', 'BATTLE_TURN_READY', 'INVENTORY_CHANGED', 'GOLD_CHANGED',
  'COMMAND_ACCEPTED', 'COMMAND_REJECTED', 'COMMAND_COMPLETED',
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
