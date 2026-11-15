import { PROTOCOL_VERSION, isCommandMessage, type CommandMessage, type PluginCommand } from './protocol/index';
import { parseInput } from './parse';
import { addLog, applyMessage, applySent, connectionStatus, initialState, type FamilyState } from './state';
import type { Transport } from './transport/types';

export interface ControllerOptions {
  now?: () => number;
  onChange?: (s: FamilyState) => void;
}

/**
 * 把傳輸層、狀態與指令送出接在一起。P1 只讀：指令都會送出去，宿主會回「尚未實作」，結果照實顯示在日誌。
 */
export class FamilyController {
  state: FamilyState = initialState();
  private seq = 0;
  private readonly tag = Math.random().toString(36).slice(2, 7);
  private readonly now: () => number;
  private lastStatus: 'RUNNING' | 'STOPPED' = 'STOPPED';
  private lastRequestedSession: string | null = null;

  constructor(private transport: Transport, private opts: ControllerOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
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

  private receive(raw: unknown): void {
    const now = this.now();
    this.state = applyMessage(this.state, raw, now);
    this.afterChange(now);
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
  send(command: PluginCommand, label: string): string | null {
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
    this.state = applySent(this.state, msg, label, now);
    this.transport.send(msg);
    this.emit();
    return msg.commandId;
  }

  /** 自由輸入：解析成與選單相同的指令再送出；解析失敗回傳錯誤文字（不送出）。 */
  parseAndSend(text: string): string | null {
    const r = parseInput(text, this.state.snapshot);
    if (!r.ok) return r.error;
    this.send(r.command, r.label);
    return null;
  }

  private emit(): void {
    this.opts.onChange?.(this.state);
  }
}
