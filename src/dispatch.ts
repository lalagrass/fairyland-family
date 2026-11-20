import type { QueueStatus, QueueStopReason } from './queue';
import { stopReasonLabel } from './queue';
import type { QuestChainStatus } from './automation/modules/questChainModule';

/**
 * F2 派工：每個角色各自一份工作指派（採集／任務鏈／新手循環／待機）、停止條件與停工原因。
 *
 * 宿主限制（fairyland command_router）：只有採集（WORK_ONCE）可以替背景角色執行；
 * 走路、對話、買賣、任務、戰鬥都要該角色在「視角中」。所以：
 * - 採集可以同時分給多個角色，各走自己的 WorkQueue。
 * - 任務鏈／新手循環是前景工作，同一時間只能有一個角色在跑；它的擁有者離開視角就暫停（不送任何指令）。
 */

export type DispatchKind = 'IDLE' | 'GATHER' | 'QUEST_CHAIN' | 'NOVICE_LOOP';
export type DispatchPhase = 'IDLE' | 'RUNNING' | 'WAITING_VIEW' | 'STOPPED' | 'DONE';

export const DISPATCH_KIND_LABEL: Record<DispatchKind, string> = {
  IDLE: '待機',
  GATHER: '採集',
  QUEST_CHAIN: '任務鏈',
  NOVICE_LOOP: '新手循環',
};

export const DISPATCH_PHASE_LABEL: Record<DispatchPhase, string> = {
  IDLE: '待機',
  RUNNING: '進行中',
  WAITING_VIEW: '等待視角',
  STOPPED: '已停工',
  DONE: '已完成',
};

export interface GatherSpec {
  skillId: number;
  skillName: string;
  targetItemId?: number;
  targetName: string;
  count: number | 'UNTIL_FULL';
  requiredToolItemId?: number;
  requiredToolName?: string;
}

export interface DispatchStop {
  /** 派工後跑滿這麼多分鐘就停（牆鐘時間，重開分頁後照樣算）。null＝不限。 */
  maxMinutes: number | null;
  stopOnBagFull: boolean;
  /** 飽食度低於或等於此值就停。null＝不限。 */
  minSatiety: number | null;
  /** 任務鏈：等級達到就停。 */
  targetLevel?: number | null;
}

export interface DispatchSpec {
  kind: DispatchKind;
  gather?: GatherSpec;
  stop: DispatchStop;
}

export interface DispatchStopInfo {
  code: string;
  text: string;
  at: number;
}

export interface DispatchRecord extends DispatchSpec {
  characterId: string;
  phase: DispatchPhase;
  startedAt: number | null;
  /** 絕對截止時間（毫秒）。存檔後重開仍然有效。 */
  deadlineAt: number | null;
  /** 最近一次停工／暫停的原因。 */
  stopped: DispatchStopInfo | null;
  /** 目前狀態說明（例如「等待視角」「採集中：青銅礦 2/5」）。 */
  text: string;
}

export interface DispatchRecap {
  characterId: string;
  name: string;
  kind: DispatchKind;
  kindLabel: string;
  phase: DispatchPhase;
  phaseLabel: string;
  /** 停工原因；進行中為 null。 */
  reason: string | null;
  at: number | null;
  line: string;
}

interface KvStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

const STORAGE_KEY = 'fairyland_family:dispatch:v1';

export function defaultStop(): DispatchStop {
  return { maxMinutes: null, stopOnBagFull: false, minSatiety: null, targetLevel: null };
}

/** 每個角色一份派工紀錄（存在 localStorage；沒傳 storage 時只存記憶體）。 */
export class DispatchStore {
  private map = new Map<string, DispatchRecord>();

  constructor(private storage: KvStorage | null = null) {
    this.load();
  }

  get(characterId: string): DispatchRecord | undefined {
    const r = this.map.get(characterId);
    return r ? clone(r) : undefined;
  }

  set(rec: DispatchRecord): void {
    this.map.set(rec.characterId, clone(rec));
    this.save();
  }

  all(): DispatchRecord[] {
    return [...this.map.values()].map(clone);
  }

