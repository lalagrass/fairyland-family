import type { QueueStatus, QueueStopReason } from './queue';
import { stopReasonLabel } from './queue';
import type { QuestChainStatus } from './automation/modules/questChainModule';

/**
 * F2／F8 派工：每個角色各自一份工作指派（採集／任務鏈／新手循環／待機）、停止條件與停工原因。
 *
 * F8（FX17 之後）：宿主的背景角色也能走路、對話、接交任務與戰鬥，所以
 * - 採集與任務鏈都可以同時分給多個角色；任務鏈各跑自己的派工通道（`lanes.ts`），指令直接送給該角色，視角不動。
 * - 同一件任務不同時派給兩人：任務鏈挑任務時跳過別人正在做的那件。
 * - 宿主停止或角色不在名冊（離線）時，任務鏈暫停（`PAUSED`），派工紀錄保留；恢復後用剩下的時限接著跑。
 */

export type DispatchKind = 'IDLE' | 'GATHER' | 'QUEST_CHAIN' | 'NOVICE_LOOP';
/** `WAITING_VIEW` 只出現在 F8 之前的存檔；讀進來會改成 `PAUSED`。 */
export type DispatchPhase = 'IDLE' | 'RUNNING' | 'PAUSED' | 'WAITING_VIEW' | 'STOPPED' | 'DONE';

export const DISPATCH_KIND_LABEL: Record<DispatchKind, string> = {
  IDLE: '待機',
  GATHER: '採集',
  QUEST_CHAIN: '任務鏈',
  NOVICE_LOOP: '新手循環',
};

