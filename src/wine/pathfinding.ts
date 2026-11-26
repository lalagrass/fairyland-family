/**
 * F15：視窗尋路的指令組裝與狀態文字。
 * 地圖代號與座標只接受呼叫端傳入的宿主快照或橋接回報，這裡不放任何原版地圖。
 */
import type { SceneSnapshot, SnapshotTerrain } from '../protocol/index';

export interface WalkToCommand {
  mapId: string;
  targetX: number;
  targetY: number;
}

export interface WinePathMap {
  mapId: string;
  mapName: string | null;
  pixelWidth: number;
  pixelHeight: number;
  characterX: number;
  characterY: number;
  terrain: SnapshotTerrain | null;
}

export interface WineNavStatus {
  running: boolean;
  state: string;
  mapId: string | null;
  currentPos: [number, number] | null;
  targetPos: [number, number] | null;
  waypoints: [number, number][];
  segmentIndex: number;
  totalSegments: number;
  replans: number;
  clicksSent: number;
  elapsedS: number;
  stopReason: string | null;
  coordSource: string | null;
}

const NAV_STATE_LABEL: Record<string, string> = {
  idle: '尚未開始',
  planning: '規劃路線',
  walking: '移動中',
  replanning: '重新規劃',
  arrived: '已到達',
  stopped: '已停下',
};

/** 橋接 stopReason。`coord_box_unsourced` 是缺出處，不是連線錯誤。 */
const NAV_STOP: Record<string, { text: string; tone: 'notice' | 'error' }> = {
  coord_box_unsourced: { text: '座標框尚無出處', tone: 'notice' },
  arrived: { text: '已到達', tone: 'notice' },
  user_stopped: { text: '已停下', tone: 'notice' },
  path_blocked: { text: '沒有可走的路', tone: 'notice' },
  timeout: { text: '逾時停下', tone: 'notice' },
  stuck: { text: '卡住後停下', tone: 'notice' },
  entered_battle: { text: '遇到戰鬥，已停下', tone: 'notice' },
  unexpected_scene: { text: '場景不對，已停下', tone: 'notice' },
  coord_read_failed: { text: '讀不到座標，已停下', tone: 'notice' },
  map_mismatch: { text: '地圖不符，已停下', tone: 'notice' },
  max_ticks: { text: '步數用完，已停下', tone: 'notice' },
  capture_error: { text: '擷取畫面失敗', tone: 'error' },
  input_error: { text: '送不出點擊', tone: 'error' },
  bridge_error: { text: '橋接錯誤', tone: 'error' },
};

export function buildWalkToBody(input: { mapId: string; targetX: number; targetY: number }): WalkToCommand {
  const mapId = input.mapId.trim();
  if (!mapId) throw new Error('缺少地圖');
  if (!Number.isFinite(input.targetX) || !Number.isFinite(input.targetY)) {
    throw new Error('目的地不是有限座標');
  }
  return { mapId, targetX: input.targetX, targetY: input.targetY };
}

/** 把地圖畫面上的點換算成宿主像素。寬高缺一或點在畫面外就回 null，不補預設地圖。 */
export function clickToWorld(input: {
  clickX: number;
  clickY: number;
  viewW: number;
  viewH: number;
  pixelWidth: number;
  pixelHeight: number;
}): { x: number; y: number } | null {
  const { clickX, clickY, viewW, viewH, pixelWidth, pixelHeight } = input;
  if (![viewW, viewH, pixelWidth, pixelHeight].every(n => Number.isFinite(n) && n > 0)) return null;
  if (!Number.isFinite(clickX) || !Number.isFinite(clickY)) return null;
  if (clickX < 0 || clickY < 0 || clickX > viewW || clickY > viewH) return null;
  return {
    x: (clickX / viewW) * pixelWidth,
    y: (clickY / viewH) * pixelHeight,
  };
}

function finitePoint(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [x, y] = value;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [x, y];
}

export function parseNavStatus(raw: unknown): WineNavStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.state !== 'string' && row.running !== true && row.running !== false && row.stopReason == null && row.mapId == null) {
    return null;
  }
  const waypoints = Array.isArray(row.waypoints)
    ? row.waypoints.map(finitePoint).filter((point): point is [number, number] => point !== null)
    : [];
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  return {
    running: row.running === true,
    state: typeof row.state === 'string' ? row.state : 'idle',
    mapId: typeof row.mapId === 'string' && row.mapId.trim() ? row.mapId : null,
    currentPos: finitePoint(row.currentPos),
    targetPos: finitePoint(row.targetPos),
    waypoints,
    segmentIndex: num(row.segmentIndex),
    totalSegments: num(row.totalSegments),
    replans: num(row.replans),
    clicksSent: num(row.clicksSent),
    elapsedS: num(row.elapsedS),
    stopReason: typeof row.stopReason === 'string' && row.stopReason ? row.stopReason : null,
    coordSource: typeof row.coordSource === 'string' && row.coordSource ? row.coordSource : null,
  };
}

/** 宿主快照裡有地圖寬高才畫得了點擊面。沒有就留空，不拿別張圖的尺寸代替。 */
export function pathMapFromSnapshot(snap: SceneSnapshot | null | undefined): WinePathMap | null {
  if (!snap) return null;
  const pixelWidth = snap.nav?.pixelWidth;
  const pixelHeight = snap.nav?.pixelHeight;
  if (typeof snap.mapId !== 'string' || !snap.mapId.trim()) return null;
  if (typeof pixelWidth !== 'number' || typeof pixelHeight !== 'number') return null;
  if (!Number.isFinite(pixelWidth) || !Number.isFinite(pixelHeight) || pixelWidth <= 0 || pixelHeight <= 0) return null;
  return {
    mapId: snap.mapId,
    mapName: snap.mapName ?? null,
    pixelWidth,
    pixelHeight,
    characterX: snap.character.x,
    characterY: snap.character.y,
    terrain: snap.nav?.terrain ?? null,
  };
}

export function formatNavProgress(nav: WineNavStatus | null | undefined): string {
  if (!nav || (nav.state === 'idle' && !nav.running && !nav.stopReason && !nav.targetPos)) return '尚未開始';
  const state = NAV_STATE_LABEL[nav.state] ?? nav.state;
  const segment = nav.totalSegments > 0 ? `第 ${Math.min(nav.totalSegments, nav.segmentIndex + 1)}/${nav.totalSegments} 段` : '';
  const pos = nav.currentPos ? `目前 (${nav.currentPos[0]}, ${nav.currentPos[1]})` : '';
  const target = nav.targetPos ? `目標 (${nav.targetPos[0]}, ${nav.targetPos[1]})` : '';
  return [state, segment, pos, target].filter(Boolean).join(' · ');
}

export function navStopPresentation(reason: string | null | undefined): { text: string; tone: 'none' | 'notice' | 'error' } {
  if (!reason) return { text: '', tone: 'none' };
  const known = NAV_STOP[reason];
  if (known) return known;
  return { text: reason, tone: 'notice' };
}
