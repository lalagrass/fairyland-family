import { QuestChainModule, type QuestChainStatus } from './automation/modules/questChainModule';
import { QuestBehaviorModule } from './automation/modules/questModule';
import type { CharacterStrategyConfig } from './automation/strategyStore';
import type { AutomationHostContext } from './automation/types';
import { AutoBattler } from './battler';
import type { Directory } from './directory';
import type { WelcomeRecapSummary } from './dv7_recap';
import { AutoNavigator } from './navigator';
import { PROTOCOL_VERSION, isEventMessage, isSnapshotMessage, type PluginCommand, type PluginMessage, type StaticDataPayload } from './protocol/index';
import type { WorkQueue } from './queue';
import { applyMessage, applySent, initialState, type FamilyState } from './state';

/**
 * F8：每位角色一條「派工通道」（lane）。FX17 之後宿主的背景角色也能走路、對話、接交任務與戰鬥，
 * 所以每條通道各有自己的狀態、導航、戰鬥、單筆任務與任務鏈，彼此不共用執行中的狀態：
 *
 * - 狀態：只套用 `characterId` 是這位角色的訊息（宿主回給這位角色的快照、事件、指令結果）。
 *   背景角色的快照宿主不會主動送，通道在指令完成、對話關閉、換圖、戰鬥結束後自己要（`REQUEST_SNAPSHOT`，信封帶角色 id）。
 * - 指令：一律送給這位角色（`sendFor(id, …)`），視角不動。
 * - 任務互斥：任務鏈挑下一件時跳過別的通道正在做的同一件任務（`questHeldElsewhere`），沒有別件可做就等。
 *
 * 通道本身不存檔；派工紀錄（`dispatch.ts`）存檔，重開後由派工重新開一條通道接著跑。
 */

/** 背景角色多久沒有新快照就主動要一次（毫秒）。 */
export const LANE_SNAPSHOT_REFRESH_MS = 5_000;
/** 同一條通道兩次要快照之間至少隔多久（毫秒）。 */
export const LANE_SNAPSHOT_THROTTLE_MS = 300;

/** 家族總覽每列顯示的派工通道摘要。 */
export interface LaneSummary {
  characterId: string;
  active: boolean;
  questId: number | null;
  /** 快照裡的任務名稱；任務在但名稱是空的時為 null（畫面顯示「未知」）。 */
  questTitle: string | null;
  /** 「已完成目標數/目標總數 項目標」；快照沒有目標時為 null。 */
  progress: string | null;
  text: string;
}

export interface LaneDeps {
  now(): number;
  after(ms: number, fn: () => void): unknown;
  status(): 'RUNNING' | 'STOPPED';
  /** 送指令給指定角色；遊戲未執行時回 null。 */
  sendFor(characterId: string, command: PluginCommand, label: string, expect?: string): string | null;
  /** 寫進主事件欄（帶 characterId，可用角色篩選）。 */
  log(characterId: string, text: string, level: 'info' | 'warn' | 'error'): void;
  onChange(): void;
  directory: Directory;
  queueFor(characterId: string): WorkQueue;
  strategyFor(characterId: string): CharacterStrategyConfig;
  nameOf(characterId: string): string;
  viewedId(): string | null;
  staticData(): StaticDataPayload | null;
  /** 這件任務是不是別的角色正在做；是的話回傳那位角色的 id。 */
  questHeldElsewhere(questId: number, characterId: string): string | null;
}

export class CharacterLane {
  state: FamilyState = initialState();
  readonly navigator: AutoNavigator;
  readonly battler: AutoBattler;
  readonly quest: QuestBehaviorModule;
  readonly chain: QuestChainModule;
  lastRecap: WelcomeRecapSummary | null = null;
  /** 通道送出的快照請求；宿主的回覆（`inReplyTo`）只套用到這條通道。 */
  private snapshotRequests = new Set<string>();
  private lastRequestAt = -Infinity;
  private requestTimer = false;

  constructor(readonly characterId: string, private deps: LaneDeps) {
    const id = characterId;
    const st = deps.staticData();
    if (st) this.state = { ...this.state, staticData: st };
    const ctx: AutomationHostContext = {
      state: () => this.state,
      status: () => deps.status(),
      now: () => deps.now(),
      getStrategyConfig: cid => deps.strategyFor(cid ?? id),
      send: (c, l, e, target) => this.send(c, l, e, target) ?? '',
      log: (t, level = 'info') => deps.log(id, `【${deps.nameOf(id)}】${t}`, level),
      onChange: () => deps.onChange(),
    };
    const base = {
      state: ctx.state,
      send: (c: PluginCommand, l: string, e?: string) => this.send(c, l, e),
      log: ctx.log,
      after: (ms: number, fn: () => void) => deps.after(ms, fn),
      now: ctx.now,
      onChange: ctx.onChange,
    };
    this.navigator = new AutoNavigator({
      ...base,
      dir: deps.directory,
      onChange: () => {
        deps.onChange();
        if (this.navigator.getStatus().phase === 'DONE') this.quest.onNavigatorDone();
      },
    });
    // 通道的戰鬥策略不存檔（存檔的是視角角色的策略）；任務鏈開始時會依任務設定攻擊或捕捉。
    this.battler = new AutoBattler(base, null);
    this.quest = new QuestBehaviorModule({
      ...ctx,
      navigator: this.navigator,
      battler: this.battler,
      getQueueFor: cid => deps.queueFor(cid ?? id),
      knownNpcNames: () => deps.directory.allNpcs().map(n => n.name),
      knownMaps: () => deps.directory.allMaps(),
    });
    this.chain = new QuestChainModule({
      ...ctx,
      navigator: this.navigator,
      battler: this.battler,
      quest: this.quest,
      getQueue: () => deps.queueFor(id),
      knownNpcs: () => deps.directory.allNpcs(),
      knownMaps: () => deps.directory.allMaps(),
      showRecap: summary => { this.lastRecap = summary; deps.onChange(); },
      questHeldElsewhere: questId => {
        const other = deps.questHeldElsewhere(questId, id);
        return other ? deps.nameOf(other) : null;
      },
    });
  }

