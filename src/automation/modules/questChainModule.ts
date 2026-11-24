import type { CaptureTurnOverride, HealTurnOverride } from '../../battler';
import type { AutoBattler } from '../../battler';
import { buildCheckpointFromState, buildStopRecap, type SessionCheckpoint, type WelcomeRecapSummary } from '../../dv7_recap';
import type { DirNpc } from '../../directory';
import type { AutoNavigator } from '../../navigator';
import type { UiAction } from '../../parse';
import { isEventMessage, type PluginMessage, type SceneSnapshot, type SnapshotGatherPoint } from '../../protocol/index';
import type { WorkQueue } from '../../queue';
import {
  CHAIN_STOP_LABEL,
  DEFAULT_CHAIN_CONFIG,
  evaluateChainStop,
  nextStuck,
  planUnmetObjective,
  progressSignature,
  selectNextQuest,
  sellableItems,
  pickDepositItem,
  bagUsedCount,
  isBagFull,
  type ChainLoopActivity,
  type ChainMetrics,
  type ChainQuest,
  type ChainStopConditions,
  type QuestChainConfig,
  type StuckState,
} from '../questPlan';
import {
  chainStopForQueue,
  isResumable,
  planRegionTravel,
  questsInRegion,
  regionOfMapId,
  type ChainStopReason,
} from '../regionPlan';
import type { AutomationHostContext, BehaviorModule } from '../types';
import type { QuestBehaviorModule } from './questModule';
import type { StaticRegion } from '../../protocol/index';

/** 一次無人任務最多略過幾件任務；達到就停下，請人看宿主資料。 */
export const MAX_SKIPPED_QUESTS = 3;
/** F7：同一趟跨區導航「走完了卻還不在目標區域」最多重來幾次，超過就以 NAV_FAILED 停下。 */
export const MAX_REGION_TRAVEL_ATTEMPTS = 3;
/** 落敗後最多等宿主送回這麼久，再從目前位置重新跨區。 */
const RESCUE_WAIT_MS = 10_000;
/** 回村補給每步互動／重試的最小間隔，避免對話或商店異常時高頻洗 log。 */
const RESUPPLY_ACTION_COOLDOWN_MS = 500;
const RESUPPLY_NAV_RETRY_MS = 1_500;
const HEAL_RETRY_BACKOFF_MS = 30_000;
const MAX_RESUPPLY_WINDOW_RETRIES = 4;
const MAX_RESUPPLY_EMPTY_NAVS = 3;
const MAX_OPEN_SHOP_ATTEMPTS = 3;

/**
 * 導航因為已經有對話框或商店開著而被拒：人其實已經到了，只是視窗還沒關。
 * 這不是走不過去，下一拍關掉視窗再走就好，不能當成找不到下一步。
 */
export function navBlockedByWindow(text: string | undefined): boolean {
  return /DIALOG_OPEN|SHOP_OPEN|已經有對話框開著|商店開著/.test(text ?? '');
}

export interface QuestChainHost extends AutomationHostContext {
  navigator: AutoNavigator;
  battler: AutoBattler;
  quest: QuestBehaviorModule;
  getQueue: () => WorkQueue;
  knownNpcs: () => DirNpc[];
  knownMaps: () => Array<{ mapId: string; name: string }>;
  showRecap: (summary: WelcomeRecapSummary) => void;
  /** F8：這件任務是不是別的角色正在做；是的話回傳那位角色的名字（同一件任務不同時派給兩人）。 */
  questHeldElsewhere?: (questId: number) => string | null;
}

export interface QuestChainStatus {
  phase: 'IDLE' | 'OPENING' | 'QUESTS' | 'LOOP' | 'STOPPED';
  text: string;
  /** 停工原因碼（`ChainStopReason`）；執行中為 null。 */
  stopReason: string | null;
  /** F7：停下的原因可以續跑（QUEST_CHAIN_RESUME）。 */
  resumable: boolean;
  completedQuestTitles: string[];
  config: QuestChainConfig;
}

interface RememberedShop {
  npcName: string;
  mapId: string;
}

interface RememberedHunt {
  mapId: string;
  mapName: string | null;
  x?: number;
  y?: number;
}

/** 開場指令送出後，階段一直沒變就停下。捕捉本身可以很久，不套這個上限。 */
const OPENING_COMMAND_WAIT_MS = 8_000;
const PATROL_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [80, 0],
  [-80, 0],
  [0, 80],
  [0, -80],
  [48, 48],
  [-48, -48],
];

/**
 * 無人任務鏈：讀宿主快照上的任務目錄，依前置順序接、做、回報。
 * 開場用宿主的 OPENING_ADVANCE／OPENING_CLAIM_REWARD，不點遊戲畫面的村長對話。
 * 捕捉時先打較弱的目標，血量不夠就用名稱像恢復的道具，再不成就抓；戰敗換圖後放下舊的走路指令，改從新地圖走向宿主給的遇敵區。
 * 任務做完（或等級還不夠）後進入可設定的新手循環。
 */
export class QuestChainModule implements BehaviorModule {
  readonly id = 'quest-chain';
  readonly label = '無人任務鏈';
  readonly priority = 28;
  readonly category = 'QUESTING' as const;

  private config: QuestChainConfig = {
    ...DEFAULT_CHAIN_CONFIG,
    stop: { ...DEFAULT_CHAIN_CONFIG.stop },
  };
  private phase: QuestChainStatus['phase'] = 'IDLE';
  private text = '無人任務：閒置';
  private stopReason: string | null = null;
  private startedAt = 0;
  private baseline: SessionCheckpoint | null = null;
  private healSent = false;
  private savedStrategy: ReturnType<AutoBattler['getStrategy']> | null = null;
  private deaths = 0;
  /** 落敗後還沒被宿主送回（LOCATION_CHANGED）的時間點；這段期間不重新跨區，免得從舊地圖出發。 */
  private rescueSince: number | null = null;
  private countedBattle: number | null = null;
  private completed: ChainQuest[] = [];
  /** 開工當下已經完成的任務。摘要只列這次新完成的。 */
  private completedAtStart = new Set<number>();
  private drivingId: number | null = null;
  private stuck: StuckState | null = null;
  private finished = false;
  private ticking = false;
  private seenStage: string | null = null;
  private openingLogged = false;
  private openingCommandId: string | null = null;
  private openingLatch: { stage: string; kind: string; at: number } | null = null;
  private openingCaptured = false;
  private openingReportRejected: { message: string; at: number } | null = null;
  private openingBusy = 0;
  private navKey: string | null = null;
  private homeMapId: string | null = null;
  private shops: RememberedShop[] = [];
  private hunts: RememberedHunt[] = [];
  private gathers: SnapshotGatherPoint[] = [];
  private walkCommandId: string | null = null;
  private walkMapId: string | null = null;
  private walkIssuedAt = 0;
  /** 開場導航的階段與文字沒變超過這個時間，就取消重走，避免戰敗換圖後一直占著。 */
  private navSig = '';
  private navSigAt = 0;
  private patrolIdx = 0;
  private resupply = false;
  private sellSkip = new Set<number>();
  /** F2b：沒有可賣的東西時改存家族倉庫；存過的品項記下來，避免同一項一直重送。 */
  private depositSkip = new Set<number>();
  private wantDeposit = false;
  private healCommandId: string | null = null;
  private healBlockedUntil = 0;
  private healBlockedGold: number | null = null;
  private lastHealCompletedAt: number | null = null;
  private resupplyActionAt = -Infinity;
  private resupplyNavCooldownUntil = 0;
  private resupplyWindowBlocked = 0;
  private resupplyEmptyNavs = 0;
  private openShopAttempts = 0;
  private skippedShops = new Set<string>();
  private activeShopKey: string | null = null;
  private unreachableHuntMaps = new Set<string>();
  /** 這次無人任務略過的任務與原因（例如目標 NPC 不在宿主地圖上）。連續略過太多就停下或轉進新手循環。 */
  private skipped = new Map<number, { title: string; why: string }>();
  private consecutiveSkipped = 0;
  private loopStartedAt: number | null = null;
  private loopLogged = false;
  private sealWarned = false;
  /** F7：目前這趟跨區的目標區域與已重來次數；途中戰鬥中的提示只寫一次。 */
  private travel: { regionId: string; attempts: number; battleLogged: boolean } | null = null;
  /** F7：續跑時佇列還留著上次的停止原因；這個舊原因不再當成新的停工。 */
  private staleQueueStop: string | null = null;

