import {
  PROTOCOL_VERSION,
  isCommandMessage,
  isPluginMessage,
  isStaticDataMessage,
  type CommandMessage,
  type PluginCommand,
  type PluginMessage,
} from './protocol/index';
import {
  createBattleModule,
  createNavigationModule,
  createWorkQueueModule,
} from './automation/modules/coreModules';
import { ExampleRestMonitorModule } from './automation/modules/exampleRestModule';
import { QuestChainModule } from './automation/modules/questChainModule';
import { QuestBehaviorModule } from './automation/modules/questModule';
import { AutomationRegistry } from './automation/registry';
import {
  CharacterStrategyStore,
  type CharacterStrategyConfig,
} from './automation/strategyStore';
import type { AutomationHostContext, BehaviorModule, CoordinatorMode } from './automation/types';
import { AutoBattler, type BattleStrategy } from './battler';
import { Directory } from './directory';
import { AutoNavigator, type NavStatus } from './navigator';
import { WorkNotifier, type NotificationAdapter } from './notify';
import { parseInput, type UiAction } from './parse';
import { RecapTracker, type WelcomeRecapSummary } from './dv7_recap';
import { WorkQueue, type QueueStatus } from './queue';
import { CharacterAppearanceStore } from './render/appearanceStore';
import { addLog, applyMessage, applySent, connectionStatus, initialState, type FamilyState } from './state';
import type { Transport } from './transport/types';

interface KvStorage { getItem(k: string): string | null; setItem(k: string, v: string): void }

export interface ControllerOptions {
  now?: () => number;
  onChange?: (s: FamilyState) => void;
  /** 持久化（目錄、單角策略）；沒有就只存在記憶體。 */
  storage?: KvStorage | null;
  /** 可替換的計時器（測試用）。 */
  after?: (ms: number, fn: () => void) => unknown;
  /** DV5：可替換的瀏覽器通知介面（測試用）。 */
  notification?: NotificationAdapter;
  /** FM-A：額外註冊的自訂行為模組（示範：新增行為只需傳入新模組）。 */
  extraModules?: BehaviorModule[];
}

/**
 * 把傳輸層、狀態與可組合行為模組接在一起。指令一律先過協定守衛再送出；
 * 宿主的接受／拒絕／完成事件原樣顯示在日誌（預期 vs 實際）。
 */
export class FamilyController {
  state: FamilyState = initialState();
  readonly directory: Directory;
  readonly navigator: AutoNavigator;
  readonly battler: AutoBattler;
  readonly queue: WorkQueue;
  readonly strategyStore: CharacterStrategyStore;
  readonly appearanceStore: CharacterAppearanceStore;
  readonly recapTracker: RecapTracker;
  readonly automation = new AutomationRegistry();
  private latestRecap: WelcomeRecapSummary | null = null;
  private readonly questModule: QuestBehaviorModule;
  private readonly questChain: QuestChainModule;
  private queues = new Map<string, WorkQueue>();
  private notifier: WorkNotifier;
  private primaryCharacterId: string | null = null;
  private seq = 0;
  private readonly tag = Math.random().toString(36).slice(2, 7);
  private readonly now: () => number;
  private readonly after: (ms: number, fn: () => void) => unknown;
  private lastStatus: 'RUNNING' | 'STOPPED' = 'STOPPED';
  private lastRequestedSession: string | null = null;
  private lastTrackedCharacterId: string | null = null;
  private sendDepth = 0;
  private agentQueue: PluginMessage[] = [];