  private load(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, DispatchRecord>;
      for (const [id, r] of Object.entries(parsed)) {
        if (!id || !r || typeof r !== 'object' || r.characterId !== id) continue;
        if (!(r.kind in DISPATCH_KIND_LABEL) || !(r.phase in DISPATCH_PHASE_LABEL)) continue;
        // 重開後前景工作沒有任何執行中的程式狀態，先回到「等待視角」，等視角與快照到位再接著跑。
        const foreground = r.kind === 'QUEST_CHAIN' || r.kind === 'NOVICE_LOOP';
        const phase: DispatchPhase = foreground && r.phase === 'RUNNING' ? 'WAITING_VIEW' : r.phase;
        this.map.set(id, {
          ...r,
          phase,
          stop: { ...defaultStop(), ...(r.stop ?? {}) },
          stopped: r.stopped ?? null,
          text: foreground && r.phase === 'RUNNING' ? '重開後恢復中：等待視角與快照' : (r.text ?? ''),
        });
      }
    } catch {
      /* 損毀的舊資料直接忽略 */
    }
  }

  private save(): void {
    if (!this.storage) return;
    try {
      const obj: Record<string, DispatchRecord> = {};
      for (const [k, v] of this.map) obj[k] = v;
      this.storage.setItem(STORAGE_KEY, JSON.stringify(obj));
    } catch {
      /* 儲存空間滿了就忽略 */
    }
  }
}

function clone(r: DispatchRecord): DispatchRecord {
  return {
    ...r,
    ...(r.gather ? { gather: { ...r.gather } } : {}),
    stop: { ...r.stop },
    stopped: r.stopped ? { ...r.stopped } : null,
  };
}

/** 任務鏈（chain）停止碼 → 派工停工原因。USER 代表被人或另一個派工中斷。 */
export function chainStopToDispatch(status: QuestChainStatus): { phase: 'STOPPED' | 'DONE'; code: string; text: string } {
  const code = status.stopReason ?? 'USER';
  const done = code === 'QUESTS_DONE';
  return { phase: done ? 'DONE' : 'STOPPED', code, text: status.text };
}

export function queueStopToDispatch(
  status: QueueStatus,
): { phase: 'STOPPED' | 'DONE'; code: QueueStopReason | string; text: string } {
  const code = status.stopReason ?? 'USER_STOPPED';
  const text = status.text || `工作佇列停止：${stopReasonLabel(code as QueueStopReason)}`;
  return { phase: code === 'DONE_TARGET' ? 'DONE' : 'STOPPED', code, text };
}

export interface DispatchHost {
  now(): number;
  running(): boolean;
  viewedId(): string | null;
  /** 視角角色的快照是否真的屬於該角色（切換視角後、新快照到達前為 false）。 */
  snapshotReady(id: string): boolean;
  nameOf(id: string): string;
  knownCharacterIds(): string[];

  queueStatus(id: string): QueueStatus;
  queueActive(id: string): boolean;
  startGather(id: string, g: GatherSpec, stop: DispatchStop): void;
  stopQueue(id: string, reason: QueueStopReason, text: string): void;

  chainActive(): boolean;
  chainOwner(): string | null;
  chainStatus(): QuestChainStatus;
  /** 以 id 為擁有者啟動任務鏈；回傳錯誤文字或 null。 */
  startChain(id: string, loopOnly: boolean, stop: DispatchStop, remainingMs: number | null): string | null;
  stopChain(text: string): void;

  switchView(id: string): void;
  requestSnapshot(): void;
  log(text: string, level: 'info' | 'warn' | 'error', characterId: string): void;
  onChange(): void;
}

/**
 * 派工邏輯：指派、停止、逐拍檢查（時限、佇列／任務鏈結束原因、視角擁有權、重開後恢復）。
 * 每個動作都帶 characterId；不會碰別的角色的佇列。
 */
export class CharacterDispatcher {
  private lastSnapshotRequestAt = 0;

  constructor(
    private host: DispatchHost,
    readonly store: DispatchStore,
  ) {}

  records(): DispatchRecord[] {
    return this.store.all();
  }

