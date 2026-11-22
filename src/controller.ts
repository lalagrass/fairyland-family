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
import { CharacterDispatcher, DispatchStore, type DispatchRecap, type DispatchRecord, type DispatchStop, type GatherSpec } from './dispatch';
import { AutoNavigator, type NavStatus } from './navigator';
import { WorkNotifier, type NotificationAdapter } from './notify';
import { parseInput, type UiAction } from './parse';
import { RecapTracker, type WelcomeRecapSummary } from './dv7_recap';
import { WorkQueue, type QueueStatus } from './queue';
import { CharacterAppearanceStore } from './render/appearanceStore';
import { CharacterViewModeStore, parseViewMode } from './render/viewMode';
import { addLog, applyMessage, applySent, connectionStatus, initialState, type FamilyState } from './state';
import type { Transport } from './transport/types';

const PRIMARY_KEY = 'family.queue.primary:v1';

interface KvStorage { getItem(k: string): string | null; setItem(k: string, v: string): void }

/** F9：派給別的角色時，最多等這麼久讓視角切過去。 */
const PENDING_QUEST_TIMEOUT_MS = 15_000;

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
  readonly viewModeStore: CharacterViewModeStore;
  readonly recapTracker: RecapTracker;
  readonly automation = new AutomationRegistry();
  readonly dispatchStore: DispatchStore;
  readonly dispatcher: CharacterDispatcher;
  /** 前景任務鏈目前屬於哪個角色（開始時的視角角色）。單一任務鏈模組一次只服務一個角色。 */
  private chainOwner: string | null = null;
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
    this.viewModeStore = new CharacterViewModeStore(opts.storage ?? null);
    this.recapTracker = new RecapTracker(opts.storage ?? null);
    this.notifier = new WorkNotifier(opts.notification);
    this.primaryCharacterId = this.readPrimary();

    const host = {
      state: () => this.state,
      send: (c: PluginCommand, l: string, e?: string) => this.send(c, l, e),
      log: (t: string, level: 'info' | 'warn' | 'error' = 'info') => {
        this.state = addLog(this.state, '系統', t, this.now(), { level });
        this.emit();
      },
      after: (ms: number, fn: () => void) => this.after(ms, fn),
      now: () => this.now(),
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
        requestView: (id: string) => this.requestViewFor(id),
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
      getQueue: () => this.getOrCreateQueue(this.chainOwner ?? this.state.characterId ?? this.primaryCharacterId ?? ''),
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

    this.dispatchStore = new DispatchStore(opts.storage ?? null);
    this.dispatcher = new CharacterDispatcher(this.dispatchHost(), this.dispatchStore);
  }

  private dispatchHost(): import('./dispatch').DispatchHost {
    const nameOf = (id: string) => this.state.members.find(m => m.characterId === id)?.name ?? id;
    return {
      now: () => this.now(),
      running: () => this.status() === 'RUNNING',
      viewedId: () => this.state.characterId,
      snapshotReady: id => {
        const snap = this.state.snapshot;
        if (!snap || this.state.characterId !== id) return false;
        const f = snap.family;
        return !f || f.activeCharacterId === id;
      },
      nameOf,
      knownCharacterIds: () => this.state.members.map(m => m.characterId),
      queueStatus: id => this.getOrCreateQueue(id).getStatus(),
      queueActive: id => this.getOrCreateQueue(id).isActive(),
      startGather: (id, g: GatherSpec, stop: DispatchStop) => {
        const q = this.getOrCreateQueue(id);
        q.setStopConditions({ stopOnBagFull: stop.stopOnBagFull, minSatiety: stop.minSatiety });
        q.enqueue({
          kind: 'GATHER',
          skillId: g.skillId,
          skillName: g.skillName,
          ...(g.targetItemId !== undefined ? { targetItemId: g.targetItemId } : {}),
          targetName: g.targetName,
          targetCount: g.count,
          ...(g.requiredToolItemId !== undefined ? { requiredToolItemId: g.requiredToolItemId } : {}),
          ...(g.requiredToolName ? { requiredToolName: g.requiredToolName } : {}),
        });
      },
      stopQueue: (id, reason, text) => this.getOrCreateQueue(id).stop(reason, text),
      chainActive: () => this.questChain.isActive(),
      chainOwner: () => this.chainOwner,
      chainStatus: () => this.questChain.getStatus(),
      startChain: (id, loopOnly, stop, remainingMs) => {
        this.chainOwner = id;
        this.questChain.handleAction({
          kind: 'QUEST_CHAIN_CONFIG',
          label: '派工設定任務鏈',
          patch: {
            stop: {
              maxDurationMs: remainingMs,
              targetLevel: stop.targetLevel ?? null,
              stopOnBagFull: stop.stopOnBagFull,
            },
            newbieLoop: true,
            loopOnly,
          },
        });
        const res = this.questChain.handleAction({ kind: 'QUEST_CHAIN_START', label: '派工開始任務鏈' });
        if (res.error) this.chainOwner = null;
        return res.error;
      },
      stopChain: text => {
        this.questChain.stop(text);
        if (this.navigator.isActive()) this.navigator.cancel();
        if (this.questModule.isActive()) this.questModule.stop();
      },
      switchView: id => {
        this.sendFor(id, { type: 'SWITCH_VIEW_CHARACTER', characterId: id }, `派工切換視角 ${nameOf(id)}`);
      },
      requestSnapshot: () => {
        this.send({ type: 'REQUEST_SNAPSHOT' }, '要求快照（派工恢復）');
      },
      log: (text, level, characterId) => {
        this.state = addLog(this.state, '系統', text, this.now(), { level, characterId });
        this.emit();
      },
      onChange: () => this.emit(),
    };
  }

  private readPrimary(): string | null {
    try {
      return this.opts.storage?.getItem(PRIMARY_KEY) ?? null;
    } catch {
      return null;
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

  /** 視角借用：背景採集需要走近時暫時把視角切給它，走近開工後還給原本的角色。 */
  private static readonly viewSwitchTimeoutMs = 20_000;
  private viewLoan: {
    borrower: string;
    returnTo: string;
    since: number;
    manualChoice?: { commandId: string; deadline: number };
  } | null = null;

  private requestViewFor(id: string): void {
    if (this.state.characterId === id || this.viewLoan?.manualChoice) return;
    if (!this.viewLoan) {
      const back = this.state.characterId;
      if (back) this.viewLoan = { borrower: id, returnTo: back, since: this.now() };
    }
    const name = this.state.members.find(m => m.characterId === id)?.name ?? id;
    this.sendFor(id, { type: 'SWITCH_VIEW_CHARACTER', characterId: id }, `採集需要走近，切換視角 ${name}`);
  }

  private settleManualViewChoice(m: PluginMessage): void {
    const loan = this.viewLoan;
    const choice = loan?.manualChoice;
    if (!choice || m.kind !== 'command-result' || m.commandId !== choice.commandId) return;
    // 宿主先完成切換才回 ACCEPTED；別把相同角色的借用快照當成手動切換已成功。
    if (m.status === 'ACCEPTED') this.viewLoan = null;
    else delete loan.manualChoice;
  }

  private settleViewLoan(): void {
    const loan = this.viewLoan;
    if (!loan) return;
    if (loan.manualChoice) {
      if (this.now() < loan.manualChoice.deadline) return;
      delete loan.manualChoice;
    }
    if (this.state.characterId !== loan.borrower) {
      if (this.now() - loan.since > FamilyController.viewSwitchTimeoutMs) this.viewLoan = null; // 一直切不過去：放棄，不要卡住
      return;
    }
    const q = this.getOrCreateQueue(loan.borrower).getStatus();
    const approaching = q.phase === 'WALKING_TO_POINT' || q.phase === 'WAITING_TOOL_BUY' || this.navigator.isActive();
    const expired = this.now() - loan.since > 120_000;
    if (approaching && !expired) return;
    this.viewLoan = null;
    const name = this.state.members.find(m => m.characterId === loan.returnTo)?.name ?? loan.returnTo;
    this.sendFor(loan.returnTo, { type: 'SWITCH_VIEW_CHARACTER', characterId: loan.returnTo }, `走近完成，視角還給 ${name}`);
  }

  private getOrCreateQueue(charId: string): WorkQueue {
    if (!this.primaryCharacterId) {
      this.primaryCharacterId = charId;
      // 預設佇列的存檔屬於第一個角色；記下來，重開後不管先看到誰都接回同一位。
      try { this.opts.storage?.setItem(PRIMARY_KEY, charId); } catch { /* ignore */ }
    }
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
          requestView: (id: string) => this.requestViewFor(id),
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
  /** F9：已派給角色、還在等視角切過去的任務。 */
  pendingQuestAssign(): { questId: number; characterId: string } | null {
    return this.pendingQuest ? { questId: this.pendingQuest.questId, characterId: this.pendingQuest.characterId } : null;
  }
  chainStatus() { return this.questChain.getStatus(); }
  coordinatorMode(): CoordinatorMode { return this.automation.getCoordinatorMode(); }
  charStrategies(): Record<string, CharacterStrategyConfig> { return this.strategyStore.snapshotAll(); }
  charAppearances(): Record<string, string> { return this.appearanceStore.snapshotAll(); }
  charViewModes(): Record<string, 'original' | 'modern'> { return this.viewModeStore.snapshotAll(); }
  welcomeRecap(): WelcomeRecapSummary | null { return this.latestRecap; }
  dispatches(): DispatchRecord[] { return this.dispatcher.records(); }
  dispatchRecaps(): DispatchRecap[] { return this.dispatcher.recaps(); }

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
    this.settleManualViewChoice(m);
    // 視角剛換掉：前景工作（走路、對話、任務鏈）都屬於舊視角角色，先收掉再處理訊息，避免指令送給別的角色。
    this.syncViewOwnership();
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
    if (this.pendingQuest && m.kind === 'snapshot' && m.characterId === this.pendingQuest.characterId) {
      this.pendingQuest.snapshotSeen = true;
    }
    this.settlePendingQuest();
  }

  /** F9 派給角色：視角中的角色直接開始自動推進；別的角色先切換視角（任務指令宿主只接受視角角色）。 */
  private assignQuest(action: Extract<UiAction, { kind: 'QUEST_ASSIGN' }>): string | null {
    const viewed = this.state.characterId;
    if (!viewed) return '尚未收到角色資料，無法派任務';
    if (action.characterId === viewed) {
      this.pendingQuest = null;
      return this.perform({ kind: 'QUEST_AUTO', questId: action.questId, label: action.label });
    }
    const member = this.state.members.find(m => m.characterId === action.characterId);
    if (!member) return `找不到角色 ${action.characterId}`;
    const name = member.name ?? member.characterId;
    const sent = this.sendFor(action.characterId, { type: 'SWITCH_VIEW_CHARACTER', characterId: action.characterId }, `派任務切換視角 ${name}`);
    if (!sent) {
      this.pendingQuest = null;
      return '遊戲未執行，無法切換視角';
    }
    this.pendingQuest = {
      questId: action.questId,
      characterId: action.characterId,
      label: action.label,
      deadline: this.now() + PENDING_QUEST_TIMEOUT_MS,
      snapshotSeen: false,
    };
    this.state = addLog(this.state, '系統', `${action.label}（等待切換視角）`, this.now(), { characterId: action.characterId });
    this.emit();
    return null;
  }

  private settlePendingQuest(): void {
    const p = this.pendingQuest;
    if (!p) return;
    const name = this.state.members.find(m => m.characterId === p.characterId)?.name ?? p.characterId;
    if (this.now() > p.deadline) {
      this.pendingQuest = null;
      this.state = addLog(this.state, '系統', `派任務給 ${name} 逾時：視角沒有切過去，沒有開始自動推進`, this.now(), { level: 'warn', characterId: p.characterId });
      this.emit();
      return;
    }
    if (!p.snapshotSeen || this.state.characterId !== p.characterId || this.lastViewedId !== p.characterId) return;
    this.pendingQuest = null;
    const quest = this.state.snapshot?.quests?.find(q => q.questId === p.questId);
    if (!quest || quest.status === 'COMPLETED') {
      this.state = addLog(this.state, '系統', `${name} 的快照沒有這個任務（或已完成），沒有開始自動推進`, this.now(), { level: 'warn', characterId: p.characterId });
      this.emit();
      return;
    }
    const err = this.perform({ kind: 'QUEST_AUTO', questId: p.questId, label: p.label });
    if (err) {
      this.state = addLog(this.state, '系統', `派任務給 ${name} 失敗：${err}`, this.now(), { level: 'warn', characterId: p.characterId });
    }
    this.emit();
  }

  private lastViewedId: string | null = null;
  /** F9 派給角色：等視角切到 characterId 並收到它的快照後，才送 QUEST_AUTO。 */
  private pendingQuest: { questId: number; characterId: string; label: string; deadline: number; snapshotSeen: boolean } | null = null;

  private syncViewOwnership(): void {
    const viewed = this.state.characterId;
    if (viewed !== this.lastViewedId) {
      const prev = this.lastViewedId;
      this.lastViewedId = viewed;
      if (prev !== null) {
        if (this.navigator.isActive()) this.navigator.cancel();
        if (this.questModule.isActive()) this.questModule.stop();
      }
    }
    this.dispatcher.enforceView();
  }

  /** 定時呼叫：心跳逾時要靠時間才會變成「遊戲未執行」，同時推動進行中的任務循環。 */
  tick(): void {
    this.afterChange(this.now());
    this.syncViewOwnership();
    this.settleViewLoan();
    this.settlePendingQuest();
    this.dispatcher.tick();
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
      const loan = action.command.type === 'SWITCH_VIEW_CHARACTER' ? this.viewLoan : null;
      const commandId = this.sendFor(action.targetCharacterId ?? this.state.characterId, action.command, action.label);
      if (loan && this.viewLoan === loan && commandId) {
        // sendFor 中同步收到的結果也會先排入佇列，等指令 id 已記錄後才交給代理處理。
        loan.manualChoice = { commandId, deadline: this.now() + FamilyController.viewSwitchTimeoutMs };
      }
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
    if (action.kind === 'CHAR_VIEWMODE_UPDATE') {
      this.viewModeStore.set(action.characterId, parseViewMode(action.viewMode));
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
    if (action.kind === 'QUEST_ASSIGN') return this.assignQuest(action);
    if (action.kind === 'DISPATCH_ASSIGN') {
      const err = this.dispatcher.assign(action.characterId, action.spec);
      this.state = addLog(this.state, '系統', action.label, this.now(), { characterId: action.characterId });
      this.emit();
      return err;
    }
    if (action.kind === 'DISPATCH_STOP') {
      this.dispatcher.stop(action.characterId);
      return null;
    }
    if (action.kind === 'QUEST_CHAIN_START') {
      this.chainOwner = this.state.characterId;
    }
    if (['NAV', 'NAV_CANCEL', 'QUEUE_GATHER', 'QUEUE_CRAFT', 'QUEUE_STOP', 'QUEST_AUTO', 'QUEST_AUTO_STOP'].includes(action.kind)) {
      // 只有動到「前景任務鏈擁有者」自己時才算手動接手；替別的角色排採集不會打斷它。
      const target = 'targetCharacterId' in action && action.targetCharacterId ? action.targetCharacterId : this.state.characterId;
      const touchesChainOwner = !this.chainOwner || target === this.chainOwner;
      const foregroundOnly = action.kind === 'NAV' || action.kind === 'NAV_CANCEL' || action.kind === 'QUEST_AUTO' || action.kind === 'QUEST_AUTO_STOP';
      if (touchesChainOwner || foregroundOnly) {
        this.questChain.stop('玩家改為手動操作');
        this.questModule.stop();
      }
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
