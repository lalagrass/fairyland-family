import { PROTOCOL_VERSION, isCommandMessage, isPluginMessage, type CommandMessage, type PluginCommand, type PluginMessage } from './protocol/index';
import { AutoBattler, type BattleStrategy } from './battler';
import { Directory } from './directory';
import { AutoNavigator, type NavStatus } from './navigator';
import { parseInput, type UiAction } from './parse';
import { WorkQueue, type QueueStatus } from './queue';
import { addLog, applyMessage, applySent, connectionStatus, initialState, type FamilyState } from './state';
import type { Transport } from './transport/types';

interface KvStorage { getItem(k: string): string | null; setItem(k: string, v: string): void }

export interface ControllerOptions {
  now?: () => number;
  onChange?: (s: FamilyState) => void;
  /** 持久化（目錄、戰鬥策略）；沒有就只存在記憶體。 */
  storage?: KvStorage | null;
  /** 可替換的計時器（測試用）。 */
  after?: (ms: number, fn: () => void) => unknown;
}

/**
 * 把傳輸層、狀態、導航器與自動戰鬥接在一起。指令一律先過協定守衛再送出；
 * 宿主的接受／拒絕／完成事件原樣顯示在日誌（預期 vs 實際）。
 */
export class FamilyController {
  state: FamilyState = initialState();
  readonly directory: Directory;
  readonly navigator: AutoNavigator;
  readonly battler: AutoBattler;
  readonly queue: WorkQueue;
  private queues = new Map<string, WorkQueue>();
  private primaryCharacterId: string | null = null;
  private seq = 0;
  private readonly tag = Math.random().toString(36).slice(2, 7);
  private readonly now: () => number;
  private readonly after: (ms: number, fn: () => void) => unknown;
  private lastStatus: 'RUNNING' | 'STOPPED' = 'STOPPED';
  private lastRequestedSession: string | null = null;
  /** 傳輸層可能在 send() 還沒返回時就同步回覆（回放、同頁腳本）；此時交給導航器／戰鬥員的訊息要排隊，等呼叫端記下 commandId 再送。 */
  private sendDepth = 0;
  private agentQueue: PluginMessage[] = [];

  constructor(private transport: Transport, private opts: ControllerOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.after = opts.after ?? ((ms, fn) => setTimeout(fn, ms));
    this.directory = new Directory(opts.storage ?? null);
    const host = {
      state: () => this.state,
      send: (c: PluginCommand, l: string, e?: string) => this.send(c, l, e),
      log: (t: string, level: 'info' | 'warn' | 'error' = 'info') => { this.state = addLog(this.state, '系統', t, this.now(), { level }); this.emit(); },
      after: (ms: number, fn: () => void) => this.after(ms, fn),
      onChange: () => this.emit(),
    };
    this.navigator = new AutoNavigator({ ...host, dir: this.directory });
    this.battler = new AutoBattler(host, opts.storage ?? null);
    const self = this;
    this.queue = new WorkQueue({
      ...host,
      get characterId() { return self.primaryCharacterId ?? self.state.characterId ?? undefined; },
      send: (c: PluginCommand, l: string, e?: string) => this.sendFor(this.primaryCharacterId ?? this.state.characterId, c, l, e),
      navigator: this.navigator,
    }, opts.storage ?? null);
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
        `family.queue.v1:${charId}`
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
    this.transport.stop();
  }

  status(): 'RUNNING' | 'STOPPED' {
    return connectionStatus(this.state, this.now());
  }

