import type { FamilyState } from '../state';
import { unpackBlockedCells } from '../protocol/terrain';
import { interpolateMemberPosition, interpolatePath, selectCameraTarget } from './extrapolation';
import { observerStatus, type ObserverStatus } from './observer';

/**
 * F4a 顯示模式：原版（沿用 PixiStageController）或現代（ModernStageController，全部程式繪製）。
 * 這個檔案只有「純函式＋本機設定」：從快照／事件算出要畫什麼，不送指令、不動時鐘、不算規則。
 */
export type ViewMode = 'original' | 'modern';

export const VIEW_MODES: ReadonlyArray<{ id: ViewMode; label: string }> = [
  { id: 'original', label: '原版' },
  { id: 'modern', label: '現代' },
];

interface KvStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

const STORAGE_KEY = 'fairyland_family:char_view_modes:v1';

export function parseViewMode(v: unknown): ViewMode {
  return v === 'modern' ? 'modern' : 'original';
}

/** 每個角色各自選的顯示模式（本機設定，存 localStorage）。 */
export class CharacterViewModeStore {
  private map = new Map<string, ViewMode>();

  constructor(private storage: KvStorage | null = null) {
    if (!storage) return;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [cid, m] of Object.entries(parsed)) if (cid && m === 'modern') this.map.set(cid, 'modern');
    } catch {
      // 損毀資料當作沒設定
    }
  }

  get(characterId: string | null | undefined): ViewMode {
    return characterId ? (this.map.get(characterId) ?? 'original') : 'original';
  }

  set(characterId: string, mode: ViewMode): ViewMode {
    if (mode === 'modern') this.map.set(characterId, 'modern');
    else this.map.delete(characterId);
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.snapshotAll()));
    } catch {
      // 空間限制：忽略，本次仍生效
    }
    return mode;
  }

  snapshotAll(): Record<string, ViewMode> {
    const out: Record<string, ViewMode> = {};
    for (const [k, v] of this.map) out[k] = v;
    return out;
  }
}

// ---------------------------------------------------------------------------
// 現代模式：畫面模型（純資料）
// ---------------------------------------------------------------------------

export interface ModernMarker {
  id: string;
  kind: 'member' | 'npc' | 'shop' | 'exit' | 'gather';
  name: string;
  x: number;
  y: number;
  isTarget?: boolean;
}

/** 宿主碰撞格。`blocked` 是快照上的 base64，給顯示層當快取鍵；`cells` 是 0／1。 */
export interface ModernTerrain {
  cols: number;
  rows: number;
  blocked: string;
  cells: Uint8Array;
}

export interface ModernViewModel {
  /** 沒有畫面可畫時（未連線、沒快照）的明確狀態；OK 才畫地圖。 */
  status: ObserverStatus;
  mapName: string;
  mapW: number;
  mapH: number;
  target: { characterId: string; name: string; x: number; y: number } | null;
  markers: ModernMarker[];
  /** 觀察對象從目前位置到終點的路徑（世界座標）。 */
  path: Array<{ x: number; y: number }>;
  /** 沒有地形時現代檢視退回底色格線。 */
  terrain: ModernTerrain | null;
}

let terrainCache: { key: string; cells: Uint8Array } | null = null;

function terrainOf(snap: NonNullable<FamilyState['snapshot']>): ModernTerrain | null {
  const t = snap.nav?.terrain;
  if (!t) return null;
  const key = `${t.cols}x${t.rows}:${t.blocked}`;
  if (!terrainCache || terrainCache.key !== key) {
    const cells = unpackBlockedCells(t);
    if (!cells) return null;
    terrainCache = { key, cells };
  }
  return { cols: t.cols, rows: t.rows, blocked: t.blocked, cells: terrainCache.cells };
}

const DEFAULT_MAP_SIZE = 8000;

