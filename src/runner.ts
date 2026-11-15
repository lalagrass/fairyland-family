import {
  isCommandResultMessage, isEventMessage, isSnapshotMessage,
  type PluginCommand, type PluginMessage, type WorkOutput,
} from './protocol/index';
import type { AutoNavigator, NavGoal } from './navigator';
import {
  LOG_LIMIT, appendSteps, emptyQueue, loadQueue, moveStep, removeStep, saveQueue, stepText, stopText,
  type NewStep, type QStep, type QueueState, type StopCond, type WorkLogEntry,
} from './queue';
import { itemNameOf } from './workdata';
import type { FamilyState } from './state';

interface KvStorage { getItem(k: string): string | null; setItem(k: string, v: string): void }

export interface RunnerHost {
  state(): FamilyState;
  send(command: PluginCommand, label: string, expect?: string, commandId?: string): string | null;
  nav: AutoNavigator;
  log(text: string, level?: 'info' | 'warn' | 'error'): void;
  after(ms: number, fn: () => void): unknown;
  now(): number;
  onChange(): void;
}

/** 這些原因碼是「畫面暫時被占住」，稍後用新的 commandId 重試即可（不算失敗）。 */
const BUSY = new Set(['GAME_BUSY', 'GAME_NOT_READY', 'IN_BATTLE', 'DIALOG_OPEN']);
const RETRY_MS = 1000;
const MAX_BUSY = 60;
const MAX_ATTEMPTS = 400;
/** 工作預計結束後多久還沒收到結果，就用同一個 commandId 重送一次（宿主會回「重複」而不是再做一次）。 */
const WORK_GRACE_MS = 4000;

const REASON: Record<string, string> = {
  MISSING_TOOL: '缺工具', MISSING_MATERIAL: '缺材料', INVENTORY_FULL: '背包滿了', TOO_FAR: '離目標太遠', TOOL_BROKEN: '工具壞了',
  NO_STAMINA: '體力不足', FAILED_ROLL: '這次失敗', NOT_AVAILABLE_DATA: '資料不存在', LEVEL_TOO_LOW: '技能等級不夠', WRONG_MAP: '不在正確的地圖',
  ITEM_NOT_IN_SHOP: '商店沒有這項商品', NOT_AT_SHOP: '沒有開著商店', CORE_REJECTED: '宿主拒絕',
};
const why = (code: string, message?: string) => `${REASON[code] ?? code}（${code}）${message ? `：${message}` : ''}`;

type Phase = 'IDLE' | 'NAV' | 'BUY_OPEN' | 'BUY_SHOP' | 'BUY_CLOSE_SHOP' | 'BUY_CLOSE_DIALOG' | 'WORK' | 'WAIT' | 'WAIT_GAME';

/**
 * 佇列執行器：一次一步，把步驟轉成導航（AutoNavigator）、商店操作與 WORK_ONCE。
 * - 每個 WORK_ONCE 的 commandId 是固定可重算的（佇列 id＋步驟＋次數＋重試序號）；重送同一個 id，宿主只會回「重複」，不會再做一次。
 * - 失敗的步驟停在原地、佇列暫停並顯示原因；使用者按「繼續」會重試那一步。
 * - 頁面重開後 resume()：宿主快照裡還在做同一個 commandId 的工作就等它；否則用同一個 id 重送。
 */
export class QueueRunner {
  q: QueueState | null = null;
  private storage: KvStorage | null = null;
  private phase: Phase = 'IDLE';
  private token = 0;
  private cur: { id: string; role: 'OPEN' | 'BUY' | 'CLOSE_SHOP' | 'CLOSE_DIALOG' | 'WORK' } | null = null;
  private busy = 0;
  private resumePending = false;
  private nextAt = 0;

  constructor(private host: RunnerHost, storage: KvStorage | null) { this.storage = storage; }

  // ------------------------------------------------------------ 佇列操作

  /** 綁定角色：載入該角色存起來的佇列。上次是執行中就標記待續跑（等連上遊戲後 resume）。 */
  bind(characterId: string): void {
    if (this.q?.characterId === characterId) return;
    this.token++;
    this.cur = null;
    this.phase = 'IDLE';
    this.q = loadQueue(this.storage, characterId);
    this.resumePending = this.q.run === 'RUNNING';
    this.host.onChange();
  }

