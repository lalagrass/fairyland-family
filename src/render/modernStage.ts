import { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { rasterTerrain } from './terrainRaster';
import type { FamilyState } from '../state';
import {
  buildModernModel,
  clampCamera,
  clampZoom,
  minimapPoint,
  minimapToWorld,
  modernLayout,
  stepCamera,
  type CameraState,
  type ModernMarker,
  type ModernViewModel,
} from './viewMode';

export interface ModernSyncInput {
  state: FamilyState;
  watchCharacterId: string | null;
  /** 縮放倍率（UI 的 +／－／滾輪改這個值）。 */
  zoom: number;
}

const COLORS: Record<ModernMarker['kind'], number> = {
  member: 0x5fd0ff,
  npc: 0xf2c14e,
  shop: 0xff9a5c,
  exit: 0x8be28b,
  gather: 0xb08cff,
};
const GRID = 400;

/**
 * 現代地圖顯示（PixiJS v8）。只用 Graphics／Text 畫色塊、線條與簡單圖示，不載入任何素材。
 * 只讀 FamilyState，不送指令、不動時鐘；鏡頭與縮放是純顯示狀態。
 */
export class ModernStageController {
  private app: Application | null = null;
  private world = new Container();
  private ground = new Sprite();
  private miniGround = new Sprite();
  private gfx = new Graphics();
  private hud = new Graphics();
  private terrainTex: Texture | null = null;
  private terrainKey = '';
  private labels = new Map<string, Text>();
  private notice = new Text({ text: '', style: { fill: 0xe8eef6, fontSize: 14, align: 'center', wordWrap: true, wordWrapWidth: 300 } });
  private latest: ModernSyncInput | null = null;
  private cam: CameraState | null = null;
  private lastTick = 0;
  private destroyed = false;
  private manualPan: { x: number; y: number } | null = null;
  /** 最近一次畫出的結果，給測試與除錯用。 */
  lastModel: ModernViewModel | null = null;
  frames = 0;

  constructor(
    private hostEl: HTMLElement,
    private onStatusChange?: (info: { ready: boolean; error: string | null }) => void,
  ) {}

  async init(): Promise<boolean> {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false;
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    if (/HappyDOM|jsdom|Node\.js/i.test(ua)) return false;
    if (typeof window.WebGLRenderingContext === 'undefined') return false;
    try {
      const app = new Application();
      await app.init({ resizeTo: this.hostEl, antialias: true, backgroundAlpha: 1, backgroundColor: 0x0e1520, resolution: Math.min(2, window.devicePixelRatio || 1), autoDensity: true });
      if (this.destroyed) {
        app.destroy({ removeView: true }, { children: true });
        return false;
      }
      this.app = app;
      this.hostEl.innerHTML = '';
      app.canvas.style.width = '100%';
      app.canvas.style.height = '100%';
      app.canvas.style.display = 'block';
      app.canvas.style.touchAction = 'none';
      this.hostEl.appendChild(app.canvas);
      this.notice.anchor.set(0.5);
      this.ground.visible = false;
      this.miniGround.visible = false;
      this.world.addChild(this.ground, this.gfx);
      app.stage.addChild(this.world, this.miniGround, this.hud, this.notice);
      app.canvas.addEventListener('pointerdown', this.onPointer);
      app.ticker.add(() => this.renderFrame());
      this.onStatusChange?.({ ready: true, error: null });
      return true;
    } catch (err) {
      this.onStatusChange?.({ ready: false, error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  update(input: ModernSyncInput): void {
    if (this.latest && this.latest.watchCharacterId !== input.watchCharacterId) this.manualPan = null;
    this.latest = input;
  }

  /** 小地圖上點擊：只把鏡頭移過去看，不送任何移動指令。換觀察對象或再點 → 回到跟隨。 */
  private onPointer = (ev: PointerEvent): void => {
    if (!this.app || !this.lastModel) return;
    const rect = this.app.canvas.getBoundingClientRect();
    const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    const m = this.lastModel;
    const lay = modernLayout(rect.width, rect.height, m.mapW, m.mapH);
    const ox = rect.width - lay.margin - lay.miniW, oy = rect.height - lay.margin - lay.miniH;
    if (px >= ox && px <= ox + lay.miniW && py >= oy && py <= oy + lay.miniH) {
      this.manualPan = minimapToWorld(px - ox, py - oy, m.mapW, m.mapH, lay.miniW, lay.miniH);
    } else {
      this.manualPan = null;
    }
  };

  private renderFrame(): void {
    const app = this.app;
    const input = this.latest;
    if (this.destroyed || !app || !input) return;
    const nowMs = Date.now();
    const dt = this.lastTick ? nowMs - this.lastTick : 16;
    this.lastTick = nowMs;
    const W = app.screen.width, H = app.screen.height;
    const model = buildModernModel(input.state, input.watchCharacterId, nowMs);
    this.lastModel = model;
    this.frames += 1;
    const lay = modernLayout(W, H, model.mapW, model.mapH);
    const g = this.gfx;
    const hud = this.hud;
    g.clear();
    hud.clear();

    const ready = model.status.kind !== 'OFFLINE' && model.status.kind !== 'NO_SNAPSHOT' && !!input.state.snapshot;
    // 沒連線／沒快照：顯示明確狀態，不畫過期的地圖當成現況
    if (!ready) {
      for (const t of this.labels.values()) t.visible = false;
      this.ground.visible = false;
      this.miniGround.visible = false;
      this.notice.visible = true;
      this.notice.style.wordWrapWidth = Math.max(120, W - 24);
      this.notice.text = model.status.kind === 'NO_SNAPSHOT' ? model.status.text : `現代地圖：${model.status.text}`;
      this.notice.position.set(W / 2, H / 2);
      this.drawIcon(hud, W / 2, H / 2 - 34, 'offline');
      return;
    }
    this.notice.visible = false;

    this.syncTerrain(model);
    const zoom = clampZoom(input.zoom);
    const tgt = model.target ?? { x: model.mapW / 2, y: model.mapH / 2 };
    const goal = this.manualPan ?? tgt;
    this.cam = stepCamera(this.cam, goal, `${input.state.snapshot?.mapId}`, dt);
    const c = clampCamera(this.cam, model.mapW, model.mapH, W, H, zoom);
    this.world.scale.set(zoom);
    this.world.position.set(W / 2 - c.x * zoom, H / 2 - c.y * zoom);

    // 有宿主地形就畫那張點陣圖；沒有才退回程式格線。兩種都不載入素材。
    g.rect(0, 0, model.mapW, model.mapH).fill({ color: 0x16212e }).stroke({ width: 4 / zoom, color: 0x35506b });
    if (!this.ground.visible) {
      const x0 = Math.max(0, Math.floor((c.x - W / zoom / 2) / GRID) * GRID);
      const x1 = Math.min(model.mapW, c.x + W / zoom / 2);
      const y0 = Math.max(0, Math.floor((c.y - H / zoom / 2) / GRID) * GRID);
      const y1 = Math.min(model.mapH, c.y + H / zoom / 2);
      for (let x = x0; x <= x1; x += GRID) g.moveTo(x, y0).lineTo(x, y1);
      for (let y = y0; y <= y1; y += GRID) g.moveTo(x0, y).lineTo(x1, y);
      g.stroke({ width: 1 / zoom, color: 0x22344a, alpha: 0.8 });
    }

    // 路徑線
    if (model.path.length >= 2) {
      g.moveTo(model.path[0].x, model.path[0].y);
      for (const p of model.path.slice(1)) g.lineTo(p.x, p.y);
      g.stroke({ width: 5 / zoom, color: 0x5fd0ff, alpha: 0.85 });
      const end = model.path[model.path.length - 1];
      g.circle(end.x, end.y, 9 / zoom).stroke({ width: 3 / zoom, color: 0xffffff });
    }

    // 標記：自製簡單圖示
    const seen = new Set<string>();
    const iconR = (lay.narrow ? 11 : 9) / zoom;
    for (const mk of model.markers) {
      this.drawMarker(g, mk, iconR, zoom);
      if (mk.kind === 'member' || zoom >= 0.5) {
        seen.add(mk.id);
        let t = this.labels.get(mk.id);
        if (!t) {
          t = new Text({ text: mk.name, style: { fill: 0xe8eef6, fontSize: 12 } });
          t.anchor.set(0.5, 0);
          this.world.addChild(t);
          this.labels.set(mk.id, t);
        }
        t.visible = true;
        if (t.text !== mk.name) t.text = mk.name;
        t.scale.set(lay.fontSize / 12 / zoom);
        t.position.set(mk.x, mk.y + iconR * 1.3);
      }
    }
    for (const [id, t] of this.labels) if (!seen.has(id)) { t.visible = false; }

    this.drawMinimap(hud, model, lay, W, H, c, zoom);
  }

  private drawMarker(g: Graphics, mk: ModernMarker, r: number, zoom: number): void {
    const color = COLORS[mk.kind];
    switch (mk.kind) {
      case 'member':
        g.circle(mk.x, mk.y, r * (mk.isTarget ? 1.35 : 1)).fill({ color }).stroke({ width: 2 / zoom, color: mk.isTarget ? 0xffffff : 0x0e1520 });
        if (mk.isTarget) g.circle(mk.x, mk.y, r * 2.1).stroke({ width: 2 / zoom, color, alpha: 0.5 });
        break;
      case 'npc':
        g.rect(mk.x - r * 0.7, mk.y - r * 0.7, r * 1.4, r * 1.4).fill({ color });
        break;
      case 'shop':
        g.poly([mk.x, mk.y - r, mk.x + r, mk.y, mk.x, mk.y + r, mk.x - r, mk.y]).fill({ color });
        break;
      case 'exit':
        g.poly([mk.x - r, mk.y + r * 0.8, mk.x + r, mk.y + r * 0.8, mk.x, mk.y - r]).fill({ color });
        break;
      case 'gather':
        g.moveTo(mk.x - r, mk.y).lineTo(mk.x + r, mk.y).moveTo(mk.x, mk.y - r).lineTo(mk.x, mk.y + r).stroke({ width: 4 / zoom, color });
        break;
    }
  }

  private drawIcon(g: Graphics, x: number, y: number, kind: 'offline'): void {
    if (kind === 'offline') {
      g.circle(x, y, 14).stroke({ width: 3, color: 0xe06c6c });
      g.moveTo(x - 8, y - 8).lineTo(x + 8, y + 8).stroke({ width: 3, color: 0xe06c6c });
    }
  }

  private drawMinimap(g: Graphics, m: ModernViewModel, lay: ReturnType<typeof modernLayout>, W: number, H: number, cam: { x: number; y: number }, zoom: number): void {
    const ox = W - lay.margin - lay.miniW, oy = H - lay.margin - lay.miniH;
    g.rect(ox, oy, lay.miniW, lay.miniH).fill({ color: 0x0a1018, alpha: 0.82 }).stroke({ width: 1, color: 0x5a7391 });
    if (this.miniGround.visible) {
      this.miniGround.position.set(ox, oy);
      this.miniGround.width = lay.miniW;
      this.miniGround.height = lay.miniH;
    }
    const P = (x: number, y: number) => minimapPoint(x, y, m.mapW, m.mapH, lay.miniW, lay.miniH);
    if (m.path.length >= 2) {
      const a = P(m.path[0].x, m.path[0].y);
      g.moveTo(ox + a.x, oy + a.y);
      for (const p of m.path.slice(1)) { const q = P(p.x, p.y); g.lineTo(ox + q.x, oy + q.y); }
      g.stroke({ width: 1.5, color: 0x5fd0ff });
    }
    for (const mk of m.markers) {
      const p = P(mk.x, mk.y);
      g.circle(ox + p.x, oy + p.y, mk.kind === 'member' ? (mk.isTarget ? 3.5 : 2.5) : 1.5).fill({ color: COLORS[mk.kind] });
    }
    // 目前視野框
    const vw = (W / zoom / m.mapW) * lay.miniW, vh = (H / zoom / m.mapH) * lay.miniH;
    const c = P(cam.x, cam.y);
    const rx = Math.max(ox, ox + c.x - vw / 2), ry = Math.max(oy, oy + c.y - vh / 2);
    g.rect(rx, ry, Math.min(vw, lay.miniW), Math.min(vh, lay.miniH)).stroke({ width: 1, color: 0xffffff, alpha: 0.8 });
  }

  /** 地形沒變就沿用同一張貼圖。換地圖或快照沒帶地形時清掉。 */
  private syncTerrain(model: ModernViewModel): void {
    const t = model.terrain;
    const key = t ? `${t.cols}x${t.rows}:${model.mapW}x${model.mapH}:${t.blocked}` : '';
    if (key === this.terrainKey) {
      const on = !!this.terrainTex;
      this.ground.visible = on;
      this.miniGround.visible = on;
      return;
    }
    this.terrainKey = key;
    this.ground.texture = Texture.EMPTY;
    this.miniGround.texture = Texture.EMPTY;
    this.terrainTex?.destroy(true);
    this.terrainTex = null;
    if (!t || typeof document === 'undefined') {
      this.ground.visible = false;
      this.miniGround.visible = false;
      return;
    }
    const raster = rasterTerrain(t.cells, t.cols, t.rows, model.mapW, model.mapH);
    const canvas = document.createElement('canvas');
    canvas.width = raster.width;
    canvas.height = raster.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      this.ground.visible = false;
      this.miniGround.visible = false;
      return;
    }
    const pixels = new Uint8ClampedArray(raster.rgba);
    ctx.putImageData(new ImageData(pixels, raster.width, raster.height), 0, 0);
    const tex = Texture.from(canvas);
    this.terrainTex = tex;
    this.ground.texture = tex;
    this.miniGround.texture = tex;
    this.ground.width = model.mapW;
    this.ground.height = model.mapH;
    this.ground.visible = true;
    this.miniGround.visible = true;
  }

  destroy(): void {
    this.destroyed = true;
    this.ground.texture = Texture.EMPTY;
    this.miniGround.texture = Texture.EMPTY;
    this.terrainTex?.destroy(true);
    this.terrainTex = null;
    const app = this.app;
    this.app = null;
    if (app) {
      app.canvas.removeEventListener('pointerdown', this.onPointer);
      app.destroy({ removeView: true }, { children: true });
    }
  }
}
