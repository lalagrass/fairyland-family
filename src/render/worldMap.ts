import type { SnapshotPortalNode } from '../protocol/index';

/**
 * F6 世界地圖的畫面模型。
 * 座標全部由自動排版算出，不讀傳送點在遊戲世界裡的 x／y，也不認得任何具體地圖。
 * 圖本身只在執行期從宿主的 portalGraph 來。
 */

/** 節點圓的半徑。中心距必須大於直徑，圓才不會疊在一起。 */
export const WORLD_MAP_NODE_R = 18;
/** 節點中心的最小距離。 */
export const WORLD_MAP_MIN_DIST = 64;
/** 窄螢幕分界（與 style.css `@container world-map (max-width: 479px)` 相同）。 */
export const WORLD_MAP_NARROW_BELOW = 480;

export interface WorldMapCharacter {
  characterId: string;
  name: string | null;
  mapId: string;
  selected: boolean;
}

export interface WorldMapNodeView {
  mapId: string;
  name: string | null;
  x: number;
  y: number;
  r: number;
  /** 已匯入的地圖可點；通往未匯入地圖的斷點目的地不可點。 */
  clickable: boolean;
  onRoute: boolean;
  routeIndex: number;
  /** 從這張圖出發、目的地未匯入的傳送點數。 */
  brokenOut: number;
  characters: WorldMapCharacter[];
}

