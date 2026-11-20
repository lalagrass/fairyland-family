import {
  isCommandResultMessage,
  isEventMessage,
  isSnapshotMessage,
  type PluginCommand,
  type PluginMessage,
  type SceneSnapshot,
  type SnapshotGatherPoint,
} from './protocol/index';
import type { AutoNavigator } from './navigator';
import { TALK_NEAR } from './navigator';
import type { FamilyState } from './state';

interface KvStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export type WorkJob =
  | {
      id: string;
      kind: 'GATHER';
      skillId: number;
      skillName: string;
      targetItemId?: number;
      targetName: string;
      targetCount: number | 'UNTIL_FULL';
      doneCount: number;
      requiredToolItemId?: number;
      requiredToolName?: string;
    }
  | {
      id: string;
      kind: 'CRAFT';
      recipeId: number;
      recipeName: string;
      targetCount: number;
      doneCount: number;
    };

export type NewWorkJob =
  | Omit<Extract<WorkJob, { kind: 'GATHER' }>, 'id' | 'doneCount'>
  | Omit<Extract<WorkJob, { kind: 'CRAFT' }>, 'id' | 'doneCount'>;

export type QueuePhase =
  | 'IDLE'
  | 'RUNNING'
  | 'PAUSED_BATTLE'
  | 'WAITING_TOOL_BUY'
  | 'WALKING_TO_POINT'
  | 'STOPPED'
  | 'DONE';

export type QueueStopReason =
  | 'DONE_TARGET'
  | 'BAG_FULL'
  | 'NO_STAMINA'
  | 'MISSING_MATERIALS'
  | 'MISSING_TOOL'
  | 'INSUFFICIENT_GOLD'
  | 'SKILL_LEVEL_TOO_LOW'
  | 'TOO_FAR'
  | 'UNKNOWN_SKILL'
  | 'UNKNOWN_RECIPE'
  | 'USER_STOPPED'
  | 'SHOP_FAILED'
  | 'NAV_FAILED';

export interface QueueStopConditions {
  stopOnBagFull: boolean;
  minSatiety: number | null;
}

export interface QueueStatus {
  phase: QueuePhase;
  jobs: WorkJob[];
  activeJobIndex: number;
  stopReason: QueueStopReason | null;
  text: string;
  stopConditions?: QueueStopConditions;
}

export interface QueueHost {
  /** FX4：若指定 characterId，此佇列專門追蹤與驅動該角色（前景或後台皆可）。 */
  characterId?: string;
  state(): FamilyState;
  send(command: PluginCommand, label: string, expect?: string): string | null;
  log(text: string, level?: 'info' | 'warn' | 'error'): void;
  after(ms: number, fn: () => void): unknown;
  navigator: AutoNavigator;
  onChange(): void;
  /** F2b：背景角色離採集點太遠又不能走路時，請求把視角切給它，走近後再還回去。 */
  requestView?(characterId: string): void;
}

const DEFAULT_KEY = 'family.queue.v1';
/** 與宿主工作指令願意動手的距離對齊，避免停在「宿主肯採、外掛卻一直重走」的空檔。 */
const GATHER_APPROACH_DIST = 240;
/** 離宿主範圍上限留一點餘裕（位置是快照插值，可能略舊）。 */
const GATHER_RANGE_MARGIN = 30;
/** 宿主拒絕採集（TOO_FAR）後改成走到採集點旁邊。 */
const GATHER_CLOSE_DIST = 40;
const MAX_VIEW_REQUESTS = 3;
const RETRY_MS = 450;

function mapRejectToStop(code: string): QueueStopReason | null {
  switch (code) {
    case 'INVENTORY_FULL':
      return 'BAG_FULL';
    case 'INSUFFICIENT_STAMINA':
      return 'NO_STAMINA';
    case 'INSUFFICIENT_MATERIALS':
      return 'MISSING_MATERIALS';
    case 'INSUFFICIENT_GOLD':
      return 'INSUFFICIENT_GOLD';
    case 'SKILL_LEVEL_TOO_LOW':
      return 'SKILL_LEVEL_TOO_LOW';
    case 'UNKNOWN_SKILL':
      return 'UNKNOWN_SKILL';
    case 'UNKNOWN_RECIPE':
      return 'UNKNOWN_RECIPE';
    case 'TOO_FAR':
      return 'TOO_FAR';
    default:
      return null;
  }
}

