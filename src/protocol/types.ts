// [sync-protocol] 自動產生，請勿手改；改協定請到 fairyland 修改後重新執行 npm run sync-protocol
// [sync-protocol] 來源：fairyland/packages/shared/src/protocol/types.ts @ 3dae01500373b7801acbbbc192b2a0a2cfa4150b
/**
 * FX1：fairyland（純淨宿主）與 fairyland-family（智慧外掛）之間的外掛協定型別。
 *
 * 規則：
 * - 這個資料夾自成一體（不得 import 本資料夾以外的檔案），因為 fairyland-family 會用
 *   `scripts/sync-protocol.mjs` 把整個資料夾原樣複製過去。
 * - 每則訊息都帶 `v`（`PROTOCOL_VERSION`）與 `characterId`；指令另外帶 `commandId`。
 *   P1–P3 只有單一角色，`characterId` 固定是目前角色；多角色之後不必升協定版本。
 * - P2（協定版本 2）：宿主執行 WALK_TO／TALK_TO_NPC／CHOOSE_DIALOG_OPTION／ACCEPT_QUEST／BUY_ITEM／SELL_ITEM／
 *   BATTLE_ACTION／BATTLE_FLEE（WORK_ONCE 仍是 `NOT_IMPLEMENTED`，P3 才做）。每個指令先回 COMMAND_ACCEPTED 或
 *   COMMAND_REJECTED（附原因碼），需要時間的指令（走路、戰鬥回合）完成或被中斷時再送 COMMAND_COMPLETED。
 * - 版本 2 相對版本 1 的不相容變更：BATTLE_ACTION 改為單一角色的 `action`；`NOT_IMPLEMENTED_P1` 改名
 *   `NOT_IMPLEMENTED`；快照新增 `inventory`／`activity`／`nav.portalGraph`；事件新增 COMMAND_COMPLETED、
 *   DIALOG_UPDATED、SHOP_OPENED、SHOP_CLOSED；BATTLE_TURN_READY 帶敵人與可否逃跑。
 * - 版本 5（F5，fairyland-family#43）：`SnapshotPortalNode` 新增必填 `portals`（逐個傳送點：id、名稱、座標、目的地圖、
 *   目的地圖是否已匯入、穿過去的落點），讓外掛不必先走過每張圖就能規劃跨圖路線。
 */

/** 協定版本。欄位語意不相容地改變時才遞增。 */
export const PROTOCOL_VERSION = 5;

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
/** 單次工作（採集／製作）。`skillId`＝採集技能（可帶 `targetItemId` 指定材料）；`recipeId`＝製作配方（二擇一）。 */
export interface WorkOnceCommand { type: 'WORK_ONCE'; skillId?: number; recipeId?: number; targetItemId?: number }
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
/** 要求宿主立刻廣播一份完整場景快照（可選 includeStatic 一併帶靜態資料）。 */
export interface RequestSnapshotCommand { type: 'REQUEST_SNAPSHOT'; includeStatic?: boolean }
/** 要求宿主送一次靜態資料（FX15：配方、傳送門圖、技能表、FX12 素材約定）。 */
export interface RequestStaticDataCommand { type: 'REQUEST_STATIC_DATA' }
/** 切換 2D 畫面目前觀察中的家族角色（FX4）。 */
export interface SwitchViewCharacterCommand { type: 'SWITCH_VIEW_CHARACTER'; characterId: string }
/** 將物品或金幣存入家族共用倉庫（FX7；以信封 `characterId` 決定操作者）。 */
export interface WarehouseDepositCommand { type: 'WAREHOUSE_DEPOSIT'; itemId?: number; count?: number; gold?: number }
/** 從家族共用倉庫取出物品或金幣到該角色背包（FX7）。 */
export interface WarehouseWithdrawCommand { type: 'WAREHOUSE_WITHDRAW'; itemId?: number; count?: number; gold?: number }
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
  | RequestStaticDataCommand
  | SwitchViewCharacterCommand
  | WarehouseDepositCommand
  | WarehouseWithdrawCommand
  | GameCommandPassthrough;

