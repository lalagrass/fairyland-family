import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { SnapshotPortalNode } from '../protocol/index';
import {
  buildWorldMapView,
  worldMapFrame,
  worldMapHitBoxes,
  type WorldMapCharacter,
  type WorldMapNodeView,
  type WorldMapRenderer,
} from '../render/worldMap';

export interface WorldMapPanelProps {
  graph: readonly SnapshotPortalNode[] | null;
  characters: readonly WorldMapCharacter[];
  /** F5 導航器目前規劃的地圖序列（含起點）。 */
  route: readonly string[];
  running: boolean;
  /** 改選角色：由外面送既有的切換視角指令。 */
  onSelectCharacter: (characterId: string) => void;
  /** 點節點：由外面送既有的 F5「移動到這張地圖」。 */
  onMoveTo: (mapId: string, name: string) => void;
}

/** 單元測試的 HappyDOM 沒有 WebGL。那種環境不載入 Pixi，改走清單。 */
function canvasSupported(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  const ua = window.navigator?.userAgent ?? '';
  if (/HappyDOM|jsdom|Node\.js/i.test(ua)) return false;
  return typeof window.WebGLRenderingContext !== 'undefined';
}

function nodeBits(n: WorldMapNodeView): string[] {
  const who = n.characters.map(c => `${c.name || c.characterId}${c.selected ? '（視角）' : ''}`).join('、');
  return [n.name || n.mapId, n.onRoute ? '路線' : '', who, n.brokenOut ? `斷點 ${n.brokenOut}` : ''].filter(Boolean);
}

/**
 * 世界地圖面板。圖從宿主的傳送點圖來；點已匯入的節點，對選定的視角角色下移動。
 * 畫布交給 WorldMapRenderer（目前是 PixiJS v8）。窄螢幕另外給一排夠大的清單按鈕。
 */
