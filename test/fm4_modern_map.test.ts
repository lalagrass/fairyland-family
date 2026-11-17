import fs from 'node:fs';
import path from 'node:path';
import type { RuntimeMapScene } from '../src/render/assetLoader';
import { computeWeatherParticles, resolveAmbientLighting } from '../src/render/environmentFx';
import { parseLdtkDecorations, type LdtkProject } from '../src/render/ldtkLoader';
import {
  chunkMacroCellBounds,
  MapChunkLruTracker,
  visibleChunkCoords,
} from '../src/render/mapChunks';
import {
  computeSeamlessNeighbors,
  isSeamlessTransition,
} from '../src/render/seamlessNeighbors';
import { assert, done, suite } from './helpers';

function assertEq<T>(actual: T, expected: T, msg: string): void {
  assert(actual === expected, `${msg}（實際：${String(actual)}，預期：${String(expected)}）`);
}

suite('FM4 現代地圖顯示：分塊快取、無縫鄰接計算、晝夜天氣、LDtk 裝飾層');

// 1. 分塊與 LRU 淘汰
const chunks = visibleChunkCoords('10001', 900, 900, 640, 400, 8000, 8000, 100);
assert(chunks.length > 0 && chunks.some(c => c.key === '10001:1,1'), '視野涵蓋地圖分塊 (1,1)');
const bounds = chunkMacroCellBounds(1, 1, 50, 100);
assert(bounds.col1 >= bounds.col0 && bounds.row1 >= bounds.row0, '分塊對應合法 macro_grid 範圍');

const lru = new MapChunkLruTracker(3);
lru.touch('10001:0,0', 1);
lru.touch('10001:1,0', 2);
lru.touch('10001:0,1', 3);
lru.touch('10001:1,1', 4);
assertEq(lru.size(), 3, 'LRU 分塊上限維持在 capacity');
assert(!lru.has('10001:0,0'), '最早的分塊已淘汰');

// 2. 無縫過場：由傳送點推導吉恩村 (10001) 與北綠野 (10004) 偏移且不黑屏
const fakeGien: RuntimeMapScene = {
  map_id: '10001',
  name: '吉恩村',
  pixel_width: 8000,
  pixel_height: 8000,
  portals: [
    {
      id: 'p_north',
      name: '往北綠野',
      target_map: '10004',
      world_x: 560,
      world_y: 360,
      target_x: 7480,
      target_y: 3700,
    } as RuntimeMapScene['portals'] extends Array<infer T> ? T : never,
  ],
};
const neighbors = computeSeamlessNeighbors(fakeGien);
assertEq(neighbors.length, 1, '推導出一條戶外鄰接關係');
assertEq(neighbors[0].targetMapId, '10004', '識別鄰接地圖為 10004 北綠野');
assertEq(neighbors[0].offsetX, 560 - 7480, '計算相對座標 offsetX');
assertEq(neighbors[0].offsetY, 360 - 3700, '計算相對座標 offsetY');
assert(isSeamlessTransition('10001', '10004', fakeGien), '10001 -> 10004 為無縫過場（不黑屏）');
assert(!isSeamlessTransition('10001', '20010', fakeGien), '10001 -> 20010 室內維持淡入淡出');

// 3. 晝夜與天氣顯示
assertEq(resolveAmbientLighting('day', 12).alpha, 0, '白天不加環境遮罩');
assertEq(resolveAmbientLighting('dusk', 12).period, 'dusk', '手動切換黃昏即時生效');
assert(resolveAmbientLighting('night', 12).alpha > 0.3, '夜晚降低亮度並點亮暖色光暈');
assertEq(resolveAmbientLighting('auto', 22).period, 'night', '自動時辰在深夜切換為夜晚');
assertEq(computeWeatherParticles('clear', 800, 480, 1000).length, 0, '晴天不產生降水粒子');
assert(computeWeatherParticles('rain', 800, 480, 1000).length > 20, '雨天產生多條雨絲粒子');
assert(computeWeatherParticles('mist', 800, 480, 1000).length > 5, '薄霧天氣產生漂浮霧層粒子');

// 4. LDtk 裝飾層讀取與移動即時反映
const ldtkPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../public/assets/maps/10001_decor.ldtk');
const proj = JSON.parse(fs.readFileSync(ldtkPath, 'utf8')) as LdtkProject;
const items = parseLdtkDecorations(proj);
assert(items.length >= 4, '吉恩村 10001_decor.ldtk 至少含 4 個原創裝飾物');
const firstX = items[0].x;

// 模擬在 LDtk 編輯器把第一個裝飾物右移 120px
const edited = structuredClone(proj);
edited.levels![0].layerInstances![0].entityInstances![0].px[0] += 120;
const editedItems = parseLdtkDecorations(edited);
assertEq(editedItems[0].x, firstX + 120, '修改 LDtk 裝飾物座標後立即反應於讀取結果');

done();