  navStatus(): NavStatus { return this.navigator.getStatus(); }
  strategy(): BattleStrategy { return this.battler.getStrategy(); }
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
    if (isPluginMessage(raw)) {
      if (raw.kind === 'snapshot') {
        this.directory.learn(raw.snapshot);
        for (const m of raw.snapshot.family?.members ?? []) this.getOrCreateQueue(m.characterId);
      }
      if (this.sendDepth > 0 || this.agentQueue.length) { this.agentQueue.push(raw); this.after(0, () => this.flushAgents()); }
      else this.dispatchToAgents(raw);
    }
    this.afterChange(now);
  }

  private flushAgents(): void {
    while (this.agentQueue.length && this.sendDepth === 0) this.dispatchToAgents(this.agentQueue.shift() as PluginMessage);
    this.emit();
  }

  private dispatchToAgents(m: PluginMessage): void {
    if (m.characterId === this.state.characterId) {
      this.navigator.onMessage(m);
      this.battler.onMessage(m);
    }
    if (m.kind === 'snapshot' || m.kind === 'heartbeat') {
      if (this.queues.size === 0) this.queue.onMessage(m);
      else for (const q of this.queues.values()) q.onMessage(m);
      return;
    }
    const q = this.queues.get(m.characterId) ?? (m.characterId === this.state.characterId ? this.queue : undefined);
    q?.onMessage(m);
  }

  /** 定時呼叫：心跳逾時要靠時間才會變成「遊戲未執行」。 */
  tick(): void {
    this.afterChange(this.now());
  }

  private afterChange(now: number): void {
    const st = connectionStatus(this.state, now);
    if (st !== this.lastStatus) {
      this.lastStatus = st;
      if (st === 'STOPPED') this.state = addLog(this.state, '連線', '遊戲未執行', now, { level: 'warn' });
    }
    // 連上（或遊戲重開）就主動要一份快照，等於「接上當下進度」。
    if (st === 'RUNNING' && this.state.sessionId && this.lastRequestedSession !== this.state.sessionId && this.state.phase === 'PLAYING') {
      this.lastRequestedSession = this.state.sessionId;
      this.emit();
      this.send({ type: 'REQUEST_SNAPSHOT' }, '要求快照（連線）');
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
      v: PROTOCOL_VERSION, characterId, ts: now, kind: 'command',
      commandId: `fam-${this.tag}-${String(++this.seq).padStart(4, '0')}`, command,
    };
    if (!isCommandMessage(msg)) {
      this.state = addLog(this.state, '系統', `指令格式不正確，未送出：${label}`, now, { level: 'error' });
      this.emit();
      return null;
    }
    this.state = applySent(this.state, msg, label, now, expect);
    this.sendDepth++;
    try { this.transport.send(msg); } finally { this.sendDepth--; }
    this.emit();
    return msg.commandId;
  }

  /** 選單按鈕與文字輸入共用的執行入口；回傳錯誤文字（無法執行）或 null。 */
  perform(action: UiAction): string | null {
    switch (action.kind) {
      case 'COMMAND':
        this.sendFor(action.targetCharacterId ?? this.state.characterId, action.command, action.label);
        return null;
      case 'NAV': return this.navigator.go(action.goal);
      case 'NAV_CANCEL': this.navigator.cancel(); return null;
      case 'STRATEGY': this.battler.setStrategy(action.strategy); return null;
      case 'QUEUE_GATHER': {
        const q = action.targetCharacterId ? this.getOrCreateQueue(action.targetCharacterId) : (this.state.characterId ? this.getOrCreateQueue(this.state.characterId) : this.queue);
        q.enqueue({
          kind: 'GATHER',
          skillId: action.skillId,
          skillName: action.skillName,
          ...(action.targetItemId !== undefined ? { targetItemId: action.targetItemId } : {}),
          targetName: action.targetName,
          targetCount: action.count,
          ...(action.requiredToolItemId !== undefined ? { requiredToolItemId: action.requiredToolItemId } : {}),
          ...(action.requiredToolName ? { requiredToolName: action.requiredToolName } : {}),
        });
        return null;
      }
      case 'QUEUE_CRAFT': {
        const q = action.targetCharacterId ? this.getOrCreateQueue(action.targetCharacterId) : (this.state.characterId ? this.getOrCreateQueue(this.state.characterId) : this.queue);
        q.enqueue({
          kind: 'CRAFT',
          recipeId: action.recipeId,
          recipeName: action.recipeName,
          targetCount: action.count,
        });
        return null;
      }
      case 'QUEUE_STOP': {
        const q = action.targetCharacterId ? this.getOrCreateQueue(action.targetCharacterId) : (this.state.characterId ? this.getOrCreateQueue(this.state.characterId) : this.queue);
        q.stop('USER_STOPPED');
        return null;
      }
      case 'QUEST_AUTO':
        return this.runQuestAuto(action.questId);
    }
  }

  private runQuestAuto(questId: number): string | null {
    const snap = this.state.snapshot;
    const quest = snap?.quests?.find(q => q.questId === questId);
    if (!quest) return '尚未收到任務資料';
    if (quest.status === 'COMPLETED') {
      this.state = addLog(this.state, '系統', `任務【${quest.title}】已完成`, this.now());
      this.emit();
      return null;
    }
    const dialog = this.state.dialog;
    if (dialog && (dialog.npcId === quest.npcId || dialog.npcName === quest.npcName)) {
      if (quest.status === 'AVAILABLE') {
        const acceptOpt = dialog.options.find(o => o.id === `ACCEPT_QUEST:${questId}`);
        if (acceptOpt) {
          this.send({ type: 'CHOOSE_DIALOG_OPTION', optionId: acceptOpt.id }, `接取任務：${quest.title}`);
          return null;
        }
        const demoOpt = dialog.options.find(o => o.id === 'ENABLE_DEMO_MODE');
        if (demoOpt) {
          this.send({ type: 'CHOOSE_DIALOG_OPTION', optionId: demoOpt.id }, '切換示範任務模式');
          return null;
        }
        this.send({ type: 'ACCEPT_QUEST', questId }, `接受任務 #${questId}`);
        return null;
      }
      if (quest.status === 'READY') {
        const completeOpt = dialog.options.find(o => o.id === `COMPLETE_QUEST:${questId}`);
        if (completeOpt) {
          this.send({ type: 'CHOOSE_DIALOG_OPTION', optionId: completeOpt.id }, `回報任務：${quest.title}`);
          return null;
        }
        return '對話選項未含回報入口，請於主畫面確認前置步驟';
      }
    }
    if (quest.status === 'AVAILABLE' || quest.status === 'READY') {
      return this.navigator.go({ kind: 'NPC', query: quest.npcName, talk: true });
    }
    // IN_PROGRESS：若有採集／收集目標先自動排程採集
    const unmet = quest.objectives.filter(o => !o.met);
    if (unmet.some(o => o.type === 'GATHER_COUNT' || o.type === 'COLLECT_ITEMS')) {
      const points = [...(snap?.gatherPoints.points ?? []), ...(snap?.nearbyGatherPoints ?? [])];
      const matchPoint = points.find(p => p.materials?.some(m => unmet.some(u => u.description.includes(m.name)))) ?? points[0];
      if (matchPoint) {
        const mat = matchPoint.materials?.[0];
        const needed = Math.max(1, ...unmet.filter(o => o.type === 'GATHER_COUNT' || o.type === 'COLLECT_ITEMS').map(o => o.required - o.current));
        const q = this.state.characterId ? this.getOrCreateQueue(this.state.characterId) : this.queue;
        q.enqueue({
          kind: 'GATHER',
          skillId: matchPoint.skillId ?? 5,
          skillName: matchPoint.skillName ?? '採礦',
          ...(mat ? { targetItemId: mat.itemId } : {}),
          targetName: mat?.name ?? matchPoint.name,
          targetCount: needed,
          ...(matchPoint.requiredToolItemId ? { requiredToolItemId: matchPoint.requiredToolItemId } : {}),
          ...(matchPoint.requiredToolName ? { requiredToolName: matchPoint.requiredToolName } : {}),
        });
        return null;
      }
    }
    if (unmet.some(o => o.type === 'KILL_MONSTERS' || o.type === 'CAPTURE_PETS' || o.type === 'DEFEAT_BOSS')) {
      const targetExit = snap?.exits.find(e => /南綠野|草地|森林|外圍|地下/.test(e.targetMapName ?? e.name));
      if (targetExit) {
        return this.navigator.go({ kind: 'MAP', mapId: targetExit.targetMapId, name: targetExit.targetMapName ?? targetExit.name });
      }
    }
    this.state = addLog(this.state, '系統', `任務進行中：${unmet.map(o => `${o.description} (${o.current}/${o.required})`).join('、')}`, this.now());
    this.emit();
    return null;
  }

  /** 自由輸入：解析成與選單相同的動作再執行；解析失敗回傳錯誤文字（不送出）。 */
  parseAndSend(text: string): string | null {
    const s = this.state;
    const r = parseInput(text, s.snapshot, {
      mapId: s.location?.mapId, dialogOptions: s.dialog?.options, enemies: s.battle?.enemyStates, battleId: s.battle?.battleId ?? null, inventory: s.inventory,
      members: s.members, warehouse: s.warehouse,
      findNpc: q => this.directory.findNpc(q), findMap: q => this.directory.findMap(q),
    });
    if (!r.ok) return r.error;
    return this.perform(r.action);
  }

  private emit(): void {
    this.opts.onChange?.(this.state);
  }
}
