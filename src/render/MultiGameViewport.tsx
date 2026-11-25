import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { FamilyState } from '../state';
import type { AppearanceProvider } from './appearance';
import { RuntimeAssetLoader } from './assetLoader';
import { GameViewport } from './GameViewport';
import {
  MULTI_VIEW_WIDE_BREAKPOINT,
  MultiViewStore,
  SWIPE_THRESHOLD_PX,
  computeMultiViewLayout,
  resolveSwipeStep,
  stepCarouselIndex,
  tileTargetFps,
} from './multiViewport';
import { VIEW_MODES, parseViewMode, type ViewMode } from './viewMode';

interface KvStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export interface MultiGameViewportProps {
  state: FamilyState;
  characterStates?: Record<string, FamilyState>;
  watchCharacterId: string | null;
  onSelectWatchCharacter: (id: string) => void;
  onSwitchHostCharacter: (characterId: string) => void;
  onWatchChange?: (charIds: string[], focusId: string | null) => void;
  appearances?: Record<string, string>;
  viewModes?: Record<string, ViewMode>;
  onSetViewMode?: (characterId: string, mode: ViewMode) => void;
  provider?: AppearanceProvider;
  running?: boolean;
  storage?: KvStorage | null;
  /** 測試可注入模擬視窗寬度（預設讀 window.innerWidth 並監聽 resize）。 */
  viewportWidth?: number;
}

