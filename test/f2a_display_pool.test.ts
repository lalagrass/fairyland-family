import { DisplayPool, type PoolNode } from '../src/render/displayPool';

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail) : ''}`);
  if (!ok) failed++;
}

class Node implements PoolNode {
  static created = 0;
  static destroyedCount = 0;
  destroyed = false;
  children: Node[] = [];
  constructor() { Node.created++; }
  removeChildren(): Node[] { const c = this.children; this.children = []; return c; }
  destroy(): void { this.destroyed = true; Node.destroyedCount++; }
}

// 模擬 pixiStage.drawEntities：每幀清圖層，再替 N 個 NPC 加陰影＋標籤＋傳送點（60fps × 120 秒）。
const layer = new Node();
const pool = new DisplayPool(400);
const FRAMES = 60 * 120;
for (let f = 0; f < FRAMES; f++) {
  pool.release(layer);
  layer.children.push(pool.acquire('portal:10:20', () => new Node()));
  for (let i = 0; i < 12; i++) {
    const c = new Node(); // 每個實體的容器每幀重建（便宜）
    c.children.push(pool.acquire('shadow', () => new Node()), pool.acquire(`label:1:NPC${i % 3}`, () => new Node()));
    layer.children.push(c);
  }
}
// 修正前：每幀 25 個新 Graphics／Text → 7200 幀約 18 萬個；修正後池內物件數固定。
const pooledCreated = Node.created - FRAMES * 12;
check('池內物件數不隨幀數增長', pooledCreated <= 30, { pooledCreated, frames: FRAMES });
check('池大小有上限', pool.size <= 400, { size: pool.size });
check('每幀只銷毀自己的容器（不銷毀池內物件）', Node.destroyedCount === (FRAMES - 1) * 12, { destroyed: Node.destroyedCount });

const l2 = new Node();
const p2 = new DisplayPool(400);
p2.release(l2);
const a = p2.acquire('shadow', () => new Node());
const b = p2.acquire('shadow', () => new Node());
check('同一幀同一 base 拿到不同物件', a !== b);
l2.children.push(a, b);
p2.release(l2);
check('下一幀拿回同一批物件', p2.acquire('shadow', () => new Node()) === a && p2.acquire('shadow', () => new Node()) === b);

const p3 = new DisplayPool(3);
const l3 = new Node();
for (let i = 0; i < 6; i++) l3.children.push(p3.acquire(`label:${i}`, () => new Node()));
p3.release(l3);
check('超過上限整批丟棄', p3.size === 0);

if (failed) { console.error(`${failed} 項失敗`); process.exit(1); }
console.log('f2a_display_pool OK');
