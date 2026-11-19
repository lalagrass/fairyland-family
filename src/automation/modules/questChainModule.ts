import type { CaptureTurnOverride } from '../../battler';
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
  type ChainLoopActivity,
  type ChainMetrics,
  type ChainQuest,
  type ChainStopConditions,
  type QuestChainConfig,
  type StuckState,
} from '../questPlan';
import type { AutomationHostContext, BehaviorModule } from '../types';
import type { QuestBehaviorModule } from './questModule';

export interface QuestChainHost extends AutomationHostContext {
  navigator: AutoNavigator;
  battler: AutoBattler;
  quest: QuestBehaviorModule;
  getQueue: () => WorkQueue;
  knownNpcs: () => DirNpc[];
  knownMaps: () => Array<{ mapId: string; name: string }>;
  showRecap: (summary: WelcomeRecapSummary) => void;
}

export interface QuestChainStatus {
  phase: 'IDLE' | 'OPENING' | 'QUESTS' | 'LOOP' | 'STOPPED';
  text: string;
  stopReason: string | null;
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

const OPENING_WAIT_MS = 45_000;
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
 * 開場村長對話若宿主沒把選項交出來就停下。任務做完（或等級還不夠）後進入可設定的新手循環。
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
  private countedBattle: number | null = null;
  private completed: ChainQuest[] = [];
  /** 開工當下已經完成的任務。摘要只列這次新完成的。 */
  private completedAtStart = new Set<number>();
  private drivingId: number | null = null;
  private stuck: StuckState | null = null;
  private finished = false;
  private ticking = false;
  private seenStage: string | null = null;
  private openingWaitAt: number | null = null;
  private openingLogged = false;
  private navKey: string | null = null;
  private homeMapId: string | null = null;
  private shops: RememberedShop[] = [];
  private hunts: RememberedHunt[] = [];
  private gathers: SnapshotGatherPoint[] = [];
  private walkCommandId: string | null = null;
  private patrolIdx = 0;
  private resupply = false;
  private sellSkip = new Set<number>();
  private loopStartedAt: number | null = null;
  private loopLogged = false;
  private sealWarned = false;

  constructor(private host: QuestChainHost) {}

  isActive(): boolean {
    return this.phase === 'OPENING' || this.phase === 'QUESTS' || this.phase === 'LOOP';
  }

  getSummary(): string {
    return this.text;
  }

  getStatus(): QuestChainStatus {
    return {
      phase: this.phase,
      text: this.text,
      stopReason: this.stopReason,
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
      this.walkCommandId = null;
    }
    if (msg.kind === 'command-result' && msg.commandId === this.walkCommandId && msg.status === 'REJECTED') {
      this.walkCommandId = null;
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
  }): void {
    this.config = {
      ...this.config,
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
    this.openingWaitAt = null;
    this.openingLogged = false;
    this.navKey = null;
    this.walkCommandId = null;
    this.resupply = false;
    this.sellSkip.clear();
    this.loopStartedAt = null;
    this.loopLogged = false;
    this.sealWarned = false;
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
      this.openingWaitAt = null;
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
      inventoryCount: c?.inventoryCount ?? st.inventory.reduce((n, it) => n + it.count, 0),
      inventoryCap: c?.inventoryCap ?? 0,
      deaths: this.deaths,
    };
  }

  private stepOpening(stage: string): void {
    if (stage !== this.seenStage) {
      this.seenStage = stage;
      this.openingWaitAt = null;
      this.openingLogged = false;
      this.navKey = null;
      this.walkCommandId = null;
      if (this.host.navigator.isActive()) this.host.navigator.cancel();
    }
    const st = this.host.state();
    if (st.battle) {
      this.applyBattle(stage === 'CAPTURE', stage === 'CAPTURE');
      this.text = stage === 'CAPTURE' ? '無人任務：開場捕捉幻獸' : '無人任務：開場途中遇敵，先脫身';
      return;
    }
    if (stage === 'CAPTURE') {
      this.applyBattle(true, true);
      this.text = '無人任務：在目前地圖巡邏並捕捉';
      this.patrolHere();
      return;
    }
    this.applyBattle(false, false);
    if (this.host.navigator.isActive() || this.pendingWalk()) return;
    if (st.dialog) {
      this.chooseDialog(st.dialog.options.map(o => o.id));
      return;
    }
    const nav = this.host.navigator.getStatus();
    if (this.navKey && (nav.phase === 'DONE' || nav.phase === 'FAILED')) {
      if (this.openingWaitAt === null) {
        this.openingWaitAt = this.host.now();
        if (!this.openingLogged) {
          this.openingLogged = true;
          this.host.log('村長委託的選項只在遊戲畫面，外掛協定沒有對應指令。等待遊戲分頁點選，或宿主補上開場指令。', 'warn');
        }
      }
      if (this.host.now() - this.openingWaitAt >= OPENING_WAIT_MS) {
        this.finish('STUCK', '找不到下一步：宿主未把村長開場對話選項交給外掛（無法送進地下室或領取幻獸蛋）');
      } else {
        this.text = '無人任務：等待村長委託對話';
      }
      return;
    }
    const chief = this.chiefName();
    if (!chief) {
      this.finish('STUCK', '找不到下一步：快照與已知目錄都沒有村長');
      return;
    }
    this.navKey = `chief:${stage}`;
    this.text = `無人任務：前往 ${chief}`;
    this.host.navigator.go({ kind: 'NPC', query: chief, talk: true });
  }