export interface WorldMapLinkView {
  key: string;
  from: string;
  to: string;
  portalId: string;
  portalName: string;
  /** 目的地圖未匯入（原版資料斷點）。 */
  broken: boolean;
  /** 落在 F5 已規劃的路線上（斷點不會被當成路線）。 */
  onRoute: boolean;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface WorldMapView {
  empty: boolean;
  width: number;
  height: number;
  nodes: WorldMapNodeView[];
  links: WorldMapLinkView[];
  brokenCount: number;
}

export interface WorldMapFit {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface WorldMapHitBox {
  mapId: string;
  left: number;
  top: number;
  size: number;
}

const EMPTY: WorldMapView = { empty: true, width: 1, height: 1, nodes: [], links: [], brokenCount: 0 };

/** 窄螢幕改顯示可點的地圖清單；寬螢幕以節點圖為主。 */
export function worldMapFrame(width: number): { narrow: boolean; showList: boolean } {
  const narrow = Number.isFinite(width) && width < WORLD_MAP_NARROW_BELOW;
  return { narrow, showList: narrow };
}

/** 把虛擬版面放進視窗，整張圖都看得到（等比，不裁切）。 */
export function fitWorldMap(viewW: number, viewH: number, boxW: number, boxH: number): WorldMapFit {
  if (!(viewW > 0) || !(viewH > 0) || !(boxW > 0) || !(boxH > 0)) return { scale: 1, offsetX: 0, offsetY: 0 };
  const scale = Math.min(boxW / viewW, boxH / viewH);
  return { scale, offsetX: (boxW - viewW * scale) / 2, offsetY: (boxH - viewH * scale) / 2 };
}

/** 可點節點在視窗裡的熱區。中心距大於直徑時，這些方塊不會互相重疊。 */
export function worldMapHitBoxes(view: WorldMapView, boxW: number, boxH: number): WorldMapHitBox[] {
  const fit = fitWorldMap(view.width, view.height, boxW, boxH);
  const hits: WorldMapHitBox[] = [];
  for (const n of view.nodes) {
    if (!n.clickable) continue;
    const size = n.r * 2 * fit.scale;
    hits.push({
      mapId: n.mapId,
      left: fit.offsetX + n.x * fit.scale - size / 2,
      top: fit.offsetY + n.y * fit.scale - size / 2,
      size,
    });
  }
  return hits;
}

export function worldMapCharacters(
  members: readonly { characterId: string; name: string | null; mapId: string }[],
  viewCharacterId: string | null,
  fallback: { characterId: string; name: string | null; mapId: string } | null,
): WorldMapCharacter[] {
  const list: WorldMapCharacter[] = members.map(m => ({
    characterId: m.characterId,
    name: m.name,
    mapId: m.mapId,
    selected: m.characterId === viewCharacterId,
  }));
  if (viewCharacterId && fallback && fallback.characterId === viewCharacterId && !list.some(c => c.characterId === viewCharacterId)) {
    list.push({ ...fallback, selected: true });
  }
  return list;
}

interface AttractEdge { a: string; b: string; weight: number }

/**
 * 力導向排版（Fruchterman-Reingold）後，把靠太近的節點推開。
 * 推不乾淨就改放到格子上。兩種結果中心距都不小於 minDist。
 * 初始位置只由節點 id 的排序決定，沒有手寫座標。
 */
export function layoutWorldNodes(
  ids: readonly string[],
  edges: readonly AttractEdge[],
  minDist = WORLD_MAP_MIN_DIST,
): Map<string, { x: number; y: number }> {
  const sorted = [...new Set(ids)].filter(Boolean).sort((a, b) => a.localeCompare(b));
  const key = `${minDist}|${sorted.join('\n')}|${edges.map(e => `${e.a}\0${e.b}\0${e.weight}`).join('\n')}`;
  const cached = readLayoutCache(key);
  if (cached) return cached;

  const pos = new Map<string, { x: number; y: number }>();
  if (sorted.length === 0) return pos;
  if (sorted.length === 1) {
    pos.set(sorted[0], { x: 0, y: 0 });
    writeLayoutCache(key, pos);
    return copyPos(pos);
  }
  const n = sorted.length;
  const radius = minDist / (2 * Math.sin(Math.PI / n));
  sorted.forEach((id, i) => {
    const ang = -Math.PI / 2 + (i / n) * Math.PI * 2;
    pos.set(id, { x: Math.cos(ang) * radius, y: Math.sin(ang) * radius });
  });
  relax(pos, sorted, edges, minDist);
  separate(pos, sorted, minDist);
  if (hasOverlap(pos, sorted, minDist)) packGrid(pos, sorted, minDist);
  writeLayoutCache(key, pos);
  return copyPos(pos);
}

let layoutCacheKey = '';
let layoutCache: Map<string, { x: number; y: number }> | null = null;

function readLayoutCache(key: string): Map<string, { x: number; y: number }> | null {
  if (key !== layoutCacheKey || !layoutCache) return null;
  return copyPos(layoutCache);
}

function writeLayoutCache(key: string, pos: Map<string, { x: number; y: number }>): void {
  layoutCacheKey = key;
  layoutCache = copyPos(pos);
}

function copyPos(pos: Map<string, { x: number; y: number }>): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  for (const [id, p] of pos) out.set(id, { x: p.x, y: p.y });
  return out;
}

function relax(
  pos: Map<string, { x: number; y: number }>,
  ids: string[],
  edges: readonly AttractEdge[],
  minDist: number,
): void {
  const k = minDist * 1.15;
  let temperature = minDist * 2;
  const usable = edges.filter(e => pos.has(e.a) && pos.has(e.b) && e.a !== e.b);
  for (let iter = 0; iter < 70; iter += 1) {
    const disp = new Map<string, { x: number; y: number }>();
    for (const id of ids) disp.set(id, { x: 0, y: 0 });
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = pos.get(ids[i])!;
        const b = pos.get(ids[j])!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d = Math.hypot(dx, dy);
        if (d < 1e-4) {
          const ang = (i + 1) * 2.399963;
          dx = Math.cos(ang);
          dy = Math.sin(ang);
          d = 1;
        }
        const force = (k * k) / d;
        const ux = dx / d;
        const uy = dy / d;
        const da = disp.get(ids[i])!;
        const db = disp.get(ids[j])!;
        da.x += ux * force;
        da.y += uy * force;
        db.x -= ux * force;
        db.y -= uy * force;
      }
    }
    for (const e of usable) {
      const a = pos.get(e.a)!;
      const b = pos.get(e.b)!;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d = Math.hypot(dx, dy) || 1e-4;
      const force = ((d * d) / k) * (e.weight > 0 ? e.weight : 1);
      const ux = dx / d;
      const uy = dy / d;
      const da = disp.get(e.a)!;
      const db = disp.get(e.b)!;
      da.x -= ux * force;
      da.y -= uy * force;
      db.x += ux * force;
      db.y += uy * force;
    }
    for (const id of ids) {
      const p = pos.get(id)!;
      const d = disp.get(id)!;
      const len = Math.hypot(d.x, d.y);
      if (len > 1e-6) {
        const step = Math.min(len, temperature);
        p.x += (d.x / len) * step;
        p.y += (d.y / len) * step;
      }
    }
    clampSpread(pos, ids, minDist);
    temperature *= 0.9;
  }
}