export function WorldMapPanel({ graph, characters, route, running, onSelectCharacter, onMoveTo }: WorldMapPanelProps) {
  const view = useMemo(
    () => buildWorldMapView({ graph, characters, route }),
    [graph, characters, route],
  );
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<WorldMapRenderer | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [canvasReady, setCanvasReady] = useState<'pending' | 'ready' | 'off'>('pending');
  const [pendingId, setPendingId] = useState<string | null>(null);

  const viewId = characters.find(c => c.selected)?.characterId ?? null;
  useEffect(() => {
    if (pendingId && pendingId === viewId) setPendingId(null);
  }, [pendingId, viewId]);
  const selectedId = pendingId && characters.some(c => c.characterId === pendingId) ? pendingId : viewId;
  const switching = Boolean(pendingId && pendingId !== viewId);
  const canMove = running && Boolean(viewId) && selectedId === viewId;

  useEffect(() => {
    if (view.empty) return;
    const host = canvasRef.current;
    if (!host) return;
    if (!canvasSupported()) {
      setCanvasReady('off');
      return;
    }
    let stopped = false;
    let renderer: WorldMapRenderer | null = null;
    void import('../render/worldMapStage')
      .then(async ({ PixiWorldMapRenderer }) => {
        if (stopped) return;
        const created = new PixiWorldMapRenderer();
        const ok = await created.mount(host);
        if (stopped || !ok) {
          created.destroy();
          if (!stopped) setCanvasReady('off');
          return;
        }
        created.setView(viewRef.current);
        renderer = created;
        rendererRef.current = created;
        if (!stopped) setCanvasReady('ready');
      })
      .catch(() => {
        if (!stopped) setCanvasReady('off');
      });
    return () => {
      stopped = true;
      renderer?.destroy();
      rendererRef.current?.destroy();
      rendererRef.current = null;
      setCanvasReady('pending');
    };
  }, [view.empty]);

  useEffect(() => {
    rendererRef.current?.setView(view);
  }, [view]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setBox({ w: rect.width, h: rect.height });
    };
    measure();
    const ResizeObs = window.ResizeObserver;
    if (!ResizeObs) return;
    let observer: ResizeObserver;
    try {
      observer = new ResizeObs(measure);
      observer.observe(el);
    } catch {
      return;
    }
    return () => observer.disconnect();
  }, [view.empty, view.width, view.height]);

  const hits = box.w > 0 && box.h > 0 ? worldMapHitBoxes(view, box.w, box.h) : [];
  const hitAt = new Map(hits.map(h => [h.mapId, h]));
  const clickable = view.nodes
    .filter(n => n.clickable)
    .slice()
    .sort((a, b) => (a.name ?? a.mapId).localeCompare(b.name ?? b.mapId, 'zh-Hant') || a.mapId.localeCompare(b.mapId));
  const nameOf = (id: string) => view.nodes.find(n => n.mapId === id)?.name || id;
  const routeText = route.length > 1 ? `路線：${route.map(nameOf).join(' → ')}` : '尚無規劃路線';
  const narrow = box.w > 0 && worldMapFrame(box.w).narrow;

  const move = (n: WorldMapNodeView) => {
    if (!canMove || !n.clickable) return;
    onMoveTo(n.mapId, n.name ?? n.mapId);
  };

  return (
    <section
      className={canvasReady === 'off' ? 'world-map is-fallback' : 'world-map'}
      data-testid="world-map-panel"
      data-empty={view.empty ? '1' : '0'}
      data-broken-count={view.brokenCount}
      data-narrow={box.w > 0 ? (narrow ? '1' : '0') : ''}
      aria-label="世界地圖"
    >
      <h2>世界地圖</h2>
      {view.empty ? (
        <p className="muted" data-testid="world-map-empty">尚未收到宿主的傳送點圖。連上遊戲後，這裡會畫出已匯入的地圖與傳送連線。</p>
      ) : (
        <>
          <div className="world-map-toolbar">
            <label>
              移動角色
              <select
                data-testid="world-map-character"
                aria-label="選擇要移動的角色"
                value={selectedId ?? ''}
                disabled={characters.length === 0}
                onChange={ev => {
                  const id = ev.currentTarget.value;
                  setPendingId(id);
                  if (id && id !== viewId) onSelectCharacter(id);
                }}
              >
                {characters.length === 0 && <option value="">（尚無角色）</option>}
                {characters.map(c => (
                  <option key={c.characterId} value={c.characterId}>{c.name || c.characterId}</option>
                ))}
              </select>
            </label>
            <span className="muted" data-testid="world-map-summary">{`已匯入 ${clickable.length} 張地圖`}</span>
            <span className="muted" data-testid="world-map-broken-count">{`斷掉的傳送點：${view.brokenCount}`}</span>
          </div>
          <p className="muted world-map-route" data-testid="world-map-route" data-route={route.join(',')}>{routeText}</p>
          {switching && <p className="muted">正在切換視角，完成後再點地圖。</p>}
          {!running && <p className="muted">遊戲未執行，不能移動。</p>}
          <div className="world-map-stage" ref={stageRef}>
            <div className="world-map-canvas" ref={canvasRef} data-testid="world-map-canvas" />
            <div className="world-map-hits">
              {clickable.map(n => {
                const hit = hitAt.get(n.mapId);
                if (!hit || hit.size < 1) return null;
                return (
                  <button
                    key={n.mapId}
                    type="button"
                    className="world-map-node-hit"
                    data-testid="world-map-node"
                    data-map-id={n.mapId}
                    data-on-route={n.onRoute ? '1' : '0'}
                    data-broken-out={String(n.brokenOut)}
                    aria-label={nodeBits(n).join('，')}
                    disabled={!canMove}
                    style={{ left: hit.left + hit.size / 2, top: hit.top + hit.size / 2, width: hit.size, height: hit.size }}
                    onClick={() => move(n)}
                  />
                );
              })}
            </div>
          </div>
          <div className="world-map-legend" data-testid="world-map-legend">
            <span>圓＝已匯入地圖</span>
            <span>黃線＝規劃路線</span>
            <span>紅叉＝斷掉的傳送</span>
            <span>色點＝角色</span>
          </div>
          {canvasReady === 'off' && <p className="muted">這個環境畫不了圖，請用下面的清單點選地圖。</p>}
          <ul className="world-map-list" data-testid="world-map-list">
            {clickable.map(n => (
              <li key={n.mapId}>
                <button
                  type="button"
                  className="item"
                  data-testid="world-map-list-item"
                  data-map-id={n.mapId}
                  data-on-route={n.onRoute ? '1' : '0'}
                  data-broken-out={String(n.brokenOut)}
                  disabled={!canMove}
                  onClick={() => move(n)}
                >
                  {nodeBits(n).join(' · ')}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
