import React, { useEffect, useState } from 'react';
import { unpackBlockedCells } from '../protocol/index';
import { rasterTerrain } from '../render/terrainRaster';
import type { WineBridgeClient, WineBridgeSnapshot } from '../wine/wineBridgeClient';
import {
  buildWalkToBody,
  clickToWorld,
  formatNavProgress,
  navStopPresentation,
  type WinePathMap,
} from '../wine/pathfinding';

function percent(value: number, span: number): string {
  if (!Number.isFinite(value) || !Number.isFinite(span) || span <= 0) return '0%';
  return `${(value / span) * 100}%`;
}

/**
 * 視窗尋路。點目前宿主畫面的地圖，把目的地送給 Wine 橋接的 walk_to。
 * 地圖寬高、碰撞與角色位置都從快照來；進度與停下原因從橋接來。
 */
export function WinePathPanel({
  client,
  map,
}: {
  client: WineBridgeClient;
  active: boolean;
  map: WinePathMap | null;
}) {
  const [snap, setSnap] = useState<WineBridgeSnapshot>(() => client.getSnapshot());
  const [busy, setBusy] = useState(false);
  const [terrainUrl, setTerrainUrl] = useState<string | null>(null);

  useEffect(() => {
    setSnap(client.getSnapshot());
    return client.subscribe(setSnap);
  }, [client]);

  useEffect(() => {
    if (!map?.terrain || typeof document === 'undefined') {
      setTerrainUrl(null);
      return;
    }
    const cells = unpackBlockedCells(map.terrain);
    if (!cells) {
      setTerrainUrl(null);
      return;
    }
    try {
      const raster = rasterTerrain(cells, map.terrain.cols, map.terrain.rows, map.pixelWidth, map.pixelHeight, 480);
      const canvas = document.createElement('canvas');
      canvas.width = raster.width;
      canvas.height = raster.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        setTerrainUrl(null);
        return;
      }
      const image = ctx.createImageData(raster.width, raster.height);
      image.data.set(raster.rgba);
      ctx.putImageData(image, 0, 0);
      setTerrainUrl(canvas.toDataURL('image/png'));
    } catch {
      setTerrainUrl(null);
    }
  }, [map]);

  const connected = snap.connState === 'CONNECTED';
  const nav = connected ? snap.status?.nav ?? null : null;
  const sameMap = Boolean(map && nav?.mapId && nav.mapId === map.mapId);
  const pin = sameMap && nav?.currentPos ? nav.currentPos : map ? [map.characterX, map.characterY] as const : null;
  const stop = navStopPresentation(nav?.stopReason);
  const progress = formatNavProgress(nav);
  const transportError = snap.error;

  const onMapClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!map || !connected || busy) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const world = clickToWorld({
      clickX: event.clientX - rect.left,
      clickY: event.clientY - rect.top,
      viewW: rect.width,
      viewH: rect.height,
      pixelWidth: map.pixelWidth,
      pixelHeight: map.pixelHeight,
    });
    if (!world) return;
    setBusy(true);
    void client.walkTo(buildWalkToBody({ mapId: map.mapId, targetX: world.x, targetY: world.y }))
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  const onStop = () => {
    if (!connected || busy) return;
    setBusy(true);
    void client.walkStop()
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  return (
    <section className="wine-panel" data-testid="wine-path-panel">
      <div className="wine-head">
        <h2>視窗尋路</h2>
      </div>
      <p className="muted wine-note">
        在目前畫面的地圖上點目的地，交給本機 Wine 橋接走路。只送指令，不改規則。
      </p>
      {!connected && <p className="muted" data-testid="wine-nav-offline">尚未連上視窗橋接。請先在「視窗練功」連線。</p>}
      {!map && <p className="muted" data-testid="wine-nav-empty">地圖尚未從宿主送來。</p>}
      {map && (
        <button
          type="button"
          className="wine-nav-map"
          data-testid="wine-nav-map"
          style={{ aspectRatio: `${map.pixelWidth} / ${map.pixelHeight}` }}
          disabled={!connected || busy}
          onClick={onMapClick}
          aria-label={map.mapName ? `在${map.mapName}點目的地` : '在目前地圖點目的地'}
        >
          {terrainUrl && <img alt="" src={terrainUrl} data-testid="wine-nav-terrain" />}
          {sameMap && nav && nav.waypoints.length > 1 && (
            <svg className="wine-nav-route" data-testid="wine-nav-route" viewBox={`0 0 ${map.pixelWidth} ${map.pixelHeight}`} preserveAspectRatio="none">
              <polyline
                points={nav.waypoints.map(point => point.join(',')).join(' ')}
                strokeWidth={Math.max(map.pixelWidth, map.pixelHeight) * 0.008}
              />
            </svg>
          )}
          {pin && (
            <span
              className="wine-nav-pin"
              data-testid="wine-nav-pin"
              style={{ left: percent(pin[0], map.pixelWidth), top: percent(pin[1], map.pixelHeight) }}
            />
          )}
        </button>
      )}
      {map && !map.terrain && (
        <p className="muted wine-note">宿主沒有送來碰撞格。點擊仍依這張圖的寬高換算。</p>
      )}
      {nav?.mapId && map && nav.mapId !== map.mapId && (
        <p className="wine-nav-notice" data-testid="wine-nav-other-map">橋接正在另一張地圖上尋路。點這張圖會改走目前畫面。</p>
      )}
      <div data-testid="wine-nav-progress">{progress}</div>
      {stop.tone === 'notice' && (
        <div className="wine-nav-notice" data-testid="wine-nav-notice">{stop.text}</div>
      )}
      {stop.tone === 'error' && (
        <div className="err" data-testid="wine-nav-stop-error">{stop.text}</div>
      )}
      {transportError && (
        <div className="err" data-testid="wine-nav-error">{transportError}</div>
      )}
      <div className="wine-primary-actions">
        <button
          type="button"
          className="item wine-stop-btn"
          data-testid="wine-nav-stop"
          disabled={!connected || busy || !nav?.running}
          onClick={onStop}
        >
          停止尋路
        </button>
      </div>
    </section>
  );
}
