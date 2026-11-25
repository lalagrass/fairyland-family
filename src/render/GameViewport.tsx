import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { FamilyState } from '../state';
import { selectCameraTarget } from './extrapolation';
import { PixiStageController, type ZoomSetting } from './pixiStage';
import { ModernStageController } from './modernStage';
import { VIEW_MODES, clampZoom, parseViewMode, type ViewMode } from './viewMode';
import {
  getAppearanceProvider,
  originalAppearanceProvider,
  type AppearanceProvider,
} from './appearance';
import { observerStatus, showBattleStage } from './observer';
import type { TimeOfDayMode, WeatherMode } from './environmentFx';
import type { RuntimeAssetLoader } from './assetLoader';

export interface GameViewportProps {
  state: FamilyState;
  watchCharacterId: string | null;
  onSelectWatchCharacter: (id: string) => void;
  appearances?: Record<string, string>;
  /** F4a：每個角色各自選的地圖顯示模式（本機設定）；沒設定就是原版。 */
  viewModes?: Record<string, ViewMode>;
  onSetViewMode?: (characterId: string, mode: ViewMode) => void;
  provider?: AppearanceProvider;
  /** F14：並排格內使用的精簡版畫面（只保留畫布與觀察狀態提示）。 */
  compact?: boolean;
  /** F14：目標幀率（60 焦點格／10 非焦點格／0 輪播隱藏格）。 */
  targetFps?: number;
  /** F14：多格並排時共用的同源素材／地圖 JSON 載入器。 */
  sharedLoader?: RuntimeAssetLoader;
  /** F14：多格模式可加上格別前綴避免 data-testid 衝突；單一模式不傳即維持原樣。 */
  testIdPrefix?: string;
}