export function stopReasonLabel(r: QueueStopReason): string {
  switch (r) {
    case 'DONE_TARGET':
      return '全部目標已完成';
    case 'BAG_FULL':
      return 'BAG_FULL（背包已滿）';
    case 'NO_STAMINA':
      return 'NO_STAMINA（飽食度不足）';
    case 'MISSING_MATERIALS':
      return 'MISSING_MATERIALS（材料不足）';
    case 'MISSING_TOOL':
      return 'MISSING_TOOL（缺少工具且找不到商店）';
    case 'INSUFFICIENT_GOLD':
      return 'INSUFFICIENT_GOLD（金幣不足購買工具）';
    case 'SKILL_LEVEL_TOO_LOW':
      return 'SKILL_LEVEL_TOO_LOW（技能等級不足）';
    case 'TOO_FAR':
      return 'TOO_FAR（找不到採集點或距離過遠）';
    case 'UNKNOWN_SKILL':
      return 'UNKNOWN_SKILL（無效的採集技能）';
    case 'UNKNOWN_RECIPE':
      return 'UNKNOWN_RECIPE（無效的製作配方）';
    case 'USER_STOPPED':
      return 'USER_STOPPED（使用者停止）';
    case 'SHOP_FAILED':
      return 'SHOP_FAILED（購買工具失敗）';
    case 'NAV_FAILED':
      return 'NAV_FAILED（移動前往採集點失敗）';
  }
}

/**
 * FX11：持久化的採集／製作工作排程器。
 * - localStorage 持久化工作佇列（重開分頁可接續）
 * - 自動補買缺失工具（找可購買工具 NPC -> 開店 -> 購買 -> 關店 -> 繼續工作）
 * - 遇敵自動暫停，戰鬥與結算結束後自動續做
 * - 背包滿／體力耗盡／材料不足等回傳明確可顯示的 stopReason
 */
export class WorkQueue {
  private token = 0;
  private stepGen = 0;
  private seq = 0;
  private jobs: WorkJob[] = [];
  private activeJobIndex = 0;
  private phase: QueuePhase = 'IDLE';
  private stopReason: QueueStopReason | null = null;
  private text = '工作佇列：閒置';
  private pending: { commandId: string; role: 'WORK' | 'WALK' | 'TALK' | 'DIALOG' | 'BUY_TOOL' | 'CLOSE_SHOP'; toolId?: number } | null = null;
  private boughtToolAttempted = new Set<number>();
  private boughtToolAt = new Map<number, number>();
  private navStartedKey: string | null = null;
  private dialogRetries = 0;
  private openShopSentAt = 0;
  /** 同一個採集點、距離幾乎沒縮短的走路次數。連走仍靠近不了就換下一個點。 */
  /** 從宿主 TOO_FAR 訊息學到的採集範圍（px）；沒學到之前用預設值，不把宿主的數字寫死。 */
  private hostGatherRange: number | null = null;
  private forceClose = false;
  private tooFarRetries = 0;
  private viewRequests = 0;
  private approachTries: { pointId: string; dist: number; tries: number } | null = null;
  /** 這次工作已經確認走不過的採集點。直線距離近不代表走得到。 */
  private skippedPoints = new Set<string>();
  private stopConditions: QueueStopConditions = { stopOnBagFull: false, minSatiety: null };

  constructor(
    private host: QueueHost,
    private storage: KvStorage | null = null,
    private readonly storageKey: string = DEFAULT_KEY
  ) {
    this.load();
  }

  getStatus(): QueueStatus {
    return {
      phase: this.phase,
      jobs: this.jobs.map(j => ({ ...j })),
      activeJobIndex: this.activeJobIndex,
      stopReason: this.stopReason,
      text: this.text,
      stopConditions: { ...this.stopConditions },
    };
  }

  setStopConditions(patch: Partial<QueueStopConditions>): QueueStopConditions {
    this.stopConditions = {
      stopOnBagFull: patch.stopOnBagFull ?? this.stopConditions.stopOnBagFull,
      minSatiety:
        patch.minSatiety === undefined
          ? this.stopConditions.minSatiety
          : patch.minSatiety === null
            ? null
            : Math.max(0, Math.min(99, Math.round(patch.minSatiety))),
    };
    this.persist();
    this.host.onChange();
    return { ...this.stopConditions };
  }

  removeJob(index: number): boolean {
    if (index < 0 || index >= this.jobs.length) return false;
    this.jobs.splice(index, 1);
    if (this.jobs.length === 0) {
      this.stop('USER_STOPPED', '工作佇列已清空');
      return true;
    }
    if (index < this.activeJobIndex) {
      this.activeJobIndex = Math.max(0, this.activeJobIndex - 1);
    } else if (index === this.activeJobIndex) {
      this.pending = null;
      this.navStartedKey = null;
      this.activeJobIndex = Math.min(this.activeJobIndex, this.jobs.length - 1);
      this.token += 1;
      if (this.isActive()) this.scheduleStep(0);
    }
    this.text = this.describeActive();
    this.persist();
    this.host.onChange();
    return true;
  }

