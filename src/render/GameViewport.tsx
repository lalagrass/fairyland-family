import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { FamilyState } from '../state';
import { selectCameraTarget } from './extrapolation';
import { PixiStageController, type ZoomSetting } from './pixiStage';
import {
  getAppearanceProvider,
  originalAppearanceProvider,
  type AppearanceProvider,
} from './appearance';
import { observerStatus, showBattleStage } from './observer';
import type { TimeOfDayMode, WeatherMode } from './environmentFx';

export interface GameViewportProps {
  state: FamilyState;
  watchCharacterId: string | null;
  onSelectWatchCharacter: (id: string) => void;
  appearances?: Record<string, string>;
  provider?: AppearanceProvider;
}

export function GameViewport({
  state,
  watchCharacterId,
  onSelectWatchCharacter,
  appearances,
  provider = originalAppearanceProvider,
}: GameViewportProps) {
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<PixiStageController | null>(null);
  const [zoomSetting, setZoomSetting] = useState<ZoomSetting>('auto');
  const [timeOfDay, setTimeOfDay] = useState<TimeOfDayMode>('day');
  const [weather, setWeather] = useState<WeatherMode>('clear');
  const [stageInfo, setStageInfo] = useState<{ ready: boolean; error: string | null; integerScale: number }>({
    ready: false,
    error: null,
    integerScale: 1,
  });

  useEffect(() => {
    const el = canvasHostRef.current;
    if (!el) return;
    const ctrl = new PixiStageController(el, info => setStageInfo(info));
    stageRef.current = ctrl;
    void ctrl.init();
    return () => {
      ctrl.destroy();
      if (stageRef.current === ctrl) stageRef.current = null;
    };
  }, []);

  useEffect(() => {
    stageRef.current?.update({ state, watchCharacterId, zoomSetting, appearances, timeOfDay, weather, provider });
  }, [state, watchCharacterId, zoomSetting, appearances, timeOfDay, weather, provider]);

  const target = useMemo(() => selectCameraTarget(state, watchCharacterId), [state, watchCharacterId]);
  const snap = state.snapshot;
  const activeId = state.activeCharacterId ?? state.characterId ?? snap?.family?.activeCharacterId ?? '';
  const watchedProvider = useMemo(() => {
    const id = target?.characterId ?? activeId;
    return appearances?.[id] ? getAppearanceProvider(appearances[id]) : provider;
  }, [appearances, target?.characterId, activeId, provider]);
  const members = state.members;
  // 上層（ui.tsx）每 250ms 重繪一次，所以心跳逾時會在下一次重繪時顯示成「未連線」；這裡不另開計時器。
  const observer = observerStatus(state, watchCharacterId, Date.now());
  const battleShown = showBattleStage(state, watchCharacterId);

  return (
    <section className="stage-panel" data-testid="game-stage-panel">
      <div className="stage-hud">
        <div className="stage-hud-left">
          <strong data-testid="stage-map-name">{snap?.mapName ?? '尚未連線到地圖'}</strong>
          {target && (
            <span className="muted" data-testid="stage-camera-target">
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
                data-testid="camera-character-select"
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
            <span>縮放</span>
            <select
              aria-label="畫面整數倍縮放"
              data-testid="stage-zoom-select"
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
          <label className="stage-control">
            <span>時辰</span>
            <select
              aria-label="晝夜顯示切換"
              data-testid="stage-time-select"
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
              data-testid="stage-weather-select"
              value={weather}
              onChange={e => setWeather(e.currentTarget.value as WeatherMode)}
            >
              <option value="clear">晴朗</option>
              <option value="rain">細雨</option>
              <option value="mist">薄霧</option>
            </select>
          </label>
          <span className="pill mode" data-testid="appearance-badge">
            {`外觀：${watchedProvider.label}`}
          </span>
        </div>
      </div>

      <div className="stage-viewport-wrap" data-testid="pixi-viewport">
        <div ref={canvasHostRef} className="pixi-host" />
        {observer.kind !== 'OK' && (
          <div className="stage-observer-note muted" data-testid="observer-status" data-kind={observer.kind} role="status">
            {observer.text}
          </div>
        )}
        {!stageInfo.ready && (
          <div className="stage-fallback" data-testid="stage-fallback">
            {state.battle && battleShown ? (
              <>
                <div className="stage-fallback-title" data-testid="stage-battle-badge">
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
                  <div className="muted" data-testid="stage-asset-origin">
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
