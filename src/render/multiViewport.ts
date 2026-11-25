export type MultiViewMode = 'single' | 'grid';
export type MultiViewPresentation = 'single' | 'grid' | 'carousel';

export const MIN_MULTI_TILES = 2;
export const MAX_MULTI_TILES = 4;
export const MULTI_VIEW_WIDE_BREAKPOINT = 768;
export const SWIPE_THRESHOLD_PX = 40;
export const MULTI_VIEW_STORAGE_KEY = 'fairyland_family:multi_view:v1';

interface KvStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export interface MultiViewLayoutInput {
  memberIds: readonly string[];
  mode: MultiViewMode;
  selectedIds?: readonly string[];
  focusId?: string | null;
  viewportWidth: number;
}

export interface MultiViewLayout {
  mode: MultiViewMode;
  presentation: MultiViewPresentation;
  columns: 1 | 2;
  rows: number;
  tileIds: string[];
  focusId: string | null;
  activeIndex: number;
}

function dedupeIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    if (typeof raw !== 'string' || !raw || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/**
 * 計算並排檢視的版面配置（純函式）：
 * - 單一模式：1 格。
 * - 並排模式：當家族成員 >= 2 時取 2–4 位不重複合法成員（不足 2 位則全選）。
 * - 寬螢幕（>= 768px）：2 欄 CSS Grid（2 人為 1x2，3–4 人為 2x2）。
 * - 窄螢幕（< 768px）：1 欄左右滑動輪播（carousel），以 activeIndex 追蹤目前可見格。
 */
export function computeMultiViewLayout(input: MultiViewLayoutInput): MultiViewLayout {
  const validMembers = dedupeIds(input.memberIds);
  const validSet = new Set(validMembers);

  if (input.mode === 'single') {
    const focusId =
      input.focusId && validSet.has(input.focusId) ? input.focusId : (validMembers[0] ?? null);
    const tileIds = focusId ? [focusId] : [];
    return {
      mode: 'single',
      presentation: 'single',
      columns: 1,
      rows: tileIds.length,
      tileIds,
      focusId,
      activeIndex: 0,
    };
  }

  let tileIds: string[];
  if (validMembers.length < MIN_MULTI_TILES) {
    tileIds = [...validMembers];
  } else {
    const requested = dedupeIds(input.selectedIds ?? []).filter(id => validSet.has(id));
    tileIds = requested.slice(0, MAX_MULTI_TILES);
    if (tileIds.length === 0) {
      // 尚未指定成員時，依 validMembers 順序預設選取最多 4 位成員（若 focusId 在第 4 名之後則替換末位，不打亂順序）
      tileIds = validMembers.slice(0, MAX_MULTI_TILES);
      if (input.focusId && validSet.has(input.focusId) && !tileIds.includes(input.focusId)) {
        tileIds[tileIds.length - 1] = input.focusId;
      }
    } else if (tileIds.length < MIN_MULTI_TILES) {
      if (input.focusId && validSet.has(input.focusId) && !tileIds.includes(input.focusId)) {
        tileIds.push(input.focusId);
      }
      for (const id of validMembers) {
        if (tileIds.length >= MIN_MULTI_TILES) break;
        if (!tileIds.includes(id)) tileIds.push(id);
      }
    }
  }

  const focusId =
    input.focusId && tileIds.includes(input.focusId) ? input.focusId : (tileIds[0] ?? null);
  const activeIndex = focusId ? Math.max(0, tileIds.indexOf(focusId)) : 0;
  const wide = input.viewportWidth >= MULTI_VIEW_WIDE_BREAKPOINT;

  if (wide) {
    const columns: 1 | 2 = tileIds.length >= MIN_MULTI_TILES ? 2 : 1;
    const rows = tileIds.length === 0 ? 0 : Math.ceil(tileIds.length / columns);
    return {
      mode: 'grid',
      presentation: 'grid',
      columns,
      rows,
      tileIds,
      focusId,
      activeIndex,
    };
  }

  return {
    mode: 'grid',
    presentation: 'carousel',
    columns: 1,
    rows: tileIds.length > 0 ? 1 : 0,
    tileIds,
    focusId,
    activeIndex,
  };
}

/** 計算各格目標幀率：可見焦點格 60fps、可見非焦點格 10fps、輪播隱藏格 0fps。 */
export function tileTargetFps(charId: string, focusId: string | null, visible: boolean): 0 | 10 | 60 {
  if (!visible) return 0;
  return focusId !== null && charId === focusId ? 60 : 10;
}

/** 計算各格 FX17 快照輪詢間隔：宿主主視角 0（主動推播）、焦點背景格 1500ms、非焦點背景格 4500ms。 */
export function tileSnapshotPollMs(
  charId: string,
  focusId: string | null,
  isHostViewed: boolean,
): 0 | 1500 | 4500 {
  if (isHostViewed) return 0;
  return focusId !== null && charId === focusId ? 1500 : 4500;
}

/** 解析觸控水平滑動方向：左滑 >= 40px 回 +1（下一位），右滑 >= 40px 回 -1（上一位），其餘 0。 */
export function resolveSwipeStep(
  startX: number,
  endX: number,
  startY?: number,
  endY?: number,
  thresholdPx = SWIPE_THRESHOLD_PX,
): -1 | 0 | 1 {
  const dx = endX - startX;
  if (startY !== undefined && endY !== undefined && Math.abs(endY - startY) > Math.abs(dx)) {
    return 0;
  }
  if (dx <= -thresholdPx) return 1;
  if (dx >= thresholdPx) return -1;
  return 0;
}

export function stepCarouselIndex(currentIndex: number, count: number, delta: -1 | 0 | 1): number {
  if (count <= 0) return 0;
  if (delta === 0) return Math.max(0, Math.min(count - 1, currentIndex));
  return (((currentIndex + delta) % count) + count) % count;
}

export function applyCarouselSwipe(
  tileIds: readonly string[],
  focusId: string | null,
  deltaX: number,
  deltaY = 0,
  thresholdPx = SWIPE_THRESHOLD_PX,
): string | null {
  if (tileIds.length === 0) return null;
  const currentIdx = focusId ? Math.max(0, tileIds.indexOf(focusId)) : 0;
  const step = resolveSwipeStep(0, deltaX, 0, deltaY, thresholdPx);
  if (step === 0) return tileIds[currentIdx] ?? null;
  const nextIdx = stepCarouselIndex(currentIdx, tileIds.length, step);
  return tileIds[nextIdx] ?? null;
}

/**
 * 確定性幀率節流器，給 PixiStageController 與 ModernStageController 共用：
 * - 第一幀立即允許繪製（除非 targetFps <= 0 且未強制）。
 * - 目標 FPS 提升（例如獲得焦點或輪播切回可見）或標記 dirty 時立即放行下一幀。
 * - 傳入 force = true 時強制放行。
 */
export class FrameThrottle {
  private targetFps: number;
  private lastRenderMs: number | null = null;
  private dirty = true;

  constructor(initialTargetFps = 60) {
    this.targetFps = Number.isFinite(initialTargetFps) ? Math.max(0, initialTargetFps) : 60;
  }

  getTargetFps(): number {
    return this.targetFps;
  }

  setTargetFps(fps: number): void {
    const next = Number.isFinite(fps) ? Math.max(0, fps) : 0;
    if (next > this.targetFps) {
      this.dirty = true;
    }
    this.targetFps = next;
  }

  markDirty(): void {
    this.dirty = true;
  }

  shouldRender(nowMs: number, force = false): boolean {
    if (this.targetFps <= 0 && !force) return false;
    if (force || this.dirty || this.lastRenderMs === null) {
      this.lastRenderMs = nowMs;
      this.dirty = false;
      return true;
    }
    if (nowMs < this.lastRenderMs) {
      this.lastRenderMs = nowMs;
      return true;
    }
    const minIntervalMs = Math.floor(1000 / this.targetFps);
    if (nowMs - this.lastRenderMs >= minIntervalMs) {
      this.lastRenderMs = nowMs;
      return true;
    }
    return false;
  }
}

export interface MultiViewPersistedState {
  mode: MultiViewMode;
  selectedIds: string[];
  focusId: string | null;
}

/** 並排畫面設定持久化（localStorage），損毀或無儲存空間時安全退回預設值。 */
export class MultiViewStore {
  private state: MultiViewPersistedState = {
    mode: 'single',
    selectedIds: [],
    focusId: null,
  };

  constructor(private storage: KvStorage | null = null) {
    if (!storage) return;
    try {
      const raw = storage.getItem(MULTI_VIEW_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<MultiViewPersistedState> | null;
      if (!parsed || typeof parsed !== 'object') return;
      const mode: MultiViewMode = parsed.mode === 'grid' ? 'grid' : 'single';
      const selectedIds = Array.isArray(parsed.selectedIds)
        ? dedupeIds(parsed.selectedIds.filter((x): x is string => typeof x === 'string')).slice(0, MAX_MULTI_TILES)
        : [];
      const focusId = typeof parsed.focusId === 'string' && parsed.focusId ? parsed.focusId : null;
      this.state = { mode, selectedIds, focusId };
    } catch {
      // 損毀資料當作沒設定
    }
  }

  get(): MultiViewPersistedState {
    return {
      mode: this.state.mode,
      selectedIds: [...this.state.selectedIds],
      focusId: this.state.focusId,
    };
  }

  setMode(mode: MultiViewMode): MultiViewPersistedState {
    return this.update({ mode });
  }

  setSelectedIds(selectedIds: readonly string[]): MultiViewPersistedState {
    return this.update({ selectedIds: dedupeIds(selectedIds).slice(0, MAX_MULTI_TILES) });
  }

  setFocusId(focusId: string | null): MultiViewPersistedState {
    return this.update({ focusId });
  }

  toggleSelected(charId: string, validMemberIds: readonly string[]): MultiViewPersistedState {
    const valid = dedupeIds(validMemberIds);
    const validSet = new Set(valid);
    if (!validSet.has(charId)) return this.get();

    const currentLayout = computeMultiViewLayout({
      memberIds: valid,
      mode: 'grid',
      selectedIds: this.state.selectedIds,
      focusId: this.state.focusId,
      viewportWidth: MULTI_VIEW_WIDE_BREAKPOINT,
    });
    const current = [...currentLayout.tileIds];
    const idx = current.indexOf(charId);
    let nextSelected: string[];
    let nextFocus = this.state.focusId;

    if (idx >= 0) {
      if (valid.length >= MIN_MULTI_TILES && current.length <= MIN_MULTI_TILES) {
        return this.update({ selectedIds: current, focusId: current.includes(nextFocus ?? '') ? nextFocus : current[0] ?? null });
      }
      nextSelected = current.filter(id => id !== charId);
      if (nextFocus === charId) nextFocus = nextSelected[0] ?? null;
    } else if (current.length < MAX_MULTI_TILES) {
      nextSelected = [...current, charId];
    } else {
      // 已達 4 人上限時，替換最後一位非焦點成員
      const dropIdx = [...current].reverse().findIndex(id => id !== this.state.focusId);
      const removeAt = dropIdx >= 0 ? current.length - 1 - dropIdx : current.length - 1;
      nextSelected = current.filter((_, i) => i !== removeAt);
      nextSelected.push(charId);
    }
    return this.update({ selectedIds: nextSelected, focusId: nextFocus });
  }

  update(patch: Partial<MultiViewPersistedState>): MultiViewPersistedState {
    const next: MultiViewPersistedState = {
      mode: patch.mode ?? this.state.mode,
      selectedIds: patch.selectedIds !== undefined
        ? dedupeIds(patch.selectedIds).slice(0, MAX_MULTI_TILES)
        : this.state.selectedIds,
      focusId: patch.focusId !== undefined ? patch.focusId : this.state.focusId,
    };
    this.state = next;
    try {
      this.storage?.setItem(MULTI_VIEW_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // 儲存空間不可用時忽略
    }
    return this.get();
  }
}
