import {
  PROTOCOL_VERSION,
  isCommandMessage,
  isEventMessage,
  isHeartbeatMessage,
  isSnapshotMessage,
  type CommandMessage,
  type PluginMessage,
  type SceneSnapshot,
} from '../protocol/index';
import type { Transport } from './types';

/** 錄好的遊戲訊息時間軸（fixtures/replay_village.json）。 */
export interface ReplayFixture {
  format: 'fairyland-replay/1';
  description: string;
  characterId: string;
  steps: Array<{ at: number; message: PluginMessage }>;
}

export interface Scheduler {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: h => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: h => clearInterval(h as ReturnType<typeof setInterval>),
};

export interface ReplayOptions {
  speed?: number;
  loop?: boolean;
  scheduler?: Scheduler;
  heartbeatMs?: number;
}

/**
 * 假 fairyland：按時間軸重播錄好的事件與快照、自己補心跳，並像 P1 宿主一樣回覆指令
 * （REQUEST_SNAPSHOT 接受並回最近快照；其餘一律 NOT_IMPLEMENTED_P1）。這樣 family 不開 fairyland 也能開發與測試。
 */
export class ReplayTransport implements Transport {
  readonly name = '回放（假 fairyland）';
  private onMessage: ((raw: unknown) => void) | null = null;
  private timers: unknown[] = [];
  private hb: unknown = null;
  private seq = 100000;
  private sessionId = 'replay-session';
  private latestSnapshot: SceneSnapshot | null = null;
  private seen = new Map<string, { status: 'ACCEPTED' | 'REJECTED'; reasonCode?: string }>();
  private readonly speed: number;
  private readonly loop: boolean;
  private readonly sch: Scheduler;
  private readonly heartbeatMs: number;
  private mapId: string | null = null;

  constructor(private fixture: ReplayFixture, opts: ReplayOptions = {}) {
    this.speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
    this.loop = !!opts.loop;
    this.sch = opts.scheduler ?? realScheduler;
    this.heartbeatMs = opts.heartbeatMs ?? 1000;
  }

  start(onMessage: (raw: unknown) => void): void {
    this.onMessage = onMessage;
    this.play();
  }

  private play(): void {
    const steps = this.fixture.steps;
    this.sessionId = `replay-${this.sch.now().toString(36)}`;
    this.latestSnapshot = null;
    this.mapId = null;
    this.beat();
    this.hb = this.sch.setInterval(() => this.beat(), this.heartbeatMs);
    for (const step of steps) {
      this.timers.push(this.sch.setTimeout(() => this.deliver(step.message), step.at / this.speed));
    }
    if (this.loop && steps.length) {
      const end = steps[steps.length - 1].at / this.speed + 3000;
      this.timers.push(this.sch.setTimeout(() => { this.clearTimers(); this.play(); }, end));
    }
  }

  private beat(): void {
    this.emit({
      v: PROTOCOL_VERSION, characterId: this.fixture.characterId, ts: this.sch.now(), kind: 'heartbeat',
      sessionId: this.sessionId, seq: ++this.seq, mapId: this.mapId, phase: 'PLAYING', inBattle: false,
    });
  }

  private deliver(m: PluginMessage): void {
    if (isSnapshotMessage(m)) { this.latestSnapshot = m.snapshot; this.mapId = m.snapshot.mapId; }
    if (isEventMessage(m)) {
      const e = m.event;
      if (e.type === 'LOCATION_CHANGED') this.mapId = e.mapId;
      if (e.type === 'GAME_STARTED') this.sessionId = e.sessionId;
    }
    if (isHeartbeatMessage(m)) return; // 心跳由本類別自己產生，錄檔裡的忽略
    this.emit({ ...m, ts: this.sch.now() } as PluginMessage);
  }

  send(msg: CommandMessage): void {
    if (!isCommandMessage(msg)) return;
    const base = { v: PROTOCOL_VERSION, characterId: this.fixture.characterId };
    const prior = this.seen.get(msg.commandId);
    if (prior) {
      this.emit({ ...base, ts: this.sch.now(), kind: 'command-result', commandId: msg.commandId, status: prior.status, ...(prior.reasonCode ? { reasonCode: prior.reasonCode } : {}), duplicate: true } as PluginMessage);
      return;
    }
    let out: { status: 'ACCEPTED' | 'REJECTED'; reasonCode?: string; message?: string };
    if (msg.characterId !== this.fixture.characterId) out = { status: 'REJECTED', reasonCode: 'WRONG_CHARACTER' };
    else if (msg.command.type === 'REQUEST_SNAPSHOT') out = this.latestSnapshot ? { status: 'ACCEPTED' } : { status: 'REJECTED', reasonCode: 'GAME_NOT_READY' };
    else out = { status: 'REJECTED', reasonCode: 'NOT_IMPLEMENTED_P1', message: `P1 只支援 REQUEST_SNAPSHOT，尚未實作 ${msg.command.type}` };
    if (out.reasonCode !== 'GAME_NOT_READY') this.seen.set(msg.commandId, out);
    const t = () => this.sch.now();
    this.emit({ ...base, ts: t(), kind: 'command-result', commandId: msg.commandId, ...out } as PluginMessage);
    this.emit({
      ...base, ts: t(), kind: 'event', seq: ++this.seq,
      event: out.status === 'ACCEPTED'
        ? { type: 'COMMAND_ACCEPTED', commandId: msg.commandId }
        : { type: 'COMMAND_REJECTED', commandId: msg.commandId, reasonCode: out.reasonCode, ...(out.message ? { message: out.message } : {}) },
    } as PluginMessage);
    if (out.status === 'ACCEPTED' && this.latestSnapshot) {
      this.emit({ ...base, ts: t(), kind: 'snapshot', seq: ++this.seq, reason: 'REQUESTED', inReplyTo: msg.commandId, snapshot: this.latestSnapshot });
    }
  }

  private emit(m: PluginMessage): void {
    this.onMessage?.(m);
  }

  private clearTimers(): void {
    for (const t of this.timers) this.sch.clearTimeout(t);
    this.timers = [];
    if (this.hb) this.sch.clearInterval(this.hb);
    this.hb = null;
  }

  stop(): void {
    this.clearTimers();
    this.onMessage = null;
  }
}