  constructor(private host: QuestChainHost) {}

  isActive(): boolean {
    return this.phase === 'OPENING' || this.phase === 'QUESTS' || this.phase === 'LOOP';
  }

  getSummary(): string {
    return this.text;
  }

  /** F8：任務鏈現在正在推進的任務（沒有在跑就是 null）。 */
  getDrivingQuestId(): number | null {
    return this.isActive() ? this.drivingId : null;
  }

  getStatus(): QuestChainStatus {
    return {
      phase: this.phase,
      text: this.text,
      stopReason: this.stopReason,
      resumable: this.phase === 'STOPPED' && isResumable(this.stopReason),
      completedQuestTitles: this.completed.map(q => q.title),
      config: {
        ...this.config,
        stop: { ...this.config.stop },
      },
    };
  }

  handleAction(action: UiAction): { handled: boolean; error: string | null } {
    if (action.kind === 'QUEST_CHAIN_CONFIG') {
      this.applyConfig(action.patch);
      return { handled: true, error: null };
    }
    if (action.kind === 'QUEST_CHAIN_START') {
      return { handled: true, error: this.start() };
    }
    if (action.kind === 'QUEST_CHAIN_STOP') {
      this.finish('USER', '玩家停止無人任務');
      return { handled: true, error: null };
    }
    if (action.kind === 'QUEST_CHAIN_RESUME') {
      return { handled: true, error: this.resume() };
    }
    return { handled: false, error: null };
  }

  onMessage(msg: PluginMessage): void {
    if (isEventMessage(msg) && msg.event.type === 'BATTLE_ENDED' && msg.event.outcome === 'LOSE') {
      if (this.countedBattle !== msg.event.battleId) {
        this.countedBattle = msg.event.battleId;
        this.deaths += 1;
      }
    }
    if (isEventMessage(msg) && msg.event.type === 'COMMAND_COMPLETED' && msg.event.commandId === this.walkCommandId) {
      this.forgetWalk();
    }
    if (msg.kind === 'command-result' && msg.commandId === this.walkCommandId && msg.status === 'REJECTED') {
      this.forgetWalk();
    }
    if (isEventMessage(msg) && msg.event.type === 'BATTLE_ENDED' && msg.event.outcome === 'LOSE' && this.isActive()) {
      this.forgetWalk();
      this.navKey = null;
      this.navSig = '';
      this.navSigAt = 0;
      if (this.host.navigator.isActive()) this.host.navigator.cancel();
      this.rescueSince = this.host.now();
    }
    if (isEventMessage(msg) && msg.event.type === 'LOCATION_CHANGED') this.rescueSince = null;
    if (msg.kind === 'command-result' && msg.commandId === this.openingCommandId) {
      this.openingCommandId = null;
      if (msg.status === 'REJECTED') this.onOpeningRejected(msg.reasonCode, msg.message);
    }
    if (this.healCommandId) {
      if (msg.kind === 'command-result' && msg.commandId === this.healCommandId && msg.status === 'REJECTED') {
        this.healCommandId = null;
        this.healBlockedUntil = this.host.now() + HEAL_RETRY_BACKOFF_MS;
        this.healBlockedGold = this.host.state().character?.gold ?? null;
        this.host.log(`回村治療無法執行（${msg.message || msg.reasonCode || '被拒'}），暫緩自動回村治療`, 'warn');
      } else if (isEventMessage(msg) && msg.event.type === 'COMMAND_COMPLETED' && msg.event.commandId === this.healCommandId) {
        this.healCommandId = null;
        this.lastHealCompletedAt = this.host.now();
      }
    }
    if (isEventMessage(msg) && msg.event.type === 'BATTLE_TIMELINE' && msg.event.events.some(e => e.isCaptured)) {
      this.openingCaptured = true;
    }
    if (msg.kind === 'snapshot') this.remember(msg.snapshot);
    if (this.isActive()) this.tick();
  }

  tick(): void {
    if (!this.isActive() || this.ticking) return;
    this.ticking = true;
    try {
      this.step();
    } finally {
      this.ticking = false;
    }
  }

  stop(reason?: string): void {
    if (!this.isActive()) return;
    this.finish('USER', reason ?? '無人任務已停止');
  }

  private applyConfig(patch: {
    stop?: Partial<ChainStopConditions>;
    newbieLoop?: boolean;
    loopActivity?: ChainLoopActivity;
    returnHpPct?: number;
    loopOnly?: boolean;
    regionId?: string | null;
  }): void {
    this.config = {
      ...this.config,
      ...(patch.loopOnly !== undefined ? { loopOnly: patch.loopOnly } : {}),
      ...(patch.regionId !== undefined ? { regionId: patch.regionId || null } : {}),
      ...(patch.newbieLoop !== undefined ? { newbieLoop: patch.newbieLoop } : {}),
      ...(patch.loopActivity !== undefined ? { loopActivity: patch.loopActivity } : {}),
      ...(patch.returnHpPct !== undefined ? { returnHpPct: Math.max(1, Math.min(90, patch.returnHpPct)) } : {}),
      stop: { ...this.config.stop, ...(patch.stop ?? {}) },
    };
    this.host.onChange();
  }

  private start(): string | null {
    if (this.host.status() !== 'RUNNING') return '遊戲未執行';
    const st = this.host.state();
    if (!st.snapshot) return '尚未收到任務快照';
    this.finished = false;
    this.stopReason = null;
    this.completed = [];
    this.completedAtStart = new Set(
      (st.snapshot.quests ?? []).filter(q => q.status === 'COMPLETED').map(q => q.questId),
    );
    this.drivingId = null;
    this.stuck = null;
    this.deaths = 0;
    this.countedBattle = null;
    this.seenStage = null;
    this.openingLogged = false;
    this.openingCommandId = null;
    this.openingLatch = null;
    this.openingCaptured = false;
    this.openingReportRejected = null;
    this.openingBusy = 0;
    this.navKey = null;
    this.forgetWalk();
    this.navSig = '';
    this.navSigAt = 0;
    this.resetResupplyState();
    this.unreachableHuntMaps.clear();
    this.skipped.clear();
    this.consecutiveSkipped = 0;
    this.loopStartedAt = null;
    this.loopLogged = false;
    this.sealWarned = false;
    this.travel = null;
    this.startedAt = this.host.now();
    this.baseline = buildCheckpointFromState(st, this.startedAt);
    this.savedStrategy = this.host.battler.getStrategy();
    this.remember(st.snapshot);
    const stage = st.snapshot.openingStage;
    this.phase = stage && stage !== 'DONE' ? 'OPENING' : 'QUESTS';
    this.text = this.phase === 'OPENING' ? '無人任務：開場主線' : '無人任務：依宿主目錄接任務';
    this.host.log('無人任務開始：依宿主提供的任務目錄依序執行，做完目前等級能做的之後進入新手循環');
    this.host.onChange();
    this.tick();
    return null;
  }

  /**
   * F7：從可續跑的停工接著做。已完成的任務、回來摘要的起點與設定（含區域）保留；
   * 時間上限與死亡次數從續跑這一刻重新算，略過清單清空（剛處理過的問題值得再試一次）。
   */
  private resume(): string | null {
    if (this.phase !== 'STOPPED' || !isResumable(this.stopReason)) return '目前沒有可以續跑的停工';
    if (this.host.status() !== 'RUNNING') return '遊戲未執行';
    const st = this.host.state();
    if (!st.snapshot) return '尚未收到任務快照';
    const was = this.stopReason;
    this.finished = false;
    this.stopReason = null;
    this.drivingId = null;
    this.stuck = null;
    this.deaths = 0;
    this.countedBattle = null;
    this.seenStage = null;
    this.openingCommandId = null;
    this.openingLatch = null;
    this.openingReportRejected = null;
    this.openingBusy = 0;
    this.navKey = null;
    this.forgetWalk();
    this.navSig = '';
    this.navSigAt = 0;
    this.resetResupplyState();
    this.unreachableHuntMaps.clear();
    this.skipped.clear();
    this.consecutiveSkipped = 0;
    this.travel = null;
    const q = this.host.getQueue().getStatus();
    this.staleQueueStop = q.phase === 'STOPPED' ? q.stopReason : null;
    this.startedAt = this.host.now();
    this.savedStrategy = this.host.battler.getStrategy();
    this.remember(st.snapshot);
    const stage = st.snapshot.openingStage;
    this.phase = stage && stage !== 'DONE' ? 'OPENING' : 'QUESTS';
    this.text = '無人任務：續跑';
    this.host.log(`無人任務續跑（上次停工原因：${was}），已完成的任務保留`);
    this.host.onChange();
    this.tick();
    return null;
  }