  reorderJob(fromIndex: number, toIndex: number): boolean {
    if (
      fromIndex < 0 ||
      fromIndex >= this.jobs.length ||
      toIndex < 0 ||
      toIndex >= this.jobs.length ||
      fromIndex === toIndex
    ) {
      return false;
    }
    const activeId = this.jobs[this.activeJobIndex]?.id;
    const [moved] = this.jobs.splice(fromIndex, 1);
    this.jobs.splice(toIndex, 0, moved);
    if (activeId) {
      const nextIdx = this.jobs.findIndex(j => j.id === activeId);
      if (nextIdx >= 0) this.activeJobIndex = nextIdx;
    }
    this.text = this.describeActive();
    this.persist();
    this.host.onChange();
    return true;
  }

  isActive(): boolean {
    return ['RUNNING', 'PAUSED_BATTLE', 'WAITING_TOOL_BUY', 'WALKING_TO_POINT'].includes(this.phase);
  }

  enqueue(spec: NewWorkJob): string {
    const job: WorkJob = {
      ...spec,
      id: `job-${Date.now()}-${++this.seq}`,
      doneCount: 0,
    } as WorkJob;

    if (!this.isActive()) {
      this.jobs = [job];
      this.activeJobIndex = 0;
      this.stopReason = null;
      this.boughtToolAttempted.clear();
      this.boughtToolAt.clear();
    } else {
      this.jobs.push(job);
    }
    this.dialogRetries = 0;
    this.openShopSentAt = 0;
    this.pending = null;
    this.navStartedKey = null;
    this.approachTries = null;
    this.skippedPoints.clear();
    this.token++;
    this.phase = 'RUNNING';
    this.text = this.describeActive();
    this.persist();
    this.host.onChange();
    this.scheduleStep(0);
    return job.id;
  }

  stop(reason: QueueStopReason = 'USER_STOPPED', detail?: string): void {
    if (this.phase === 'IDLE' && this.jobs.length === 0) return;
    this.token++;
    this.stepGen++;
    this.pending = null;
    this.navStartedKey = null;
    const st = this.host.state();
    const isViewed = !this.host.characterId || this.host.characterId === st.characterId;
    if (isViewed && this.host.navigator.isActive()) this.host.navigator.cancel();
    this.phase = reason === 'DONE_TARGET' ? 'DONE' : 'STOPPED';
    this.stopReason = reason;
    this.text = detail ?? `工作佇列停止：${stopReasonLabel(reason)}`;
    this.host.log(this.text, reason === 'DONE_TARGET' ? 'info' : 'warn');
    this.persist();
    this.host.onChange();
  }

  clear(): void {
    this.token++;
    this.stepGen++;
    this.pending = null;
    this.navStartedKey = null;
    this.jobs = [];
    this.activeJobIndex = 0;
    this.phase = 'IDLE';
    this.stopReason = null;
    this.text = '工作佇列：閒置';
    this.persist();
    this.host.onChange();
  }

  onMessage(m: PluginMessage): void {
    if (isEventMessage(m)) {
      const e = m.event;
      if (e.type === 'GAME_STARTED') {
        if (this.isActive()) {
          this.pending = null;
          this.navStartedKey = null;
          this.token++;
          this.scheduleStep(200);
        }
        return;
      }
      if (!this.isActive()) return;

      if (e.type === 'BATTLE_STARTED') {
        this.pending = null;
        this.navStartedKey = null;
        this.phase = 'PAUSED_BATTLE';
        this.text = '工作佇列暫停：戰鬥中';
        this.persist();
        this.host.onChange();
        return;
      }
      if (e.type === 'BATTLE_ENDED') {
        this.scheduleStep(450);
        return;
      }
      if (e.type === 'COMMAND_REJECTED' && this.pending && e.commandId === this.pending.commandId) {
        this.handleRejected(e.reasonCode, e.message);
        return;
      }
      if (e.type === 'COMMAND_COMPLETED' && this.pending && e.commandId === this.pending.commandId) {
        this.handleCompleted(e.outcome, e.code, e.message);
        return;
      }
      if (e.type === 'SHOP_OPENED') this.openShopSentAt = 0;
      if (
        e.type === 'DIALOG_OPENED' ||
        e.type === 'DIALOG_CLOSED' ||
        e.type === 'SHOP_OPENED' ||
        e.type === 'SHOP_CLOSED' ||
        e.type === 'LOCATION_CHANGED' ||
        e.type === 'INVENTORY_CHANGED' ||
        (this.navStartedKey && (e.type === 'COMMAND_COMPLETED' || e.type === 'COMMAND_REJECTED'))
      ) {
        if (!this.pending) {
          const delay = e.type === 'DIALOG_CLOSED' && this.phase === 'WAITING_TOOL_BUY' ? 150 : 10;
          this.scheduleStep(delay);
        }
      }
      return;
    }

    if (isCommandResultMessage(m) && this.pending && m.commandId === this.pending.commandId) {
      if (m.status === 'REJECTED') {
        this.handleRejected(m.reasonCode ?? 'CORE_REJECTED', m.message);
      }
      return;
    }

    if (isSnapshotMessage(m) && this.isActive()) {
      if (this.checkStopConditions(this.host.state())) return;
      if (!this.pending) this.scheduleStep(50);
    }
  }

