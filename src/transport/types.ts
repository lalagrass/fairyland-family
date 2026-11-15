import type { CommandMessage } from '../protocol/index';

/**
 * 傳輸層抽象：family 只透過這個介面和「遊戲」對話，指令與事件的格式（協定）不變。
 * 之後要改成本機 WebSocket 中繼或伺服器連線，只需新增一個實作。
 */
export interface Transport {
  readonly name: string;
  /** 開始接收；`onMessage` 收到的是原始（尚未檢核）訊息。 */
  start(onMessage: (raw: unknown) => void): void;
  send(msg: CommandMessage): void;
  stop(): void;
}