  private regions(): StaticRegion[] {
    return this.host.state().staticData?.regions ?? [];
  }

  /**
   * F7：沿傳送點圖跨區到目標區域的村莊地圖。途中遇敵時照血量打或逃，導航器自己暫停、戰鬥後從目前位置接續；
   * 落敗換圖時（onMessage 會取消導航）下一拍從新位置重新規劃。走不通以 NAV_FAILED 停下，可續跑。
   */
  private travelToRegion(region: StaticRegion, label: string): void {
    const st = this.host.state();
    const key = `region:${region.regionId}`;
    if (!this.travel || this.travel.regionId !== region.regionId) {
      this.travel = { regionId: region.regionId, attempts: 0, battleLogged: false };
    }
    if (st.battle || st.battleResult) {
      this.applyBattle(false, true);
      this.text = `${label}：跨區途中遇敵，戰鬥結束後接續前往 ${region.name}`;
      if (!this.travel.battleLogged) {
        this.travel.battleLogged = true;
        this.host.log(`跨區前往 ${region.name} 途中遇敵，戰鬥結束後從目前位置接續`, 'warn');
      }
      return;
    }
    this.travel.battleLogged = false;
    this.applyBattle(false, true);
    if (this.rescueSince !== null && this.host.now() - this.rescueSince < RESCUE_WAIT_MS) {
      this.text = `${label}：落敗，等送回後重新跨區前往 ${region.name}`;
      return;
    }
    this.rescueSince = null;
    const nav = this.host.navigator.getStatus();
    if (this.navKey === key && nav.phase === 'FAILED' && !navBlockedByWindow(nav.text)) {
      this.finish('NAV_FAILED', `無法跨區前往 ${region.name}：${nav.text}`);
      return;
    }
    if (this.host.navigator.isActive()) {
      if (this.navKey === key) this.text = `${label}：跨區前往 ${region.name}（${nav.text.replace(/^導航：/, '')}）`;
      return;
    }
    if (this.pendingWalk() || Object.keys(st.pending).length > 0) return;
    if (st.dialog) {
      this.closeDialog();
      return;
    }
    if (this.navKey === key && nav.phase === 'DONE') {
      this.travel.attempts += 1;
      if (this.travel.attempts >= MAX_REGION_TRAVEL_ATTEMPTS) {
        this.finish('NAV_FAILED', `已走到 ${region.name} 的村莊 ${this.travel.attempts} 次，宿主快照仍不在這個區域`);
        return;
      }
    }
    this.navKey = key;
    this.text = `${label}：跨區前往 ${region.name}`;
    this.host.log(`跨區：沿傳送點圖前往 ${region.name}`);
    this.host.navigator.go({ kind: 'MAP', mapId: region.villageMapId, name: region.name });
  }

  private noteArrived(region: StaticRegion): void {
    if (this.travel?.regionId !== region.regionId) return;
    this.travel = null;
    if (this.navKey === `region:${region.regionId}`) this.navKey = null;
    this.host.log(`已抵達 ${region.name}，接著做這個區域的事`);
  }

  /** F7：設了區域時，循環只用這個區域的遇敵區與採集點（地圖歸屬由宿主的區域清單決定）。 */
  private loopHunts(): RememberedHunt[] {
    const regionId = this.config.regionId;
    if (!regionId) return this.hunts;
    const regions = this.regions();
    return this.hunts.filter(h => regionOfMapId(regions, h.mapId)?.regionId === regionId);
  }

  private loopGathers(): SnapshotGatherPoint[] {
    const regionId = this.config.regionId;
    if (!regionId) return this.gathers;
    const regions = this.regions();
    return this.gathers.filter(p => regionOfMapId(regions, p.mapId)?.regionId === regionId);
  }

  private step(): void {
    if (this.host.status() !== 'RUNNING') return;
    const st = this.host.state();
    const snap = st.snapshot;
    if (!snap || !st.character) return;
    const metrics = this.metrics();
    const stop = evaluateChainStop(this.config.stop, metrics);
    if (stop) {
      this.finish(stop, `停止條件觸發：${CHAIN_STOP_LABEL[stop]}`);
      return;
    }
    const stage = snap.openingStage;
    if (stage && stage !== 'DONE') {
      this.phase = 'OPENING';
      this.stepOpening(stage);
      return;
    }
    if (this.phase === 'OPENING') {
      this.phase = 'QUESTS';
      this.navKey = null;
      this.text = '無人任務：開場結束，開始任務目錄';
      this.host.log('開場階段已結束，改跑宿主任務目錄');
    }
    if (this.phase === 'LOOP') {
      this.stepLoop();
      return;
    }
    this.phase = 'QUESTS';
    this.stepQuests();
  }

  private metrics(): ChainMetrics {
    const st = this.host.state();
    const c = st.character;
    return {
      startedAt: this.startedAt,
      now: this.host.now(),
      level: c?.level ?? 1,
      gold: c?.gold ?? 0,
      inventoryCount: bagUsedCount(st.inventory),
      inventoryCap: c?.inventoryCap ?? 0,
      deaths: this.deaths,
    };
  }

  private stepOpening(stage: string): void {
    if (stage !== this.seenStage) {
      this.seenStage = stage;
      this.openingLogged = false;
      this.openingCommandId = null;
      this.openingLatch = null;
      this.openingReportRejected = null;
      this.openingBusy = 0;
      this.navKey = null;
      this.forgetWalk();
      this.navSig = '';
      this.navSigAt = 0;
      if (this.host.navigator.isActive()) this.host.navigator.cancel();
    }
    const st = this.host.state();
    if (st.battle?.timeline?.events.some(e => e.isCaptured)) this.openingCaptured = true;
    if (st.battle) {
      this.applyBattle(stage === 'CAPTURE', stage === 'CAPTURE');
      this.text = stage === 'CAPTURE' ? '無人任務：開場捕捉幻獸' : '無人任務：開場途中遇敵，先脫身';
      return;
    }
    if (st.dialog) {
      this.closeDialog();
      return;
    }
    if (st.battleResult) {
      this.applyBattle(stage === 'CAPTURE', stage === 'CAPTURE');
      this.text = '無人任務：等待戰鬥結算關閉';
      return;
    }
    if (stage === 'QUIZ') {
      this.text = '無人任務：等待遊戲畫面的角色問答';
      if (!this.openingLogged) {
        this.openingLogged = true;
        this.host.log('角色問答在遊戲畫面，外掛沒有對應指令。問答結束後會繼續開場。', 'warn');
      }
      return;
    }
    if (stage === 'GO_CHIEF' || stage === 'GO_BASEMENT') {
      this.applyBattle(false, false);
      this.text = '無人任務：請村長送去捕捉';
      this.sendOpening(stage, 'capture', { type: 'OPENING_ADVANCE', to: 'CAPTURE' }, '開場前進到捕捉');
      return;
    }
    if (stage === 'CAPTURE') {
      this.stepCapture(stage);
      return;
    }
    if (stage === 'REPORT') {
      this.applyBattle(false, false);
      this.text = '無人任務：領取村長的新手獎勵';
      const petId = `pet_egg_${this.host.now().toString(36)}`;
      this.sendOpening(stage, 'claim', { type: 'OPENING_CLAIM_REWARD', eggChoice: 0, petId }, '領取開場獎勵');
      return;
    }
    this.finish('STUCK', `找不到下一步：不認識的開場階段 ${stage}`);
  }