function clampSpread(pos: Map<string, { x: number; y: number }>, ids: string[], minDist: number): void {
  let cx = 0;
  let cy = 0;
  for (const id of ids) {
    const p = pos.get(id)!;
    cx += p.x;
    cy += p.y;
  }
  cx /= ids.length;
  cy /= ids.length;
  const limit = minDist * (ids.length + 2);
  for (const id of ids) {
    const p = pos.get(id)!;
    const dx = p.x - cx;
    const dy = p.y - cy;
    const d = Math.hypot(dx, dy);
    if (d > limit) {
      p.x = cx + (dx / d) * limit;
      p.y = cy + (dy / d) * limit;
    }
  }
}

function separate(pos: Map<string, { x: number; y: number }>, ids: string[], minDist: number): void {
  const maxIter = ids.length * 14 + 24;
  for (let iter = 0; iter < maxIter; iter += 1) {
    let moved = false;
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = pos.get(ids[i])!;
        const b = pos.get(ids[j])!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= minDist - 1e-4) continue;
        if (d < 1e-4) {
          const ang = (i + 1) * 2.399963 + j;
          dx = Math.cos(ang);
          dy = Math.sin(ang);
          d = 1;
        }
        const push = (minDist - d) / 2 + 0.05;
        const ux = dx / d;
        const uy = dy / d;
        a.x -= ux * push;
        a.y -= uy * push;
        b.x += ux * push;
        b.y += uy * push;
        moved = true;
      }
    }
    if (!moved) return;
  }
}

function hasOverlap(pos: Map<string, { x: number; y: number }>, ids: string[], minDist: number): boolean {
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = pos.get(ids[i])!;
      const b = pos.get(ids[j])!;
      if (Math.hypot(a.x - b.x, a.y - b.y) < minDist - 1e-3) return true;
    }
  }
  return false;
}

function packGrid(pos: Map<string, { x: number; y: number }>, ids: string[], minDist: number): void {
  const order = [...ids].sort((a, b) => {
    const pa = pos.get(a)!;
    const pb = pos.get(b)!;
    return pa.y - pb.y || pa.x - pb.x || a.localeCompare(b);
  });
  const cols = Math.max(1, Math.ceil(Math.sqrt(order.length)));
  order.forEach((id, i) => {
    pos.set(id, { x: (i % cols) * minDist, y: Math.floor(i / cols) * minDist });
  });
}

interface AccNode {
  mapId: string;
  name: string | null;
  portals: SnapshotPortalNode['portals'];
}