export const PLUGIN_COMMAND_TYPES = [
  'WALK_TO', 'TALK_TO_NPC', 'CHOOSE_DIALOG_OPTION', 'ACCEPT_QUEST', 'BUY_ITEM', 'SELL_ITEM',
  'WORK_ONCE', 'BATTLE_ACTION', 'BATTLE_FLEE', 'REQUEST_SNAPSHOT', 'REQUEST_STATIC_DATA',
  'SWITCH_VIEW_CHARACTER', 'WAREHOUSE_DEPOSIT', 'WAREHOUSE_WITHDRAW', 'GAME_COMMAND',
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
  | 'MISSING_TOOL'
  | 'INSUFFICIENT_MATERIALS'
  | 'INSUFFICIENT_GOLD'
  | 'INSUFFICIENT_STAMINA'
  | 'INVENTORY_FULL'
  | 'SKILL_LEVEL_TOO_LOW'
  | 'UNKNOWN_SKILL'
  | 'UNKNOWN_RECIPE'
  | 'INSUFFICIENT_WAREHOUSE_GOLD'
  | 'INSUFFICIENT_WAREHOUSE_ITEMS'
  | 'CHARACTER_NOT_FOUND'
  | 'WAREHOUSE_FULL';

export const REJECT_REASON_CODES: readonly RejectReasonCode[] = [
  'NOT_IMPLEMENTED', 'INVALID_COMMAND', 'UNKNOWN_COMMAND', 'WRONG_CHARACTER', 'PROTOCOL_VERSION_MISMATCH', 'GAME_NOT_READY',
  'GAME_BUSY', 'WRONG_MAP', 'TOO_FAR', 'NPC_NOT_FOUND', 'UNREACHABLE', 'IN_BATTLE', 'NOT_IN_BATTLE', 'STALE_BATTLE',
  'DIALOG_OPEN', 'NOT_IN_DIALOG', 'OPTION_NOT_FOUND', 'NOT_AT_SHOP', 'ITEM_NOT_IN_SHOP', 'COMMAND_NOT_ALLOWED',
  'CORE_REJECTED', 'BATTLE_NOT_READY', 'INVALID_BATTLE_ACTION',
  'MISSING_TOOL', 'INSUFFICIENT_MATERIALS', 'INSUFFICIENT_GOLD', 'INSUFFICIENT_STAMINA', 'INVENTORY_FULL',
  'SKILL_LEVEL_TOO_LOW', 'UNKNOWN_SKILL', 'UNKNOWN_RECIPE',
  'INSUFFICIENT_WAREHOUSE_GOLD', 'INSUFFICIENT_WAREHOUSE_ITEMS', 'CHARACTER_NOT_FOUND', 'WAREHOUSE_FULL',
];

/**
 * 已被接受的指令完成（或中斷）時的結果碼（COMMAND_COMPLETED.code）。
 * - 走路：ARRIVED＝走到目的點（或夠近）；MAP_CHANGED＝走路途中換圖（走到出口時這是預期結果）；
 *   ENCOUNTER＝被暗雷遇敵打斷；SUPERSEDED＝被新的走路／手動操作取代；BLOCKED＝路徑走不通或被障礙擋下；TIMEOUT。
 * - 其他：DIALOG_OPENED（TALK_TO_NPC）、DONE（狀態指令與選項）、TURN_SUBMITTED（戰鬥動作已送出並結算）、
 *   FLED／FLEE_FAILED（逃跑結果）。
 */
export type CompletionCode =
  | 'ARRIVED' | 'MAP_CHANGED' | 'ENCOUNTER' | 'SUPERSEDED' | 'BLOCKED' | 'TIMEOUT'
  | 'DIALOG_OPENED' | 'DONE' | 'TURN_SUBMITTED' | 'FLED' | 'FLEE_FAILED' | 'BATTLE_ENDED' | 'GAME_STOPPED';

export const COMPLETION_CODES: readonly CompletionCode[] = [
  'ARRIVED', 'MAP_CHANGED', 'ENCOUNTER', 'SUPERSEDED', 'BLOCKED', 'TIMEOUT',
  'DIALOG_OPENED', 'DONE', 'TURN_SUBMITTED', 'FLED', 'FLEE_FAILED', 'BATTLE_ENDED', 'GAME_STOPPED',
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

export interface SnapshotActiveWork {
  kind: 'GATHER' | 'CRAFT';
  skillId?: number;
  recipeId?: number;
  targetItemId?: number;
  label: string;
  startedAt: number;
  endsAt: number;
}

export type CharacterVisualAction = 'IDLE' | 'WALK' | 'WORK' | 'BATTLE';

export interface SnapshotMovePath {
  waypoints: Array<{ x: number; y: number }>;
  startedAt: number;
  endsAt: number;
  speedPxPerSec?: number;
}

export interface SnapshotRampTint {
  hair: [number, number, number];
  skin: [number, number, number];
  outfit: [number, number, number];
}

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
  /** FX13：畫面狀態（外觀模型、武器、染色、目前動作、移動路徑與時間）。 */
  modelId?: string;
  weaponModel?: string;
  tint?: SnapshotRampTint;
  action?: CharacterVisualAction;
  movePath?: SnapshotMovePath | null;
  satiety?: number;
  maxSatiety?: number;
  inventoryCount?: number;
  inventoryCap?: number;
  workSkills?: Record<number, number>;
  activeWork?: SnapshotActiveWork | null;
  /** FL1：目前規則卡匣與職業名稱（classic 顯示職業，revamp 顯示武器族與連擊）。 */
  ruleset?: 'classic' | 'revamp';
  className?: string;
  /** FX8：目前裝備武器系別、該系熟練等級、連擊等級與各系熟練等級。 */
  weaponFamily?: string;
  familyLevel?: number;
  comboLevel?: number;
  masteryLevels?: Record<string, number>;
  statuses?: SnapshotBattleStatus[];
  isDefending?: boolean;
  isChanting?: boolean;
  activePet?: SnapshotBattleUnitSummary | null;
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

export interface SnapshotGatherMaterial {
  itemId: number;
  name: string;
  reqLevel: number;
}

export interface SnapshotGatherPoint {
  id: string;
  name: string;
  mapId?: string;
  mapName?: string | null;
  x: number;
  y: number;
  skillId: number | null;
  skillName?: string;
  requiredToolItemId: number | null;
  requiredToolName?: string | null;
  materials?: SnapshotGatherMaterial[];
  walkableVerified?: boolean;
  source?: 'EXTRACTED' | 'CUSTOM_STARTER_LOOP';
}

export interface SnapshotWorkRecipeIngredient {
  itemId: number | null;
  name: string;
  count: number;
  resolved: boolean;
}

export interface SnapshotWorkRecipe {
  recipeId: number;
  resultItemId: number;
  name: string;
  skillId: number;
  skillName: string;
  reqLevel: number;
  ingredients: SnapshotWorkRecipeIngredient[];
  unresolvedIngredients: string[];
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

/** 傳送點所通往的目的地圖在宿主端的狀態：IMPORTED＝已匯入可進入；NOT_IMPORTED＝世界目錄沒有或未匯入（原版資料斷點，走過去也進不去）；UNKNOWN＝宿主沒有世界目錄可判斷。 */
export type PortalTargetStatus = 'IMPORTED' | 'NOT_IMPORTED' | 'UNKNOWN';
export const PORTAL_TARGET_STATUSES: readonly PortalTargetStatus[] = ['IMPORTED', 'NOT_IMPORTED', 'UNKNOWN'];

/**
 * v5：傳送點圖的一條邊。`x`／`y` 是這個傳送點在「所屬地圖」的世界像素座標（WALK_TO 的目標，宿主端缺資料時省略）；
 * `entryX`／`entryY` 是穿過去之後在目的地圖的落點（缺資料時省略）。座標全部由宿主從已載入的世界目錄與場景資料即時算出。
 */
export interface SnapshotPortalEdge {
  id: string;
  name: string;
  x?: number;
  y?: number;
  targetMapId: string;
  targetMapName: string | null;
  targetStatus: PortalTargetStatus;
  entryX?: number;
  entryY?: number;
}

/** 世界地圖鄰接（每張地圖通往哪些地圖）；v5 起每張圖另附逐個傳送點（`portals`），外掛用它規劃跨圖路線並對每個傳送點送 WALK_TO。 */
export interface SnapshotPortalNode {
  mapId: string;
  name: string | null;
  /** 可直接通往的地圖 id（含 NOT_IMPORTED 的目的地）。 */
  targets: string[];
  /** v5：這張圖的傳送點（不含指回本圖的建築入口）。 */
  portals: SnapshotPortalEdge[];
}

/** 進行中的互動狀態：外掛重連時用它重建「現在正在對話／戰鬥」。 */
export interface SnapshotActivity {
  dialog: { npcId: string; npcName: string; lines: string[]; options: DialogOption[] } | null;
  shop: { npcId: string; npcName: string } | null;
  /** 戰鬥結束後的勝敗結算視窗（需要 RETURN_TO_MAP／DEFEAT_RESCUE 才會回到地圖）。 */
  battleResult: 'VICTORY' | 'DEFEAT' | null;
  battle: {
    battleId: number;
    round: number;
    enemies: BattleEnemyState[];
    canFlee: boolean;
    player?: SnapshotBattleUnitSummary;
    pet?: SnapshotBattleUnitSummary | null;
  } | null;
  /** 宿主正在執行的畫面指令（走路中）。 */
  command: { commandId: string; type: string } | null;
}

export interface SnapshotFamilyMember {
  characterId: string;
  name: string | null;
  level: number;
  mapId: string;
  mapName: string | null;
  x: number;
  y: number;
  dir?: number;
  modelId?: string;
  weaponModel?: string;
  tint?: SnapshotRampTint;
  action?: CharacterVisualAction;
  movePath?: SnapshotMovePath | null;
  gold: number;
  satiety: number;
  inventoryCount: number;
  inventoryCap: number;
  inBattle: boolean;
  inventory: SnapshotItem[];
  workSkills: Record<number, number>;
  activeWork?: SnapshotActiveWork | null;
}

export interface SnapshotFamilyState {
  activeCharacterId: string;
  maxSlots: number;
  members: SnapshotFamilyMember[];
  warehouse: {
    gold: number;
    cap: number;
    items: SnapshotItem[];
  };
}

export interface SceneSnapshot {
  schema: 'scene-snapshot';
  mapId: string;
  mapName: string | null;
  character: SnapshotCharacter;
  /** FX4+FX7：家族成員摘要、目前視角與家族共用倉庫。 */
  family?: SnapshotFamilyState;
  npcs: SnapshotNpc[];
  exits: SnapshotExit[];
  /** 採集點（FX6：依 maps/*.adf 與 10001 新手採礦點提供本圖可走採集點）。 */
  gatherPoints: { status: DataAvailability; reason?: string; points: SnapshotGatherPoint[] };
  /** 附近其他已匯入可達地圖的採集點（供外掛搜尋跨圖採集目標）。 */
  nearbyGatherPoints?: SnapshotGatherPoint[];
  /** FX6 工作製造／冶煉／鍛造配方目錄。 */
  recipes?: SnapshotWorkRecipe[];
  shops: SnapshotShop[];
  /** 背包（含數量）；賣東西與戰鬥用道具要從這裡選。 */
  inventory: SnapshotItem[];
  activity: SnapshotActivity;
  openingStage?: string;
  quests?: SnapshotQuestEntry[];
  nav: {
    status: DataAvailability;
    reason?: string;
    /** 以傳送點相連可到達的地圖（含直接出口，hops 由近到遠）。 */
    reachableMaps: SnapshotReachableMap[];
    /** 地圖像素寬高，供外掛估距離。 */
    pixelWidth: number | null;
    pixelHeight: number | null;
    /** v4 起改於 STATIC_DATA 連線時送一次（Snapshot 可省略以瘦身）；測試或舊夾具可選附帶。 */
    portalGraph?: SnapshotPortalNode[];
  };
}

// ---------------------------------------------------------------------------
// 事件（宿主 → 外掛）
// ---------------------------------------------------------------------------

export interface DialogOption { id: string; label: string }

export interface BattleEnemyBrief {
  id: string;
  name: string;
  level: number | null;
  slot?: number;
  modelId?: string;
  colorTint?: string;
}
/** 回合就緒時敵人的即時狀態（只列存活者）。 */
export interface SnapshotBattleStatus {
  type: string;
  duration: number;
  value?: number;
  stacks?: number;
}

export interface SnapshotBattleUnitSummary {
  id: string;
  name: string;
  hp: number;
  maxHp: number;
  mp?: number;
  maxMp?: number;
  slot?: number;
  row?: 'FRONT' | 'BACK';
  modelId?: string;
  weaponModel?: string;
  colorTint?: string;
  isDead?: boolean;
  isDefending?: boolean;
  isChanting?: boolean;
  statuses?: SnapshotBattleStatus[];
}

export interface SnapshotQuestTargetMapHint {
  mapId: string;
  mapName: string | null;
  reason: 'ENCOUNTER_AREA' | 'ENCOUNTER_POOL' | 'GATHER_POINT';
  x?: number;
  y?: number;
  pools?: string[];
}

export interface SnapshotQuestObjective {
  type: string;
  description: string;
  current: number;
  required: number;
  met: boolean;
  targetMaps?: SnapshotQuestTargetMapHint[];
  /** 進行中的目標才帶；宿主目錄裡有才出現。 */
  targetNpcName?: string;
  targetMapId?: string;
  itemId?: number;
  itemName?: string;
}

export interface SnapshotQuestEntry {
  questId: number;
  title: string;
  npcId: string;
  npcName: string;
  minLevel: number;
  status: 'AVAILABLE' | 'IN_PROGRESS' | 'READY' | 'COMPLETED';
  prerequisites?: number[];
  objectives: SnapshotQuestObjective[];
  rewardExp: number;
  rewardCoins: number;
}

export interface BattleEnemyState {
  slot: number;
  id: string;
  name: string;
  hp: number;
  maxHp: number;
  row?: 'FRONT' | 'BACK';
  modelId?: string;
  colorTint?: string;
  isDead?: boolean;
  isDefending?: boolean;
  isChanting?: boolean;
  statuses?: SnapshotBattleStatus[];
}

/** FX14：戰鬥時間軸事件單項（供 family FM2 播放動畫與特效）。 */
export interface BattleTimelineItem {
  tMs: number;
  type: string;
  actorId?: string;
  targetId?: string;
  targetIds?: string[];
  actionName?: string;
  skillId?: number;
  effectId?: string;
  damage?: number;
  heal?: number;
  isCrit?: boolean;
  isCombo?: boolean;
  comboIndex?: number;
  comboTotal?: number;
  statusType?: string;
  isCaptured?: boolean;
  message?: string;
}

export type LocationChangeCause = 'LOAD' | 'MAP_CHANGE' | 'WARP';
export type BattleOutcome = 'WIN' | 'LOSE' | 'FLEE' | 'UNKNOWN';

export type GameEvent =
  | { type: 'GAME_STARTED'; sessionId: string }
  | { type: 'GAME_STOPPED'; sessionId: string; reason: 'PAGE_HIDE' | 'UNLOAD' | 'SHUTDOWN' }
  | { type: 'LOCATION_CHANGED'; mapId: string; mapName: string | null; fromMapId: string | null; x: number; y: number; cause: LocationChangeCause }
  | { type: 'MOVED'; mapId: string; x: number; y: number; dir: number; action?: CharacterVisualAction; movePath?: SnapshotMovePath | null }
  | { type: 'DIALOG_OPENED'; npcId: string; npcName: string; role: string | null; lines: string[]; options: DialogOption[]; optionsAvailable: boolean }
  | { type: 'DIALOG_UPDATED'; npcId: string; lines: string[]; options: DialogOption[] }
  | { type: 'DIALOG_CLOSED'; npcId: string }
  | { type: 'SHOP_OPENED'; npcId: string; npcName: string; goods: SnapshotShopGood[] }
  | { type: 'SHOP_CLOSED'; npcId: string }
  | { type: 'BATTLE_STARTED'; battleId: number; mapId: string; enemies: BattleEnemyBrief[]; allies?: SnapshotBattleUnitSummary[] }
  | { type: 'BATTLE_ENDED'; battleId: number; outcome: BattleOutcome }
  | { type: 'BATTLE_TIMELINE'; battleId: number; round: number; events: BattleTimelineItem[] }
  | {
      type: 'BATTLE_TURN_READY';
      battleId: number;
      round: number;
      enemies: BattleEnemyState[];
      canFlee: boolean;
      player?: SnapshotBattleUnitSummary;
      pet?: SnapshotBattleUnitSummary | null;
    }
  | { type: 'INVENTORY_CHANGED'; changes: Array<{ itemId: number; delta: number; count: number }> }
  | { type: 'GOLD_CHANGED'; gold: number; delta: number }
  | { type: 'WAREHOUSE_CHANGED'; items: SnapshotItem[]; gold: number }
  | { type: 'ACTIVE_CHARACTER_CHANGED'; characterId: string }
  | { type: 'COMMAND_ACCEPTED'; commandId: string }
  | { type: 'COMMAND_REJECTED'; commandId: string; reasonCode: RejectReasonCode; message?: string }
  | { type: 'COMMAND_COMPLETED'; commandId: string; outcome: CompletionOutcome; code: CompletionCode; message?: string };

export const GAME_EVENT_TYPES = [
  'GAME_STARTED', 'GAME_STOPPED', 'LOCATION_CHANGED', 'MOVED', 'DIALOG_OPENED', 'DIALOG_UPDATED', 'DIALOG_CLOSED',
  'SHOP_OPENED', 'SHOP_CLOSED', 'BATTLE_STARTED', 'BATTLE_ENDED', 'BATTLE_TIMELINE', 'BATTLE_TURN_READY', 'INVENTORY_CHANGED', 'GOLD_CHANGED',
  'WAREHOUSE_CHANGED', 'ACTIVE_CHARACTER_CHANGED',
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

/** FX12：同源、唯讀、有版本的素材清單與圖層／混色約定。 */
export interface StaticAssetManifest {
  version: string;
  baseUrl: string;
  readOnly: true;
  paths: {
    spriteManifest: string;
    spriteAtlas: string;
    mapScene: string;
    mapAsset: string;
    spellManifest: string;
    spellAtlas: string;
    worldCatalog: string;
    battleBg: string;
    itemIcon: string;
    digitsManifest: string;
  };
  spriteLayerOrder: string[];
  supportedBlendModes: Array<'normal' | 'additive' | 'screen' | 'luma_alpha'>;
}

/** FX15：技能表摘要（供 family FM3 顯示對照與戰鬥面板查表）。 */
export interface StaticSkillSummary {
  id: number;
  name: string;
  kind: 'SKILL' | 'SPELL';
  mpCost: number;
  targetScope: string;
  maxTargets?: number;
  element?: string;
  animId?: string;
  weaponFamily?: string;
  reqLevel?: number;
}

/** FX15／B9：連線時送一次的靜態資料（配方、地圖與傳送點鄰接、技能表、FX12 素材約定）。 */
export interface StaticDataPayload {
  schema: 'static-data';
  version: string;
  recipes: SnapshotWorkRecipe[];
  portalGraph: SnapshotPortalNode[];
  skills: StaticSkillSummary[];
  assets: StaticAssetManifest;
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
  /** FX16：宿主處於 `?clock=1` 只當時鐘模式（不畫畫面）。 */
  clockOnly?: boolean;
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

export interface StaticDataMessage extends EnvelopeBase {
  kind: 'static-data';
  seq: number;
  inReplyTo?: string;
  staticData: StaticDataPayload;
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
  | StaticDataMessage
  | EventMessage
  | CommandMessage
  | CommandResultMessage;

export const MESSAGE_KINDS = ['heartbeat', 'snapshot', 'static-data', 'event', 'command', 'command-result'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