  private stepCapture(stage: string): void {
    this.applyBattle(true, true);
    if (this.openingCaptured) {
      if (this.openingReportRejected) {
        if (this.host.now() - this.openingReportRejected.at >= OPENING_COMMAND_WAIT_MS) {
          this.finish('STUCK', `開場捕捉後無法回報：${this.openingReportRejected.message}`);
        } else {
          this.text = '無人任務：等待開場階段更新';
        }
        return;
      }
      this.text = '無人任務：捕捉成功，回報村長';
      this.sendOpening(stage, 'report', { type: 'OPENING_ADVANCE', to: 'REPORT' }, '開場前進到回報');
      return;
    }
    const snap = this.host.state().snapshot;
    if (!snap) return;
    this.text = '無人任務：在遇敵區捕捉幻獸';
    if (this.blockOnNavigator(true) || this.pendingWalk()) return;
    const here = this.hunts.find(h => h.mapId === snap.mapId && h.x !== undefined);
    if (here) {
      this.patrolAround(here.x, here.y);
      return;
    }
    const away = this.hunts.find(h => h.mapId !== snap.mapId);
    if (away) {
      const nav = this.host.navigator.getStatus();
      if (this.navKey === away.mapId && nav.phase === 'FAILED') {
        this.finish('STUCK', `找不到下一步：${nav.text}`);
        return;
      }
      if (this.navKey !== away.mapId) {
        this.navKey = away.mapId;
        this.text = `無人任務：前往遇敵地圖 ${away.mapName ?? away.mapId}`;
        this.host.navigator.go({ kind: 'MAP', mapId: away.mapId, name: away.mapName ?? away.mapId });
      }
      return;
    }
    this.text = '無人任務：在目前地圖巡邏並捕捉';
    this.patrolHere();
  }

  private sendOpening(
    stage: string,
    kind: string,
    command: { type: 'OPENING_ADVANCE'; to: 'CAPTURE' | 'REPORT' } | { type: 'OPENING_CLAIM_REWARD'; eggChoice: number; petId: string },
    label: string,
  ): void {
    if (this.openingCommandId) {
      this.text = `無人任務：等待${label}`;
      return;
    }
    if (this.openingLatch?.stage === stage && this.openingLatch.kind === kind) {
      if (this.host.now() - this.openingLatch.at >= OPENING_COMMAND_WAIT_MS) {
        this.finish('STUCK', `找不到下一步：${label}沒有讓開場階段前進`);
      }
      return;
    }
    const id = this.host.send({ type: 'GAME_COMMAND', command }, label, 'DONE');
    if (!id) return;
    this.openingCommandId = id;
    this.openingLatch = { stage, kind, at: this.host.now() };
  }

  private onOpeningRejected(reason: string | undefined, message: string | undefined): void {
    const why = message || reason || '宿主拒絕';
    // 戰鬥中（遇敵剛好打斷）也只是時機不對：戰鬥結束後再送，不算走不下去。
    if (reason === 'GAME_BUSY' || reason === 'IN_BATTLE') {
      this.openingLatch = null;
      this.openingBusy += 1;
      if (this.openingBusy >= (reason === 'IN_BATTLE' ? 30 : 5)) {
        this.finish('STUCK', `找不到下一步：開場指令一直被遊戲畫面擋住（${why}）`);
      } else {
        this.host.log(`開場指令被遊戲畫面擋住，稍後再送：${why}`, 'warn');
      }
      return;
    }
    if (this.openingLatch?.kind === 'report') {
      this.openingLatch = null;
      this.openingReportRejected = { message: why, at: this.host.now() };
      return;
    }
    this.finish('STUCK', `找不到下一步：開場指令被拒（${why}）`);
  }

  private closeDialog(): void {
    const dialog = this.host.state().dialog;
    if (!dialog) return;
    const close = dialog.options.find(o => o.id === 'CLOSE' || o.id === 'BYE') ?? dialog.options[dialog.options.length - 1];
    if (!close) return;
    this.host.send({ type: 'CHOOSE_DIALOG_OPTION', optionId: close.id }, '關閉開場以外的對話', 'DONE');
  }

  private stepQuests(): void {
    const st = this.host.state();
    const snap = st.snapshot;
    if (!snap) return;
    const quests = (snap.quests ?? []) as ChainQuest[];
    const level = st.character?.level ?? 1;
    // 快照可能已經把上一筆標成完成，而單筆任務模組還沒停。先記下來，避免改做下一筆時漏掉。
    this.absorbCompleted(quests);
    if (this.config.loopOnly) {
      this.enterLoop('派工只跑新手循環');
      return;
    }
    if (this.drivingId !== null && !this.host.quest.isActive()) {
      const current = quests.find(q => q.questId === this.drivingId);
      if (current?.status === 'COMPLETED') {
        this.noteCompleted(current);
        this.drivingId = null;
        this.stuck = null;
      } else {
        const why = this.host.quest.getLastStopReason() ?? '';
        if (why.includes('戰鬥落敗')) {
          // 結算視窗還在時保留 drivingId。清掉的話下一拍會重接，又立刻因落敗停住。
          if (st.battle || st.battleResult) {
            if (this.text !== '無人任務：戰鬥落敗，恢復後再試同一件任務') {
              this.host.log('戰鬥落敗，恢復後再接同一件任務', 'warn');
            }
            this.text = '無人任務：戰鬥落敗，恢復後再試同一件任務';
            return;
          }
          this.drivingId = null;
          this.stuck = null;
        } else {
          this.skipQuest(this.drivingId, current?.title ?? `#${this.drivingId}`, why || '停住且沒有完成');
          if (!this.isActive()) return;
        }
      }
    }
    let pool = quests.filter(q => !this.skipped.has(q.questId));
    const heldBy = (questId: number) => (questId === this.drivingId ? null : this.host.questHeldElsewhere?.(questId) ?? null);
    const regionId = this.config.regionId ?? null;
    if (regionId) {
      const travel = planRegionTravel(this.regions(), snap.region?.regionId, regionId);
      if (travel.kind === 'UNKNOWN_REGION') {
        this.finish('REGION_UNKNOWN', `宿主的區域清單裡沒有設定的區域（${regionId}），請重新選擇區域`);
        return;
      }
      pool = questsInRegion(pool, regionId);
      const pick = selectNextQuest(pool.filter(q => !heldBy(q.questId)), level);
      // 接任務與回報都要找這一區的 NPC：人不在這一區就先跨區到村莊，到了快照才看得到那裡的 NPC。
      // 進行中的目標（打怪、採集、走到某圖）交給單筆任務模組，目標地圖可能在區域外。
      if (travel.kind === 'TRAVEL' && pick.kind === 'QUEST' && pick.quest.status !== 'IN_PROGRESS') {
        if (this.host.quest.isActive()) this.host.quest.stop();
        this.drivingId = null;
        this.stuck = null;
        this.travelToRegion(travel.region, `無人任務（${travel.region.name}）`);
        return;
      }
      if (travel.kind === 'HERE') this.noteArrived(travel.region);
    }
    const next = selectNextQuest(pool.filter(q => !heldBy(q.questId)), level);
    if (next.kind !== 'QUEST') {
      // F8：剩下能做的任務正由別的角色在做：等它做完，不改跑新手循環、也不算任務做完。
      const waiting = selectNextQuest(pool, level);
      const holder = waiting.kind === 'QUEST' ? heldBy(waiting.quest.questId) : null;
      if (waiting.kind === 'QUEST' && holder) {
        const text = `無人任務：等待【${holder}】做完【${waiting.quest.title}】`;
        if (this.text !== text) this.host.log(`【${waiting.quest.title}】由【${holder}】進行中，先等待`);
        this.text = text;
        return;
      }
    }
    if (next.kind === 'QUEST') {
      this.text = `無人任務：${next.quest.title}`;
      this.applyBattleForQuest(next.quest);
      if (this.drivingId === next.quest.questId && this.host.quest.isActive()) {
        this.host.quest.advance();
      }
      // 鏈的優先序比任務模組高，落敗當下是這裡的 advance 先把任務停住。
      if (this.drivingId !== null && !this.host.quest.isActive()) {
        const why = this.host.quest.getLastStopReason() ?? '';
        if (why.includes('戰鬥落敗') && (this.host.state().battle || this.host.state().battleResult)) {
          if (this.text !== '無人任務：戰鬥落敗，恢復後再試同一件任務') {
            this.host.log('戰鬥落敗，恢復後再接同一件任務', 'warn');
          }
          this.text = '無人任務：戰鬥落敗，恢復後再試同一件任務';
          return;
        }
      }
      this.watchStuck(next.quest, snap);
      if (!this.isActive() || this.skipped.has(next.quest.questId)) return;
      if (this.drivingId !== next.quest.questId) {
        const err = this.host.quest.start(next.quest.questId);
        this.drivingId = next.quest.questId;
        if (err) this.skipQuest(next.quest.questId, next.quest.title, err);
      }
      return;
    }
    if (!this.config.newbieLoop) {
      const reason = next.kind === 'DONE'
        ? '宿主目錄裡的任務都完成了'
        : `目前等級能做的任務已完成，還有 ${next.blocked.length} 個因等級或前置還沒開放`;
      this.finish('QUESTS_DONE', reason);
      return;
    }
    this.enterLoop(next.kind === 'DONE' ? '任務目錄已完成' : '目前等級能做的任務已完成');
  }