export const DISPATCH_PHASE_LABEL: Record<DispatchPhase, string> = {
  IDLE: '待機',
  RUNNING: '進行中',
  PAUSED: '暫停（佇列保留）',
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
  /** 任務鏈／新手循環的宿主區域；null 或舊存檔未指定＝不限。 */
  regionId?: string | null;
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
        // 重開後任務鏈沒有任何執行中的程式狀態，先暫停，等宿主與這位角色的快照到位再接著跑。
        // F8 之前的「等待視角」存檔也一樣改成暫停（不再需要切視角）。
        const foreground = r.kind === 'QUEST_CHAIN' || r.kind === 'NOVICE_LOOP';
        const resume = foreground && (r.phase === 'RUNNING' || r.phase === 'WAITING_VIEW' || r.phase === 'PAUSED');
        const phase: DispatchPhase = resume ? 'PAUSED' : r.phase === 'WAITING_VIEW' ? 'PAUSED' : r.phase;
        this.map.set(id, {
          ...r,
          phase,
          stop: { ...defaultStop(), ...(r.stop ?? {}) },
          stopped: r.stopped ?? null,
          text: resume ? '重開後恢復中：等待宿主與角色快照' : (r.text ?? ''),
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
  /** 這位角色的派工通道是否已有自己的快照（背景角色要等通道要到快照）；給 since 時要是這個時間之後收到的。 */
  snapshotReady(id: string, since?: number): boolean;
  nameOf(id: string): string;
  knownCharacterIds(): string[];

  queueStatus(id: string): QueueStatus;
  queueActive(id: string): boolean;
  startGather(id: string, g: GatherSpec, stop: DispatchStop): void;
  stopQueue(id: string, reason: QueueStopReason, text: string): void;

  /** 這位角色有沒有任務鏈在跑（派工通道，或玩家手動開的視角任務鏈）。 */
  chainActive(id: string): boolean;
  chainStatus(id: string): QuestChainStatus;
  /** 在這位角色的派工通道啟動任務鏈；回傳錯誤文字或 null。 */
  startChain(id: string, loopOnly: boolean, stop: DispatchStop, remainingMs: number | null, regionId: string | null): string | null;
  stopChain(id: string, text: string): void;
  /** F9c：停止該角色在背景通道待啟動或進行中的單筆任務。 */
  stopSingleQuest?(id: string, text: string): void;
  /** 玩家手動開的視角任務鏈屬於誰（沒有就是 null）；只有它需要留在視角中。 */
  viewChainOwner(): string | null;
  viewedId(): string | null;

  requestSnapshot(id: string): void;
  log(text: string, level: 'info' | 'warn' | 'error', characterId: string): void;
  onChange(): void;
}

/** 這些停工碼代表「暫停、之後自動接著跑」，不是真的結束。 */
const PAUSE_CODES = new Set(['HOST_STOPPED', 'CHARACTER_OFFLINE', 'VIEW_SWITCHED']);

/**
 * 派工邏輯：指派、停止、逐拍檢查（時限、佇列／任務鏈結束原因、宿主停止與角色離線時暫停、恢復）。
 * 每個動作都帶 characterId；不會碰別的角色的佇列或任務鏈。
 */
export class CharacterDispatcher {
  private lastSnapshotRequestAt = new Map<string, number>();

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

    // 取代舊派工：只收掉這個角色自己的東西。
    this.releaseJob(id, '被新的派工取代');

    const now = this.host.now();
    const rec: DispatchRecord = {
      characterId: id,
      kind: spec.kind,
      ...(spec.gather ? { gather: { ...spec.gather } } : {}),
      ...((spec.kind === 'QUEST_CHAIN' || spec.kind === 'NOVICE_LOOP') && spec.regionId !== undefined
        ? { regionId: spec.regionId } : {}),
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
    } else if (this.host.running() && this.host.snapshotReady(id)) {
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
      // 背景角色的快照還沒到（或宿主還沒連上）：先暫停，要到快照後自動開始，不切視角。
      this.store.set({ ...rec, phase: 'PAUSED', text: '等待角色快照：到了就開始' });
      this.host.log(`【${name}】派工：${DISPATCH_KIND_LABEL[spec.kind]}（等待角色快照）`, 'info', id);
      if (this.host.running()) this.requestSnapshot(id);
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

  /**
   * 玩家手動開的視角任務鏈（舊的「無人任務」按鈕）仍走視角角色的模組：擁有者離開視角就暫停，不再送指令。
   * 派工通道的任務鏈不受視角影響。要在處理訊息之前呼叫。
   */
  enforceView(): void {
    const owner = this.host.viewChainOwner();
    if (!owner || owner === this.host.viewedId()) return;
    this.host.stopChain(owner, '視角已切換，任務鏈暫停');
    const rec = this.store.get(owner);
    if (rec && rec.phase === 'RUNNING') this.pause(rec, 'VIEW_SWITCHED', '視角已切換，任務鏈暫停，之後在背景接著跑');
  }

  tick(): void {
    this.enforceView();
    this.adoptUntracked();
    const now = this.host.now();
    const running = this.host.running();
    const known = new Set(this.host.knownCharacterIds());
    for (const rec of this.store.all()) {
      if (rec.phase === 'RUNNING' || rec.phase === 'PAUSED') {
        if (rec.deadlineAt !== null && now >= rec.deadlineAt) {
          this.releaseJob(rec.characterId, '時間到');
          this.finish(rec, 'STOPPED', 'TIME_UP', `停止條件觸發：時間到（已跑滿 ${rec.stop.maxMinutes} 分鐘）`);
          continue;
        }
      }
      const foreground = rec.kind === 'QUEST_CHAIN' || rec.kind === 'NOVICE_LOOP';
      if (foreground && rec.phase === 'RUNNING') {
        // 宿主停止或角色離線：暫停，派工紀錄與剩下的時限保留。
        if (!running) { this.pause(rec, 'HOST_STOPPED', '宿主停止，佇列保留，恢復連線後接著跑'); continue; }
        if (known.size > 0 && !known.has(rec.characterId)) { this.pause(rec, 'CHARACTER_OFFLINE', '角色離線，佇列保留，回來後接著跑'); continue; }
      }
      if (rec.kind === 'GATHER' && rec.phase === 'RUNNING') this.watchGather(rec, running, known);
      else if (foreground && rec.phase === 'RUNNING') this.watchChain(rec);
      else if (foreground && rec.phase === 'PAUSED') this.tryResume(rec);
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
    return this.host.startChain(rec.characterId, rec.kind === 'NOVICE_LOOP', rec.stop, remaining, rec.regionId ?? null);
  }

  /** 這個角色自己的工作全部收掉（佇列、任務鏈、背景單筆任務），不碰別人。 */
  private releaseJob(id: string, text: string): void {
    if (this.host.queueActive(id)) this.host.stopQueue(id, 'USER_STOPPED', text);
    if (this.host.chainActive(id)) this.host.stopChain(id, text);
    this.host.stopSingleQuest?.(id, text);
  }

  private finish(rec: DispatchRecord, phase: 'STOPPED' | 'DONE', code: string, text: string): void {
    const now = this.host.now();
    this.store.set({ ...rec, phase, stopped: { code, text, at: now }, text });
    this.host.log(`【${this.host.nameOf(rec.characterId)}】${DISPATCH_KIND_LABEL[rec.kind]}${phase === 'DONE' ? '完成' : '停工'}：${text}`, phase === 'DONE' ? 'info' : 'warn', rec.characterId);
    this.host.onChange();
  }

  private pause(rec: DispatchRecord, code: string, text: string): void {
    if (this.host.chainActive(rec.characterId)) this.host.stopChain(rec.characterId, text);
    const now = this.host.now();
    this.store.set({ ...rec, phase: 'PAUSED', stopped: { code, text, at: now }, text: `暫停：${text}` });
    this.host.log(`【${this.host.nameOf(rec.characterId)}】${DISPATCH_KIND_LABEL[rec.kind]}暫停：${text}`, 'warn', rec.characterId);
    this.host.onChange();
  }

  private watchGather(rec: DispatchRecord, running: boolean, known: Set<string>): void {
    const q = this.host.queueStatus(rec.characterId);
    if (q.phase === 'STOPPED' || q.phase === 'DONE') {
      const r = queueStopToDispatch(q);
      this.finish(rec, r.phase, String(r.code), r.text);
      return;
    }
    // 採集佇列自己存檔、自己等宿主；這裡只把狀態寫清楚。
    const text = !running ? '宿主停止，採集佇列保留' : known.size > 0 && !known.has(rec.characterId) ? '角色離線，採集佇列保留' : q.text;
    if (text && text !== rec.text) this.store.set({ ...rec, text });
  }

  private watchChain(rec: DispatchRecord): void {
    if (this.host.chainActive(rec.characterId)) {
      const t = this.host.chainStatus(rec.characterId).text;
      if (t !== rec.text) this.store.set({ ...rec, text: t });
      return;
    }
    // 任務鏈不在跑了（結束或被別的操作停掉）。
    const r = chainStopToDispatch(this.host.chainStatus(rec.characterId));
    this.finish(rec, r.phase, r.code, r.text);
  }

  private requestSnapshot(id: string): void {
    const now = this.host.now();
    if (now - (this.lastSnapshotRequestAt.get(id) ?? -Infinity) <= 2000) return;
    this.lastSnapshotRequestAt.set(id, now);
    this.host.requestSnapshot(id);
  }

  private tryResume(rec: DispatchRecord): void {
    const id = rec.characterId;
    if (!this.host.running()) return;
    if (!this.host.knownCharacterIds().includes(id)) return;
    if (this.host.chainActive(id)) return;
    // 宿主停過或角色離線過：要等恢復之後的新快照，不用停之前的舊狀態開工。
    const since = rec.stopped && (rec.stopped.code === 'HOST_STOPPED' || rec.stopped.code === 'CHARACTER_OFFLINE') ? rec.stopped.at : undefined;
    if (!this.host.snapshotReady(id, since)) {
      this.requestSnapshot(id);
      return;
    }
    const err = this.startForeground(rec);
    if (err) {
      if (rec.text !== `暫停：${err}`) this.store.set({ ...rec, text: `暫停：${err}` });
      return;
    }
    const resumed = rec.stopped && PAUSE_CODES.has(rec.stopped.code);
    this.store.set({ ...rec, phase: 'RUNNING', text: `${DISPATCH_KIND_LABEL[rec.kind]}：${resumed || rec.startedAt !== null ? '已恢復' : '開始'}` });
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
      } else if (this.host.chainActive(id)) {
        const status = this.host.chainStatus(id);
        this.store.set({
          characterId: id,
          kind: status.config.loopOnly ? 'NOVICE_LOOP' : 'QUEST_CHAIN',
          ...(status.config.regionId !== undefined ? { regionId: status.config.regionId } : {}),
          stop: defaultStop(),
          phase: 'RUNNING',
          startedAt: this.host.now(),
          deadlineAt: null,
          stopped: null,
          text: status.text,
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
