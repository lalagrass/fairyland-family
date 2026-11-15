import { PLUGIN_CHANNEL_NAME, type CommandMessage } from '../protocol/index';
import type { Transport } from './types';

/** 真實通道：與 fairyland 分頁走同源 BroadcastChannel（兩個分頁必須由同一個 origin 提供）。 */
export class BroadcastTransport implements Transport {
  readonly name = 'BroadcastChannel';
  private ch: BroadcastChannel | null = null;

  start(onMessage: (raw: unknown) => void): void {
    this.ch = new BroadcastChannel(PLUGIN_CHANNEL_NAME);
    this.ch.onmessage = ev => onMessage(ev.data);
  }

  send(msg: CommandMessage): void {
    this.ch?.postMessage(msg);
  }

  stop(): void {
    this.ch?.close();
    this.ch = null;
  }
}