  private enterLoop(why: string): void {
    this.phase = 'LOOP';
    this.drivingId = null;
    if (this.host.quest.isActive()) this.host.quest.stop();
    this.loopStartedAt = this.host.now();
    this.stuck = null;
    this.resupply = false;
    this.navKey = null;
    this.unreachableHuntMaps.clear();
    this.text = `新手循環：${this.config.loopActivity === 'HUNT' ? '打怪補給' : this.config.loopActivity === 'GATHER' ? '採集' : '配方'}`;
    if (!this.loopLogged) {
      this.loopLogged = true;
      this.host.log(`${why}，進入新手循環`);
    }
    this.host.onChange();
  }

  private stepLoop(): void {
    const st = this.host.state();
    const snap = st.snapshot;
    if (!snap || !st.character) return;
    if (st.battle) {
      const hunting = this.config.loopActivity === 'HUNT' && !this.resupply;
      this.applyBattle(false, hunting);
      return;
    }
    const now = this.host.now();
    if (
      this.lastHealCompletedAt !== null
      && !this.healCommandId
      && !st.shop
      && !st.dialog
      && Object.keys(st.pending).length === 0
      && Object.keys(st.inflight).length === 0
      && now - this.lastHealCompletedAt >= RESUPPLY_ACTION_COOLDOWN_MS
    ) {
      this.lastHealCompletedAt = null;
      const hp = st.character.hp;
      const max = st.character.maxHp;
      if (hp != null && max != null && max > 0 && (hp / max) * 100 <= this.config.returnHpPct) {
        this.healBlockedUntil = now + HEAL_RETRY_BACKOFF_MS;
        this.healBlockedGold = st.character.gold ?? null;
        this.host.log(`回村治療後體力仍未高於 ${this.config.returnHpPct}%，暫緩自動回村治療`, 'warn');
      }
    }
    if (this.shouldResupply(st)) {
      if (this.config.stop.stopOnBagFull && this.bagFull(st)) {
        this.finish('BAG_FULL', '停止條件觸發：背包已滿');
        return;
      }
      this.resupply = true;
      this.stepResupply();
      return;
    }
    if (this.resupply) {
      this.resupply = false;
      this.healSent = false;
      this.sellSkip.clear();
      this.depositSkip.clear();
      this.skippedShops.clear();
      this.activeShopKey = null;
      this.resupplyWindowBlocked = 0;
      this.resupplyEmptyNavs = 0;
      this.openShopAttempts = 0;
    }
    if (st.shop) {
      if (Object.keys(st.pending).length === 0 && Object.keys(st.inflight).length === 0) {
        this.host.send({ type: 'CHOOSE_DIALOG_OPTION', optionId: 'CLOSE_SHOP' }, '關閉商店', 'DONE');
      }
      return;
    }
    if (this.config.regionId) {
      const travel = planRegionTravel(this.regions(), snap.region?.regionId, this.config.regionId);
      if (travel.kind === 'UNKNOWN_REGION') {
        this.finish('REGION_UNKNOWN', `宿主的區域清單裡沒有設定的區域（${this.config.regionId}），請重新選擇區域`);
        return;
      }
      const known = this.config.loopActivity === 'HUNT'
        ? this.loopHunts().length > 0 || this.loopGathers().some(p => p.x !== undefined)
        : this.config.loopActivity === 'CRAFT';
      if (travel.kind === 'TRAVEL' && !known) {
        this.travelToRegion(travel.region, `新手循環（${travel.region.name}）`);
        return;
      }
      if (travel.kind === 'HERE') this.noteArrived(travel.region);
    }
    if (this.config.loopActivity === 'GATHER') this.stepGatherLoop();
    else if (this.config.loopActivity === 'CRAFT') this.stepCraftLoop();
    else this.stepHuntLoop();
  }

  private stepHuntLoop(): void {
    const st = this.host.state();
    const snap = st.snapshot;
    if (!snap) return;
    this.applyBattle(false, true);
    if (this.host.navigator.isActive() || this.pendingWalk()) return;
    const target = this.pickHuntTarget(snap.mapId);
    if (!target) {
      this.finish('STUCK', '找不到下一步：宿主沒有提供遇敵區或採集點，新手循環無法打怪');
      return;
    }
    if (snap.mapId !== target.mapId) {
      const nav = this.host.navigator.getStatus();
      if (this.navKey === target.mapId && nav.phase === 'FAILED' && !navBlockedByWindow(nav.text)) {
        this.unreachableHuntMaps.add(target.mapId);
        this.navKey = null;
        const fallback = this.pickHuntTarget(snap.mapId);
        if (fallback) {
          if (fallback.mapId === snap.mapId) {
            this.text = `新手循環：在 ${fallback.mapName ?? snap.mapName ?? snap.mapId} 巡邏`;
            this.patrolAround(fallback.x, fallback.y);
          }
          return;
        }
        this.finish('STUCK', `找不到下一步：${nav.text}`);
        return;
      }
      if (this.navKey === target.mapId && (nav.phase === 'DONE' || nav.phase === 'CANCELLED')) {
        this.navKey = null;
      }
      if (this.navKey !== target.mapId) {
        this.navKey = target.mapId;
        this.text = `新手循環：前往 ${target.mapName ?? target.mapId}`;
        this.host.navigator.go({ kind: 'MAP', mapId: target.mapId, name: target.mapName ?? target.mapId });
      }
      return;
    }
    this.text = `新手循環：在 ${target.mapName ?? snap.mapName ?? snap.mapId} 巡邏`;
    this.patrolAround(target.x, target.y);
  }

  private stepGatherLoop(): void {
    const q = this.host.getQueue();
    const stat = q.getStatus();
    if (['RUNNING', 'PAUSED_BATTLE', 'WAITING_TOOL_BUY', 'WALKING_TO_POINT'].includes(stat.phase)) {
      this.text = `新手循環：${stat.text}`;
      return;
    }
    const fresh = !(stat.phase === 'STOPPED' && this.staleQueueStop !== null && stat.stopReason === this.staleQueueStop);
    if (fresh && stat.phase === 'STOPPED' && stat.stopReason === 'BAG_FULL' && this.bagFull(this.host.state())) {
      this.resupply = true;
      this.stepResupply();
      return;
    }
    if (fresh && stat.phase === 'STOPPED' && stat.stopReason && stat.stopReason !== 'DONE_TARGET' && stat.stopReason !== 'USER_STOPPED') {
      const code = chainStopForQueue(stat.stopReason);
      this.finish(code, `${code === 'STUCK' ? '找不到下一步：' : ''}採集停住（${stat.stopReason}）：${stat.text}`);
      return;
    }
    this.staleQueueStop = null;
    const points = this.loopGathers().filter(p => p.skillId !== null);
    const st = this.host.state();
    const skills = st.members.find(m => m.characterId === st.characterId)?.workSkills;
    const options = points.map(point => {
      const level = Math.max(skills?.[point.skillId!] ?? 1, 10);
      const mat = point.materials?.find(m => (m.reqLevel ?? 1) <= level);
      return { point, mat };
    });
    const choice = options.find(({ point, mat }) => mat || !point.materials?.length);
    if (!choice) {
      this.finish('STUCK', points.length ? '找不到下一步：目前技能等級沒有可採材料' : '找不到下一步：宿主採集清單是空的');
      return;
    }
    const { point, mat } = choice;
    this.text = `新手循環：採集 ${mat?.name ?? point.name}`;
    q.enqueue({
      kind: 'GATHER',
      skillId: point.skillId ?? 0,
      skillName: point.skillName ?? point.name,
      ...(mat ? { targetItemId: mat.itemId } : {}),
      targetName: mat?.name ?? point.name,
      targetCount: 'UNTIL_FULL',
      ...(point.requiredToolItemId ? { requiredToolItemId: point.requiredToolItemId } : {}),
      ...(point.requiredToolName ? { requiredToolName: point.requiredToolName } : {}),
    });
  }