  needsResume(): boolean { return this.resumePending; }
  isRunning(): boolean { return this.q?.run === 'RUNNING'; }
  private step(): QStep | null { return this.q && this.q.cursor < this.q.steps.length ? this.q.steps[this.q.cursor] : null; }

  private commit(q: QueueState): void {
    this.q = q;
    saveQueue(this.storage, q);
    this.host.onChange();
  }
  private addLog(kind: WorkLogEntry['kind'], text: string, stepId: string | null = this.step()?.id ?? null): void {
    if (!this.q) return;
    const log = [...this.q.log, { at: this.host.now(), stepId, kind, text }].slice(-LOG_LIMIT);
    this.commit({ ...this.q, log });
  }

  enqueue(steps: NewStep[]): void {
    if (!this.q) return;
    this.commit(appendSteps(this.q, steps));
  }

  remove(index: number): string | null {
    if (!this.q) return '還沒有角色';
    const r = removeStep(this.q, index);
    if (typeof r === 'string') return r;
    this.commit(r);
    return null;
  }

  move(index: number, delta: -1 | 1): string | null {
    if (!this.q) return '還沒有角色';
    const r = moveStep(this.q, index, delta);
    if (typeof r === 'string') return r;
    this.commit(r);
    return null;
  }

  clear(): void {
    if (!this.q) return;
    this.stopInternal();
    this.commit({ ...emptyQueue(this.q.characterId, this.q.qid), seq: this.q.seq, log: this.q.log });
  }

  /** 開始或繼續：從目前這一步（失敗暫停時就是失敗的那一步）重試。 */
  start(): string | null {
    const q = this.q;
    if (!q) return '還沒有角色資料';
    if (q.cursor >= q.steps.length) return '佇列是空的（或已全部完成）';
    if (q.run === 'RUNNING' && this.phase !== 'IDLE') return '佇列已經在執行';
    this.token++;
    this.busy = 0;
    this.resumePending = false;
    this.commit({ ...q, run: 'RUNNING', reason: null });
    this.addLog('INFO', `開始執行：${stepText(this.step()!)}`);
    this.drive();
    return null;
  }

  /** 暫停：正在進行的那個指令會做完（宿主端無法中途取消），但做完後不再接下一步。 */
  pause(reason = '手動暫停'): void {
    const q = this.q;
    if (!q || q.run !== 'RUNNING') return;
    this.token++;
    if (this.host.nav.isActive()) this.host.nav.cancel();
    this.phase = this.cur ? this.phase : 'IDLE';
    this.commit({ ...q, run: 'PAUSED', reason });
    this.addLog('STOP', `暫停：${reason}`);
  }

  skip(): string | null {
    const q = this.q;
    if (!q || q.cursor >= q.steps.length) return '沒有可跳過的步驟';
    if (q.run === 'RUNNING') return '請先暫停再跳過';
    this.commit({ ...q, cursor: q.cursor + 1, run: q.cursor + 1 >= q.steps.length ? 'DONE' : 'PAUSED', reason: q.cursor + 1 >= q.steps.length ? null : q.reason, pendingWork: null });
    return null;
  }

  private stopInternal(): void {
    this.token++;
    this.cur = null;
    this.phase = 'IDLE';
    if (this.host.nav.isActive()) this.host.nav.cancel();
  }

  // ------------------------------------------------------------ 重開頁面後續跑

  /** 連上遊戲、拿到快照後呼叫：和宿主快照對照，決定是等、重送同一個 id，還是從這一步重做。 */
  resume(): void {
    const q = this.q;
    if (!q || !this.resumePending) return;
    this.resumePending = false;
    if (q.run !== 'RUNNING') return;
    const st = this.step();
    if (!st) { this.commit({ ...q, run: 'DONE' }); return; }
    this.token++;
    const pw = q.pendingWork;
    const hostWork = this.host.state().snapshot?.activity.work ?? null;
    if (pw && st.kind === 'WORK' && pw.stepId === st.id) {
      if (hostWork && hostWork.commandId === pw.commandId) {
        this.addLog('INFO', `接上進行中的工作（${pw.commandId}），等宿主完成，不重送`);
        this.cur = { id: pw.commandId, role: 'WORK' };
        this.phase = 'WORK';
        this.nextAt = hostWork.endsAt + WORK_GRACE_MS;
        return;
      }
      this.addLog('INFO', `宿主快照沒有進行中的工作：用同一個 commandId 重送（${pw.commandId}），已結算的話宿主只會回「重複」`);
      this.sendWork(st, pw.commandId);
      return;
    }
    this.addLog('INFO', '重新連上遊戲，從目前這一步接著做');
    this.drive();
  }