  private stepQuests(): void {
    const st = this.host.state();
    const snap = st.snapshot;
    if (!snap) return;
    const quests = (snap.quests ?? []) as ChainQuest[];
    const level = st.character?.level ?? 1;
    // 快照可能已經把上一筆標成完成，而單筆任務模組還沒停。先記下來，避免改做下一筆時漏掉。
    this.absorbCompleted(quests);
    if (this.drivingId !== null && !this.host.quest.isActive()) {
      const current = quests.find(q => q.questId === this.drivingId);
      if (current?.status === 'COMPLETED') {
        this.noteCompleted(current);
        this.drivingId = null;
        this.stuck = null;
      } else {
        const why = this.host.quest.getLastStopReason();
        this.finish('STUCK', why ?? `任務 #${this.drivingId} 停住且沒有完成`);
        return;
      }
    }
    const next = selectNextQuest(quests, level);
    if (next.kind === 'QUEST') {
      this.text = `無人任務：${next.quest.title}`;
      this.applyBattleForQuest(next.quest);
      if (this.drivingId === next.quest.questId && this.host.quest.isActive()) {
        this.host.quest.advance();
      }
      this.watchStuck(next.quest, snap);
      if (!this.isActive()) return;
      if (this.drivingId !== next.quest.questId) {
        const err = this.host.quest.start(next.quest.questId);
        this.drivingId = next.quest.questId;
        if (err) this.finish('STUCK', err);
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
    if (this.shouldResupply(st)) {
      if (this.config.stop.stopOnBagFull && this.bagFull(st)) {
        this.finish('BAG_FULL', '停止條件觸發：背包已滿');
        return;
      }
      this.resupply = true;
      this.stepResupply();
      return;
    }
    this.resupply = false;
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
    const target = this.hunts[0] ?? this.gatherHunt();
    if (!target) {
      this.finish('STUCK', '找不到下一步：宿主沒有提供遇敵區或採集點，新手循環無法打怪');
      return;
    }
    if (snap.mapId !== target.mapId) {
      const nav = this.host.navigator.getStatus();
      if (this.navKey === target.mapId && nav.phase === 'FAILED') {
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
    if (stat.phase === 'STOPPED' && stat.stopReason === 'BAG_FULL' && this.bagFull(this.host.state())) {
      this.resupply = true;
      this.stepResupply();
      return;
    }
    if (stat.phase === 'STOPPED' && stat.stopReason && stat.stopReason !== 'DONE_TARGET' && stat.stopReason !== 'USER_STOPPED') {
      this.finish('STUCK', `找不到下一步：採集停住（${stat.stopReason}）`);
      return;
    }
    const point = this.gathers.find(p => p.skillId !== null) ?? null;
    if (!point) {
      this.finish('STUCK', '找不到下一步：宿主採集清單是空的');
      return;
    }
    const mat = point.materials?.[0];
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
    if (stat.phase === 'STOPPED' && stat.stopReason && stat.stopReason !== 'DONE_TARGET' && stat.stopReason !== 'USER_STOPPED') {
      this.finish('STUCK', `找不到下一步：配方做不下去（${stat.stopReason}）`);
      return;
    }
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
    if (this.host.navigator.isActive()) return;
    this.text = '新手循環：回村補給';
    if (st.shop) {
      const keep = this.keepNames();
      const sell = sellableItems(st.inventory, keep).find(it => !this.sellSkip.has(it.itemId));
      if (sell) {
        this.host.send({ type: 'SELL_ITEM', itemId: sell.itemId, count: sell.count }, `賣出 ${sell.name ?? '物品'}`, 'DONE');
        this.sellSkip.add(sell.itemId);
        return;
      }
      if (this.bagFull(st)) {
        this.finish('BAG_FULL', '背包已滿，而且沒有可賣的物品');
        return;
      }
      const hp = st.character?.hp;
      const max = st.character?.maxHp;
      if (!this.healSent && hp != null && max && max > 0 && (hp / max) * 100 <= this.config.returnHpPct) {
        this.healSent = true;
        this.host.send({ type: 'GAME_COMMAND', command: { type: 'HEAL_PARTY' } }, '回村治療', 'DONE');
        return;
      }
      this.host.send({ type: 'CHOOSE_DIALOG_OPTION', optionId: 'CLOSE_SHOP' }, '補給完成，離開商店', 'DONE');
      this.resupply = false;
      this.healSent = false;
      this.sellSkip.clear();
      return;
    }
    if (st.dialog) {
      const open = st.dialog.options.find(o => o.id === 'OPEN_SHOP');
      if (open) this.host.send({ type: 'CHOOSE_DIALOG_OPTION', optionId: open.id }, '打開商店', 'DONE');
      else this.chooseDialog(st.dialog.options.map(o => o.id));
      return;
    }
    const shop = this.pickShop(snap);
    if (!shop) {
      this.finish('STUCK', '找不到下一步：宿主快照沒有商店，無法回村補給');
      return;
    }
    const nav = this.host.navigator.getStatus();
    if (this.navKey === `shop:${shop.npcName}` && nav.phase === 'FAILED') {
      this.finish('STUCK', `找不到下一步：${nav.text}`);
      return;
    }
    this.navKey = `shop:${shop.npcName}`;
    this.host.navigator.go({ kind: 'NPC', query: shop.npcName, talk: true });
  }

  private watchStuck(quest: ChainQuest, snap: SceneSnapshot): void {
    const st = this.host.state();
    const waitingScene = Boolean(st.location && snap.mapId !== st.location.mapId);
    const idle = !waitingScene
      && !this.host.quest.isBusy()
      && !this.host.navigator.isActive()
      && !st.battle
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
      this.finish('STUCK', `找不到下一步：任務【${quest.title}】沒有進展（${unmet}）`);
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
    if (low || !fight) {
      if (this.host.battler.getStrategy() !== 'FLEE') this.host.battler.setStrategy('FLEE');
      this.host.battler.setTurnOverride(null);
      return;
    }
    if (this.host.battler.getStrategy() !== 'ATTACK') this.host.battler.setStrategy('ATTACK');
    if (!capture) {
      this.host.battler.setTurnOverride(null);
      return;
    }
    const seal = st.inventory.find(it => (it.name ?? '').includes('封印') || (it.name ?? '').includes('捕捉'));
    const override: CaptureTurnOverride | null = seal
      ? { mode: 'CAPTURE', sealStoneId: seal.itemId, captureBelowHpRatio: 0.5 }
      : null;
    this.host.battler.setTurnOverride(override);
    if (!seal) {
      if (!this.sealWarned) {
        this.sealWarned = true;
        this.host.log('背包裡沒有名稱可辨識的封印石，捕捉會先改為攻擊', 'warn');
      }
      return;
    }
    this.sealWarned = false;
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
    if (id) this.walkCommandId = id;
  }

  private chooseDialog(optionIds: string[]): void {
    const preferred = optionIds.find(id => id.startsWith('ACCEPT_QUEST:') || id.startsWith('COMPLETE_QUEST:') || id === 'ENABLE_DEMO_MODE');
    const close = optionIds.find(id => id === 'CLOSE' || id === 'BYE');
    const id = preferred ?? close ?? optionIds[0];
    if (!id) return;
    this.host.send({ type: 'CHOOSE_DIALOG_OPTION', optionId: id }, '推進對話', 'DONE');
  }

  private chiefName(): string | null {
    const npcs = this.host.knownNpcs();
    const chief = npcs.find(n => n.role === 'CHIEF') ?? npcs.find(n => n.name.includes('村長'));
    return chief?.name ?? null;
  }

  private pickShop(snap: SceneSnapshot): RememberedShop | null {
    const here = snap.shops[0];
    if (here) return { npcName: here.npcName, mapId: snap.mapId };
    const home = this.shops.find(s => s.mapId === this.homeMapId);
    return home ?? this.shops[0] ?? null;
  }

  private gatherHunt(): RememberedHunt | null {
    const point = this.gathers.find(p => p.mapId && p.x !== undefined);
    if (!point?.mapId) return null;
    return { mapId: point.mapId, mapName: point.mapName ?? null, x: point.x, y: point.y };
  }

  private shouldResupply(st: ReturnType<QuestChainHost['state']>): boolean {
    if (this.bagFull(st)) return true;
    const hp = st.character?.hp;
    const max = st.character?.maxHp;
    return hp != null && max != null && max > 0 && (hp / max) * 100 <= this.config.returnHpPct;
  }

  private bagFull(st: ReturnType<QuestChainHost['state']>): boolean {
    const count = st.character?.inventoryCount;
    const cap = st.character?.inventoryCap;
    return cap != null && cap > 0 && count != null && count >= cap;
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
        for (const quoted of o.description.matchAll(/「([^」]+)」/g)) names.add(quoted[1]);
      }
    }
    return [...names];
  }

  private pendingWalk(): boolean {
    if (!this.walkCommandId) return false;
    const st = this.host.state();
    return Boolean(st.pending[this.walkCommandId] || st.inflight[this.walkCommandId]);
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

  private noteCompleted(quest: ChainQuest): void {
    if (this.completed.some(q => q.questId === quest.questId)) return;
    this.completed.push(quest);
    this.host.log(`任務【${quest.title}】已完成`);
  }

  private finish(code: string, detail: string): void {
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
      stopReason: detail,
    });
    this.host.showRecap(summary);
  }
}