  private checkStopConditions(st: FamilyState): boolean {
    const tgt = this.targetMember(st);
    if (!tgt) return false;
    if (this.stopConditions.stopOnBagFull && tgt.inventoryCount >= tgt.inventoryCap) {
      this.stop('BAG_FULL', '停止條件觸發：背包已滿');
      return true;
    }
    if (
      this.stopConditions.minSatiety !== null &&
      tgt.satiety <= this.stopConditions.minSatiety
    ) {
      this.stop('NO_STAMINA', `停止條件觸發：飽食度 ${tgt.satiety} ≤ ${this.stopConditions.minSatiety}`);
      return true;
    }
    return false;
  }

  private handleRejected(code: string, message?: string): void {
    const cur = this.pending;
    this.pending = null;
    if (!cur) return;

    if (code === 'GAME_BUSY' || code === 'GAME_NOT_READY' || code === 'IN_BATTLE') {
      this.scheduleStep(RETRY_MS);
      return;
    }

    if (
      (code === 'DIALOG_OPEN' || (code === 'OPTION_NOT_FOUND' && message?.includes('CLOSE_SHOP')))
      && this.dialogRetries < 3
    ) {
      this.dialogRetries += 1;
      const st = this.host.state();
      if (st.shop) {
        this.sendPending({ type: 'CHOOSE_DIALOG_OPTION', optionId: 'CLOSE_SHOP' }, '關閉殘留商店繼續工作', 'CLOSE_SHOP');
        return;
      }
      if (st.dialog) {
        this.sendPending({ type: 'CHOOSE_DIALOG_OPTION', optionId: 'CLOSE' }, '關閉殘留對話繼續工作', 'DIALOG');
        return;
      }
      this.host.send({ type: 'REQUEST_SNAPSHOT' }, '檢查殘留對話狀態');
      this.scheduleStep(300);
      return;
    }

    if (cur.role === 'WORK' && code === 'MISSING_TOOL') {
      const job = this.jobs[this.activeJobIndex];
      const toolId = job?.kind === 'GATHER' ? this.resolveToolId(job, this.host.state().snapshot) : undefined;
      if (toolId && !this.boughtToolAttempted.has(toolId)) {
        this.host.log(`缺少工具 (#${toolId})，嘗試前往商店購買`, 'info');
        this.scheduleStep(0);
        return;
      }
      this.stop('MISSING_TOOL', message ?? '缺少工作工具，無法繼續');
      return;
    }

    if (cur.role === 'WORK' && code === 'TOO_FAR') {
      const range = /需要\s*[≤<=]+\s*(\d+)\s*px/.exec(message ?? '');
      if (range) this.hostGatherRange = Number(range[1]);
      if (this.tooFarRetries < 3) {
        this.tooFarRetries += 1;
        this.forceClose = true;
        this.host.log(`宿主說離採集點太遠（${message ?? 'TOO_FAR'}），先走近再採`, 'info');
        this.scheduleStep(0);
        return;
      }
      this.stop('TOO_FAR', `工作停止（TOO_FAR）：走近後宿主仍說太遠：${message ?? code}`);
      return;
    }

    const mapped = mapRejectToStop(code);
    if (mapped) {
      this.stop(mapped, `工作停止（${mapped}）：${message ?? code}`);
      return;
    }

    if (cur.role === 'BUY_TOOL') {
      this.stop('SHOP_FAILED', `購買工具失敗：${message ?? code}`);
      return;
    }
    this.stop('NAV_FAILED', `指令被拒絕（${code}）：${message ?? ''}`);
  }

