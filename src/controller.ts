import { PROTOCOL_VERSION, isCommandMessage, isPluginMessage, type CommandMessage, type PluginCommand, type PluginMessage } from './protocol/index';
import { AutoBattler, type BattleStrategy } from './battler';
import { Directory } from './directory';
import { AutoNavigator, type NavStatus } from './navigator';
import { parseInput, type UiAction } from './parse';
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

  private receive(raw: unknown): void {
    const now = this.now();
    this.state = applyMessage(this.state, raw, now);
    if (isPluginMessage(raw)) {
      if (raw.kind === 'snapshot') this.directory.learn(raw.snapshot);
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
    if (m.characterId !== this.state.characterId) return;
    this.navigator.onMessage(m);
    this.battler.onMessage(m);
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
    const now = this.now();
    const characterId = this.state.characterId;
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
      case 'COMMAND': this.send(action.command, action.label); return null;
      case 'NAV': return this.navigator.go(action.goal);
      case 'NAV_CANCEL': this.navigator.cancel(); return null;
      case 'STRATEGY': this.battler.setStrategy(action.strategy); return null;
    }
  }

  /** 自由輸入：解析成與選單相同的動作再執行；解析失敗回傳錯誤文字（不送出）。 */
  parseAndSend(text: string): string | null {
    const s = this.state;
    const r = parseInput(text, s.snapshot, {
      mapId: s.location?.mapId, dialogOptions: s.dialog?.options, enemies: s.battle?.enemyStates, battleId: s.battle?.battleId ?? null, inventory: s.inventory,
      findNpc: q => this.directory.findNpc(q), findMap: q => this.directory.findMap(q),
    });
    if (!r.ok) return r.error;
    return this.perform(r.action);
  }

  private emit(): void {
    this.opts.onChange?.(this.state);
  }
}
