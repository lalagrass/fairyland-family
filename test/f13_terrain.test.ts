import { packBlockedCells, terrainCellBlocked, terrainCellCenter, unpackBlockedCells, worldToTerrainCell } from '../src/protocol/terrain';
import { applyMessage, initialState, type FamilyState } from '../src/state';
import { buildModernModel, minimapPoint, minimapToWorld, stepCamera } from '../src/render/viewMode';
import { rasterTerrain, TERRAIN_BLOCK_RGBA, TERRAIN_WALK_RGBA } from '../src/render/terrainRaster';
import { createWorld } from './f2_world';
import { assert, done, suite } from './helpers';
import { PROTOCOL_VERSION, type PluginMessage } from '../src/protocol/index';

function booted(): FamilyState {
  const w = createWorld();
  let s = initialState();
  const msg = (m: unknown, now: number) => { s = applyMessage(s, m as PluginMessage, now); };
  msg({ v: PROTOCOL_VERSION, characterId: 'char_1', ts: 1, kind: 'heartbeat', sessionId: 's1', seq: 1, mapId: '99001', phase: 'PLAYING', inBattle: false }, 1000);
  msg({ v: PROTOCOL_VERSION, characterId: 'char_1', ts: 2, kind: 'snapshot', seq: 2, reason: 'STARTED', snapshot: w.snapshotFor('char_1') }, 1000);
  return s;
}

suite('F13 幾何轉換：虛構碰撞格打包、菱形中心、點陣取樣');
{
  const cols = 2;
  const rows = 2;
  const grid = new Uint8Array(cols * rows);
  grid[1] = 1;
  const packed = packBlockedCells(grid, cols, rows);
  assert(!!packed, '打包成功');
  const cells = packed ? unpackBlockedCells(packed) : null;
  assert(!!cells && cells[0] === 0 && cells[1] === 1 && cells[2] === 0 && cells[3] === 0, '還原後只有第 1 格阻擋');
  const c0 = terrainCellCenter(0, 0);
  const c1 = terrainCellCenter(1, 0);
  const back0 = worldToTerrainCell(c0.x, c0.y);
  const back1 = worldToTerrainCell(c1.x, c1.y);
  assert(back0.cx === 0 && back0.cy === 0 && back1.cx === 1 && back1.cy === 0, '菱形中心回到同一格');
  assert(cells !== null && !terrainCellBlocked(cells, cols, rows, 0, 0) && terrainCellBlocked(cells, cols, rows, 1, 0), '中心那格的阻擋旗標與打包一致');

  const mapW = 80;
  const mapH = 40;
  const img = rasterTerrain(cells!, cols, rows, mapW, mapH, 80);
  const at = (x: number, y: number) => {
    const o = (y * img.width + x) * 4;
    return [img.rgba[o], img.rgba[o + 1], img.rgba[o + 2], img.rgba[o + 3]];
  };
  const walk = at(Math.floor(c0.x), Math.floor(c0.y));
  const block = at(Math.floor(c1.x), Math.floor(c1.y));
  assert(walk.every((v, i) => v === TERRAIN_WALK_RGBA[i]), `可走格中心是可走色 ${walk.join(',')}`);
  assert(block.every((v, i) => v === TERRAIN_BLOCK_RGBA[i]), `阻擋格中心是阻擋色 ${block.join(',')}`);
}

suite('F13 鏡頭跟隨與小地圖座標');
{
  let cam = stepCamera(null, { x: 0, y: 0 }, 'map-a', 16);
  cam = stepCamera(cam, { x: 200, y: 0 }, 'map-a', 120);
  assert(Math.abs(cam.x - 100) < 1 && cam.y === 0, '一個半衰期走一半，不跳過目標');
  assert(stepCamera(cam, { x: 10, y: 10 }, 'map-b', 16).x === 10, '換地圖直接跟上');
  const p = minimapPoint(40, 20, 80, 40, 80, 40);
  const w = minimapToWorld(p.x, p.y, 80, 40, 80, 40);
  assert(p.x === 40 && p.y === 20 && w.x === 40 && w.y === 20, '小地圖與世界座標來回一致');
}

suite('F13 現代模型：地形不改角色位置，原版座標仍是同一點');
{
  const s = booted();
  const snap = s.snapshot!;
  const grid = new Uint8Array(4);
  grid[1] = 1;
  const packed = packBlockedCells(grid, 2, 2)!;
  snap.nav.terrain = packed;
  const center = terrainCellCenter(0, 0);
  snap.character.x = center.x;
  snap.character.y = center.y;
  const before = snap.character.x;
  const m = buildModernModel(s, null, 1500);
  assert(m.terrain !== null && m.terrain.cols === 2 && m.terrain.cells[1] === 1, '模型帶上解過的地形');
  assert(m.target?.x === before && m.target.y === center.y, '鏡頭目標就是角色的世界座標');
  const marker = m.markers.find(x => x.kind === 'member' && x.isTarget);
  assert(!!marker && marker.x === snap.character.x && marker.y === snap.character.y, '標記與快照角色同一點（原版／現代共用這份座標）');
  const none = buildModernModel(booted(), null, 1500);
  assert(none.terrain === null, '快照沒帶地形時模型是 null，畫面退回格線');
}

done();
