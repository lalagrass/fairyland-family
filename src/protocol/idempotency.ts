// [sync-protocol] 自動產生，請勿手改；改協定請到 fairyland 修改後重新執行 npm run sync-protocol
// [sync-protocol] 來源：fairyland/packages/shared/src/protocol/idempotency.ts @ 12fbb324c7260eb1c5dd0a5d916fcddd86d3e632
/**
 * 指令冪等：以 commandId 記住最近處理過的指令結果，重送同一個 commandId 回傳先前結果、不重複執行。
 * （概念同 `GameSessionState.processedCommandIds`，但這裡還要保存結果以便原樣回覆。）
 */
export class CommandDedup<R> {
  private m = new Map<string, R>();
  constructor(private capacity = 200) {
    if (capacity < 1) throw new Error('capacity must be >= 1');
  }
  get size(): number { return this.m.size; }
  has(commandId: string): boolean { return this.m.has(commandId); }
  get(commandId: string): R | undefined { return this.m.get(commandId); }
  /** 忘記某個 commandId（例如原本接受、但之後發現無法執行時改成可重試）。 */
  forget(commandId: string): boolean { return this.m.delete(commandId); }
  /** 記錄結果；超過容量時丟掉最舊的。 */
  remember(commandId: string, result: R): void {
    if (this.m.has(commandId)) this.m.delete(commandId);
    this.m.set(commandId, result);
    while (this.m.size > this.capacity) {
      const oldest = this.m.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.m.delete(oldest);
    }
  }
}