  // ------------------------------------------------------------ 驅動

  private fail(text: string, detail?: string): void {
    const q = this.q;
    if (!q) return;
    this.token++;
    this.cur = null;
    this.phase = 'IDLE';
    this.commit({ ...q, run: 'PAUSED', reason: text, pendingWork: null });
    this.addLog('STOP', `停在這一步：${text}${detail ? `（${detail}）` : ''}`);
    this.host.log(`佇列暫停：${text}`, 'warn');
  }

  private finishStep(note: string): void {
    const q = this.q;
    if (!q) return;
    const st = this.step();
    this.cur = null;
    this.phase = 'IDLE';
    this.busy = 0;
    if (st) this.addLog('STOP', note, st.id);
    const cursor = q.cursor + 1;
    const done = cursor >= q.steps.length;
    this.commit({ ...this.q!, cursor, run: done ? 'DONE' : this.q!.run === 'RUNNING' ? 'RUNNING' : this.q!.run, reason: null, pendingWork: null });
    if (done) { this.addLog('INFO', '佇列全部完成', null); return; }
    if (this.q!.run === 'RUNNING') this.drive();
  }

  private drive(): void {
    const q = this.q;
    const st = this.step();
    if (!q || q.run !== 'RUNNING') return;
    if (!st) { this.commit({ ...q, run: 'DONE', reason: null }); return; }
    const s = this.host.state();
    if (!s.characterId || this.host.state().lastHeartbeatAt === null) { this.phase = 'WAIT_GAME'; return; }
    const token = this.token;
    switch (st.kind) {
      case 'GOTO_NPC': return this.go({ kind: 'NPC', query: st.query, talk: false }, st);
      case 'GOTO_MAP': return this.go({ kind: 'MAP', mapId: st.mapId, name: st.name }, st);
      case 'GOTO_POINT': return this.go({ kind: 'POINT', mapId: st.mapId, x: st.x, y: st.y, reach: st.reach, name: st.name }, st);
      case 'BUY': {
        const have = s.inventory.filter(i => i.itemId === st.itemId).reduce((n, i) => n + i.count, 0);
        if (have >= st.target) { this.finishStep(`已經有 ${st.itemName}×${have}，不用再買`); return; }
        if (s.shop) { this.buyNow(st); return; }
        if (s.dialog) { this.openShop(st); return; }
        this.phase = 'NAV';
        this.host.nav.go({ kind: 'NPC', query: st.npcName, talk: true });
        this.poll();
        return;
      }
      case 'WORK': {
        if (s.battle || s.battleResult) { this.phase = 'WAIT'; this.nextAt = this.host.now() + RETRY_MS; return; }
        if (token !== this.token) return;
        this.workNext(st);
      }
    }
  }

  private go(goal: NavGoal, st: QStep): void {
    this.phase = 'NAV';
    this.host.nav.go(goal);
    void st;
    this.poll();
  }

  /** 控制器每次收到訊息或定時呼叫：看導航結果、重試等待、逾時重送。 */
  poll(): void {
    const q = this.q;
    if (!q || q.run !== 'RUNNING') return;
    const st = this.step();
    if (!st) return;
    const now = this.host.now();
    if (this.phase === 'NAV') {
      const n = this.host.nav.getStatus();
      if (n.phase === 'DONE') {
        if (st.kind === 'BUY') {
          const s = this.host.state();
          if (s.shop) this.buyNow(st);
          else if (s.dialog) this.openShop(st);
          else this.fail('走到了但沒有和商店 NPC 對話', st.npcName);
        } else this.finishStep(`${st.label}：已到達`);
      } else if (n.phase === 'FAILED' || n.phase === 'CANCELLED') {
        this.fail(n.text);
      }
      return;
    }
    if (this.phase === 'WAIT_GAME') { if (this.host.state().lastHeartbeatAt !== null) { this.phase = 'IDLE'; this.drive(); } return; }
    if (this.phase === 'WAIT' && now >= this.nextAt) { this.phase = 'IDLE'; this.drive(); return; }
    if (this.phase === 'WORK' && this.cur && st.kind === 'WORK' && this.nextAt && now >= this.nextAt) {
      // 工作該結束了卻沒收到結果（事件掉了或頁面剛重開）：用同一個 commandId 再問一次。
      this.nextAt = 0;
      this.addLog('INFO', `等不到結果，用同一個 commandId 重送（${this.cur.id}）`);
      this.sendWork(st, this.cur.id);
    }
  }