  private stepCraftLoop(): void {
    const q = this.host.getQueue();
    const stat = q.getStatus();
    if (['RUNNING', 'PAUSED_BATTLE', 'WAITING_TOOL_BUY', 'WALKING_TO_POINT'].includes(stat.phase)) {
      this.text = `新手循環：${stat.text}`;
      return;
    }
    const fresh = !(stat.phase === 'STOPPED' && this.staleQueueStop !== null && stat.stopReason === this.staleQueueStop);
    if (fresh && stat.phase === 'STOPPED' && stat.stopReason && stat.stopReason !== 'DONE_TARGET' && stat.stopReason !== 'USER_STOPPED') {
      const code = chainStopForQueue(stat.stopReason);
      this.finish(code, `${code === 'STUCK' ? '找不到下一步：' : ''}配方做不下去（${stat.stopReason}）`);
      return;
    }
    this.staleQueueStop = null;
    const recipes = this.host.state().staticData?.recipes ?? this.host.state().snapshot?.recipes ?? [];
    const recipe = recipes[0];
    if (!recipe) {
      this.finish('STUCK', '找不到下一步：宿主沒有提供配方');
      return;
    }
    this.text = `新手循環：製作 ${recipe.name}`;
    q.enqueue({ kind: 'CRAFT', recipeId: recipe.recipeId, recipeName: recipe.name, targetCount: 1 });
  }

  private stepResupply(): void {
    const st = this.host.state();
    const snap = st.snapshot;
    if (!snap) return;
    this.applyBattle(false, false);
    if (st.battle || st.battleResult) return;
    if (this.host.navigator.isActive()) return;
    this.text = '新手循環：回村補給';
    // 開商店、賣東西的指令還沒回來時，對話框剛關、商店還沒開，這一拍看起來什麼都沒有。等結果回來再判斷。
    if (Object.keys(st.pending).length > 0 || Object.keys(st.inflight).length > 0) return;
    const now = this.host.now();
    if (st.shop) {
      if (!this.wantDeposit) {
        const keep = this.keepNames();
        const sell = sellableItems(this.unreservedBag(st), keep).find(it => !this.sellSkip.has(it.itemId));
        if (sell) {
          this.sellSkip.add(sell.itemId);
          this.resupplyActionAt = now;
          this.host.send({ type: 'SELL_ITEM', itemId: sell.itemId, count: sell.count }, `賣出 ${sell.name ?? '物品'}`, 'DONE');
          return;
        }
        if (this.bagFull(st)) {
          if (!this.depositCandidate(st, keep)) {
            this.finish('BAG_FULL', '背包已滿，沒有可賣、也沒有可存進家族倉庫的物品');
            return;
          }
          // 倉庫指令在商店開著時會被拒（DIALOG_OPEN），先離開商店再存。
          this.wantDeposit = true;
          this.resupplyActionAt = now;
          this.host.send({ type: 'CHOOSE_DIALOG_OPTION', optionId: 'CLOSE_SHOP' }, '背包還是滿的，離開商店改存家族倉庫', 'DONE');
          return;
        }
        const hp = st.character?.hp;
        const max = st.character?.maxHp;
        if (!this.healSent && now >= this.healBlockedUntil && hp != null && max && max > 0 && (hp / max) * 100 <= this.config.returnHpPct) {
          this.healSent = true;
          this.resupplyActionAt = now;
          this.healCommandId = this.host.send({ type: 'GAME_COMMAND', command: { type: 'HEAL_PARTY' } }, '回村治療', 'DONE');
          return;
        }
      }
      this.resupplyActionAt = now;
      this.resupplyNavCooldownUntil = now + RESUPPLY_ACTION_COOLDOWN_MS;
      this.host.send({ type: 'CHOOSE_DIALOG_OPTION', optionId: 'CLOSE_SHOP' }, '補給完成，離開商店', 'DONE');
      this.resupply = false;
      this.healSent = false;
      this.openShopAttempts = 0;
      this.resupplyEmptyNavs = 0;
      this.resupplyWindowBlocked = 0;
      return;
    }
    if (this.wantDeposit && !st.dialog) {
      if (!this.bagFull(st)) {
        this.wantDeposit = false;
        this.depositSkip.clear();
        if (!this.shouldResupply(st)) {
          this.resupply = false;
          this.healSent = false;
          this.sellSkip.clear();
        }
        return;
      }
      const dep = this.depositCandidate(st, this.keepNames());
      if (!dep) {
        this.finish('BAG_FULL', '背包已滿，家族倉庫也存不下（沒有其他可存的物品）');
        return;
      }
      this.depositSkip.add(dep.itemId);
      this.resupplyActionAt = now;
      this.text = `新手循環：存放 ${dep.name ?? '物品'} 到家族倉庫`;
      this.host.send({ type: 'WAREHOUSE_DEPOSIT', itemId: dep.itemId, count: dep.count }, `存入家族倉庫：${dep.name ?? '物品'} ×${dep.count}`, 'DONE');
      return;
    }
    if (now - this.resupplyActionAt < RESUPPLY_ACTION_COOLDOWN_MS) return;
    if (st.dialog) {
      if (this.wantDeposit) {
        this.resupplyActionAt = now;
        this.closeDialog();
        return;
      }
      const open = st.dialog.options.find(o => o.id === 'OPEN_SHOP');
      if (open && this.openShopAttempts < MAX_OPEN_SHOP_ATTEMPTS) {
        this.openShopAttempts += 1;
        this.resupplyActionAt = now;
        this.host.send({ type: 'CHOOSE_DIALOG_OPTION', optionId: open.id }, '打開商店', 'DONE');
        return;
      }
      const shopKey = this.activeShopKey ?? `${snap.mapId}:${st.dialog.npcName}`;
      this.skippedShops.add(shopKey);
      this.navKey = null;
      this.activeShopKey = null;
      this.openShopAttempts = 0;
      this.resupplyActionAt = now;
      this.resupplyNavCooldownUntil = now + RESUPPLY_NAV_RETRY_MS;
      this.host.log(
        open
          ? `商店【${st.dialog.npcName}】多次無法開啟，改試其他商店`
          : `對話【${st.dialog.npcName}】沒有開啟商店選項，關閉後改試其他商店`,
        'warn',
      );
      this.closeDialog();
      return;
    }
    const shop = this.pickShop(snap);
    if (!shop) {
      if (this.skippedShops.size > 0 && !this.bagFull(st)) {
        this.healBlockedUntil = now + HEAL_RETRY_BACKOFF_MS;
        this.healBlockedGold = st.character?.gold ?? null;
        this.resupply = false;
        this.skippedShops.clear();
        this.host.log('附近商店對話皆未提供商店功能，暫緩自動回村治療', 'warn');
        return;
      }
      this.finish(
        'STUCK',
        this.skippedShops.size > 0
          ? `找不到下一步：已略過 ${this.skippedShops.size} 個無法開啟的商店，無法回村補給`
          : '找不到下一步：宿主快照沒有商店，無法回村補給',
      );
      return;
    }
    const shopKey = `${shop.mapId}:${shop.npcName}`;
    if (this.activeShopKey !== shopKey) {
      this.activeShopKey = shopKey;
      this.resupplyWindowBlocked = 0;
      this.resupplyEmptyNavs = 0;
      this.openShopAttempts = 0;
    }
    const navKey = `shop:${shop.npcName}`;
    const nav = this.host.navigator.getStatus();
    if (this.navKey === navKey) {
      if (nav.phase === 'FAILED') {
        if (!navBlockedByWindow(nav.text)) {
          this.finish('STUCK', `找不到下一步：${nav.text}`);
          return;
        }
        this.resupplyWindowBlocked += 1;
        if (this.resupplyWindowBlocked >= MAX_RESUPPLY_WINDOW_RETRIES) {
          this.finish('STUCK', '找不到下一步：商店對話或殘留視窗未能關閉，無法回村補給');
          return;
        }
        this.resupplyNavCooldownUntil = Math.max(this.resupplyNavCooldownUntil, now + RESUPPLY_NAV_RETRY_MS);
      } else if (nav.phase === 'DONE' || nav.phase === 'CANCELLED') {
        this.resupplyEmptyNavs += 1;
        if (this.resupplyEmptyNavs >= MAX_RESUPPLY_EMPTY_NAVS) {
          this.skippedShops.add(shopKey);
          this.navKey = null;
          this.activeShopKey = null;
          this.resupplyEmptyNavs = 0;
          this.resupplyNavCooldownUntil = Math.max(this.resupplyNavCooldownUntil, now + RESUPPLY_NAV_RETRY_MS);
          this.host.log(`走到【${shop.npcName}】後未開啟商店，改試其他商店`, 'warn');
          return;
        }
        this.resupplyNavCooldownUntil = Math.max(this.resupplyNavCooldownUntil, now + RESUPPLY_NAV_RETRY_MS);
      }
    }
    if (now < this.resupplyNavCooldownUntil) return;
    this.resupplyActionAt = now;
    this.resupplyNavCooldownUntil = now + RESUPPLY_ACTION_COOLDOWN_MS;
    this.navKey = navKey;
    this.host.navigator.go({ kind: 'NPC', query: shop.npcName, talk: true });
  }