export function GameViewport({
  state,
  watchCharacterId,
  onSelectWatchCharacter,
  appearances,
  viewModes,
  onSetViewMode,
  provider = originalAppearanceProvider,
  compact = false,
  targetFps,
  sharedLoader,
  testIdPrefix,
}: GameViewportProps) {
  const tid = (name: string) => (testIdPrefix ? `${testIdPrefix}-${name}` : name);
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<PixiStageController | null>(null);
  const modernRef = useRef<ModernStageController | null>(null);
  const [modernZoom, setModernZoom] = useState(0.5);
  const [modernReady, setModernReady] = useState<{ ready: boolean; error: string | null }>({ ready: false, error: null });
  const [zoomSetting, setZoomSetting] = useState<ZoomSetting>('auto');
  const [timeOfDay, setTimeOfDay] = useState<TimeOfDayMode>('day');
  const [weather, setWeather] = useState<WeatherMode>('clear');
  const [stageInfo, setStageInfo] = useState<{ ready: boolean; error: string | null; integerScale: number }>({
    ready: false,
    error: null,
    integerScale: 1,
  });

  const target = useMemo(() => selectCameraTarget(state, watchCharacterId), [state, watchCharacterId]);
  const snap = state.snapshot;
  const activeId = state.activeCharacterId ?? state.characterId ?? snap?.family?.activeCharacterId ?? '';
  const viewedId = target?.characterId ?? activeId;
  const viewMode: ViewMode = parseViewMode(viewedId ? viewModes?.[viewedId] : undefined);
  const modern = viewMode === 'modern';

  // 切換模式時換掉整個舞台：原版與現代各有自己的畫布，吃同一份 state，互不影響快照與事件處理。
  useEffect(() => {
    const el = canvasHostRef.current;
    if (!el) return;
    if (modern) {
      setModernReady({ ready: false, error: null });
      const ctrl = new ModernStageController(el, info => setModernReady(info));
      modernRef.current = ctrl;
      void ctrl.init();
      return () => {
        ctrl.destroy();
        if (modernRef.current === ctrl) modernRef.current = null;
      };
    }
    const ctrl = new PixiStageController(el, info => setStageInfo(info), sharedLoader);
    stageRef.current = ctrl;
    void ctrl.init();
    return () => {
      ctrl.destroy();
      if (stageRef.current === ctrl) stageRef.current = null;
      setStageInfo(i => ({ ...i, ready: false }));
    };
  }, [modern, sharedLoader]);

  useEffect(() => {
    if (modern) return;
    stageRef.current?.update({ state, watchCharacterId, zoomSetting, appearances, timeOfDay, weather, provider, targetFps });
  }, [state, watchCharacterId, zoomSetting, appearances, timeOfDay, weather, provider, modern, targetFps]);

  useEffect(() => {
    modernRef.current?.update({ state, watchCharacterId, zoom: modernZoom, targetFps });
  }, [state, watchCharacterId, modernZoom, modern, modernReady.ready, targetFps]);

  const watchedProvider = useMemo(() => {
    const id = viewedId;
    return appearances?.[id] ? getAppearanceProvider(appearances[id]) : provider;
  }, [appearances, viewedId, provider]);
  const members = state.members;
  // 上層（ui.tsx）每 250ms 重繪一次，所以心跳逾時會在下一次重繪時顯示成「未連線」；這裡不另開計時器。
  const observer = observerStatus(state, watchCharacterId, Date.now());
  const battleShown = showBattleStage(state, watchCharacterId);

  return (
    <section className={`stage-panel${compact ? ' stage-panel-compact' : ''}`} data-testid={tid('game-stage-panel')}>
      {!compact && <div className="stage-hud">
        <div className="stage-hud-left">
          <strong data-testid={tid('stage-map-name')}>{snap?.mapName ?? '尚未連線到地圖'}</strong>
          {target && (
            <span className="muted" data-testid={tid('stage-camera-target')}>
              {`正在看：${target.name}（${target.mapId} ${target.x},${target.y}｜方向 ${target.dir}）`}
            </span>
          )}
        </div>
        <div className="stage-hud-controls">
          {members.length > 0 && (
            <label className="stage-control">
              <span>鏡頭</span>
              <select
                aria-label="切換觀看角色"
                data-testid={tid('camera-character-select')}
                value={watchCharacterId ?? activeId}
                onChange={e => onSelectWatchCharacter(e.currentTarget.value)}
              >
                {members.map(m => (
                  <option key={m.characterId} value={m.characterId}>
                    {`${m.name ?? m.characterId} (${m.mapId})`}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="stage-control">
            <span>地圖</span>
            <select
              aria-label="切換地圖顯示模式"
              data-testid={tid('stage-view-mode-select')}
              value={viewMode}
              disabled={!viewedId || !onSetViewMode}
              onChange={e => viewedId && onSetViewMode?.(viewedId, parseViewMode(e.currentTarget.value))}
            >
              {VIEW_MODES.map(m => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </label>
          {modern ? (
            <span className="stage-control" role="group" aria-label="現代地圖縮放">
              <span>縮放</span>
              <button type="button" className="item" aria-label="縮小" data-testid={tid('modern-zoom-out')} onClick={() => setModernZoom(z => clampZoom(z / 1.25))}>－</button>
              <span data-testid={tid('modern-zoom-value')}>{`${Math.round(modernZoom * 100)}%`}</span>
              <button type="button" className="item" aria-label="放大" data-testid={tid('modern-zoom-in')} onClick={() => setModernZoom(z => clampZoom(z * 1.25))}>＋</button>
            </span>
          ) : (
          <label className="stage-control">
            <span>縮放</span>
            <select
              aria-label="畫面整數倍縮放"
              data-testid={tid('stage-zoom-select')}
              value={String(zoomSetting)}
              onChange={e => {
                const v = e.currentTarget.value;
                setZoomSetting(v === 'auto' ? 'auto' : (Number(v) as 1 | 2));
              }}
            >
              <option value="auto">{`自動整數 (${stageInfo.integerScale}x)`}</option>
              <option value="1">1x 原始像素</option>
              <option value="2">2x 整數放大</option>
            </select>
          </label>
          )}
          <label className="stage-control">
            <span>時辰</span>
            <select
              aria-label="晝夜顯示切換"
              data-testid={tid('stage-time-select')}
              value={timeOfDay}
              onChange={e => setTimeOfDay(e.currentTarget.value as TimeOfDayMode)}
            >
              <option value="day">白天</option>
              <option value="dusk">黃昏</option>
              <option value="night">夜晚</option>
              <option value="auto">依時鐘自動</option>
            </select>
          </label>
          <label className="stage-control">
            <span>天氣</span>
            <select
              aria-label="天氣顯示切換"
              data-testid={tid('stage-weather-select')}
              value={weather}
              onChange={e => setWeather(e.currentTarget.value as WeatherMode)}
            >
              <option value="clear">晴朗</option>
              <option value="rain">細雨</option>
              <option value="mist">薄霧</option>
            </select>
          </label>
          <span className="pill mode" data-testid={tid('appearance-badge')}>
            {`外觀：${watchedProvider.label}`}
          </span>
        </div>
      </div>}

      <div className="stage-viewport-wrap" data-testid={tid('pixi-viewport')} data-view-mode={viewMode}>
        <div
          key={viewMode}
          ref={canvasHostRef}
          className={`pixi-host ${modern ? 'pixi-host-modern' : ''}`}
          data-testid={tid(modern ? 'modern-host' : 'original-host')}
          onWheel={modern ? e => setModernZoom(z => clampZoom(e.deltaY < 0 ? z * 1.1 : z / 1.1)) : undefined}
        />
        {observer.kind !== 'OK' && (
          <div className="stage-observer-note muted" data-testid={tid('observer-status')} data-kind={observer.kind} data-view-mode={viewMode} role="status">
            {observer.text}
          </div>
        )}
        {modern && modernReady.ready && snap && observer.kind === 'OK' && (
          <div className="stage-modern-legend muted" data-testid={tid('modern-legend')}>
            <span>● 角色</span><span>■ 人物</span><span>◆ 商店</span><span>▲ 出口</span><span>✚ 採集</span>
          </div>
        )}
        {!(modern ? modernReady.ready : stageInfo.ready) && (
          <div className="stage-fallback" data-testid={tid('stage-fallback')}>
            {state.battle && battleShown ? (
              <>
                <div className="stage-fallback-title" data-testid={tid('stage-battle-badge')}>
                  {`戰鬥舞台 #${state.battle.battleId}${state.battle.round ? ` 第 ${state.battle.round} 回合` : ''}`}
                </div>
                <div className="muted">
                  {`敵方：${state.battle.enemies.join('、') || '遇敵中'}${state.battle.timeline ? `（時間軸事件 ${state.battle.timeline.events.length} 筆）` : ''}`}
                </div>
              </>
            ) : snap ? (
              <>
                <div className="stage-fallback-title">{`${snap.mapName}（${snap.mapId}）`}</div>
                <div className="muted">
                  {target
                    ? `${target.name} 位於 (${target.x}, ${target.y})，方向 ${target.dir}`
                    : '等待角色快照…'}
                </div>
                {state.staticData?.assets && (
                  <div className="muted" data-testid={tid('stage-asset-origin')}>
                    {`同源素材：${state.staticData.assets.paths.mapScene}`}
                  </div>
                )}
              </>
            ) : (
              <div className="muted">等待 fairyland 連線以繪製原版遊戲畫面…</div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