  constructor(private transport: Transport, private opts: ControllerOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.after = opts.after ?? ((ms, fn) => setTimeout(fn, ms));
    this.directory = new Directory(opts.storage ?? null);
    this.strategyStore = new CharacterStrategyStore(opts.storage ?? null);
    this.appearanceStore = new CharacterAppearanceStore(opts.storage ?? null);
    this.recapTracker = new RecapTracker(opts.storage ?? null);
    this.notifier = new WorkNotifier(opts.notification);

    const host = {
      state: () => this.state,
      send: (c: PluginCommand, l: string, e?: string) => this.send(c, l, e),
      log: (t: string, level: 'info' | 'warn' | 'error' = 'info') => {
        this.state = addLog(this.state, '系統', t, this.now(), { level });
        this.emit();
      },
      after: (ms: number, fn: () => void) => this.after(ms, fn),
      onChange: () => this.emit(),
    };

    this.navigator = new AutoNavigator({
      ...host,
      dir: this.directory,
      onChange: () => {
        this.emit();
        if (this.navigator.getStatus().phase === 'DONE') {
          this.questModule.onNavigatorDone();
        }
      },
    });
    this.battler = new AutoBattler(host, opts.storage ?? null);
    const self = this;
    this.queue = new WorkQueue(
      {
        ...host,
        get characterId() {
          return self.primaryCharacterId ?? self.state.characterId ?? undefined;
        },
        send: (c: PluginCommand, l: string, e?: string) =>
          this.sendFor(this.primaryCharacterId ?? this.state.characterId, c, l, e),
        navigator: this.navigator,
      },
      opts.storage ?? null,
    );

    const modHost = this.moduleContext();
    this.questModule = new QuestBehaviorModule({
      ...modHost,
      navigator: this.navigator,
      battler: this.battler,
      getQueueFor: cid => (cid ? this.getOrCreateQueue(cid) : this.queue),
      knownNpcNames: () => this.directory.allNpcs().map(n => n.name),
      knownMaps: () => this.directory.allMaps(),
    });
    this.questChain = new QuestChainModule({
      ...modHost,
      navigator: this.navigator,
      battler: this.battler,
      quest: this.questModule,
      getQueue: () => this.queue,
      knownNpcs: () => this.directory.allNpcs(),
      knownMaps: () => this.directory.allMaps(),
      showRecap: summary => {
        this.latestRecap = summary;
        this.emit();
      },
    });

    // 註冊四大核心模組 ＋ 示範擴充模組 ＋ 使用端附加模組
    this.automation.register(createBattleModule(this.battler));
    this.automation.register(createNavigationModule(this.navigator));
    this.automation.register(createWorkQueueModule(cid => (cid ? this.getOrCreateQueue(cid) : this.queue)));
    this.automation.register(this.questModule);
    this.automation.register(this.questChain);
    this.automation.register(new ExampleRestMonitorModule());
    for (const extra of opts.extraModules ?? []) {
      this.automation.register(extra);
    }
  }

  private moduleContext(): AutomationHostContext {
    return {
      state: () => this.state,
      status: () => this.status(),
      now: () => this.now(),
      getStrategyConfig: cid => this.strategyStore.get(cid ?? this.state.characterId),
      send: (c, l, e, targetCharId) => this.sendFor(targetCharId ?? this.state.characterId, c, l, e) ?? '',
      log: (t, level = 'info') => {
        this.state = addLog(this.state, '系統', t, this.now(), { level });
        this.emit();
      },
      onChange: () => this.emit(),
    };
  }

  private getOrCreateQueue(charId: string): WorkQueue {
    if (!this.primaryCharacterId) this.primaryCharacterId = charId;
    if (charId === this.primaryCharacterId) {
      this.queues.set(charId, this.queue);
      return this.queue;
    }
    let q = this.queues.get(charId);
    if (!q) {
      const storage = this.opts.storage ?? null;
      q = new WorkQueue(
        {
          characterId: charId,
          state: () => this.state,
          send: (c: PluginCommand, l: string, e?: string) => this.sendFor(charId, c, l, e),
          log: (t: string, level: 'info' | 'warn' | 'error' = 'info') => {
            this.state = addLog(this.state, '系統', t, this.now(), { level });
            this.emit();
          },
          after: (ms: number, fn: () => void) => this.after(ms, fn),
          navigator: this.navigator,
          onChange: () => this.emit(),
        },
        storage,
        `family.queue.v1:${charId}`,
      );
      this.queues.set(charId, q);
    }
    return q;
  }

  start(): void {
    this.state = addLog(this.state, '系統', `傳輸：${this.transport.name}`, this.now());
    this.transport.start(raw => this.receive(raw));
    this.emit();
  }

  stop(): void {
    this.automation.stopAll();
    this.transport.stop();
  }

  status(): 'RUNNING' | 'STOPPED' {
    return connectionStatus(this.state, this.now());
  }