  private watchStuck(quest: ChainQuest, snap: SceneSnapshot): void {
    const st = this.host.state();
    const waitingScene = Boolean(st.location && snap.mapId !== st.location.mapId);
    // 結算視窗還開著時任務模組會先等它關掉。同一拍的金錢與道具事件不是閒置。
    const idle = !waitingScene
      && !this.host.quest.isBusy()
      && !this.host.navigator.isActive()
      && !st.battle
      && !st.battleResult
      && !st.dialog
      && !st.shop
      && !this.pendingWalk()
      && Object.keys(st.pending).length === 0
      && Object.keys(st.inflight).length === 0;
    const signature = progressSignature(
      quest.questId,
      quest.status,
      quest.objectives,
      snap.openingStage ?? null,
      snap.mapId,
    );
    const next = nextStuck(this.stuck, signature, idle);
    this.stuck = next.state;
    if (next.stuck) {
      const unmet = quest.objectives.filter(o => !o.met).map(o => o.description).join('、') || quest.status;
      this.skipQuest(quest.questId, quest.title, `沒有進展（${unmet}）`);
    }
  }

  private applyBattleForQuest(quest: ChainQuest): void {
    const unmet = quest.objectives.filter(o => !o.met);
    const first = unmet[0];
    if (!first || quest.status === 'AVAILABLE' || quest.status === 'READY') {
      this.applyBattle(false, false);
      return;
    }
    const plan = planUnmetObjective(first, {
      npcNames: this.host.knownNpcs().map(n => n.name),
      maps: this.host.knownMaps(),
      gatherPoints: this.gathers,
      recipes: [],
    });
    const capture = plan.kind === 'COMBAT' && plan.capture;
    const fight = plan.kind === 'COMBAT';
    this.applyBattle(capture, fight);
  }

  private applyBattle(capture: boolean, fight: boolean): void {
    const st = this.host.state();
    const hp = st.character?.hp;
    const max = st.character?.maxHp;
    const low = hp != null && max != null && max > 0 && (hp / max) * 100 <= this.config.returnHpPct;
    const seal = capture ? st.inventory.find(it => this.isSealName(it.name)) : undefined;
    const heal = st.inventory.find(it => this.isHealName(it.name));
    if (!fight || (low && !heal && !(capture && seal))) {
      if (this.host.battler.getStrategy() !== 'FLEE') this.host.battler.setStrategy('FLEE');
      this.host.battler.setTurnOverride(null);
      return;
    }
    if (this.host.battler.getStrategy() !== 'ATTACK') this.host.battler.setStrategy('ATTACK');
    if (capture && seal) {
      const override: CaptureTurnOverride = {
        mode: 'CAPTURE',
        sealStoneId: seal.itemId,
        captureBelowHpRatio: 0.5,
        healBelowHpRatio: this.config.returnHpPct / 100,
        ...(heal ? { healItemId: heal.itemId } : {}),
      };
      this.host.battler.setTurnOverride(override);
      this.sealWarned = false;
      return;
    }
    if (capture && !seal && !this.sealWarned) {
      this.sealWarned = true;
      this.host.log('背包裡沒有名稱可辨識的封印石，捕捉會先改為攻擊', 'warn');
    }
    if (heal) {
      const healing: HealTurnOverride = {
        mode: 'HEAL',
        healItemId: heal.itemId,
        healBelowHpRatio: this.config.returnHpPct / 100,
      };
      this.host.battler.setTurnOverride(healing);
      return;
    }
    this.host.battler.setTurnOverride(null);
  }

  private isSealName(name: string | null): boolean {
    const text = name ?? '';
    return text.includes('封印') || text.includes('捕捉');
  }

  private isHealName(name: string | null): boolean {
    const text = name ?? '';
    if (!text || this.isSealName(text)) return false;
    return text.includes('恢復') || text.includes('藥');
  }

  private patrolHere(): void {
    const st = this.host.state();
    const snap = st.snapshot;
    const pos = st.character;
    if (!snap || !pos || this.pendingWalk() || this.host.navigator.isActive()) return;
    this.patrolAround(pos.x, pos.y);
  }

  private patrolAround(hintX?: number, hintY?: number): void {
    const st = this.host.state();
    const snap = st.snapshot;
    const pos = st.character;
    if (!snap || !pos || this.pendingWalk()) return;
    const [dx, dy] = PATROL_OFFSETS[this.patrolIdx % PATROL_OFFSETS.length];
    this.patrolIdx += 1;
    const baseX = hintX ?? pos.x;
    const baseY = hintY ?? pos.y;
    const id = this.host.send(
      { type: 'WALK_TO', mapId: snap.mapId, x: baseX + dx, y: baseY + dy },
      '巡邏尋找下一步',
      'ARRIVED',
    );
    if (id) {
      this.walkCommandId = id;
      this.walkMapId = snap.mapId;
      this.walkIssuedAt = this.host.now();
    }
  }

  private forgetWalk(): void {
    this.walkCommandId = null;
    this.walkMapId = null;
    this.walkIssuedAt = 0;
  }

  /** 開場導航停在同一句話太久就取消，讓捕捉從目前地圖重走。進行中的長路不在這裡切斷。 */
  private blockOnNavigator(opening: boolean): boolean {
    if (!this.host.navigator.isActive()) {
      this.navSig = '';
      return false;
    }
    const nav = this.host.navigator.getStatus();
    const sig = `${nav.phase}|${nav.text}`;
    if (sig !== this.navSig) {
      this.navSig = sig;
      this.navSigAt = this.host.now();
    }
    if (opening && this.navSigAt > 0 && this.host.now() - this.navSigAt > 45_000) {
      this.host.navigator.cancel();
      this.navKey = null;
      this.navSig = '';
      this.navSigAt = 0;
      return false;
    }
    return true;
  }

  private resetResupplyState(): void {
    this.resupply = false;
    this.healSent = false;
    this.healCommandId = null;
    this.healBlockedUntil = 0;
    this.healBlockedGold = null;
    this.lastHealCompletedAt = null;
    this.resupplyActionAt = -Infinity;
    this.resupplyNavCooldownUntil = 0;
    this.resupplyWindowBlocked = 0;
    this.resupplyEmptyNavs = 0;
    this.openShopAttempts = 0;
    this.skippedShops.clear();
    this.activeShopKey = null;
    this.sellSkip.clear();
    this.depositSkip.clear();
    this.wantDeposit = false;
  }

  private pickShop(snap: SceneSnapshot): RememberedShop | null {
    const allowed = (s: { mapId: string; npcName: string }) => !this.skippedShops.has(`${s.mapId}:${s.npcName}`);
    const hereAvail = snap.shops.find(s => s.goodsStatus !== 'UNAVAILABLE' && allowed({ mapId: snap.mapId, npcName: s.npcName }));
    if (hereAvail) return { npcName: hereAvail.npcName, mapId: snap.mapId };
    const hereAny = snap.shops.find(s => allowed({ mapId: snap.mapId, npcName: s.npcName }));
    if (hereAny) return { npcName: hereAny.npcName, mapId: snap.mapId };
    const home = this.shops.find(s => s.mapId === this.homeMapId && allowed(s));
    return home ?? this.shops.find(allowed) ?? null;
  }