  private handleCompleted(outcome: string, code: string, message?: string): void {
    const cur = this.pending;
    this.pending = null;
    if (!cur) return;
    this.dialogRetries = 0;

    if (code === 'ENCOUNTER' || outcome === 'INTERRUPTED') {
      if (code === 'ENCOUNTER') {
        this.phase = 'PAUSED_BATTLE';
        this.text = '工作佇列暫停：遭遇戰鬥';
        this.persist();
        this.host.onChange();
        return;
      }
    }

    if (cur.role === 'WORK') {
      if (outcome === 'DONE') {
        const job = this.jobs[this.activeJobIndex];
        if (job) {
          job.doneCount += 1;
          this.forceClose = false;
          this.tooFarRetries = 0;
          this.text = this.describeActive();
          this.persist();
          this.host.onChange();
        }
        this.scheduleStep(30);
      } else {
        this.stop('UNKNOWN_RECIPE', message ?? `工作失敗：${code}`);
      }
      return;
    }

    if (cur.role === 'BUY_TOOL' && cur.toolId !== undefined) {
      this.boughtToolAttempted.add(cur.toolId);
      if (outcome === 'DONE') this.boughtToolAt.set(cur.toolId, Date.now());
    }

    if (cur.role === 'WALK' && code === 'BLOCKED') {
      this.stop('NAV_FAILED', `無法走到採集點：${message ?? 'BLOCKED'}`);
      return;
    }

    // DIALOG / CLOSE_SHOP / BUY_TOOL rely on React useEffect events (DIALOG_CLOSED, SHOP_OPENED,
    // SHOP_CLOSED, INVENTORY_CHANGED) arriving shortly after COMMAND_COMPLETED; allow time or wake on event.
    const waitMs = cur.role === 'DIALOG' || cur.role === 'CLOSE_SHOP' || cur.role === 'BUY_TOOL' ? 150 : 30;
    this.scheduleStep(waitMs);
  }

  private targetMember(st: FamilyState) {
    const targetId = this.host.characterId ?? st.characterId;
    const isViewed = !targetId || targetId === st.characterId;
    if (isViewed) {
      if (!st.snapshot || !st.character) return null;
      const invUsed =
        st.character.inventoryCount ?? st.inventory.reduce((sum, i) => sum + i.count, 0);
      return {
        isViewed: true,
        characterId: targetId ?? '',
        name: st.character.name ?? targetId ?? '',
        mapId: st.snapshot.mapId,
        x: st.character.x,
        y: st.character.y,
        inBattle: Boolean(st.battle || st.battleResult),
        inventory: st.inventory,
        inventoryCount: invUsed,
        inventoryCap: st.character.inventoryCap ?? 40,
        satiety: st.character.satiety ?? 100,
      };
    }
    const m = st.members.find(x => x.characterId === targetId);
    if (!m || !st.snapshot) return null;
    return {
      isViewed: false,
      characterId: m.characterId,
      name: m.name ?? m.characterId,
      mapId: m.mapId,
      x: m.x,
      y: m.y,
      inBattle: m.inBattle,
      inventory: m.inventory,
      inventoryCount: m.inventoryCount,
      inventoryCap: m.inventoryCap,
      satiety: m.satiety,
    };
  }