  navStatus(): NavStatus { return this.navigator.getStatus(); }
  strategy(): BattleStrategy { return this.battler.getStrategy(); }
  activeQuest(): number | null { return this.questModule.getActiveQuestId(); }
  chainStatus() { return this.questChain.getStatus(); }
  coordinatorMode(): CoordinatorMode { return this.automation.getCoordinatorMode(); }
  charStrategies(): Record<string, CharacterStrategyConfig> { return this.strategyStore.snapshotAll(); }
  charAppearances(): Record<string, string> { return this.appearanceStore.snapshotAll(); }
  welcomeRecap(): WelcomeRecapSummary | null { return this.latestRecap; }

  queueStatus(): QueueStatus {
    const cid = this.state.characterId;
    return (cid ? this.queues.get(cid) : undefined)?.getStatus() ?? this.queue.getStatus();
  }
  queueStatuses(): Record<string, QueueStatus> {
    const out: Record<string, QueueStatus> = {};
    for (const [cid, q] of this.queues) out[cid] = q.getStatus();
    return out;
  }

  private receive(raw: unknown): void {
    const now = this.now();
    this.state = applyMessage(this.state, raw, now);
    const recap = this.recapTracker.evaluateOnState(this.state, now);
    if (recap) this.latestRecap = recap;
    if (this.state.characterId && this.state.characterId !== this.lastTrackedCharacterId) {
      this.lastTrackedCharacterId = this.state.characterId;
      const saved = this.strategyStore.snapshotAll()[this.state.characterId];
      if (saved) this.battler.setStrategy(saved.battleStrategy);
    }
    if (isPluginMessage(raw)) {
      if (isStaticDataMessage(raw)) {
        this.directory.learnPortalGraph(raw.staticData.portalGraph);
      }
      if (raw.kind === 'snapshot') {
        this.directory.learn(raw.snapshot, this.state.staticData?.portalGraph);
        for (const m of raw.snapshot.family?.members ?? []) this.getOrCreateQueue(m.characterId);
      }
      if (this.sendDepth > 0 || this.agentQueue.length) {
        this.agentQueue.push(raw);
        this.after(0, () => this.flushAgents());
      } else {
        this.dispatchToAgents(raw);
      }
    }
    this.afterChange(now);
  }

  private flushAgents(): void {
    while (this.agentQueue.length && this.sendDepth === 0) {
      this.dispatchToAgents(this.agentQueue.shift() as PluginMessage);
    }
    this.emit();
  }

  private dispatchToAgents(m: PluginMessage): void {
    const ctx = this.moduleContext();
    this.automation.notifyPreMessage(m, ctx);
    if (m.characterId === this.state.characterId) {
      this.navigator.onMessage(m);
      this.battler.onMessage(m);
    }
    if (this.queues.size === 0) this.queue.onMessage(m);
    else if (m.kind === 'snapshot' || m.kind === 'heartbeat') {
      for (const q of this.queues.values()) q.onMessage(m);
    } else {
      const q = this.queues.get(m.characterId) ?? (m.characterId === this.state.characterId ? this.queue : undefined);
      q?.onMessage(m);
    }
    this.automation.notifyMessage(m, ctx);
  }

  /** 定時呼叫：心跳逾時要靠時間才會變成「遊戲未執行」，同時推動進行中的任務循環。 */
  tick(): void {
    this.afterChange(this.now());
    if (this.questChain.isActive()) this.questChain.tick();
    if (this.questModule.isActive()) this.questModule.advance();
    this.automation.syncCoordinator(this.moduleContext());
  }

  private afterChange(now: number): void {
    const st = connectionStatus(this.state, now);
    if (st !== this.lastStatus) {
      this.lastStatus = st;
      if (st === 'STOPPED') this.state = addLog(this.state, '連線', '遊戲未執行', now, { level: 'warn' });
    }
    if (st === 'RUNNING' && this.state.sessionId && this.lastRequestedSession !== this.state.sessionId && this.state.phase === 'PLAYING') {
      const needStatic = this.lastRequestedSession === null || !this.state.staticData;
      this.lastRequestedSession = this.state.sessionId;
      this.emit();
      this.send(needStatic ? { type: 'REQUEST_SNAPSHOT', includeStatic: true } : { type: 'REQUEST_SNAPSHOT' }, '要求快照（連線）');
      return;
    }
    this.emit();
  }