  recordFor(id: string): DispatchRecord | undefined {
    return this.store.get(id);
  }

  /** 指派（取代這個角色原本的派工）。回傳錯誤文字或 null。 */
  assign(id: string, spec: DispatchSpec): string | null {
    if (!this.host.knownCharacterIds().includes(id)) return `找不到家族成員：${id}`;
    const stop = normalizeStop(spec.stop);
    if (spec.kind === 'IDLE') {
      this.stop(id, 'USER_STOPPED', '改為待機');
      const rec = this.store.get(id);
      if (rec) this.store.set({ ...rec, kind: 'IDLE', phase: 'IDLE', text: '待機', deadlineAt: null, startedAt: null });
      this.host.onChange();
      return null;
    }
    if (spec.kind === 'GATHER' && !spec.gather) return '採集派工需要指定採集目標';
    const foreground = spec.kind === 'QUEST_CHAIN' || spec.kind === 'NOVICE_LOOP';
    if (foreground && this.host.chainActive() && this.host.chainOwner() !== id) {
      const owner = this.host.chainOwner();
      return `【${owner ? this.host.nameOf(owner) : '另一位角色'}】正在跑任務鏈（前景工作），一次只能有一位；請先停止它`;
    }

    // 取代舊派工：只收掉這個角色自己的東西。
    this.releaseJob(id, '被新的派工取代');

    const now = this.host.now();
    const rec: DispatchRecord = {
      characterId: id,
      kind: spec.kind,
      ...(spec.gather ? { gather: { ...spec.gather } } : {}),
      stop,
      phase: 'RUNNING',
      startedAt: now,
      deadlineAt: stop.maxMinutes !== null ? now + stop.maxMinutes * 60_000 : null,
      stopped: null,
      text: `${DISPATCH_KIND_LABEL[spec.kind]}：開始`,
    };
    const name = this.host.nameOf(id);
    if (spec.kind === 'GATHER') {
      this.store.set(rec);
      this.host.startGather(id, spec.gather!, stop);
      this.host.log(`【${name}】派工：採集 ${spec.gather!.targetName}`, 'info', id);
    } else if (this.host.viewedId() === id && this.host.snapshotReady(id)) {
      this.store.set(rec);
      const err = this.startForeground(rec);
      if (err) {
        this.store.set({ ...rec, phase: 'STOPPED', stopped: { code: 'START_FAILED', text: err, at: now }, text: err });
        this.host.log(`【${name}】派工失敗：${err}`, 'warn', id);
        this.host.onChange();
        return err;
      }
      this.host.log(`【${name}】派工：${DISPATCH_KIND_LABEL[spec.kind]}`, 'info', id);
    } else {
      this.store.set({ ...rec, phase: 'WAITING_VIEW', text: '等待視角：切換到此角色後開始' });
      this.host.log(`【${name}】派工：${DISPATCH_KIND_LABEL[spec.kind]}（等待視角）`, 'info', id);
      if (this.host.running() && this.host.viewedId() !== id) this.host.switchView(id);
    }
    this.host.onChange();
    return null;
  }

  /** 停止這個角色的派工。已經是停工狀態就不重複寫。 */
  stop(id: string, code = 'USER_STOPPED', text = '玩家停止派工'): void {
    const rec = this.store.get(id);
    this.releaseJob(id, text);
    if (!rec || rec.phase === 'IDLE' || rec.phase === 'STOPPED' || rec.phase === 'DONE') {
      this.host.onChange();
      return;
    }
    this.finish(rec, 'STOPPED', code, text);
  }

  /** 前景擁有權檢查：任務鏈擁有者離開視角就立刻暫停，不再送任何指令。要在處理訊息之前呼叫。 */
  enforceView(): void {
    if (!this.host.chainActive()) return;
    const owner = this.host.chainOwner();
    if (!owner || owner === this.host.viewedId()) return;
    this.host.stopChain('視角已切換，任務鏈暫停');
    const rec = this.store.get(owner);
    if (rec && rec.phase === 'RUNNING') this.pauseForView(rec, '視角已切換，任務鏈暫停');
  }