  private step(token: number): void {
    if (token !== this.token || !this.isActive()) return;
    if (this.pending) return;

    const st = this.host.state();
    if (!st.snapshot || st.phase !== 'PLAYING') return;
    const tgt = this.targetMember(st);
    if (!tgt) return;
    if (tgt.inBattle) {
      this.phase = 'PAUSED_BATTLE';
      this.text = tgt.isViewed && st.battleResult ? '工作佇列暫停：等待關閉戰鬥結算視窗' : '工作佇列暫停：戰鬥中';
      this.host.onChange();
      this.scheduleStep(RETRY_MS);
      return;
    }
    if (tgt.isViewed && st.location && st.snapshot.mapId !== st.location.mapId) {
      this.scheduleStep(100);
      return;
    }
    if (tgt.isViewed && this.navStartedKey) {
      if (this.host.navigator.getStatus().phase === 'FAILED') {
        this.stop('NAV_FAILED', this.host.navigator.getStatus().text);
        return;
      }
      if (this.host.navigator.isActive()) {
        return;
      }
      this.navStartedKey = null;
    }

    // Advance completed jobs
    while (this.activeJobIndex < this.jobs.length) {
      const j = this.jobs[this.activeJobIndex];
      if (j.kind === 'CRAFT' && j.doneCount >= j.targetCount) {
        this.activeJobIndex++;
        continue;
      }
      if (j.kind === 'GATHER' && j.targetCount !== 'UNTIL_FULL' && j.doneCount >= j.targetCount) {
        this.activeJobIndex++;
        continue;
      }
      break;
    }

    const job = this.jobs[this.activeJobIndex];
    if (!job) {
      this.stop('DONE_TARGET', '工作佇列全部目標已完成');
      return;
    }

    if (this.checkStopConditions(st)) return;

    if (job.kind === 'CRAFT') {
      if (tgt.isViewed && st.shop) {
        this.sendPending({ type: 'CHOOSE_DIALOG_OPTION', optionId: 'CLOSE_SHOP' }, '關閉商店', 'CLOSE_SHOP');
        return;
      }
      if (tgt.isViewed && st.dialog) {
        this.sendPending({ type: 'CHOOSE_DIALOG_OPTION', optionId: 'CLOSE' }, '結束對話', 'DIALOG');
        return;
      }
      this.phase = 'RUNNING';
      this.text = this.describeActive();
      this.persist();
      this.host.onChange();
      this.sendPending(
        { type: 'WORK_ONCE', recipeId: job.recipeId },
        `[${tgt.name}] 製作：${job.recipeName} (${job.doneCount + 1}/${job.targetCount})`,
        'WORK'
      );
      return;
    }

    // GATHER job
    const snap = st.snapshot;
    const toolId = this.resolveToolId(job, snap);
    const hasTool = !toolId || tgt.inventory.some(i => i.itemId === toolId && i.count > 0);
    if (toolId && !hasTool) {
      if (!tgt.isViewed) {
        // 買工具要走到商店、開對話，背景角色做不到：把視角暫時借給它，買好再還。
        if (this.host.requestView && this.viewRequests < MAX_VIEW_REQUESTS) {
          this.viewRequests += 1;
          this.phase = 'WAITING_TOOL_BUY';
          this.text = `【${tgt.name}】缺少工具 #${toolId}，切換視角去買`;
          this.persist();
          this.host.onChange();
          this.host.requestView(tgt.characterId);
          this.scheduleStep(1500);
          return;
        }
        this.stop('MISSING_TOOL', `背景角色【${tgt.name}】缺少工具 #${toolId}，無法切換視角購置，請存倉領取`);
        return;
      }
      const boughtAt = this.boughtToolAt.get(toolId);
      if (boughtAt !== undefined) {
        if (st.shop) {
          this.sendPending({ type: 'CHOOSE_DIALOG_OPTION', optionId: 'CLOSE_SHOP' }, '關閉商店等待背包更新', 'CLOSE_SHOP');
          return;
        }
        if (Date.now() - boughtAt < 3000) {
          this.scheduleStep(100);
          return;
        }
        this.stop('MISSING_TOOL', `已購買工具 #${toolId} 但背包仍未顯示`);
        return;
      }
      this.stepBuyTool(token, st, snap, toolId, job.requiredToolName ?? `工具 #${toolId}`);
      return;
    }

    // Have tool: ensure shop/dialog are closed before walking/working (foreground only)
    if (tgt.isViewed && st.shop) {
      this.sendPending({ type: 'CHOOSE_DIALOG_OPTION', optionId: 'CLOSE_SHOP' }, '關閉商店繼續工作', 'CLOSE_SHOP');
      return;
    }
    if (tgt.isViewed && st.dialog) {
      this.sendPending({ type: 'CHOOSE_DIALOG_OPTION', optionId: 'CLOSE' }, '結束對話繼續工作', 'DIALOG');
      return;
    }

    // Find target gather point (background prioritizes member's own mapId)
    const pt = this.pickGatherPoint(job, snap, tgt.x, tgt.y, tgt.mapId);
    if (!pt) {
      const why = this.skippedPoints.size > 0
        ? `【${job.targetName}】的採集點都走不過`
        : `找不到【${job.targetName}】的採集點`;
      this.stop('TOO_FAR', why);
      return;
    }

    const ptMap = pt.mapId ?? snap.mapId;
    if (ptMap !== tgt.mapId) {
      if (!tgt.isViewed) {
        this.stop('TOO_FAR', `背景角色【${tgt.name}】目前在 ${tgt.mapId}，無法遠端跨圖到 ${pt.mapName ?? ptMap}`);
        return;
      }
      const key = `map:${ptMap}`;
      if (!this.host.navigator.isActive() || this.navStartedKey !== key) {
        this.navStartedKey = key;
        this.phase = 'WALKING_TO_POINT';
        this.text = `跨圖前往採集點地圖：${pt.mapName ?? ptMap}`;
        this.persist();
        this.host.onChange();
        const err = this.host.navigator.go({ kind: 'MAP', mapId: ptMap, name: pt.mapName ?? ptMap });
        if (err) this.stop('NAV_FAILED', err);
      }
      return;
    }

    const dist = Math.hypot(tgt.x - pt.x, tgt.y - pt.y);
    const range = this.hostGatherRange ?? GATHER_APPROACH_DIST;
    const maxAllowedDist = this.forceClose ? GATHER_CLOSE_DIST : Math.max(GATHER_CLOSE_DIST, range - GATHER_RANGE_MARGIN);
    if (dist > maxAllowedDist) {
      if (!tgt.isViewed) {
        // 背景角色不能走路（宿主只讓視角中的角色走）：把視角暫時切給它，走近後由派工把視角還給前景工作。
        if (this.host.requestView && this.viewRequests < MAX_VIEW_REQUESTS) {
          this.viewRequests += 1;
          this.phase = 'WALKING_TO_POINT';
          this.text = `【${tgt.name}】離【${pt.name}】太遠 (${Math.round(dist)}px)，切換視角走近`;
          this.persist();
          this.host.onChange();
          this.host.requestView(tgt.characterId);
          this.scheduleStep(1500);
          return;
        }
        this.stop('TOO_FAR', `背景角色【${tgt.name}】離【${pt.name}】太遠 (${Math.round(dist)}px，需要 ≤ ${range}px)，無法切換視角走近`);
        return;
      }
      const prior = this.approachTries;
      const same = prior !== null && prior.pointId === pt.id && Math.abs(prior.dist - dist) <= 8;
      const tries = same && prior ? prior.tries + 1 : 1;
      this.approachTries = { pointId: pt.id, dist, tries };
      if (tries >= 3) {
        this.skippedPoints.add(pt.id);
        this.approachTries = null;
        this.phase = 'RUNNING';
        this.host.log(`採集點【${pt.name}】走不過（仍距離 ${Math.round(dist)}px），改試下一個`, 'info');
        this.scheduleStep(0);
        return;
      }
      this.phase = 'WALKING_TO_POINT';
      this.text = `走到採集點：${pt.name}`;
      this.persist();
      this.host.onChange();
      this.sendPending({ type: 'WALK_TO', mapId: snap.mapId, x: pt.x, y: pt.y }, `走到 ${pt.name}`, 'WALK');
      return;
    }
    this.approachTries = null;
    this.viewRequests = 0;

    this.phase = 'RUNNING';
    this.text = this.describeActive();
    this.persist();
    this.host.onChange();
    this.sendPending(
      {
        type: 'WORK_ONCE',
        skillId: job.skillId,
        ...(job.targetItemId !== undefined ? { targetItemId: job.targetItemId } : {}),
      },
      `[${tgt.name}] 採集：${job.targetName}${job.targetCount === 'UNTIL_FULL' ? ` (${job.doneCount}/到滿)` : ` (${job.doneCount + 1}/${job.targetCount})`}`,
      'WORK'
    );
  }

