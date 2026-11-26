import { applyMessage, initialState, type FamilyState } from '../src/state';
import { overlayMarkers, routePolylines, worldToStagePoint, buildModernModel } from '../src/render/viewMode';
import {
  parseCssColor,
  parseMapThemePreset,
  readMapThemePreset,
  resolveModernTheme,
  themePixel,
  writeMapThemePreset,
  DEFAULT_MAP_THEME_TOKENS,
} from '../src/render/modernTheme';
import { rasterTerrain, TERRAIN_WALK_RGBA } from '../src/render/terrainRaster';
import { createWorld } from './f2_world';
import { assert, done, suite } from './helpers';
import { PROTOCOL_VERSION, type PluginMessage } from '../src/protocol/index';

suite('F13b 標記座標：原樣採用快照，投到舞台時用現代鏡頭');
{
  const markers = overlayMarkers({
    mapId: 'synthetic',
    exits: [{ id: 'door', name: '出口', x: 12, y: 34 }],
    npcs: [{ id: 'n1', name: '人', x: 3, y: 4, isShop: false }, { id: 's1', name: '店', x: 8, y: 9, isShop: true }],
    gatherPoints: [
      { id: 'g1', name: '採', mapId: 'synthetic', x: 5, y: 6 },
      { id: 'g2', name: '別張圖', mapId: 'other', x: 1, y: 1 },
    ],
    portals: [
      { id: 'door', name: '出口', x: 99, y: 99, targetStatus: 'NOT_IMPORTED' },
      { id: 'extra', name: '另一個出口', x: 20, y: 21, targetStatus: 'IMPORTED' },
      { id: 'bare', name: '沒座標', targetStatus: 'IMPORTED' },
    ],
  });
  const door = markers.find(m => m.id === 'exit:door');
  const extra = markers.find(m => m.id === 'exit:extra');
  assert(door?.x === 12 && door.y === 34 && door.unimported === true, '已在 exits 的傳送點沿用出口座標，不改用圖上的另一組數字');
  assert(extra?.x === 20 && extra.y === 21 && extra.unimported !== true, '快照沒有、但傳送點圖自帶座標的點會補上');
  assert(!markers.some(m => m.id === 'exit:bare'), '沒有座標的傳送點不補一個點');
  assert(markers.find(m => m.id === 'npc:n1')?.x === 3 && markers.find(m => m.id === 'npc:s1')?.kind === 'shop', 'NPC 與商店座標原樣');
  assert(markers.some(m => m.id === 'gather:g1' && m.x === 5) && !markers.some(m => m.id === 'gather:g2'), '只畫這張圖的採集點');

  const stage = worldToStagePoint({ x: 10, y: 20 }, { x: 0, y: 0 }, 1, 100, 80);
  assert(stage.x === 60 && stage.y === 60, '鏡頭在原點、縮放 1：點落在視野中心加世界座標');
  const centered = worldToStagePoint({ x: 10, y: 20 }, { x: 10, y: 20 }, 2, 200, 100);
  assert(centered.x === 100 && centered.y === 50, '鏡頭對準標記時，標記在舞台正中');
  const clamped = worldToStagePoint({ x: 1, y: 1 }, { x: 0, y: 0 }, 99, 10, 10);
  assert(clamped.x === 7 && clamped.y === 7, '縮放超過上限時用 2 倍，不沿用呼叫端的大數字');
}

suite('F13b 路線疊圖：兩點以上才畫，順序與座標不變');
{
  assert(routePolylines([]).length === 0 && routePolylines([{ x: 1, y: 1 }]).length === 0, '單點沒有線');
  const line = routePolylines([{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }]);
  assert(line.length === 1 && line[0].kind === 'walk' && line[0].points.length === 3, '三點畫成一條走路路線');
  assert(line[0].points[0].x === 1 && line[0].points[2].y === 6, '路線點保持原本順序');
  const screen = line[0].points.map(p => worldToStagePoint(p, { x: 0, y: 0 }, 1, 0, 0));
  assert(screen[1].x === 3 && screen[1].y === 4, '路線上的每一點用同一套座標換算');
}

