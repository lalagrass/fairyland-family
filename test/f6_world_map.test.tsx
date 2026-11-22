/**
 * F6（fairyland-family#46）：世界地圖的自動排版、路線高亮與斷點標示。
 * 全部使用虛構的地圖 id（m-*／n-*），不含任何原版資料或座標。
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SnapshotPortalEdge, SnapshotPortalNode } from '../src/protocol/index';
import { WorldMapPanel } from '../src/panels/WorldMapPanel';
import {
  WORLD_MAP_MIN_DIST,
  WORLD_MAP_NARROW_BELOW,
  buildWorldMapView,
  fitWorldMap,
  worldMapCharacters,
  worldMapFrame,
  worldMapHitBoxes,
  type WorldMapView,
} from '../src/render/worldMap';
import { assert, done, suite } from './helpers';

const edge = (
  id: string,
  to: string,
  x: number,
  y: number,
  status: SnapshotPortalEdge['targetStatus'] = 'IMPORTED',
): SnapshotPortalEdge => ({
  id, name: `門${id}`, x, y, targetMapId: to, targetMapName: null, targetStatus: status, entryX: 1, entryY: 1,
});
const node = (mapId: string, portals: SnapshotPortalEdge[], name?: string): SnapshotPortalNode => ({
  mapId, name: name ?? `圖${mapId}`, targets: [...new Set(portals.map(p => p.targetMapId))], portals,
});

// 虛構世界：a → b → d（短）；a → c → e → d（長）；a 有一條通往不存在地圖的斷點；z 是孤島。
const world: SnapshotPortalNode[] = [
  node('m-a', [edge('a-b', 'm-b', 99999, -88888), edge('a-c', 'm-c', 1, 1), edge('a-gone', 'm-gone', 500000, 500000, 'NOT_IMPORTED')]),
  node('m-b', [edge('b-a', 'm-a', 2, 2), edge('b-d', 'm-d', 3, 3)]),
  node('m-c', [edge('c-a', 'm-a', 4, 4), edge('c-e', 'm-e', 5, 5)]),
  node('m-e', [edge('e-d', 'm-d', 6, 6)]),
  node('m-d', [edge('d-b', 'm-b', 7, 7)]),
  node('m-z', []),
  node('m-gone', []),
];

function minCenterDist(view: WorldMapView): number {
  let best = Infinity;
  for (let i = 0; i < view.nodes.length; i += 1) {
    for (let j = i + 1; j < view.nodes.length; j += 1) {
      best = Math.min(best, Math.hypot(view.nodes[i].x - view.nodes[j].x, view.nodes[i].y - view.nodes[j].y));
    }
  }
  return best;
}

function noOverlap(view: WorldMapView): boolean {
  return view.nodes.length < 2 || minCenterDist(view) >= WORLD_MAP_MIN_DIST - 1e-3;
}

suite('F6: 自動排版不重疊，也不採用傳送點自己的座標');
{
  const view = buildWorldMapView({
    graph: world,
    characters: [{ characterId: 'c1', name: '旅人', mapId: 'm-a', selected: true }],
    route: [],
  });
  assert(!view.empty && view.nodes.length >= 7, '虛構圖的每個節點都在');
  assert(noOverlap(view), `節點中心距不小於 ${WORLD_MAP_MIN_DIST}（實際 ${minCenterDist(view).toFixed(1)}）`);
  assert(view.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y)), '座標都是有限數');
  const span = Math.max(view.width, view.height);
  assert(span < WORLD_MAP_MIN_DIST * (view.nodes.length + 2) * 8, '版面大小由節點數決定，不是傳送點上的巨大座標');
  assert(view.nodes.every(n => n.x !== 99999 && n.y !== -88888 && n.x !== 500000), '排版沒有沿用傳送點在遊戲世界裡的座標');
  const again = buildWorldMapView({ graph: world, characters: [], route: ['m-a', 'm-b'] });
  const ax = view.nodes.map(n => `${n.mapId}:${n.x.toFixed(3)},${n.y.toFixed(3)}`).join('|');
  const bx = again.nodes.map(n => `${n.mapId}:${n.x.toFixed(3)},${n.y.toFixed(3)}`).join('|');
  assert(ax === bx, '同一張圖排兩次，位置相同（路線與角色不改變版面）');
}

suite('F6: 較密的虛構圖也不重疊');
{
  const n = 24;
  const nodes: SnapshotPortalNode[] = [];
  for (let i = 0; i < n; i += 1) {
    const portals: SnapshotPortalEdge[] = [];
    if (i + 1 < n) portals.push(edge(`p-${i}`, `n-${i + 1}`, i * 1000, -i * 1000));
    if (i + 4 < n) portals.push(edge(`q-${i}`, `n-${i + 4}`, 0, 0));
    if (i === 3) portals.push(edge('gap', 'n-missing', 1, 1, 'NOT_IMPORTED'));
    nodes.push(node(`n-${i}`, portals));
  }
  nodes.push(node('n-missing', []));
  const view = buildWorldMapView({ graph: nodes, characters: [], route: [] });
  assert(view.nodes.length === n + 1, '鏈上的節點與斷點目的地都在');
  assert(noOverlap(view), `密圖中心距不小於最小距離（實際 ${minCenterDist(view).toFixed(1)}）`);
  const packed = WORLD_MAP_MIN_DIST * Math.ceil(Math.sqrt(view.nodes.length)) * 4 + 80;
  assert(view.width < packed && view.height < packed, `版面維持在點得到的大小（${view.width.toFixed(0)}×${view.height.toFixed(0)}，上限 ${packed}）`);
}

suite('F6: 路線高亮');
{
  const view = buildWorldMapView({
    graph: world,
    characters: [
      { characterId: 'c1', name: '旅人', mapId: 'm-a', selected: true },
      { characterId: 'c2', name: '同伴', mapId: 'm-z', selected: false },
    ],
    route: ['m-a', 'm-b', 'm-d'],
  });
  const byId = new Map(view.nodes.map(n => [n.mapId, n]));
  assert(byId.get('m-a')?.onRoute === true && byId.get('m-b')?.onRoute === true && byId.get('m-d')?.onRoute === true, '路線上的地圖被標成路線');
  assert(byId.get('m-c')?.onRoute === false && byId.get('m-e')?.onRoute === false && byId.get('m-z')?.onRoute === false, '沒走的地圖不是路線');
  assert(byId.get('m-a')?.routeIndex === 0 && byId.get('m-b')?.routeIndex === 1 && byId.get('m-d')?.routeIndex === 2, '路線順序跟著規劃');
  const ab = view.links.find(l => l.portalId === 'a-b');
  const bd = view.links.find(l => l.portalId === 'b-d');
  const ac = view.links.find(l => l.portalId === 'a-c');
  assert(!!ab && ab.onRoute && !ab.broken, '第一段傳送被高亮');
  assert(!!bd && bd.onRoute && !bd.broken, '第二段傳送被高亮');
  assert(!!ac && !ac.onRoute, '沒走的傳送不高亮');
  const here = byId.get('m-a');
  const island = byId.get('m-z');
  assert(here?.characters.length === 1 && here.characters[0].selected && here.characters[0].name === '旅人', '選定角色標在目前這張圖上');
  assert(island?.characters.length === 1 && island.characters[0].name === '同伴' && !island.characters[0].selected, '另一位角色標在自己的圖上');
}

suite('F6: 斷點標示');
{
  const view = buildWorldMapView({ graph: world, characters: [], route: ['m-a', 'm-b', 'm-d'] });
  const gone = view.links.find(l => l.portalId === 'a-gone');
  assert(!!gone && gone.broken && !gone.onRoute, '通往未匯入地圖的傳送是斷點，不算進路線');
  assert(view.brokenCount === 1, '斷點數記在畫面上');
  const stub = view.nodes.find(n => n.mapId === 'm-gone');
  assert(!!stub && !stub.clickable, '斷點的目的地不能點了下移動');
  const src = view.nodes.find(n => n.mapId === 'm-a');
  assert(src?.brokenOut === 1 && src.clickable, '來源圖仍可點，並記下從這裡出去的斷點');
  const unknown = buildWorldMapView({
    graph: [node('m-a', [edge('a-b', 'm-b', 1, 1, 'UNKNOWN')]), node('m-b', [])],
    characters: [],
    route: ['m-a', 'm-b'],
  });
  const link = unknown.links.find(l => l.portalId === 'a-b');
  assert(!!link && !link.broken && link.onRoute && unknown.brokenCount === 0, '目的地狀態 UNKNOWN 仍可走，不算斷點');
  assert(buildWorldMapView({ graph: [], characters: [], route: [] }).empty, '還沒收到傳送點圖就是空的');
}

suite('F6: 節點很多時，熱區仍然點得到');
{
  const count = 80;
  const nodes: SnapshotPortalNode[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `w-${String(i).padStart(2, '0')}`;
    const portals: SnapshotPortalEdge[] = [];
    if (i + 1 < count) portals.push(edge(`e-${i}`, `w-${String(i + 1).padStart(2, '0')}`, i * 10000, -i));
    if (i % 7 === 0) portals.push(edge(`x-${i}`, `w-gap-${i}`, 0, 0, 'NOT_IMPORTED'));
    nodes.push(node(id, portals));
  }
  const view = buildWorldMapView({
    graph: nodes,
    characters: [{ characterId: 'c', name: '旅人', mapId: 'w-00', selected: true }],
    route: ['w-00', 'w-01', 'w-02'],
  });
  assert(noOverlap(view), `大圖中心距不小於最小距離（實際 ${minCenterDist(view).toFixed(1)}）`);
  assert(view.links.some(l => l.portalId === 'e-0' && l.onRoute) && view.links.some(l => l.portalId === 'x-0' && l.broken && !l.onRoute), '大圖仍標出路徑與斷點');
  const hits = worldMapHitBoxes(view, 480, 320);
  const min = Math.min(...hits.map(h => h.size));
  assert(min >= 8, `480×320 的熱區至少 8px（實際 ${min.toFixed(1)}，節點 ${view.nodes.length}）`);
}

suite('F6: 窄螢幕熱區落在視窗內且不重疊');
{
  const view = buildWorldMapView({
    graph: world,
    characters: [{ characterId: 'c1', name: '旅人', mapId: 'm-d', selected: true }],
    route: ['m-a', 'm-b', 'm-d'],
  });
  for (const box of [{ w: 320, h: 480 }, { w: 900, h: 520 }]) {
    const hits = worldMapHitBoxes(view, box.w, box.h);
    assert(hits.length === view.nodes.filter(n => n.clickable).length, `${box.w}px：每個可點節點都有熱區`);
    let inside = true;
    let overlap = false;
    for (let i = 0; i < hits.length; i += 1) {
      const h = hits[i];
      if (h.left < -0.05 || h.top < -0.05 || h.left + h.size > box.w + 0.05 || h.top + h.size > box.h + 0.05) inside = false;
      for (let j = i + 1; j < hits.length; j += 1) {
        const o = hits[j];
        const sepX = h.left + h.size <= o.left + 0.05 || o.left + o.size <= h.left + 0.05;
        const sepY = h.top + h.size <= o.top + 0.05 || o.top + o.size <= h.top + 0.05;
        if (!sepX && !sepY) overlap = true;
      }
    }
    assert(inside, `${box.w}px：熱區在視窗裡面`);
    assert(!overlap, `${box.w}px：熱區不重疊`);
  }
  const fit = fitWorldMap(view.width, view.height, 320, 480);
  assert(fit.scale > 0 && fit.scale <= 320 / view.width + 1e-9, '窄視窗整張圖等比縮進去');
  assert(worldMapFrame(320).narrow && worldMapFrame(320).showList, '窄於分界就改用清單');
  assert(!worldMapFrame(WORLD_MAP_NARROW_BELOW).narrow && !worldMapFrame(900).showList, '寬螢幕以節點圖為主');
}

suite('F6: 面板標出路徑與斷點，點節點走既有的移動回呼');
{
  const moves: Array<{ mapId: string; name: string }> = [];
  const html = renderToStaticMarkup(
    <WorldMapPanel
      graph={world}
      characters={[{ characterId: 'c1', name: '旅人', mapId: 'm-a', selected: true }]}
      route={['m-a', 'm-b', 'm-d']}
      running
      onSelectCharacter={() => {}}
      onMoveTo={(mapId, name) => moves.push({ mapId, name })}
    />,
  );
  assert(html.includes('data-testid="world-map-panel"') && html.includes('data-broken-count="1"'), '面板帶著斷點數');
  assert(html.includes('data-testid="world-map-route"') && html.includes('data-route="m-a,m-b,m-d"'), '面板標出 F5 路線');
  assert(html.includes('圖m-a → 圖m-b → 圖m-d'), '路線用宿主給的名稱，不是另外一張名稱表');
  assert(html.includes('data-map-id="m-a"') && html.includes('data-on-route="1"') && html.includes('data-map-id="m-gone"') === false, '清單只列出可點的地圖，斷點目的地不在裡面');
  assert(html.includes('斷點 1'), '來源圖的清單列標出斷點');
  assert(moves.length === 0, '只畫面板不會自己下移動');
  assert(html.includes('data-testid="world-map-list"'), '尺寸未確認時先提供清單');
  assert(!html.includes('world-map-stage') && !html.includes('data-testid="world-map-node"'), '尺寸未確認時沒有空白畫布或不可見節點按鈕');
}

suite('F6: 角色所在由名冊組出來');
{
  const list = worldMapCharacters(
    [{ characterId: 'c2', name: '同伴', mapId: 'm-z' }],
    'c1',
    { characterId: 'c1', name: '旅人', mapId: 'm-a' },
  );
  assert(list.length === 2 && list.some(c => c.characterId === 'c1' && c.selected) && list.some(c => c.characterId === 'c2' && !c.selected), '視角角色是選定的那一位，名冊裡的其他人也在');
}

suite('F6: 窄欄與無畫布時只有可用清單，選角色須等宿主確認');
{
  const win = new Window();
  const rootEl = win.document.createElement('div');
  win.document.body.append(rootEl);
  Object.assign(globalThis, { window: win, document: win.document, IS_REACT_ACT_ENVIRONMENT: true });
  class FakeResizeObserver {
    static callback: (entries: Array<{ target: Element; contentRect: { width: number } }>) => void;
    constructor(fn: typeof FakeResizeObserver.callback) { FakeResizeObserver.callback = fn; }
    observe() {}
    disconnect() {}
  }
  Object.defineProperty(win, 'ResizeObserver', { value: FakeResizeObserver });
  const root = createRoot(rootEl as unknown as HTMLElement);
  let selected = 'c1';
  const switches: string[] = [];
  const moves: string[] = [];
  const render = () => act(() => root.render(
    <WorldMapPanel
      graph={world}
      characters={[
        { characterId: 'c1', name: '旅人', mapId: 'm-a', selected: selected === 'c1' },
        { characterId: 'c2', name: '同伴', mapId: 'm-z', selected: selected === 'c2' },
      ]}
      route={[]} running
      onSelectCharacter={id => switches.push(id)}
      onMoveTo={id => moves.push(`${selected}:${id}`)}
    />,
  ));
  render();
  const panel = rootEl.querySelector('[data-testid="world-map-panel"]')!;
  const resize = (width: number) => act(() => {
    FakeResizeObserver.callback([{ target: panel as unknown as Element, contentRect: { width } }]);
  });
  const stageOrHit = () => panel.querySelector('.world-map-stage, [data-testid="world-map-node"], [data-testid="world-map-legend"]');

  resize(360);
  assert(panel.getAttribute('data-narrow') === '1' && panel.querySelector('[data-testid="world-map-list"]') !== null, '360px 量測：清單是主要操作');
  assert(stageOrHit() === null, '窄欄不建立圖形舞台、幽靈熱區或圖例');
  const select = panel.querySelector('select')!;
  act(() => {
    select.value = 'c2';
    select.dispatchEvent(new win.Event('change', { bubbles: true }));
  });
  const destination = panel.querySelector('[data-testid="world-map-list-item"][data-map-id="m-d"]') as unknown as HTMLButtonElement;
  assert(switches.join() === 'c2' && destination.disabled, '換角色未確認前不允許下移動');
  act(() => destination.click());
  assert(moves.length === 0, '待確認時點目的地，不送指令');
  selected = 'c2';
  render();
  act(() => destination.click());
  assert(moves.join() === 'c2:m-d', '收到宿主確認後，只移動新選的角色');

  resize(900);
  assert(panel.getAttribute('data-narrow') === '0' && panel.textContent?.includes('環境畫不了圖'), '900px 但無 WebGL：明示清單替代圖形');
  assert(stageOrHit() === null && panel.querySelector('[data-testid="world-map-list"]') !== null, '無畫布時沒有空舞台或鍵盤可聚焦的隱形按鈕');
  resize(360);
  assert(panel.getAttribute('data-narrow') === '1' && !panel.textContent?.includes('環境畫不了圖') && stageOrHit() === null, '再縮回窄欄，保持清單且不報無畫布警訊');
  act(() => root.unmount());
  await win.close();
}

done();
