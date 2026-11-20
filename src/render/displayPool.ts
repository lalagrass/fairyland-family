/**
 * 每幀重建的圖層裡，不變的顯示物件（陰影、光圈、文字標籤、傳送點）重複使用。
 *
 * F2a：以前每幀都 new Graphics／Text 再 destroy，Pixi 的 GraphicsContext 與文字材質沒有被回收，
 * 約 50MB／秒，家族分頁約 1.5～2.5 分鐘就因記憶體耗盡崩潰。
 * 這裡只依賴最小介面，方便不載入 Pixi 就能測試。
 */
export interface PoolNode {
  destroyed?: boolean;
  removeChildren(): PoolNode[];
  destroy(options?: { children?: boolean }): void;
}

export class DisplayPool {
  private pool = new Map<string, PoolNode>();
  private pooled = new WeakSet<PoolNode>();
  private use = new Map<string, number>();

  constructor(private readonly limit = 400) {}

  get size(): number {
    return this.pool.size;
  }

  /** 同一幀內同一 base 每次呼叫拿到不同物件（避免兩處共用同一個物件而互搶父節點）。 */
  acquire<T extends PoolNode>(base: string, make: () => T): T {
    const n = this.use.get(base) ?? 0;
    this.use.set(base, n + 1);
    const key = `${base}#${n}`;
    let o = this.pool.get(key) as T | undefined;
    if (!o || o.destroyed) {
      o = make();
      this.pool.set(key, o);
      this.pooled.add(o);
    }
    return o;
  }

  /** 清空圖層：池內物件只拆下來留著，其他物件才銷毀；並開始新的一幀。 */
  release(layer: PoolNode): void {
    for (const child of layer.removeChildren()) this.releaseNode(child);
    this.use.clear();
    // 池內物件過多（標籤文字隨地圖與名字累積）就整批丟掉；此時圖層剛清空，沒有物件正在使用。
    if (this.pool.size > this.limit) {
      for (const o of this.pool.values()) o.destroy({ children: true });
      this.pool.clear();
    }
  }

  private releaseNode(node: PoolNode): void {
    if (this.pooled.has(node)) return;
    for (const c of node.removeChildren()) this.releaseNode(c);
    node.destroy();
  }
}