suite('F13b 主題 token：預設沿用 F13 的顏色，高對比分開，壞值退回');
{
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
  assert(readMapThemePreset(storage) === 'default', '沒存過就是預設');
  assert(writeMapThemePreset('high-contrast', storage) === 'high-contrast', '寫入高對比');
  assert(readMapThemePreset(storage) === 'high-contrast', '讀回高對比');
  assert(parseMapThemePreset('nope') === 'default' && writeMapThemePreset('default', { getItem: () => 'high-contrast', setItem() { throw new Error('full'); } }) === 'default', '壞值與寫不進去都不丟錯');
  const bad = parseCssColor('not-a-color', DEFAULT_MAP_THEME_TOKENS.walk);
  assert(bad.css === DEFAULT_MAP_THEME_TOKENS.walk, '認不出的顏色退回 token');
  const parsed = parseCssColor('#1e4a3a', '#000000');
  assert(parsed.hex === 0x1e4a3a && themePixel(parsed)[0] === TERRAIN_WALK_RGBA[0], '預設可走色與 F13 點陣相同');
  const hi = resolveModernTheme({ getAttribute: () => 'high-contrast', closest: () => null, style: { getPropertyValue: () => '' } } as unknown as HTMLElement);
  const lo = resolveModernTheme(null);
  assert(hi.preset === 'high-contrast' && lo.preset === 'default' && hi.npc.hex !== lo.npc.hex, '兩組配色的 NPC 色不同');
  assert(hi.key !== lo.key, '配色鍵不同，換色會重畫地形');
  const cells = new Uint8Array([0]);
  const tinted = rasterTerrain(cells, 1, 1, 4, 4, 4, { walk: themePixel(hi.walk), block: themePixel(hi.block) });
  assert(tinted.rgba[0] === hi.walk.rgba[0] && tinted.rgba[1] === hi.walk.rgba[1], '點陣圖吃主題的可走色');
  assert(hi.exit.hex !== lo.exit.hex, '高對比出口色與預設不同');
}

suite('F13b 現代模型仍從快照取標記，建模不改座標');
{
  const w = createWorld();
  let s = initialState();
  const msg = (m: unknown, now: number) => { s = applyMessage(s, m as PluginMessage, now); };
  msg({ v: PROTOCOL_VERSION, characterId: 'char_1', ts: 1, kind: 'heartbeat', sessionId: 's1', seq: 1, mapId: '99001', phase: 'PLAYING', inBattle: false }, 1000);
  msg({ v: PROTOCOL_VERSION, characterId: 'char_1', ts: 2, kind: 'snapshot', seq: 2, reason: 'STARTED', snapshot: w.snapshotFor('char_1') }, 1000);
  const snap = s.snapshot!;
  const npc = snap.npcs[0];
  const gather = snap.gatherPoints.points[0];
  snap.nav.portalGraph = [{
    mapId: snap.mapId,
    name: snap.mapName,
    targets: ['elsewhere'],
    portals: [{ id: 'p1', name: '往外', x: 40, y: 50, targetMapId: 'elsewhere', targetMapName: null, targetStatus: 'IMPORTED' }],
  }];
  const beforeX = npc.x;
  const m = buildModernModel(s, null, 1500);
  const npcMark = m.markers.find(x => x.id === `npc:${npc.id}`);
  const gatherMark = m.markers.find(x => x.id === `gather:${gather.id}`);
  const exitMark = m.markers.find(x => x.id === 'exit:p1');
  assert(npcMark?.x === beforeX && npcMark.y === npc.y, 'NPC 標記等於快照座標');
  assert(gatherMark?.x === gather.x && gatherMark.y === gather.y, '採集點標記等於快照座標');
  assert(exitMark?.x === 40 && exitMark.y === 50, '這張圖的傳送點標記等於傳送點圖座標');
  assert(s.snapshot?.npcs[0].x === beforeX, '建模不改快照');
  const walked = s.snapshot!.character;
  walked.movePath = { waypoints: [{ x: walked.x, y: walked.y }, { x: 40, y: 50 }], startedAt: 1000, endsAt: 5000 };
  const moving = buildModernModel(s as FamilyState, null, 1000);
  const routes = routePolylines(moving.path);
  assert(routes.length === 1 && routes[0].points[routes[0].points.length - 1].x === 40, '走路路徑的終點就是快照上的路點');
}

done();