function defaultStorage(): KvStorage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function MultiGameViewport({
  state,
  characterStates,
  watchCharacterId,
  onSelectWatchCharacter,
  onSwitchHostCharacter,
  onWatchChange,
  appearances,
  viewModes,
  onSetViewMode,
  provider,
  running = false,
  storage,
  viewportWidth,
}: MultiGameViewportProps) {
  const sharedLoader = useMemo(() => new RuntimeAssetLoader(), []);
  const store = useMemo(() => new MultiViewStore(storage !== undefined ? storage : defaultStorage()), [storage]);
  const [mvState, setMvState] = useState(() => store.get());
  const [measuredWidth, setMeasuredWidth] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth : MULTI_VIEW_WIDE_BREAKPOINT,
  );
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const onWatchChangeRef = useRef(onWatchChange);
  onWatchChangeRef.current = onWatchChange;

  useEffect(() => {
    if (viewportWidth !== undefined || typeof window === 'undefined') return;
    const onResize = () => setMeasuredWidth(window.innerWidth);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [viewportWidth]);

  const effectiveWidth = viewportWidth ?? measuredWidth;
  const snap = state.snapshot;
  const hostActiveId =
    state.activeCharacterId ?? state.characterId ?? snap?.family?.activeCharacterId ?? '';

  const memberIds = useMemo(() => {
    const ids = state.members.map(m => m.characterId);
    if (state.characterId && !ids.includes(state.characterId)) ids.unshift(state.characterId);
    return ids;
  }, [state.members, state.characterId]);

  const memberNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of state.members) map.set(m.characterId, m.name ?? m.characterId);
    if (state.characterId && !map.has(state.characterId)) {
      map.set(state.characterId, state.character?.name ?? state.characterId);
    }
    return map;
  }, [state.members, state.characterId, state.character?.name]);

  const layout = useMemo(
    () =>
      computeMultiViewLayout({
        memberIds,
        mode: mvState.mode,
        selectedIds: mvState.selectedIds,
        focusId: mvState.focusId ?? (hostActiveId || null),
        viewportWidth: effectiveWidth,
      }),
    [memberIds, mvState.mode, mvState.selectedIds, mvState.focusId, hostActiveId, effectiveWidth],
  );

  const watchKey = layout.mode === 'grid' ? `${layout.tileIds.join(',')}|${layout.focusId ?? ''}` : '|';
  useEffect(() => {
    const ids = layout.mode === 'grid' ? layout.tileIds : [];
    const focus = layout.mode === 'grid' ? layout.focusId : null;
    // 延後到 React commit 之後再通知 controller，避免在 lifecycle 內同步觸發 flushSync
    const timer = setTimeout(() => {
      onWatchChangeRef.current?.(ids, focus);
    }, 0);
    return () => clearTimeout(timer);
  }, [watchKey]);

  const setFocus = (cid: string) => {
    setMvState(store.setFocusId(cid));
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    const t = e.touches?.[0] ?? e.changedTouches?.[0];
    touchStartRef.current = t ? { x: t.clientX, y: t.clientY } : null;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start || layout.tileIds.length <= 1) return;
    const t = e.changedTouches?.[0] ?? e.touches?.[0];
    if (!t) return;
    const step = resolveSwipeStep(start.x, t.clientX, start.y, t.clientY, SWIPE_THRESHOLD_PX);
    if (step === 0) return;
    const nextIdx = stepCarouselIndex(layout.activeIndex, layout.tileIds.length, step);
    const nextId = layout.tileIds[nextIdx];
    if (nextId) setFocus(nextId);
  };

  const stepCarousel = (delta: -1 | 1) => {
    if (layout.tileIds.length <= 1) return;
    const nextIdx = stepCarouselIndex(layout.activeIndex, layout.tileIds.length, delta);
    const nextId = layout.tileIds[nextIdx];
    if (nextId) setFocus(nextId);
  };

  return (
    <div className="multiview-shell" data-testid="multiview-shell" data-mode={layout.mode}>
      <div className="multiview-toolbar" data-testid="multiview-toolbar">
        <button
          type="button"
          className={`item ${layout.mode === 'grid' ? 'tab-active' : ''}`}
          data-testid="multiview-toggle"
          aria-pressed={layout.mode === 'grid'}
          onClick={() => setMvState(store.setMode(layout.mode === 'grid' ? 'single' : 'grid'))}
        >
          {layout.mode === 'grid' ? '單一畫面' : '並排畫面'}
        </button>
        {layout.mode === 'grid' && memberIds.length > 0 && (
          <div className="multiview-member-pills" role="group" aria-label="選擇並排角色（2–4 位）">
            {memberIds.map(cid => {
              const selected = layout.tileIds.includes(cid);
              const name = memberNames.get(cid) ?? cid;
              return (
                <button
                  key={cid}
                  type="button"
                  className={`item ${selected ? 'tab-active' : ''}`}
                  data-testid={`multiview-member-pill-${cid}`}
                  aria-pressed={selected}
                  onClick={() => setMvState(store.toggleSelected(cid, memberIds))}
                >
                  {name}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {layout.mode === 'single' ? (
        <GameViewport
          state={state}
          watchCharacterId={watchCharacterId}
          onSelectWatchCharacter={onSelectWatchCharacter}
          appearances={appearances}
          viewModes={viewModes}
          onSetViewMode={onSetViewMode}
          provider={provider}
          sharedLoader={sharedLoader}
        />
      ) : layout.tileIds.length === 0 ? (
        <section className="stage-panel" data-testid="multiview-empty">
          <div className="muted">尚未收到家族成員快照，連線後即可並排顯示 2–4 位角色畫面。</div>
        </section>
      ) : (
        <>
          {layout.presentation === 'carousel' && (
            <div className="multiview-carousel-nav" data-testid="multiview-carousel-nav">
              <button
                type="button"
                className="item"
                data-testid="multiview-prev"
                disabled={layout.tileIds.length <= 1}
                onClick={() => stepCarousel(-1)}
              >
                上一位
              </button>
              <div className="multiview-carousel-pills">
                {layout.tileIds.map((cid, idx) => {
                  const active = idx === layout.activeIndex;
                  return (
                    <button
                      key={cid}
                      type="button"
                      className={`item ${active ? 'tab-active' : ''}`}
                      data-testid={`multiview-slide-pill-${cid}`}
                      aria-current={active ? 'true' : undefined}
                      onClick={() => setFocus(cid)}
                    >
                      {memberNames.get(cid) ?? cid}
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                className="item"
                data-testid="multiview-next"
                disabled={layout.tileIds.length <= 1}
                onClick={() => stepCarousel(1)}
              >
                下一位
              </button>
            </div>
          )}

          <div
            className={layout.presentation === 'carousel' ? 'multiview-carousel' : 'multiview-grid'}
            data-testid={layout.presentation === 'carousel' ? 'multiview-carousel' : 'multiview-grid'}
            data-columns={String(layout.columns)}
            onTouchStart={layout.presentation === 'carousel' ? handleTouchStart : undefined}
            onTouchEnd={layout.presentation === 'carousel' ? handleTouchEnd : undefined}
          >
            {layout.tileIds.map((cid, idx) => {
              const isFocused = cid === layout.focusId;
              const visible = layout.presentation !== 'carousel' || idx === layout.activeIndex;
              const fps = tileTargetFps(cid, layout.focusId, visible);
              const tileRaw = characterStates?.[cid];
              const tileState = tileRaw && (tileRaw.snapshot || tileRaw.battle) ? tileRaw : state;
              const member = state.members.find(m => m.characterId === cid);
              const tileName = memberNames.get(cid) ?? tileState.snapshot?.character?.name ?? cid;
              const tileMapName =
                tileState.snapshot?.mapName ?? member?.mapName ?? member?.mapId ?? '未連線';
              const tileViewMode = parseViewMode(viewModes?.[cid]);
              const isHostActive = cid === hostActiveId;

              return (
                <article
                  key={cid}
                  className={`multiview-tile ${isFocused ? 'is-focused' : ''} ${!visible ? 'multiview-tile-hidden' : ''}`}
                  data-testid={`multiview-tile-${cid}`}
                  data-focused={isFocused ? 'true' : 'false'}
                  data-visible={visible ? 'true' : 'false'}
                  data-target-fps={String(fps)}
                  aria-hidden={!visible || undefined}
                  onClick={() => setFocus(cid)}
                >
                  <div className="multiview-tile-head">
                    <div className="multiview-tile-title">
                      <strong>{tileName}</strong>
                      <span className="muted">{tileMapName}</span>
                      <span className={`pill ${isFocused ? 'ok' : ''}`}>
                        {`${isHostActive ? '主視角' : isFocused ? '焦點' : '背景'} · ${fps}fps`}
                      </span>
                    </div>
                    <div className="multiview-tile-controls">
                      <select
                        aria-label={`${tileName} 地圖顯示模式`}
                        data-testid={`multiview-view-mode-${cid}`}
                        value={tileViewMode}
                        disabled={!onSetViewMode}
                        onClick={e => e.stopPropagation()}
                        onChange={e => {
                          e.stopPropagation();
                          onSetViewMode?.(cid, parseViewMode(e.currentTarget.value));
                        }}
                      >
                        {VIEW_MODES.map(m => (
                          <option key={m.id} value={m.id}>{m.label}</option>
                        ))}
                      </select>
                      {!isHostActive && (
                        <button
                          type="button"
                          className="item"
                          data-testid={`multiview-set-host-${cid}`}
                          disabled={!running}
                          onClick={e => {
                            e.stopPropagation();
                            onSwitchHostCharacter(cid);
                          }}
                        >
                          設為主視角
                        </button>
                      )}
                    </div>
                  </div>
                  <GameViewport
                    compact
                    state={tileState}
                    watchCharacterId={cid}
                    onSelectWatchCharacter={onSelectWatchCharacter}
                    appearances={appearances}
                    viewModes={viewModes}
                    onSetViewMode={onSetViewMode}
                    provider={provider}
                    targetFps={fps}
                    sharedLoader={sharedLoader}
                    testIdPrefix={`multiview-${cid}`}
                  />
                </article>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
