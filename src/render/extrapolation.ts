import type {
  CharacterVisualAction,
  SnapshotFamilyMember,
  SnapshotMovePath,
} from '../protocol/index';
import type { FamilyState } from '../state';

/**
 * 與 fairyland 伺服器／客戶端一致的 8 方向索引：
 * 0=S, 1=SW, 2=W, 3=NW, 4=N, 5=NE, 6=E, 7=SE
 */
export function getDirection8(dx: number, dy: number, fallback = 0): number {
  if (dx === 0 && dy === 0) return fallback;
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (deg >= 67.5 && deg < 112.5) return 0; // S
  if (deg >= 112.5 && deg < 157.5) return 1; // SW
  if (deg >= 157.5 || deg < -157.5) return 2; // W
  if (deg >= -157.5 && deg < -112.5) return 3; // NW
  if (deg >= -112.5 && deg < -67.5) return 4; // N
  if (deg >= -67.5 && deg < -22.5) return 5; // NE
  if (deg >= -22.5 && deg < 22.5) return 6; // E
  return 7; // SE
}

export function visualActionToCode(action?: CharacterVisualAction): number {
  switch (action) {
    case 'WALK':
      return 1;
    case 'WORK':
      return 20;
    case 'BATTLE':
      return 4;
    case 'IDLE':
    default:
      return 0;
  }
}

export interface InterpolatedPose {
  x: number;
  y: number;
  dir: number;
  isMoving: boolean;
  visualAction: CharacterVisualAction;
  actionCode: number;
}

export function interpolatePath(
  movePath: SnapshotMovePath,
  nowMs: number,
  fallbackX: number,
  fallbackY: number,
  fallbackDir: number,
): { x: number; y: number; dir: number; isMoving: boolean } {
  const pts = movePath.waypoints;
  if (!pts || pts.length === 0) {
    return { x: fallbackX, y: fallbackY, dir: fallbackDir, isMoving: false };
  }
  if (pts.length === 1) {
    return { x: pts[0].x, y: pts[0].y, dir: fallbackDir, isMoving: false };
  }

  const span = Math.max(1, movePath.endsAt - movePath.startedAt);
  const rawT = (nowMs - movePath.startedAt) / span;
  const t = Math.max(0, Math.min(1, rawT));
  const isMoving = nowMs >= movePath.startedAt && nowMs < movePath.endsAt;

  let totalLen = 0;
  const segLens: number[] = [];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    segLens.push(len);
    totalLen += len;
  }

  if (totalLen <= 0.001 || t >= 1) {
    const last = pts[pts.length - 1];
    const prev = pts[pts.length - 2];
    const dir = getDirection8(last.x - prev.x, last.y - prev.y, fallbackDir);
    return { x: last.x, y: last.y, dir, isMoving: false };
  }

  let targetDist = totalLen * t;
  for (let i = 0; i < segLens.length; i += 1) {
    const len = segLens[i];
    if (targetDist <= len || i === segLens.length - 1) {
      const a = pts[i];
      const b = pts[i + 1];
      const frac = len > 0.001 ? Math.max(0, Math.min(1, targetDist / len)) : 1;
      const dir = getDirection8(b.x - a.x, b.y - a.y, fallbackDir);
      return {
        x: Math.round(a.x + (b.x - a.x) * frac),
        y: Math.round(a.y + (b.y - a.y) * frac),
        dir,
        isMoving,
      };
    }
    targetDist -= len;
  }

  const end = pts[pts.length - 1];
  return { x: end.x, y: end.y, dir: fallbackDir, isMoving: false };
}

export function interpolateMemberPosition(
  member: Pick<
    SnapshotFamilyMember,
    'x' | 'y' | 'dir' | 'action' | 'movePath' | 'activeWork'
  >,
  nowMs: number,
): InterpolatedPose {
  const dir = member.dir ?? 0;
  if (member.movePath && member.movePath.waypoints.length >= 2) {
    const p = interpolatePath(member.movePath, nowMs, member.x, member.y, dir);
    const visualAction: CharacterVisualAction = p.isMoving
      ? 'WALK'
      : (member.action ?? (member.activeWork ? 'WORK' : 'IDLE'));
    return {
      x: p.x,
      y: p.y,
      dir: p.dir,
      isMoving: p.isMoving,
      visualAction,
      actionCode: visualActionToCode(visualAction),
    };
  }
  const visualAction: CharacterVisualAction =
    member.action ?? (member.activeWork ? 'WORK' : 'IDLE');
  return {
    x: member.x,
    y: member.y,
    dir,
    isMoving: visualAction === 'WALK',
    visualAction,
    actionCode: visualActionToCode(visualAction),
  };
}

export interface CameraTarget {
  characterId: string;
  name: string;
  mapId: string;
  x: number;
  y: number;
  dir: number;
  sameMapAsSnapshot: boolean;
}

/** 選取目前鏡頭要追隨的角色：優先看 watchCharacterId（若存在於家族名冊），否則跟隨當前 active 角色。 */
export function selectCameraTarget(
  state: FamilyState,
  watchCharacterId: string | null,
  nowMs: number = Date.now(),
): CameraTarget | null {
  const snap = state.snapshot;
  const activeId = state.activeCharacterId ?? state.characterId ?? snap?.family?.activeCharacterId ?? 'active';
  const currentMap = snap?.mapId ?? '';
  if (watchCharacterId) {
    const m = state.members.find(x => x.characterId === watchCharacterId);
    if (m) {
      const sameMap = !currentMap || m.mapId === currentMap;
      if (snap && m.characterId === activeId) {
        const c = snap.character;
        const p = c.movePath && c.movePath.waypoints.length >= 2
          ? interpolatePath(c.movePath, nowMs, c.x, c.y, c.dir)
          : { x: c.x, y: c.y, dir: c.dir, isMoving: c.action === 'WALK' };
        return {
          characterId: m.characterId,
          name: c.name ?? m.name ?? m.characterId,
          mapId: snap.mapId,
          x: p.x,
          y: p.y,
          dir: p.dir,
          sameMapAsSnapshot: true,
        };
      }
      const p = interpolateMemberPosition(m, nowMs);
      return {
        characterId: m.characterId,
        name: m.name ?? m.characterId,
        mapId: m.mapId,
        x: p.x,
        y: p.y,
        dir: p.dir,
        sameMapAsSnapshot: sameMap,
      };
    }
  }
  if (snap) {
    const c = snap.character;
    if (c.movePath && c.movePath.waypoints.length >= 2) {
      const p = interpolatePath(c.movePath, nowMs, c.x, c.y, c.dir);
      return {
        characterId: activeId,
        name: c.name ?? activeId,
        mapId: snap.mapId,
        x: p.x,
        y: p.y,
        dir: p.dir,
        sameMapAsSnapshot: true,
      };
    }
    return {
      characterId: activeId,
      name: c.name ?? activeId,
      mapId: snap.mapId,
      x: c.x,
      y: c.y,
      dir: c.dir,
      sameMapAsSnapshot: true,
    };
  }
  return null;
}

/** 計算預設整數放大倍率，確保像素保持清晰不模糊。 */
export function computeIntegerScale(viewWidth: number, viewHeight: number): number {
  const minDim = Math.min(Math.max(1, viewWidth), Math.max(1, viewHeight));
  if (minDim >= 900) return 2;
  return 1;
}