  private pickHuntTarget(mapId: string): RememberedHunt | null {
    const hunts = this.loopHunts().filter(h => !this.unreachableHuntMaps.has(h.mapId));
    const gatherHere = this.gatherHunt(mapId);
    const gatherAny = gatherHere ?? this.gatherHunt();
    if (!this.config.regionId) {
      return hunts.find(h => h.mapId === mapId) ?? gatherHere ?? hunts[0] ?? gatherAny;
    }
    return hunts.find(h => h.mapId === mapId) ?? hunts[0] ?? gatherHere ?? gatherAny;
  }

  private gatherHunt(preferMapId?: string): RememberedHunt | null {
    const points = this.loopGathers().filter(p => p.mapId && p.x !== undefined && !this.unreachableHuntMaps.has(p.mapId));
    const point = (preferMapId ? points.find(p => p.mapId === preferMapId) : undefined) ?? points[0];
    if (!point?.mapId) return null;
    return { mapId: point.mapId, mapName: point.mapName ?? null, x: point.x, y: point.y };
  }

  private shouldResupply(st: ReturnType<QuestChainHost['state']>): boolean {
    if (this.bagFull(st)) return true;
    const hp = st.character?.hp;
    const max = st.character?.maxHp;
    const hpLow = hp != null && max != null && max > 0 && (hp / max) * 100 <= this.config.returnHpPct;
    if (!hpLow) {
      this.healBlockedUntil = 0;
      this.healBlockedGold = null;
      return false;
    }
    const gold = st.character?.gold ?? 0;
    if (this.healBlockedUntil > 0 && this.healBlockedGold !== null && gold > this.healBlockedGold && gold >= 200) {
      this.healBlockedUntil = 0;
      this.healBlockedGold = null;
    }
    return this.host.now() >= this.healBlockedUntil;
  }

  /** 可以存進倉庫的物品：不是任務／工具要用的，也不是封印石；每項只試一次。 */
  private depositCandidate(st: ReturnType<QuestChainHost['state']>, keep: readonly string[]) {
    return pickDepositItem(this.unreservedBag(st), keep, this.depositSkip, st.warehouse);
  }

  private unreservedBag(st: ReturnType<QuestChainHost['state']>) {
    const cfg = this.host.getStrategyConfig(st.characterId).inventoryPolicy;
    if (!cfg) return st.inventory;
    const reserved = new Set([...cfg.keep, ...cfg.deposit, cfg.hpItem, cfg.staminaItem]);
    return st.inventory.filter(it => !reserved.has(it.itemId));
  }

  private bagFull(st: ReturnType<QuestChainHost['state']>): boolean {
    return isBagFull(st.inventory, st.character?.inventoryCap);
  }

  private keepNames(): string[] {
    const names = new Set<string>();
    for (const point of this.gathers) {
      if (point.requiredToolName) names.add(point.requiredToolName);
    }
    const quests = this.host.state().snapshot?.quests ?? [];
    for (const q of quests) {
      if (q.status === 'COMPLETED') continue;
      for (const o of q.objectives) {
        if (o.itemName) names.add(o.itemName);
        for (const quoted of o.description.matchAll(/「([^」]+)」/g)) names.add(quoted[1]);
      }
    }
    return [...names];
  }

  private pendingWalk(): boolean {
    if (!this.walkCommandId) return false;
    const st = this.host.state();
    const tracked = Boolean(st.pending[this.walkCommandId] || st.inflight[this.walkCommandId]);
    const mapId = st.snapshot?.mapId ?? st.location?.mapId ?? null;
    const wrongMap = this.walkMapId !== null && mapId !== null && this.walkMapId !== mapId;
    const stale = this.walkIssuedAt > 0 && this.host.now() - this.walkIssuedAt > 12_000;
    if (!tracked || wrongMap || stale) {
      this.forgetWalk();
      return false;
    }
    return true;
  }

  private remember(snap: SceneSnapshot): void {
    if (!this.homeMapId) this.homeMapId = snap.mapId;
    for (const shop of snap.shops) {
      if (!this.shops.some(s => s.npcName === shop.npcName && s.mapId === snap.mapId)) {
        this.shops.push({ npcName: shop.npcName, mapId: snap.mapId });
      }
    }
    for (const quest of snap.quests ?? []) {
      for (const obj of quest.objectives) {
        for (const hint of obj.targetMaps ?? []) {
          if (hint.reason === 'GATHER_POINT') continue;
          if (!this.hunts.some(h => h.mapId === hint.mapId && h.x === hint.x && h.y === hint.y)) {
            this.hunts.push({ mapId: hint.mapId, mapName: hint.mapName, x: hint.x, y: hint.y });
          }
        }
      }
    }
    for (const point of [...snap.gatherPoints.points, ...(snap.nearbyGatherPoints ?? [])]) {
      if (!this.gathers.some(g => g.id === point.id)) this.gathers.push(point);
    }
  }

  /** 把開工之後才變成完成的任務補進摘要。已經記過的不重複。 */
  private absorbCompleted(quests: readonly ChainQuest[]): void {
    for (const quest of quests) {
      if (quest.status !== 'COMPLETED') continue;
      if (this.completedAtStart.has(quest.questId)) continue;
      this.noteCompleted(quest);
    }
  }

  /**
   * 這件任務做不下去（目標不在宿主地圖上、一直沒有進展…）：寫下原因、略過它，接著做下一件或進新手循環。
   * 連同這件已經略過 MAX_SKIPPED_QUESTS 件就整條停下，避免宿主資料整批有問題時一路略過。
   */
  private skipQuest(questId: number, title: string, why: string): void {
    if (this.host.quest.isActive()) this.host.quest.stop();
    if (this.host.navigator.isActive()) this.host.navigator.cancel();
    this.drivingId = null;
    this.stuck = null;
    this.consecutiveSkipped += 1;
    this.skipped.set(questId, { title, why });
    this.host.log(`略過任務【${title}】：${why}`, 'warn');
    if (this.consecutiveSkipped < MAX_SKIPPED_QUESTS) return;
    if (this.completed.length > 0 && this.config.newbieLoop) {
      this.enterLoop(`已略過 ${this.skipped.size} 件無法推進的任務（最後一件【${title}】：${why}）`);
      return;
    }
    this.finish('STUCK', `找不到下一步：已略過 ${this.skipped.size} 件任務，最後一件【${title}】${why}`);
  }

  private noteCompleted(quest: ChainQuest): void {
    if (this.completed.some(q => q.questId === quest.questId)) return;
    this.consecutiveSkipped = 0;
    this.completed.push(quest);
    this.host.log(`任務【${quest.title}】已完成`);
  }

  private finish(code: ChainStopReason, detail: string): void {
    if (this.finished || this.phase === 'IDLE') return;
    this.finished = true;
    this.phase = 'STOPPED';
    this.stopReason = code;
    this.text = `無人任務停止：${detail}`;
    this.walkCommandId = null;
    this.host.battler.setTurnOverride(null);
    if (this.savedStrategy && this.host.battler.getStrategy() !== this.savedStrategy) {
      this.host.battler.setStrategy(this.savedStrategy);
    }
    if (this.host.quest.isActive()) this.host.quest.stop();
    if (this.host.navigator.isActive()) this.host.navigator.cancel();
    const queue = this.host.getQueue();
    if (queue.isActive()) queue.stop('USER_STOPPED', '無人任務結束，停下工作');
    this.host.log(this.text, code === 'STUCK' ? 'warn' : 'info');
    this.publishRecap(detail);
    this.host.onChange();
  }

  private publishRecap(detail: string): void {
    const st = this.host.state();
    this.absorbCompleted((st.snapshot?.quests ?? []) as ChainQuest[]);
    const now = this.host.now();
    const curr = buildCheckpointFromState(st, now);
    if (!this.baseline || !curr) return;
    const questExp = this.completed.reduce((n, q) => n + (q.rewardExp ?? 0), 0);
    const summary = buildStopRecap(this.baseline, curr, st.log, {
      completedQuests: this.completed.map(q => q.title),
      questExp,
      stopReason: this.skipped.size === 0
        ? detail
        : `${detail}（略過任務：${[...this.skipped.values()].map(s => `${s.title}——${s.why}`).join('；')}）`,
    });
    this.host.showRecap(summary);
  }
}