  private stepBuyTool(token: number, st: FamilyState, snap: SceneSnapshot, toolId: number, toolName: string): void {
    this.phase = 'WAITING_TOOL_BUY';
    this.text = `自動補買工具：${toolName} (#${toolId})`;
    this.persist();
    this.host.onChange();

    if (st.shop) {
      const good = st.shop.goods.find(g => g.itemId === toolId);
      if (!good) {
        this.sendPending({ type: 'CHOOSE_DIALOG_OPTION', optionId: 'CLOSE_SHOP' }, '離開沒有該工具的商店', 'CLOSE_SHOP');
        return;
      }
      if (st.character && st.character.gold < good.price) {
        this.stop('INSUFFICIENT_GOLD', `金錢不足購買【${toolName}】（需要 ${good.price}）`);
        return;
      }
      this.sendPending({ type: 'BUY_ITEM', itemId: toolId, count: 1 }, `自動購買工具：${good.name ?? toolName}`, 'BUY_TOOL', toolId);
      return;
    }

    if (st.dialog) {
      const openOpt = st.dialog.options.find(o => o.id === 'OPEN_SHOP');
      if (openOpt) {
        if (Date.now() - this.openShopSentAt < 1000) {
          this.scheduleStep(100);
          return;
        }
        this.openShopSentAt = Date.now();
        this.sendPending({ type: 'CHOOSE_DIALOG_OPTION', optionId: 'OPEN_SHOP' }, `開啟商店購買 ${toolName}`, 'DIALOG');
      } else {
        this.sendPending({ type: 'CHOOSE_DIALOG_OPTION', optionId: 'CLOSE' }, '關閉無關對話', 'DIALOG');
      }
      return;
    }

    const shop = snap.shops.find(s => s.goods.some(g => g.itemId === toolId));
    if (shop && st.character) {
      const npc = snap.npcs.find(n => n.id === shop.npcId || n.name === shop.npcName);
      if (npc) {
        const dist = Math.hypot(st.character.x - npc.x, st.character.y - npc.y);
        if (dist < TALK_NEAR) {
          this.sendPending({ type: 'TALK_TO_NPC', npcId: npc.id }, `向 ${npc.name} 購買 ${toolName}`, 'TALK');
          return;
        }
        const key = `buy:${npc.id}`;
        if (!this.host.navigator.isActive() || this.navStartedKey !== key) {
          this.navStartedKey = key;
          const err = this.host.navigator.go({ kind: 'NPC', query: npc.name, talk: true });
          if (err) this.stop('MISSING_TOOL', `無法前往商店購買 ${toolName}：${err}`);
        }
        return;
      }
    }

    // Fallback: try known shopkeeper '收破爛阿利' across maps
    if (snap.mapId !== '10001') {
      const key = 'buy:10001';
      if (!this.host.navigator.isActive() || this.navStartedKey !== key) {
        this.navStartedKey = key;
        const err = this.host.navigator.go({ kind: 'NPC', query: '收破爛阿利', talk: true });
        if (!err) return;
      } else {
        return;
      }
    }

    this.stop('MISSING_TOOL', `缺少工具【${toolName}】(#${toolId})，本圖與已知商店未販售`);
    void token;
  }