  // ------------------------------------------------------------ 買東西

  private openShop(st: Extract<QStep, { kind: 'BUY' }>): void {
    const d = this.host.state().dialog;
    const opt = d?.options.find(o => o.id === 'OPEN_SHOP') ?? d?.options.find(o => /商店|買|購/.test(o.label));
    if (!opt) { this.fail(`${st.npcName} 的對話沒有商店選項`, d?.options.map(o => o.label).join('／') || '沒有選項'); return; }
    this.phase = 'BUY_OPEN';
    this.issue({ type: 'CHOOSE_DIALOG_OPTION', optionId: opt.id }, `佇列：開商店（${st.npcName}）`, 'DONE', 'OPEN');
  }

  private buyNow(st: Extract<QStep, { kind: 'BUY' }>): void {
    const goods = this.host.state().shop?.goods ?? [];
    const g = goods.find(x => x.itemId === st.itemId);
    if (!g) { this.phase = 'IDLE'; this.fail(`${st.npcName} 的商店沒有「${st.itemName}」（無庫存／不賣）`); return; }
    const gold = this.host.state().character?.gold;
    if (gold !== undefined && gold < g.price * st.count) { this.fail(`金錢不夠：${st.itemName} ${g.price} 金，目前 ${gold} 金`); return; }
    this.phase = 'BUY_SHOP';
    // 買東西的 commandId 固定：重送只會得到「重複」，不會多買。
    this.issue({ type: 'BUY_ITEM', itemId: st.itemId, count: st.count }, `佇列：買 ${st.itemName} ×${st.count}（${g.price} 金）`, 'DONE', 'BUY', `${this.q!.qid}.${st.id}.buy`);
  }

  private issue(command: PluginCommand, label: string, expect: string, role: 'OPEN' | 'BUY' | 'CLOSE_SHOP' | 'CLOSE_DIALOG' | 'WORK', commandId?: string): void {
    const id = this.host.send(command, label, expect, commandId);
    if (!id) { this.phase = 'WAIT_GAME'; this.cur = null; return; }
    this.cur = { id, role };
  }

  // ------------------------------------------------------------ 工作

  private workId(st: Extract<QStep, { kind: 'WORK' }>): string {
    return `${this.q!.qid}.${st.id}.${st.attempts}.${this.busy}`;
  }

  private haveOf(itemId: number): number {
    return this.host.state().inventory.filter(i => i.itemId === itemId).reduce((n, i) => n + i.count, 0);
  }

  /** 送 WORK_ONCE 之前先看停止條件，免得多做一次。 */
  private reached(st: Extract<QStep, { kind: 'WORK' }>): string | null {
    const u = st.until;
    if (u.kind === 'COUNT' && st.done >= u.n) return `做了 ${st.done} 次，達到目標`;
    if (u.kind === 'HAVE' && this.haveOf(u.itemId) >= u.n) return `${itemNameOf(u.itemId)} 已有 ${this.haveOf(u.itemId)} 個，達到目標`;
    return null;
  }

  private workNext(st: Extract<QStep, { kind: 'WORK' }>): void {
    const done = this.reached(st);
    if (done) { this.finishStep(done); return; }
    if (st.attempts >= MAX_ATTEMPTS) { this.fail(`已嘗試 ${st.attempts} 次仍沒達到條件，為了安全先停下`); return; }
    this.sendWork(st, this.workId(st));
  }

  private sendWork(st: Extract<QStep, { kind: 'WORK' }>, commandId: string): void {
    const q = this.q!;
    const id = this.host.send({ type: 'WORK_ONCE', workType: st.workType, targetId: st.targetId }, `佇列：${st.label}（第 ${st.attempts + 1} 次）`, 'WORK_DONE', commandId);
    if (!id) { this.phase = 'WAIT_GAME'; return; }
    this.phase = 'WORK';
    this.cur = { id, role: 'WORK' };
    this.nextAt = 0;
    this.commit({ ...q, pendingWork: { commandId: id, stepId: st.id, sentAt: this.host.now() } });
  }