export function buildModernModel(state: FamilyState, watchCharacterId: string | null, now: number): ModernViewModel {
  const status = observerStatus(state, watchCharacterId, now);
  const snap = state.snapshot;
  const empty: ModernViewModel = { status, mapName: snap?.mapName ?? '', mapW: DEFAULT_MAP_SIZE, mapH: DEFAULT_MAP_SIZE, target: null, markers: [], path: [], terrain: snap ? terrainOf(snap) : null };
  if (!snap) return empty;
  const t = selectCameraTarget(state, watchCharacterId, now);
  const markers: ModernMarker[] = [];
  for (const e of snap.exits ?? []) markers.push({ id: `exit:${e.id}`, kind: 'exit', name: e.name, x: e.x, y: e.y });
  for (const n of snap.npcs ?? []) markers.push({ id: `npc:${n.id}`, kind: n.isShop ? 'shop' : 'npc', name: n.name, x: n.x, y: n.y });
  for (const g of snap.gatherPoints?.points ?? []) {
    if (!g.mapId || g.mapId === snap.mapId) markers.push({ id: `gather:${g.id}`, kind: 'gather', name: g.name, x: g.x, y: g.y });
  }
  const activeId = state.activeCharacterId ?? state.characterId ?? snap.family?.activeCharacterId ?? null;
  for (const m of state.members) {
    if (m.mapId !== snap.mapId) continue;
    const p = m.characterId === activeId ? interpolateCharacter(state, now) : interpolateMemberPosition(m, now);
    markers.push({ id: `member:${m.characterId}`, kind: 'member', name: m.name ?? m.characterId, x: p.x, y: p.y, isTarget: m.characterId === t?.characterId });
  }
  if (!state.members.some(m => m.characterId === activeId)) {
    const p = interpolateCharacter(state, now);
    markers.push({ id: `member:${activeId ?? 'active'}`, kind: 'member', name: snap.character.name ?? '角色', x: p.x, y: p.y, isTarget: !t || t.characterId === activeId });
  }
  const mapW = snap.nav?.pixelWidth ?? DEFAULT_MAP_SIZE;
  const mapH = snap.nav?.pixelHeight ?? DEFAULT_MAP_SIZE;
  const sameMap = !!t && t.mapId === snap.mapId;
  return {
    status,
    mapName: snap.mapName ?? snap.mapId,
    mapW: mapW > 0 ? mapW : DEFAULT_MAP_SIZE,
    mapH: mapH > 0 ? mapH : DEFAULT_MAP_SIZE,
    target: t && sameMap ? { characterId: t.characterId, name: t.name, x: t.x, y: t.y } : null,
    markers,
    path: sameMap && t ? remainingPath(state, t.characterId, activeId, now) : [],
    terrain: terrainOf(snap),
  };
}

function interpolateCharacter(state: FamilyState, now: number): { x: number; y: number } {
  const c = state.snapshot!.character;
  return c.movePath && c.movePath.waypoints.length >= 2 ? interpolatePath(c.movePath, now, c.x, c.y, c.dir) : { x: c.x, y: c.y };
}

function remainingPath(state: FamilyState, characterId: string, activeId: string | null, now: number): Array<{ x: number; y: number }> {
  const mp = characterId === activeId ? state.snapshot?.character.movePath : state.members.find(m => m.characterId === characterId)?.movePath;
  return pathAhead(mp ?? null, now);
}

/** 路徑線：從目前插值位置到終點。走完或沒路徑回傳空陣列。 */
export function pathAhead(
  mp: { waypoints: Array<{ x: number; y: number }>; startedAt: number; endsAt: number } | null,
  now: number,
): Array<{ x: number; y: number }> {
  if (!mp || mp.waypoints.length < 2 || now >= mp.endsAt) return [];
  const cur = interpolatePath(mp as Parameters<typeof interpolatePath>[0], now, mp.waypoints[0].x, mp.waypoints[0].y, 0);
  const pts = mp.waypoints;
  // 找出目前位置所在的線段，丟掉已走過的點
  let idx = 0;
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const d = distToSegment(cur.x, cur.y, pts[i], pts[i + 1]);
    if (d <= best + 0.001) { best = Math.min(best, d); idx = i; }
  }
  return [{ x: cur.x, y: cur.y }, ...pts.slice(idx + 1)];
}