  tick(): void {
    this.enforceView();
    this.adoptUntracked();
    const now = this.host.now();
    for (const rec of this.store.all()) {
      if (rec.phase === 'RUNNING' || rec.phase === 'WAITING_VIEW') {
        if (rec.deadlineAt !== null && now >= rec.deadlineAt) {
          this.releaseJob(rec.characterId, '時間到');
          this.finish(rec, 'STOPPED', 'TIME_UP', `停止條件觸發：時間到（已跑滿 ${rec.stop.maxMinutes} 分鐘）`);
          continue;
        }
      }
      if (rec.kind === 'GATHER' && rec.phase === 'RUNNING') this.watchGather(rec);
      else if ((rec.kind === 'QUEST_CHAIN' || rec.kind === 'NOVICE_LOOP') && rec.phase === 'RUNNING') this.watchChain(rec);
      else if (rec.phase === 'WAITING_VIEW') this.tryResume(rec);
    }
  }

  recaps(): DispatchRecap[] {
    const out: DispatchRecap[] = [];
    for (const rec of this.store.all()) {
      if (rec.kind === 'IDLE' && !rec.stopped) continue;
      const name = this.host.nameOf(rec.characterId);
      const reason = rec.phase === 'RUNNING' || rec.phase === 'IDLE' ? null : rec.stopped?.text ?? rec.text;
      out.push({
        characterId: rec.characterId,
        name,
        kind: rec.kind,
        kindLabel: DISPATCH_KIND_LABEL[rec.kind],
        phase: rec.phase,
        phaseLabel: DISPATCH_PHASE_LABEL[rec.phase],
        reason,
        at: rec.stopped?.at ?? null,
        line: reason
          ? `【${name}】${DISPATCH_KIND_LABEL[rec.kind]}${DISPATCH_PHASE_LABEL[rec.phase]}：${reason}`
          : `【${name}】${DISPATCH_KIND_LABEL[rec.kind]}進行中：${rec.text}`,
      });
    }
    return out;
  }

  // ───── 內部 ─────

  private startForeground(rec: DispatchRecord): string | null {
    const remaining = rec.deadlineAt !== null ? Math.max(1000, rec.deadlineAt - this.host.now()) : null;
    return this.host.startChain(rec.characterId, rec.kind === 'NOVICE_LOOP', rec.stop, remaining);
  }

  /** 這個角色自己的工作全部收掉（佇列、前景任務鏈），不碰別人。 */
  private releaseJob(id: string, text: string): void {
    if (this.host.queueActive(id)) this.host.stopQueue(id, 'USER_STOPPED', text);
    if (this.host.chainActive() && this.host.chainOwner() === id) this.host.stopChain(text);
  }

  private finish(rec: DispatchRecord, phase: 'STOPPED' | 'DONE', code: string, text: string): void {
    const now = this.host.now();
    this.store.set({ ...rec, phase, stopped: { code, text, at: now }, text });
    this.host.log(`【${this.host.nameOf(rec.characterId)}】${DISPATCH_KIND_LABEL[rec.kind]}${phase === 'DONE' ? '完成' : '停工'}：${text}`, phase === 'DONE' ? 'info' : 'warn', rec.characterId);
    this.host.onChange();
  }

  private pauseForView(rec: DispatchRecord, text: string): void {
    const now = this.host.now();
    this.store.set({ ...rec, phase: 'WAITING_VIEW', stopped: { code: 'VIEW_SWITCHED', text, at: now }, text: `等待視角：${text}` });
    this.host.log(`【${this.host.nameOf(rec.characterId)}】${DISPATCH_KIND_LABEL[rec.kind]}暫停：${text}`, 'warn', rec.characterId);
    this.host.onChange();
  }

  private watchGather(rec: DispatchRecord): void {
    const q = this.host.queueStatus(rec.characterId);
    if (q.phase === 'STOPPED' || q.phase === 'DONE') {
      const r = queueStopToDispatch(q);
      this.finish(rec, r.phase, String(r.code), r.text);
      return;
    }
    if (q.text && q.text !== rec.text) this.store.set({ ...rec, text: q.text });
  }