/** 由宿主的傳送點圖、角色所在與 F5 路線組成可畫的畫面。沒有圖就是空的。 */
export function buildWorldMapView(input: {
  graph: readonly SnapshotPortalNode[] | null | undefined;
  characters: readonly WorldMapCharacter[];
  route: readonly string[];
}): WorldMapView {
  const graph = input.graph ?? [];
  if (graph.length === 0) return EMPTY;

  const byId = new Map<string, AccNode>();
  for (const n of graph) {
    const prev = byId.get(n.mapId);
    if (!prev) byId.set(n.mapId, { mapId: n.mapId, name: n.name, portals: n.portals ?? [] });
    else {
      if (!prev.name && n.name) prev.name = n.name;
      prev.portals = [...prev.portals, ...(n.portals ?? [])];
    }
  }
  const incoming = new Map<string, string[]>();
  for (const n of byId.values()) {
    for (const p of n.portals) {
      if (!p.targetMapId || p.targetMapId === n.mapId) continue;
      const list = incoming.get(p.targetMapId) ?? [];
      list.push(p.targetStatus);
      incoming.set(p.targetMapId, list);
      if (!byId.has(p.targetMapId)) {
        byId.set(p.targetMapId, { mapId: p.targetMapId, name: p.targetMapName, portals: [] });
      } else if (!byId.get(p.targetMapId)!.name && p.targetMapName) {
        byId.get(p.targetMapId)!.name = p.targetMapName;
      }
    }
  }
  for (const c of input.characters) {
    if (c.mapId && !byId.has(c.mapId)) byId.set(c.mapId, { mapId: c.mapId, name: null, portals: [] });
  }
  for (const id of input.route) {
    if (id && !byId.has(id)) byId.set(id, { mapId: id, name: null, portals: [] });
  }

  const stub = (id: string): boolean => {
    const node = byId.get(id);
    if (!node || node.portals.length > 0) return false;
    const inc = incoming.get(id) ?? [];
    return inc.length > 0 && inc.every(s => s === 'NOT_IMPORTED');
  };

  const rawLinks: Array<Omit<WorldMapLinkView, 'x1' | 'y1' | 'x2' | 'y2'>> = [];
  for (const n of byId.values()) {
    for (const p of n.portals) {
      if (!p.targetMapId || p.targetMapId === n.mapId) continue;
      rawLinks.push({
        key: `${n.mapId}:${p.id}`,
        from: n.mapId,
        to: p.targetMapId,
        portalId: p.id,
        portalName: p.name,
        broken: p.targetStatus === 'NOT_IMPORTED',
        onRoute: false,
      });
    }
  }
  const hops = new Set<string>();
  for (let i = 0; i < input.route.length - 1; i += 1) hops.add(`${input.route[i]}\0${input.route[i + 1]}`);
  for (const l of rawLinks) l.onRoute = !l.broken && hops.has(`${l.from}\0${l.to}`);

  const attract = new Map<string, number>();
  for (const l of rawLinks) {
    const weight = l.broken || stub(l.to) ? 0.2 : 1;
    const [a, b] = l.from < l.to ? [l.from, l.to] : [l.to, l.from];
    const k = `${a}\0${b}`;
    attract.set(k, Math.max(attract.get(k) ?? 0, weight));
  }
  const edges: AttractEdge[] = [...attract.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, weight]) => {
      const [a, b] = k.split('\0');
      return { a, b, weight };
    });

  const ids = [...byId.keys()];
  const pos = layoutWorldNodes(ids, edges, WORLD_MAP_MIN_DIST);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of ids) {
    const p = pos.get(id) ?? { x: 0, y: 0 };
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) return EMPTY;
  const pad = WORLD_MAP_NODE_R + 16;
  const width = Math.max(1, maxX - minX) + pad * 2;
  const height = Math.max(1, maxY - minY) + pad * 2;

  const routeIndex = new Map<string, number>();
  input.route.forEach((id, i) => { if (id && !routeIndex.has(id)) routeIndex.set(id, i); });
  const brokenOut = new Map<string, number>();
  for (const l of rawLinks) if (l.broken) brokenOut.set(l.from, (brokenOut.get(l.from) ?? 0) + 1);
  const people = new Map<string, WorldMapCharacter[]>();
  for (const c of input.characters) {
    if (!c.mapId) continue;
    const list = people.get(c.mapId) ?? [];
    list.push(c);
    people.set(c.mapId, list);
  }

  const nodes: WorldMapNodeView[] = ids.sort((a, b) => a.localeCompare(b)).map(id => {
    const p = pos.get(id) ?? { x: minX, y: minY };
    const src = byId.get(id)!;
    const clickable = !stub(id);
    return {
      mapId: id,
      name: src.name,
      x: p.x - minX + pad,
      y: p.y - minY + pad,
      r: WORLD_MAP_NODE_R,
      clickable,
      onRoute: routeIndex.has(id),
      routeIndex: routeIndex.get(id) ?? -1,
      brokenOut: brokenOut.get(id) ?? 0,
      characters: (people.get(id) ?? []).slice().sort((a, b) => a.characterId.localeCompare(b.characterId)),
    };
  });
  const at = new Map(nodes.map(n => [n.mapId, n]));
  const links: WorldMapLinkView[] = rawLinks
    .map(l => {
      const a = at.get(l.from);
      const b = at.get(l.to);
      return { ...l, x1: a?.x ?? 0, y1: a?.y ?? 0, x2: b?.x ?? 0, y2: b?.y ?? 0 };
    })
    .sort((a, b) => a.key.localeCompare(b.key));

  return { empty: false, width, height, nodes, links, brokenCount: links.filter(l => l.broken).length };
}