function distToSegment(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

// ---------------------------------------------------------------------------
// 鏡頭、縮放、小地圖、版面（純數學）
// ---------------------------------------------------------------------------

export interface CameraState { x: number; y: number; mapKey: string }

export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 2;

export function clampZoom(z: number): number {
  return Number.isFinite(z) ? Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z)) : 1;
}

/** 平滑跟隨：指數趨近目標；換地圖或距離極遠時直接定位，避免飛越整張圖。 */
export function stepCamera(cam: CameraState | null, target: { x: number; y: number }, mapKey: string, dtMs: number, halfLifeMs = 120): CameraState {
  if (!cam || cam.mapKey !== mapKey || Math.hypot(target.x - cam.x, target.y - cam.y) > 4000) return { x: target.x, y: target.y, mapKey };
  const k = 1 - Math.pow(0.5, Math.max(0, dtMs) / halfLifeMs);
  return { x: cam.x + (target.x - cam.x) * k, y: cam.y + (target.y - cam.y) * k, mapKey };
}

/** 鏡頭中心夾在地圖範圍內（地圖比視窗小就置中）。 */
export function clampCamera(c: { x: number; y: number }, mapW: number, mapH: number, viewW: number, viewH: number, zoom: number): { x: number; y: number } {
  const hw = viewW / zoom / 2, hh = viewH / zoom / 2;
  const cl = (v: number, size: number, half: number) => (size <= half * 2 ? size / 2 : Math.max(half, Math.min(size - half, v)));
  return { x: cl(c.x, mapW, hw), y: cl(c.y, mapH, hh) };
}

export interface ModernLayout { narrow: boolean; miniW: number; miniH: number; margin: number; fontSize: number }

/** 窄螢幕（手機）用小一點的小地圖與字，避免蓋住畫面。 */
export function modernLayout(viewW: number, viewH: number, mapW: number, mapH: number): ModernLayout {
  const narrow = viewW < 480;
  const maxSide = Math.round(Math.min(narrow ? 84 : 150, viewW * 0.3, viewH * 0.4));
  const aspect = mapW > 0 && mapH > 0 ? mapW / mapH : 1;
  const miniW = aspect >= 1 ? maxSide : Math.max(24, Math.round(maxSide * aspect));
  const miniH = aspect >= 1 ? Math.max(24, Math.round(maxSide / aspect)) : maxSide;
  return { narrow, miniW, miniH, margin: narrow ? 6 : 10, fontSize: narrow ? 10 : 12 };
}

export function minimapPoint(x: number, y: number, mapW: number, mapH: number, miniW: number, miniH: number): { x: number; y: number } {
  return { x: Math.max(0, Math.min(1, x / mapW)) * miniW, y: Math.max(0, Math.min(1, y / mapH)) * miniH };
}

/** 小地圖上點一下 → 世界座標（用於把鏡頭移過去；只是看，不送移動指令）。 */
export function minimapToWorld(px: number, py: number, mapW: number, mapH: number, miniW: number, miniH: number): { x: number; y: number } {
  return { x: Math.max(0, Math.min(1, px / miniW)) * mapW, y: Math.max(0, Math.min(1, py / miniH)) * mapH };
}

/** 兩種模式共用的「現在畫得出什麼」：未連線／沒快照時兩種模式都顯示同一句明確說明。 */
export function stageDisplayState(state: FamilyState, mode: ViewMode, watchCharacterId: string | null, now: number): { mode: ViewMode; status: ObserverStatus } {
  return { mode, status: observerStatus(state, watchCharacterId, now) };
}