  /** 通道有沒有這位角色自己的快照（背景角色要等通道要到的快照）。 */
  ready(): boolean {
    return this.state.snapshot !== null && this.state.characterId === this.characterId;
  }

  /** 任務鏈或單筆任務正在跑。 */
  active(): boolean {
    return this.chain.isActive() || this.quest.isActive();
  }

  chainStatus(): QuestChainStatus {
    return this.chain.getStatus();
  }

  /** 這條通道現在占著的任務（任務鏈正在推進的那件，或單筆任務）。 */
  heldQuestId(): number | null {
    return this.chain.getDrivingQuestId() ?? this.quest.getActiveQuestId();
  }

  /** 這個 commandId 是不是這條通道要的快照。 */
  ownsSnapshotRequest(commandId: string | undefined): boolean {
    return Boolean(commandId && this.snapshotRequests.has(commandId));
  }

  /** 收到屬於這位角色的訊息（控制器已經先依 characterId 篩過）。 */
  onMessage(m: PluginMessage): void {
    if (m.kind === 'heartbeat') return;
    if (m.characterId !== this.characterId && m.kind !== 'static-data') return;
    this.state = applyMessage(this.state, m, this.deps.now());
    if (isSnapshotMessage(m) && m.inReplyTo) this.snapshotRequests.delete(m.inReplyTo);
    this.quest.onPreMessage(m);
    this.navigator.onMessage(m);
    this.battler.onMessage(m);
    this.chain.onMessage(m);
    this.quest.onMessage(m);
    if (isEventMessage(m) && this.deps.viewedId() !== this.characterId) {
      const t = m.event.type;
      if (t === 'COMMAND_COMPLETED' || t === 'DIALOG_CLOSED' || t === 'LOCATION_CHANGED' || t === 'BATTLE_ENDED' || t === 'SHOP_CLOSED') {
        this.requestSnapshot('背景角色進度更新');
      }
    }
  }

  tick(): void {
    if (!this.active()) return;
    if (this.deps.viewedId() !== this.characterId && this.deps.now() - (this.state.snapshotAt ?? -Infinity) > LANE_SNAPSHOT_REFRESH_MS) {
      this.requestSnapshot('背景角色定時更新');
    }
    if (this.chain.isActive()) this.chain.tick();
    if (this.quest.isActive()) this.quest.advance();
  }

  /** 要一次這位角色自己的快照（節流；宿主回覆帶 inReplyTo）。 */
  requestSnapshot(why: string): void {
    const now = this.deps.now();
    if (now - this.lastRequestAt < LANE_SNAPSHOT_THROTTLE_MS) {
      if (!this.requestTimer) {
        this.requestTimer = true;
        this.deps.after(LANE_SNAPSHOT_THROTTLE_MS, () => {
          this.requestTimer = false;
          this.requestSnapshot(why);
        });
      }
      return;
    }
    this.lastRequestAt = now;
    this.send({ type: 'REQUEST_SNAPSHOT' }, `要求快照（${why}）`);
  }

  /** 停下這條通道的全部自動化（任務鏈、單筆任務、導航）。 */
  stop(text: string): void {
    if (this.chain.isActive()) this.chain.stop(text);
    if (this.quest.isActive()) this.quest.stop(text);
    if (this.navigator.isActive()) this.navigator.cancel();
  }

  private send(command: PluginCommand, label: string, expect?: string, target?: string): string | null {
    const characterId = target ?? this.characterId;
    const id = this.deps.sendFor(characterId, command, label, expect);
    if (!id) return null;
    if (command.type === 'REQUEST_SNAPSHOT') this.snapshotRequests.add(id);
    // 通道的狀態也記下送出中的指令（任務鏈靠它判斷走路是否還在進行、戰鬥這回合是否已出手）。
    // 宿主的結果與事件在控制器排隊後才送進通道，所以一定晚於這筆紀錄。
    const now = this.deps.now();
    this.state = applySent(this.state, { v: PROTOCOL_VERSION, characterId, ts: now, kind: 'command', commandId: id, command }, label, now, expect);
    return id;
  }
}
