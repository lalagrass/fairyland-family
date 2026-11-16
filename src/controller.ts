import {
  PROTOCOL_VERSION,
  isCommandMessage,
  isCommandResultMessage,
  isEventMessage,
  isPluginMessage,
  isSnapshotMessage,
  type CommandMessage,
  type PluginCommand,
  type PluginMessage,
} from './protocol/index';
import { AutoBattler, type BattleStrategy } from './battler';
import { Directory } from './directory';
import { AutoNavigator, type NavStatus } from './navigator';
import { WorkNotifier, type NotificationAdapter } from './notify';
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
  /** DV5：可替換的瀏覽器通知介面（測試用）。 */
  notification?: NotificationAdapter;
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
  private notifier: WorkNotifier;
  private primaryCharacterId: string | null = null;
  private activeQuestId: number | null = null;
  private questPatrolCommandId: string | null = null;
  private questPatrolIdx = 0;
  private questCooldownUntil = 0;
  private questSnapshotPending = false;
  private lastQuestStatus: string | null = null;
  private advancingQuest = false;
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
    this.notifier = new WorkNotifier(opts.notification);
    const host = {
      state: () => this.state,
      send: (c: PluginCommand, l: string, e?: string) => this.send(c, l, e),
      log: (t: string, level: 'info' | 'warn' | 'error' = 'info') => { this.state = addLog(this.state, '系統', t, this.now(), { level }); this.emit(); },
      after: (ms: number, fn: () => void) => this.after(ms, fn),
      onChange: () => this.emit(),
    };
    this.navigator = new AutoNavigator({
      ...host,
      dir: this.directory,
      onChange: () => {
        this.emit();
        if (this.activeQuestId !== null && this.navigator.getStatus().phase === 'DONE') {
          this.advanceActiveQuest();
        }
      },
    });
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
  activeQuest(): number | null { return this.activeQuestId; }
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
    if (isEventMessage(m)) {
      if (m.event.type === 'COMMAND_COMPLETED' && m.event.code === 'DIALOG_OPENED' && !this.state.dialog) {
        this.questCooldownUntil = Math.max(this.questCooldownUntil, this.now() + 800);
      } else if (m.event.type === 'DIALOG_OPENED' || m.event.type === 'DIALOG_UPDATED') {
        this.questCooldownUntil = 0;
      }
      if (m.event.type === 'COMMAND_COMPLETED' && m.event.commandId === this.questPatrolCommandId) {
        this.questPatrolCommandId = null;
      }
    }
    if (isCommandResultMessage(m) && m.commandId === this.questPatrolCommandId && m.status === 'REJECTED') {
      this.questPatrolCommandId = null;
    }
    if (m.kind === 'snapshot') this.questSnapshotPending = false;
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
    if (this.activeQuestId !== null && (isSnapshotMessage(m) || isEventMessage(m) || isCommandResultMessage(m))) {
      this.advanceActiveQuest();
    }
  }

  /** 定時呼叫：心跳逾時要靠時間才會變成「遊戲未執行」，同時推動進行中的任務循環。 */
  tick(): void {
    this.afterChange(this.now());
    if (this.activeQuestId !== null) this.advanceActiveQuest();
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
      case 'NAV':
        this.stopActiveQuest();
        return this.navigator.go(action.goal);
      case 'NAV_CANCEL':
        this.stopActiveQuest();
        this.navigator.cancel();
        return null;
      case 'STRATEGY': this.battler.setStrategy(action.strategy); return null;
      case 'QUEUE_GATHER': {
        this.stopActiveQuest();
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
        this.stopActiveQuest();
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
        this.stopActiveQuest();
        const q = action.targetCharacterId ? this.getOrCreateQueue(action.targetCharacterId) : (this.state.characterId ? this.getOrCreateQueue(this.state.characterId) : this.queue);
        q.stop('USER_STOPPED');
        return null;
      }
      case 'QUEST_AUTO':
        return this.runQuestAuto(action.questId);
      case 'QUEST_AUTO_STOP':
        this.stopActiveQuest('玩家取消任務自動推進');
        return null;
    }
  }

  private stopActiveQuest(reasonLog?: string): void {
    if (this.activeQuestId === null) return;
    this.activeQuestId = null;
    this.questPatrolCommandId = null;
    this.questSnapshotPending = false;
    if (reasonLog) {
      this.state = addLog(this.state, '系統', reasonLog, this.now());
      this.emit();
    }
  }

  private runQuestAuto(questId: number): string | null {
    const snap = this.state.snapshot;
    const quest = snap?.quests?.find(q => q.questId === questId);
    if (!quest) return '尚未收到任務資料';
    if (quest.status === 'COMPLETED') {
      this.stopActiveQuest();
      this.state = addLog(this.state, '系統', `任務【${quest.title}】已完成`, this.now());
      this.emit();
      return null;
    }
    this.activeQuestId = questId;
    this.questPatrolCommandId = null;
    this.questPatrolIdx = 0;
    this.questCooldownUntil = 0;
    this.questSnapshotPending = false;
    this.lastQuestStatus = null;
    this.state = addLog(this.state, '系統', `任務自動推進開始：【${quest.title}】`, this.now());
    const err = this.advanceActiveQuest();
    this.emit();
    return err;
  }

  private advanceActiveQuest(): string | null {
    if (this.advancingQuest || this.activeQuestId === null || this.status() !== 'RUNNING') return null;
    this.advancingQuest = true;
    try {
      return this.stepActiveQuest();
    } finally {
      this.advancingQuest = false;
    }
  }

  private stepActiveQuest(): string | null {
    if (this.activeQuestId === null || this.status() !== 'RUNNING') return null;
    const questId = this.activeQuestId;
    const snap = this.state.snapshot;
    const quest = snap?.quests?.find(q => q.questId === questId);
    if (!snap || !quest) return null;
    // 剛換圖但新場景快照還沒送達時，不要用上一張圖的舊快照繼續推進。
    if (this.state.location && snap.mapId !== this.state.location.mapId) return null;

    if (quest.status === 'COMPLETED') {
      this.activeQuestId = null;
      this.questPatrolCommandId = null;
      this.state = addLog(this.state, '系統', `任務【${quest.title}】已完成`, this.now());
      this.emit();
      return null;
    }

    if (this.state.battleResult === 'DEFEAT') {
      this.stopActiveQuest(`任務【${quest.title}】自動推進中止：戰鬥落敗`);
      return null;
    }
    if (this.state.battle) {
      const hasCombat = quest.objectives.some(o => !o.met && (o.type === 'KILL_MONSTERS' || o.type === 'CAPTURE_PETS' || o.type === 'DEFEAT_BOSS'));
      if (hasCombat && this.battler.getStrategy() === 'MANUAL') {
        this.battler.setStrategy('ATTACK');
      }
      return null;
    }
    if (this.state.battleResult === 'VICTORY') {
      if (this.battler.getStrategy() === 'MANUAL') {
        this.send({ type: 'CHOOSE_DIALOG_OPTION', optionId: 'RETURN_TO_MAP' }, '關閉勝利視窗');
      }
      return null;
    }

    if (this.navigator.isActive()) return null;
    if (this.questPatrolCommandId && (this.state.pending[this.questPatrolCommandId] || this.state.inflight[this.questPatrolCommandId])) {
      return null;
    }

    const activeQ = this.state.characterId ? this.getOrCreateQueue(this.state.characterId) : this.queue;
    const qStat = activeQ.getStatus();
    if (['RUNNING', 'PAUSED_BATTLE', 'WAITING_TOOL_BUY', 'WALKING_TO_POINT'].includes(qStat.phase)) {
      return null;
    }
    if (quest.status === 'IN_PROGRESS' && qStat.phase === 'STOPPED' && qStat.stopReason && qStat.stopReason !== 'USER_STOPPED' && qStat.stopReason !== 'DONE_TARGET') {
      this.stopActiveQuest(`任務【${quest.title}】自動推進中止：工作停止（${qStat.stopReason}）`);
      return null;
    }

    const now = this.now();
    if (this.lastQuestStatus !== quest.status) {
      this.lastQuestStatus = quest.status;
      this.questCooldownUntil = 0;
    }
    if (now < this.questCooldownUntil) return null;

    const dialog = this.state.dialog;
    const dialogMatchesNpc = !!dialog && (dialog.npcId === quest.npcId || dialog.npcName === quest.npcName);

    if (quest.status === 'AVAILABLE') {
      if (dialogMatchesNpc && dialog) {
        const demoOpt = dialog.options.find(o => o.id === 'ENABLE_DEMO_MODE');
        if (demoOpt) {
          this.questCooldownUntil = now + 700;
          this.send({ type: 'CHOOSE_DIALOG_OPTION', optionId: demoOpt.id }, '切換示範任務模式');
          return null;
        }
        const acceptOpt = dialog.options.find(o => o.id === `ACCEPT_QUEST:${questId}`);
        if (acceptOpt) {
          this.questCooldownUntil = now + 700;
          this.send({ type: 'CHOOSE_DIALOG_OPTION', optionId: acceptOpt.id }, `接取任務：${quest.title}`);
          return null;
        }
        this.questCooldownUntil = now + 700;
        this.send({ type: 'ACCEPT_QUEST', questId }, `接受任務 #${questId}`);
        return null;
      }
      if (dialog) {
        const closeOpt = dialog.options.find(o => o.id === 'CLOSE' || o.id === 'BYE') ?? dialog.options[dialog.options.length - 1];
        if (closeOpt) {
          this.questCooldownUntil = now + 400;
          this.send({ type: 'CHOOSE_DIALOG_OPTION', optionId: closeOpt.id }, '關閉對話');
          return null;
        }
      }
      return this.navigator.go({ kind: 'NPC', query: quest.npcName, talk: true });
    }

    if (quest.status === 'READY') {
      if (dialogMatchesNpc && dialog) {
        const completeOpt = dialog.options.find(o => o.id === `COMPLETE_QUEST:${questId}`);
        if (completeOpt) {
          this.questCooldownUntil = now + 700;
          this.send({ type: 'CHOOSE_DIALOG_OPTION', optionId: completeOpt.id }, `回報任務：${quest.title}`);
          return null;
        }
        const demoOpt = dialog.options.find(o => o.id === 'ENABLE_DEMO_MODE');
        if (demoOpt) {
          this.questCooldownUntil = now + 700;
          this.send({ type: 'CHOOSE_DIALOG_OPTION', optionId: demoOpt.id }, '切換示範任務模式');
          return null;
        }
        this.stopActiveQuest('對話選項未含回報入口，請於主畫面確認前置步驟');
        return '對話選項未含回報入口，請於主畫面確認前置步驟';
      }
      if (dialog) {
        const closeOpt = dialog.options.find(o => o.id === 'CLOSE' || o.id === 'BYE') ?? dialog.options[dialog.options.length - 1];
        if (closeOpt) {
          this.questCooldownUntil = now + 400;
          this.send({ type: 'CHOOSE_DIALOG_OPTION', optionId: closeOpt.id }, '關閉對話');
          return null;
        }
      }
      return this.navigator.go({ kind: 'NPC', query: quest.npcName, talk: true });
    }

    // IN_PROGRESS：先關閉還開著的 NPC 對話，再推進下一個未達成目標。
    if (dialog) {
      const closeOpt = dialog.options.find(o => o.id === 'CLOSE' || o.id === 'BYE') ?? dialog.options[dialog.options.length - 1];
      if (closeOpt) {
        this.questCooldownUntil = now + 400;
        this.send({ type: 'CHOOSE_DIALOG_OPTION', optionId: closeOpt.id }, '關閉對話繼續推進任務');
        return null;
      }
    }

    const unmet = quest.objectives.filter(o => !o.met);
    if (unmet.length === 0) {
      if (!this.questSnapshotPending) {
        this.questSnapshotPending = true;
        this.questCooldownUntil = now + 600;
        this.send({ type: 'REQUEST_SNAPSHOT' }, '更新任務狀態');
      }
      return null;
    }

    const gatherObj = unmet.find(o => o.type === 'GATHER_COUNT' || o.type === 'COLLECT_ITEMS');
    if (gatherObj) {
      const points = [...(snap.gatherPoints.points ?? []), ...(snap.nearbyGatherPoints ?? [])];
      const hintMapIds = new Set((gatherObj.targetMaps ?? []).map(h => h.mapId));
      const matchPoint =
        points.find(p => (hintMapIds.size === 0 || (!!p.mapId && hintMapIds.has(p.mapId))) && p.materials?.some(m => gatherObj.description.includes(m.name)))
        ?? points.find(p => p.materials?.some(m => unmet.some(u => u.description.includes(m.name))))
        ?? (hintMapIds.size > 0 ? points.find(p => !!p.mapId && hintMapIds.has(p.mapId)) : undefined)
        ?? points[0];
      if (matchPoint) {
        const mat = matchPoint.materials?.find(m => gatherObj.description.includes(m.name)) ?? matchPoint.materials?.[0];
        const needed = Math.max(1, gatherObj.required - gatherObj.current);
        this.questSnapshotPending = false;
        activeQ.enqueue({
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

    const combatObj = unmet.find(o => o.type === 'KILL_MONSTERS' || o.type === 'CAPTURE_PETS' || o.type === 'DEFEAT_BOSS');
    if (combatObj) {
      const hints = combatObj.targetMaps ?? [];
      if (hints.length === 0) {
        this.stopActiveQuest(`任務【${quest.title}】目標未提供目標地圖資訊（targetMaps）`);
        return '任務目標未提供目標地圖資訊';
      }
      const curMapId = this.state.location?.mapId ?? snap.mapId;
      const localHint = hints.find(h => h.mapId === curMapId);
      if (!localHint) {
        const hopOf = (id: string) => snap.nav.reachableMaps.find(r => r.mapId === id)?.hops ?? 999;
        const target = [...hints].sort((a, b) => hopOf(a.mapId) - hopOf(b.mapId))[0];
        return this.navigator.go({ kind: 'MAP', mapId: target.mapId, name: target.mapName ?? target.mapId });
      }
      if (this.battler.getStrategy() === 'MANUAL') {
        this.battler.setStrategy('ATTACK');
      }
      const pos = this.state.character ?? { x: snap.character.x, y: snap.character.y };
      const hx = localHint.x ?? pos.x;
      const hy = localHint.y ?? pos.y;
      const distToCenter = Math.hypot(pos.x - hx, pos.y - hy);
      const offsets: ReadonlyArray<readonly [number, number]> = [
        [0, 0],
        [96, 0],
        [-96, 0],
        [0, 96],
        [0, -96],
        [64, 64],
        [-64, -64],
      ];
      let tx = hx;
      let ty = hy;
      if (distToCenter <= 160) {
        for (let tries = 0; tries < offsets.length; tries++) {
          const [dx, dy] = offsets[(this.questPatrolIdx + tries) % offsets.length];
          const cx = hx + dx;
          const cy = hy + dy;
          if (Math.hypot(pos.x - cx, pos.y - cy) >= 32) {
            tx = cx;
            ty = cy;
            this.questPatrolIdx = (this.questPatrolIdx + tries + 1) % offsets.length;
            break;
          }
        }
      } else {
        this.questPatrolIdx = 1;
      }
      this.questCooldownUntil = now + 250;
      const cmdId = this.send({ type: 'WALK_TO', mapId: curMapId, x: tx, y: ty }, `巡邏目標區域：${localHint.mapName ?? localHint.mapId}`, 'ARRIVED');
      this.questPatrolCommandId = cmdId;
      return null;
    }

    this.state = addLog(this.state, '系統', `任務進行中：${unmet.map(o => `${o.description} (${o.current}/${o.required})`).join('、')}`, now);
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
    this.notifier.check(this.state, this.queueStatuses(), this.queueStatus());
    this.opts.onChange?.(this.state);
  }
}