  private patchStep(patch: Partial<Extract<QStep, { kind: 'WORK' }>>): void {
    const q = this.q!;
    const steps = q.steps.map((s, i) => (i === q.cursor && s.kind === 'WORK' ? { ...s, ...patch } : s));
    this.commit({ ...q, steps });
  }

  private onWorkSettled(code: string, outcome: string, output: WorkOutput | undefined, message: string | undefined, duplicate: boolean): void {
    const st = this.step();
    if (!st || st.kind !== 'WORK' || !this.q) return;
    const running = this.q.run === 'RUNNING';
    this.cur = null;
    this.busy = 0;
    this.commit({ ...this.q, pendingWork: null });
    const gained = output ? output.gained.map(g => `${g.name ?? itemNameOf(g.itemId)}×${g.count}`).join('、') : '';
    const u: StopCond = st.until;
    if (duplicate) {
      // 宿主說這個 id 早就結算過（例如分頁關掉的期間做完了）：結果內容拿不到，只記一次嘗試，再看實際背包決定要不要繼續。
      this.patchStep({ attempts: st.attempts + 1 });
      this.addLog('RESULT', '這次工作在外掛離線時已完成（沿用先前結果，不重做）；以目前背包為準繼續');
      if (running) { this.phase = 'IDLE'; this.nextAt = 0; this.host.send({ type: 'REQUEST_SNAPSHOT' }, '要求快照（工作結果重複）'); this.afterDelay(); }
      return;
    }
    if (code === 'WORK_DONE' || code === 'TOOL_BROKEN') {
      const nst = { done: st.done + 1, attempts: st.attempts + 1 };
      this.patchStep(nst);
      this.addLog('RESULT', `${st.name} 第 ${nst.attempts} 次：${gained ? `得到 ${gained}` : '完成'}${output ? `（背包 ${output.inventorySlotsUsed} 格、體力 ${output.staminaLeft}${output.toolDurabilityLeft !== null ? `、耐久 ${output.toolDurabilityLeft}` : ''}）` : ''}${code === 'TOOL_BROKEN' ? '，工具壞了' : ''}`);
      if (u.kind === 'COUNT' && nst.done >= u.n) { this.finishStep(`做了 ${nst.done} 次，達到目標`); return; }
      if (u.kind === 'HAVE' && this.haveOf(u.itemId) >= u.n) { this.finishStep('達到目標數量'); return; }
      if (code === 'TOOL_BROKEN') { u.kind === 'TOOL' ? this.finishStep('工具壞了，依條件停止') : this.fail(why('TOOL_BROKEN'), `已做 ${nst.done} 次`); return; }
      if (output?.inventoryFullAfter && u.kind === 'BAG_FULL') { this.finishStep('背包滿了，依條件停止'); return; }
      if (output?.inventoryFullAfter) { this.fail(why('INVENTORY_FULL'), '再做下去放不下'); return; }
      if (running) this.afterDelay();
      return;
    }
    if (code === 'FAILED_ROLL') {
      this.patchStep({ attempts: st.attempts + 1 });
      this.addLog('RESULT', `${st.name} 第 ${st.attempts + 1} 次：失敗（擲骰）${output ? `，體力 ${output.staminaLeft}` : ''}`);
      if (running) this.afterDelay();
      return;
    }
    if (code === 'INVENTORY_FULL' && u.kind === 'BAG_FULL') { this.finishStep('背包滿了，依條件停止'); return; }
    if (code === 'MISSING_MATERIAL' && u.kind === 'MATERIAL') { this.finishStep('材料用完，依條件停止'); return; }
    if ((code === 'MISSING_TOOL' || code === 'TOOL_BROKEN') && u.kind === 'TOOL') { this.finishStep('工具已壞，依條件停止'); return; }
    this.fail(why(code, message), outcome);
  }

  private afterDelay(): void {
    const token = this.token;
    this.phase = 'WAIT';
    this.nextAt = this.host.now() + 50;
    this.host.after(50, () => { if (token === this.token && this.phase === 'WAIT') { this.phase = 'IDLE'; this.drive(); } });
  }

  // ------------------------------------------------------------ 收訊息