  /** 送出指令；遊戲未執行時不送（藍圖：遊戲未執行不接受指令）。回傳 commandId 或 null。 */
  send(command: PluginCommand, label: string, expect?: string): string | null {
    return this.sendFor(this.state.characterId, command, label, expect);
  }

  sendFor(targetCharId: string | null, command: PluginCommand, label: string, expect?: string): string | null {
    const now = this.now();
    const characterId = targetCharId ?? this.state.characterId;
    if (!characterId || this.status() !== 'RUNNING') {
      this.state = addLog(this.state, '系統', `遊戲未執行，未送出：${label}`, now, { level: 'warn' });
      this.emit();
      return null;
    }
    const msg: CommandMessage = {
      v: PROTOCOL_VERSION,
      characterId,
      ts: now,
      kind: 'command',
      commandId: `fam-${this.tag}-${String(++this.seq).padStart(4, '0')}`,
      command,
    };
    if (!isCommandMessage(msg)) {
      this.state = addLog(this.state, '系統', `指令格式不正確，未送出：${label}`, now, { level: 'error' });
      this.emit();
      return null;
    }
    this.state = applySent(this.state, msg, label, now, expect);
    this.sendDepth++;
    try {
      this.transport.send(msg);
    } finally {
      this.sendDepth--;
    }
    this.emit();
    return msg.commandId;
  }

  /** 選單按鈕與文字輸入共用的執行入口；回傳錯誤文字（無法執行）或 null。 */
  perform(action: UiAction): string | null {
    if (action.kind === 'COMMAND') {
      this.sendFor(action.targetCharacterId ?? this.state.characterId, action.command, action.label);
      return null;
    }
    if (action.kind === 'CHAR_STRATEGY_UPDATE') {
      const updated = this.strategyStore.update(action.characterId, action.patch);
      if (action.patch.battleStrategy && action.characterId === (this.state.characterId ?? this.state.activeCharacterId)) {
        this.battler.setStrategy(updated.battleStrategy);
      }
      this.state = addLog(this.state, '系統', action.label, this.now());
      this.emit();
      return null;
    }
    if (action.kind === 'CHAR_APPEARANCE_UPDATE') {
      this.appearanceStore.set(action.characterId, action.appearanceId);
      this.state = addLog(this.state, '系統', action.label, this.now());
      this.emit();
      return null;
    }
    if (action.kind === 'DISMISS_RECAP') {
      this.latestRecap = null;
      this.emit();
      return null;
    }
    if (action.kind === 'STRATEGY') {
      const cid = this.state.characterId ?? this.state.activeCharacterId;
      if (cid) this.strategyStore.update(cid, { battleStrategy: action.strategy });
    }
    if (['NAV', 'NAV_CANCEL', 'QUEUE_GATHER', 'QUEUE_CRAFT', 'QUEUE_STOP', 'QUEST_AUTO', 'QUEST_AUTO_STOP'].includes(action.kind)) {
      this.questChain.stop('玩家改為手動操作');
      this.questModule.stop();
    }
    const res = this.automation.dispatchAction(action, this.moduleContext());
    if (res.handled) return res.error;
    return null;
  }

  /** 自由輸入：解析成與選單相同的動作再執行；解析失敗回傳錯誤文字（不送出）。 */
  parseAndSend(text: string): string | null {
    const s = this.state;
    const r = parseInput(text, s.snapshot, {
      mapId: s.location?.mapId,
      dialogOptions: s.dialog?.options,
      enemies: s.battle?.enemyStates,
      battleId: s.battle?.battleId ?? null,
      inventory: s.inventory,
      members: s.members,
      warehouse: s.warehouse,
      recipes: s.staticData?.recipes,
      findNpc: q => this.directory.findNpc(q),
      findMap: q => this.directory.findMap(q),
    });
    if (!r.ok) return r.error;
    return this.perform(r.action);
  }

  private emit(): void {
    this.notifier.check(this.state, this.queueStatuses(), this.queueStatus());
    this.opts.onChange?.(this.state);
  }
}
