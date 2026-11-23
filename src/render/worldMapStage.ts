import { Application, Graphics, Text } from 'pixi.js';
import {
  fitWorldMap,
  worldMapFrame,
  type WorldMapLinkView,
  type WorldMapRenderer,
  type WorldMapView,
} from './worldMap';

const CHAR_COLORS = [0x5fd0ff, 0xf2c14e, 0xb08cff, 0x5fd38d, 0xff9a5c];

/**
 * F6 世界地圖的 PixiJS v8 繪製。只畫圓、線與文字，不載入素材。
 * 實作 `WorldMapRenderer`：換引擎時換這支，畫面模型不用改。
 */
export class PixiWorldMapRenderer implements WorldMapRenderer {
  private app: Application | null = null;
  private gfx = new Graphics();
  private labels = new Map<string, Text>();
  private view: WorldMapView | null = null;
  private destroyed = false;
  private rafId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly onResize = (): void => { this.draw(false); };

  async mount(host: HTMLElement): Promise<boolean> {
    if (this.destroyed) return false;
    if (typeof window === 'undefined' || typeof document === 'undefined') return false;
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    if (/HappyDOM|jsdom|Node\.js/i.test(ua)) return false;
    if (typeof window.WebGLRenderingContext === 'undefined') return false;
    try {
      const app = new Application();
      await app.init({
        resizeTo: host,
        autoStart: false,
        antialias: true,
        backgroundAlpha: 1,
        backgroundColor: 0x0e1520,
        resolution: Math.min(2, window.devicePixelRatio || 1),
        autoDensity: true,
      });
      if (this.destroyed) {
        // 避免傳 true 觸發 PixiJS v8 GlobalResourceRegistry.release() 而破壞同頁其他舞台的 Batch 池
        app.destroy({ removeView: true }, { children: true });
        return false;
      }
      this.app = app;
      host.replaceChildren();
      app.canvas.style.width = '100%';
      app.canvas.style.height = '100%';
      app.canvas.style.display = 'block';
      app.canvas.setAttribute('aria-hidden', 'true');
      host.appendChild(app.canvas);
      app.stage.addChild(this.gfx);
      app.renderer.on('resize', this.onResize);
      if (typeof ResizeObserver === 'function') {
        const obs = new ResizeObserver(() => {
          if (!this.destroyed && this.app?.renderer && host.clientWidth > 0 && host.clientHeight > 0) {
            this.app.resize();
          }
        });
        obs.observe(host);
        this.resizeObserver = obs;
      }
      this.draw(true);
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null;
        this.draw(true);
      });
      return true;
    } catch {
      return false;
    }
  }

  setView(view: WorldMapView): void {
    if (this.destroyed) return;
    this.view = view;
    this.draw(true);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.view = null;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    const app = this.app;
    this.app = null;
    if (!app) return;
    app.renderer?.off('resize', this.onResize);
    for (const t of this.labels.values()) t.destroy();
    this.labels.clear();
    // 僅移除本實例畫布與子節點，不全域釋放共用池，免得同頁 GameViewport 下幀 batch.textures 為 null
    app.destroy({ removeView: true }, { children: true });
  }

  private draw(shouldRender = true): void {
    const app = this.app;
    const view = this.view;
    if (this.destroyed || !app || !app.renderer || !view || view.empty) return;
    const W = app.screen.width;
    const H = app.screen.height;
    if (W < 2 || H < 2) return;
    const fit = fitWorldMap(view.width, view.height, W, H);
    const X = (x: number) => fit.offsetX + x * fit.scale;
    const Y = (y: number) => fit.offsetY + y * fit.scale;
    const g = this.gfx;
    g.clear();
    g.rect(0, 0, W, H).fill({ color: 0x0e1520 });

    const at = new Map(view.nodes.map(n => [n.mapId, n]));
    const groups = new Map<string, WorldMapLinkView[]>();
    for (const link of view.links) {
      const key = link.from < link.to ? `${link.from}\0${link.to}` : `${link.to}\0${link.from}`;
      const list = groups.get(key) ?? [];
      list.push(link);
      groups.set(key, list);
    }

    const drawLink = (link: WorldMapLinkView, index: number, count: number) => {
      const a = at.get(link.from);
      const b = at.get(link.to);
      if (!a || !b) return;
      const shift = (index - (count - 1) / 2) * 6;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const ox = (-dy / len) * shift;
      const oy = (dx / len) * shift;
      const x1 = X(a.x + ox);
      const y1 = Y(a.y + oy);
      const x2 = X(b.x + ox);
      const y2 = Y(b.y + oy);
      if (link.broken) this.strokeDash(g, x1, y1, x2, y2, 0xff6b6b);
      else g.moveTo(x1, y1).lineTo(x2, y2).stroke({ width: link.onRoute ? 3 : 1.5, color: link.onRoute ? 0xffd56a : 0x6d88a8, alpha: link.onRoute ? 1 : 0.9 });
    };
    for (const list of groups.values()) {
      list.forEach((link, i) => { if (!link.onRoute) drawLink(link, i, list.length); });
    }
    const routePts = view.nodes.filter(n => n.routeIndex >= 0).sort((a, b) => a.routeIndex - b.routeIndex);
    if (routePts.length >= 2) {
      g.moveTo(X(routePts[0].x), Y(routePts[0].y));
      for (const n of routePts.slice(1)) g.lineTo(X(n.x), Y(n.y));
      g.stroke({ width: 4, color: 0xffd56a, alpha: 0.95 });
    }
    for (const list of groups.values()) {
      list.forEach((link, i) => { if (link.onRoute) drawLink(link, i, list.length); });
    }

    const showLabels = !worldMapFrame(W).narrow && fit.scale >= 0.34;
    const fontSize = Math.max(9, Math.min(13, 12 * Math.max(fit.scale, 0.5)));
    const seen = new Set<string>();
    for (const n of view.nodes) {
      const cx = X(n.x);
      const cy = Y(n.y);
      const rr = Math.max(2, n.r * fit.scale);
      if (!n.clickable) {
        g.circle(cx, cy, rr * 0.45).stroke({ width: 1.5, color: 0xff6b6b, alpha: 0.9 });
        continue;
      }
      const onRoute = n.onRoute;
      const selected = n.characters.some(c => c.selected);
      g.circle(cx, cy, rr).fill({ color: onRoute ? 0x3a3420 : 0x1c3148 }).stroke({ width: onRoute ? 3 : 1.5, color: onRoute ? 0xffd56a : 0x7cb7ff });
      if (selected) g.circle(cx, cy, rr + 4).stroke({ width: 1.5, color: 0xfff4c2, alpha: 0.95 });
      n.characters.forEach((c, i) => {
        const ang = -Math.PI / 2 + (i * Math.PI * 2) / Math.max(1, n.characters.length);
        const dot = Math.max(2, rr * 0.28);
        g.circle(cx + Math.cos(ang) * rr * 0.45, cy + Math.sin(ang) * rr * 0.45, c.selected ? dot + 1 : dot)
          .fill({ color: c.selected ? 0xfff4c2 : CHAR_COLORS[i % CHAR_COLORS.length] });
      });
      if (!showLabels) continue;
      seen.add(n.mapId);
      const text = shortName(n.name, n.mapId);
      let label = this.labels.get(n.mapId);
      if (!label) {
        label = new Text({
          text,
          style: { fill: 0xe8eef6, fontSize, fontFamily: '-apple-system, "PingFang TC", "Noto Sans TC", sans-serif' },
        });
        label.anchor.set(0.5, 0);
        app.stage.addChild(label);
        this.labels.set(n.mapId, label);
      }
      if (label.text !== text) label.text = text;
      label.style.fontSize = fontSize;
      label.visible = true;
      label.position.set(cx, cy + rr + 2);
    }
    for (const [id, label] of this.labels) {
      if (seen.has(id)) continue;
      label.visible = false;
    }
    if (shouldRender && !this.destroyed && app.renderer) {
      app.render();
    }
  }

  private strokeDash(g: Graphics, x1: number, y1: number, x2: number, y2: number, color: number): void {
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 1) return;
    const dx = (x2 - x1) / len;
    const dy = (y2 - y1) / len;
    let traveled = 0;
    while (traveled < len) {
      const a = traveled;
      const b = Math.min(len, traveled + 7);
      g.moveTo(x1 + dx * a, y1 + dy * a).lineTo(x1 + dx * b, y1 + dy * b);
      traveled += 12;
    }
    g.stroke({ width: 2, color, alpha: 0.95 });
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    g.moveTo(mx - 4, my - 4).lineTo(mx + 4, my + 4).moveTo(mx + 4, my - 4).lineTo(mx - 4, my + 4).stroke({ width: 2, color });
  }
}

function shortName(name: string | null, mapId: string): string {
  const text = (name && name.trim()) || mapId;
  return text.length > 8 ? `${text.slice(0, 7)}…` : text;
}