  private resolveToolId(job: Extract<WorkJob, { kind: 'GATHER' }>, snap: SceneSnapshot | null): number | undefined {
    if (job.requiredToolItemId) return job.requiredToolItemId;
    if (!snap) return undefined;
    const all = [...snap.gatherPoints.points, ...(snap.nearbyGatherPoints ?? [])];
    const hit = all.find(
      p => p.skillId === job.skillId && (job.targetItemId === undefined || p.materials?.some(m => m.itemId === job.targetItemId))
    );
    return hit?.requiredToolItemId ?? undefined;
  }

  private pickGatherPoint(job: Extract<WorkJob, { kind: 'GATHER' }>, snap: SceneSnapshot, px: number, py: number, memberMapId?: string): SnapshotGatherPoint | null {
    const filter = (pts: SnapshotGatherPoint[]) =>
      pts.filter(p =>
        !this.skippedPoints.has(p.id)
        && p.skillId === job.skillId
        && (job.targetItemId === undefined || p.materials?.some(m => m.itemId === job.targetItemId)));
    const allPts = [...snap.gatherPoints.points, ...(snap.nearbyGatherPoints ?? [])];
    const onMemberMap = memberMapId
      ? filter(allPts).filter(p => (p.mapId ?? snap.mapId) === memberMapId)
      : filter(snap.gatherPoints.points);
    if (onMemberMap.length > 0) {
      return onMemberMap.slice().sort((a, b) => Math.hypot(px - a.x, py - a.y) - Math.hypot(px - b.x, py - b.y))[0];
    }
    const nearby = filter(snap.nearbyGatherPoints ?? []);
    if (nearby.length > 0) return nearby[0];
    return null;
  }

  private scheduleStep(delayMs: number): void {
    const token = this.token;
    const gen = ++this.stepGen;
    this.host.after(delayMs, () => {
      if (token === this.token && gen === this.stepGen) this.step(token);
    });
  }

  private sendPending(
    command: PluginCommand,
    label: string,
    role: NonNullable<WorkQueue['pending']>['role'],
    toolId?: number
  ): void {
    this.stepGen++;
    const expect = command.type === 'WALK_TO' ? 'ARRIVED' : command.type === 'TALK_TO_NPC' ? 'DIALOG_OPENED' : 'DONE';
    const commandId = this.host.send(command, label, expect);
    if (commandId) {
      this.pending = { commandId, role, ...(toolId !== undefined ? { toolId } : {}) };
    }
  }

  private describeActive(): string {
    const job = this.jobs[this.activeJobIndex];
    if (!job) return '工作佇列：閒置';
    if (job.kind === 'GATHER') {
      const target = job.targetCount === 'UNTIL_FULL' ? '到滿' : String(job.targetCount);
      return `採集中：${job.targetName}（${job.doneCount}/${target}）`;
    }
    return `製作中：${job.recipeName}（${job.doneCount}/${job.targetCount}）`;
  }

  private persist(): void {
    try {
      this.storage?.setItem(
        this.storageKey,
        JSON.stringify({
          jobs: this.jobs,
          activeJobIndex: this.activeJobIndex,
          phase: this.phase,
          stopReason: this.stopReason,
          text: this.text,
          stopConditions: this.stopConditions,
        })
      );
    } catch {
      /* ignore storage quota */
    }
  }

  private load(): void {
    try {
      const raw = this.storage?.getItem(this.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<QueueStatus>;
      if (Array.isArray(parsed.jobs)) this.jobs = parsed.jobs;
      if (typeof parsed.activeJobIndex === 'number') this.activeJobIndex = parsed.activeJobIndex;
      if (typeof parsed.phase === 'string') this.phase = parsed.phase as QueuePhase;
      this.stopReason = parsed.stopReason ?? null;
      if (typeof parsed.text === 'string') this.text = parsed.text;
      if (parsed.stopConditions && typeof parsed.stopConditions === 'object') {
        this.stopConditions = {
          stopOnBagFull: Boolean(parsed.stopConditions.stopOnBagFull),
          minSatiety:
            typeof parsed.stopConditions.minSatiety === 'number'
              ? parsed.stopConditions.minSatiety
              : null,
        };
      }
    } catch {
      /* ignore corrupt storage */
    }
  }
}