  private watchChain(rec: DispatchRecord): void {
    if (this.host.chainActive() && this.host.chainOwner() === rec.characterId) {
      const t = this.host.chainStatus().text;
      if (t !== rec.text) this.store.set({ ...rec, text: t });
      return;
    }
    // 任務鏈不在跑了（結束或被別的操作停掉）。
    const r = chainStopToDispatch(this.host.chainStatus());
    this.finish(rec, r.phase, r.code, r.text);
  }

  private tryResume(rec: DispatchRecord): void {
    const id = rec.characterId;
    if (rec.kind === 'GATHER' || rec.kind === 'IDLE') return;
    if (!this.host.running()) return;
    if (this.host.chainActive() && this.host.chainOwner() !== id) return;
    if (this.host.viewedId() !== id) return;
    if (!this.host.snapshotReady(id)) {
      const now = this.host.now();
      if (now - this.lastSnapshotRequestAt > 2000) {
        this.lastSnapshotRequestAt = now;
        this.host.requestSnapshot();
      }
      return;
    }
    const err = this.startForeground(rec);
    if (err) {
      if (rec.text !== `等待視角：${err}`) this.store.set({ ...rec, text: `等待視角：${err}` });
      return;
    }
    this.store.set({ ...rec, phase: 'RUNNING', text: `${DISPATCH_KIND_LABEL[rec.kind]}：已恢復` });
    this.host.log(`【${this.host.nameOf(id)}】${DISPATCH_KIND_LABEL[rec.kind]}恢復`, 'info', id);
    this.host.onChange();
  }

  /** 玩家用舊的文字指令或按鈕直接開了佇列／任務鏈：補一筆派工紀錄，讓停工原因一樣會被記下來。 */
  private adoptUntracked(): void {
    for (const id of this.host.knownCharacterIds()) {
      const rec = this.store.get(id);
      const live = !rec || rec.phase === 'IDLE' || rec.phase === 'STOPPED' || rec.phase === 'DONE';
      if (!live) continue;
      if (this.host.queueActive(id)) {
        const q = this.host.queueStatus(id);
        const job = q.jobs[q.activeJobIndex];
        const gather = job && job.kind === 'GATHER'
          ? {
              skillId: job.skillId,
              skillName: job.skillName,
              ...(job.targetItemId !== undefined ? { targetItemId: job.targetItemId } : {}),
              targetName: job.targetName,
              count: job.targetCount,
            }
          : undefined;
        this.store.set({
          characterId: id,
          kind: 'GATHER',
          ...(gather ? { gather } : {}),
          stop: { ...defaultStop(), stopOnBagFull: Boolean(q.stopConditions?.stopOnBagFull), minSatiety: q.stopConditions?.minSatiety ?? null },
          phase: 'RUNNING',
          startedAt: this.host.now(),
          deadlineAt: null,
          stopped: null,
          text: q.text,
        });
      } else if (this.host.chainActive() && this.host.chainOwner() === id) {
        this.store.set({
          characterId: id,
          kind: this.host.chainStatus().config.loopOnly ? 'NOVICE_LOOP' : 'QUEST_CHAIN',
          stop: defaultStop(),
          phase: 'RUNNING',
          startedAt: this.host.now(),
          deadlineAt: null,
          stopped: null,
          text: this.host.chainStatus().text,
        });
      }
    }
  }
}

function normalizeStop(s: Partial<DispatchStop> | undefined): DispatchStop {
  const m = s?.maxMinutes;
  const sat = s?.minSatiety;
  const lv = s?.targetLevel;
  return {
    maxMinutes: typeof m === 'number' && Number.isFinite(m) && m > 0 ? m : null,
    stopOnBagFull: Boolean(s?.stopOnBagFull),
    minSatiety: typeof sat === 'number' && Number.isFinite(sat) ? Math.max(0, Math.min(99, Math.round(sat))) : null,
    targetLevel: typeof lv === 'number' && Number.isFinite(lv) && lv > 0 ? Math.round(lv) : null,
  };
}