  onMessage(m: PluginMessage): void {
    const q = this.q;
    if (!q) return;
    if (isSnapshotMessage(m)) return;
    if (q.run !== 'RUNNING' && !(q.pendingWork && this.cur)) { return; }
    if (isEventMessage(m)) {
      const e = m.event;
      if (e.type === 'GAME_STARTED' || e.type === 'GAME_STOPPED') {
        // 遊戲關掉或重開：進行中的指令不會再有結果。記下來，等遊戲回來用 resume 對照。
        if (q.run === 'RUNNING') { this.cur = null; this.token++; this.phase = 'WAIT_GAME'; this.resumePending = true; this.addLog('INFO', `遊戲${e.type === 'GAME_STOPPED' ? '停止' : '重新啟動'}：等遊戲回來再對照續跑`); }
        return;
      }
      if (e.type === 'BATTLE_ENDED' && this.phase === 'WAIT') { this.nextAt = 0; this.host.after(0, () => this.poll()); }
      if (e.type === 'COMMAND_COMPLETED' && this.cur && e.commandId === this.cur.id) this.onCompleted(e.code, e.outcome, e.output, e.message);
      this.poll();
      return;
    }
    if (isCommandResultMessage(m) && this.cur && m.commandId === this.cur.id) {
      if (m.status === 'REJECTED') this.onRejected(m.reasonCode ?? 'CORE_REJECTED', m.message);
      else if (m.duplicate && this.cur.role === 'WORK') this.onWorkSettled('WORK_DONE', 'DONE', undefined, undefined, true);
      return;
    }
    this.poll();
  }

  private onRejected(code: string, message?: string): void {
    const cur = this.cur;
    if (!cur) return;
    this.cur = null;
    if (BUSY.has(code)) {
      if (++this.busy > MAX_BUSY) { this.fail('等待遊戲可操作逾時'); return; }
      if (cur.role === 'WORK') this.commit({ ...this.q!, pendingWork: null });
      const token = this.token;
      this.phase = 'WAIT';
      this.nextAt = this.host.now() + RETRY_MS;
      this.host.after(RETRY_MS, () => { if (token === this.token && this.phase === 'WAIT') { this.phase = 'IDLE'; this.drive(); } });
      return;
    }
    if (cur.role === 'WORK') { this.onWorkSettled(code, 'FAILED', undefined, message, false); return; }
    this.fail(why(code, message), cur.role === 'BUY' ? '買東西' : cur.role === 'OPEN' ? '開商店' : '離開商店');
  }

  private onCompleted(code: string, outcome: string, output: WorkOutput | undefined, message?: string): void {
    const cur = this.cur;
    const st = this.step();
    if (!cur || !st) return;
    if (cur.role === 'WORK') { this.onWorkSettled(code, outcome, output, message, false); return; }
    this.cur = null;
    if (code !== 'DONE') { this.fail(`${cur.role === 'BUY' ? '買東西' : '商店操作'}失敗 ${code}`, message); return; }
    if (cur.role === 'OPEN') {
      // SHOP_OPENED 事件通常先到；沒到就等一下。
      if (this.host.state().shop && st.kind === 'BUY') this.buyNow(st);
      else this.waitShop(st as Extract<QStep, { kind: 'BUY' }>, 20);
    } else if (cur.role === 'BUY') {
      this.addLog('RESULT', `買了 ${st.kind === 'BUY' ? `${st.itemName}×${st.count}` : ''}`);
      this.phase = 'BUY_CLOSE_SHOP';
      this.issue({ type: 'CHOOSE_DIALOG_OPTION', optionId: 'CLOSE_SHOP' }, '佇列：離開商店', 'DONE', 'CLOSE_SHOP');
    } else if (cur.role === 'CLOSE_SHOP') {
      if (this.host.state().dialog) { this.phase = 'BUY_CLOSE_DIALOG'; this.issue({ type: 'CHOOSE_DIALOG_OPTION', optionId: 'CLOSE' }, '佇列：結束對話', 'DONE', 'CLOSE_DIALOG'); }
      else this.finishStep(st.kind === 'BUY' ? `${st.label}：完成` : '完成');
    } else this.finishStep(st.kind === 'BUY' ? `${st.label}：完成` : '完成');
  }

  private waitShop(st: Extract<QStep, { kind: 'BUY' }>, left: number): void {
    const token = this.token;
    this.host.after(100, () => {
      if (token !== this.token || this.q?.run !== 'RUNNING') return;
      if (this.host.state().shop) this.buyNow(st);
      else if (left > 0) this.waitShop(st, left - 1);
      else this.fail('商店沒有開起來');
    });
  }
}
