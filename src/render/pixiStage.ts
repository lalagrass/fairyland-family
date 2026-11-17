import {
  Application,
  Assets,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Text,
  Texture,
  TextureStyle,
} from 'pixi.js';
import type { FamilyState } from '../state';
import {
  originalAppearanceProvider,
  type AppearanceLayerPlan,
  type AppearanceProvider,
} from './appearance';
import { RuntimeAssetLoader, type RuntimeMapScene } from './assetLoader';
import {
  computeIntegerScale,
  interpolateMemberPosition,
  selectCameraTarget,
} from './extrapolation';

const GROUND_CELL_W = 160;
const GROUND_CELL_H = 80;

export type ZoomSetting = 'auto' | 1 | 2;

export interface StageSyncInput {
  state: FamilyState;
  watchCharacterId: string | null;
  zoomSetting: ZoomSetting;
  provider?: AppearanceProvider;
}

/**
 * PixiJS v8 實機畫面舞台：
 * - roundPixels: true + TextureStyle.defaultOptions.scaleMode = 'nearest'，確保整數倍放大清晰。
 * - 使用 resizeTo 跟著外層容器自動縮放。
 * - 執行時透過 FX12 清單讀取同源地圖與人物精靈，依 FX13 movePath 插值位置與動作。
 */
export class PixiStageController {
  private app: Application | null = null;
  private worldContainer = new Container();
  private groundLayer = new Container();
  private entityLayer = new Container();
  private uiOverlay = new Container();
  private loader = new RuntimeAssetLoader();
  private textureCache = new Map<string, Texture>();
  private textureInflight = new Map<string, Promise<Texture | null>>();
  private subTextureCache = new Map<string, Texture>();
  private latestInput: StageSyncInput | null = null;
  private currentScale = 1;
  private initialized = false;
  private destroyed = false;
  private lastGroundKey = '';

  constructor(
    private hostEl: HTMLElement,
    private onStatusChange?: (info: { ready: boolean; error: string | null; integerScale: number }) => void,
  ) {}

  async init(): Promise<boolean> {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false;
    // HappyDOM / headless DOM 無 WebGL/2D 環境安全退場
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    if (/HappyDOM|jsdom|Node\.js/i.test(ua)) return false;
    if (typeof window.WebGLRenderingContext === 'undefined') return false;

    try {
      TextureStyle.defaultOptions.scaleMode = 'nearest';
      const app = new Application();
      await app.init({
        resizeTo: this.hostEl,
        roundPixels: true,
        antialias: false,
        backgroundAlpha: 1,
        backgroundColor: 0x0d1218,
        resolution: 1,
      });
      if (this.destroyed) {
        app.destroy(true);
        return false;
      }
      this.app = app;
      this.hostEl.innerHTML = '';
      app.canvas.style.width = '100%';
      app.canvas.style.height = '100%';
      app.canvas.style.display = 'block';
      app.canvas.style.imageRendering = 'pixelated';
      this.hostEl.appendChild(app.canvas);

      this.entityLayer.sortableChildren = true;
      this.worldContainer.addChild(this.groundLayer, this.entityLayer, this.uiOverlay);
      app.stage.addChild(this.worldContainer);

      app.ticker.add(() => this.renderFrame());
      this.initialized = true;
      this.onStatusChange?.({ ready: true, error: null, integerScale: this.currentScale });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onStatusChange?.({ ready: false, error: msg, integerScale: 1 });
      return false;
    }
  }

  update(input: StageSyncInput): void {
    this.latestInput = input;
    const mapId = input.state.snapshot?.mapId;
    const assets = input.state.staticData?.assets;
    if (mapId) {
      void this.loader.loadMap(mapId, assets).then(scene => {
        if (!scene || this.destroyed) return;
        for (const npc of scene.npcs ?? []) {
          const mId = npc.runtime_model || npc.model;
          if (mId) void this.loader.loadSprite(mId, assets);
        }
      });
    }
    const charModel = input.state.snapshot?.character.modelId;
    if (charModel) void this.loader.loadSprite(charModel, assets);
    for (const m of input.state.members) {
      if (m.modelId) void this.loader.loadSprite(m.modelId, assets);
    }
  }

  private getOrLoadTexture(url: string): Texture | null {
    const cached = this.textureCache.get(url);
    if (cached) return cached;
    if (!this.textureInflight.has(url)) {
      const p = Assets.load<Texture>(url)
        .then(tex => {
          if (tex?.source) tex.source.scaleMode = 'nearest';
          this.textureCache.set(url, tex);
          this.textureInflight.delete(url);
          return tex;
        })
        .catch(() => {
          this.textureInflight.delete(url);
          return null;
        });
      this.textureInflight.set(url, p);
    }
    return null;
  }

  private sliceTexture(layer: AppearanceLayerPlan): Texture | null {
    const base = this.getOrLoadTexture(layer.imageUrl);
    if (!base) return null;
    if (!layer.isAtlas) return base;
    const k = `${layer.imageUrl}#${layer.atlasX},${layer.atlasY},${layer.w},${layer.h}`;
    let sub = this.subTextureCache.get(k);
    if (!sub) {
      const maxX = Math.max(0, Math.min(layer.atlasX, base.width - 1));
      const maxY = Math.max(0, Math.min(layer.atlasY, base.height - 1));
      const w = Math.max(1, Math.min(layer.w, base.width - maxX));
      const h = Math.max(1, Math.min(layer.h, base.height - maxY));
      sub = new Texture({
        source: base.source,
        frame: new Rectangle(maxX, maxY, w, h),
      });
      this.subTextureCache.set(k, sub);
    }
    return sub;
  }

  private renderFrame(): void {
    if (!this.initialized || !this.app || !this.latestInput) return;
    const { state, watchCharacterId, zoomSetting } = this.latestInput;
    const provider = this.latestInput.provider ?? originalAppearanceProvider;
    const snap = state.snapshot;
    if (!snap) return;

    const nowMs = Date.now();
    const viewW = Math.max(1, this.app.screen.width);
    const viewH = Math.max(1, this.app.screen.height);
    const intScale =
      zoomSetting === 'auto' ? computeIntegerScale(viewW, viewH) : zoomSetting;
    if (intScale !== this.currentScale) {
      this.currentScale = intScale;
      this.onStatusChange?.({ ready: true, error: null, integerScale: intScale });
    }
    this.worldContainer.scale.set(intScale, intScale);

    const target = selectCameraTarget(state, watchCharacterId, nowMs);
    const camTargetX = target && target.sameMapAsSnapshot ? target.x : snap.character.x;
    const camTargetY = target && target.sameMapAsSnapshot ? target.y : snap.character.y;
    const activeId = state.activeCharacterId ?? state.characterId ?? snap.family?.activeCharacterId ?? 'active';

    const scene = this.loader.getMap(snap.mapId) ?? null;
    const mapW = scene?.pixel_width ?? 3200;
    const mapH = scene?.pixel_height ?? 2400;
    const logicalW = viewW / intScale;
    const logicalH = viewH / intScale;
    const camX = Math.round(Math.max(0, Math.min(Math.max(0, mapW - logicalW), camTargetX - logicalW / 2)));
    const camY = Math.round(Math.max(0, Math.min(Math.max(0, mapH - logicalH), camTargetY - logicalH / 2)));
    this.worldContainer.position.set(-camX * intScale, -camY * intScale);

    this.drawGround(scene, camX, camY, logicalW, logicalH);
    this.drawEntities(
      scene,
      state,
      target?.characterId ?? activeId,
      activeId,
      camX,
      camY,
      logicalW,
      logicalH,
      nowMs,
      provider,
    );
  }

  private drawGround(
    scene: RuntimeMapScene | null,
    camX: number,
    camY: number,
    logicalW: number,
    logicalH: number,
  ): void {
    if (!scene?.ground?.macro_grid?.length) {
      if (this.lastGroundKey !== 'fallback') {
        this.groundLayer.removeChildren().forEach(c => c.destroy());
        const g = new Graphics();
        g.rect(0, 0, 6400, 4800).fill(0x13202c);
        this.groundLayer.addChild(g);
        this.lastGroundKey = 'fallback';
      }
      return;
    }

    const cols = scene.ground.macro_width;
    const rows = scene.ground.macro_height;
    const c0 = Math.max(0, Math.floor(camX / GROUND_CELL_W) - 1);
    const c1 = Math.min(cols - 1, Math.ceil((camX + logicalW) / GROUND_CELL_W) + 1);
    const r0 = Math.max(0, Math.floor(camY / GROUND_CELL_H) - 1);
    const r1 = Math.min(rows - 1, Math.ceil((camY + logicalH) / GROUND_CELL_H) + 1);

    // 地面只在視野格子範圍或材質解碼變化時重建
    const key = `${scene.map_id}:${c0},${r0},${c1},${r1}:${this.textureCache.size}`;
    if (key === this.lastGroundKey) return;
    this.lastGroundKey = key;

    this.groundLayer.removeChildren().forEach(c => c.destroy());
    for (let r = r0; r <= r1; r += 1) {
      for (let c = c0; c <= c1; c += 1) {
        const cell = scene.ground.macro_grid[r * cols + c];
        if (!cell?.tile_file) continue;
        const tex = this.getOrLoadTexture(cell.tile_file);
        if (!tex) continue;
        const sp = new Sprite(tex);
        sp.width = GROUND_CELL_W;
        sp.height = GROUND_CELL_H;
        if (cell.flip_x) {
          sp.scale.x *= -1;
          sp.x = (c + 1) * GROUND_CELL_W;
        } else {
          sp.x = c * GROUND_CELL_W;
        }
        if (cell.flip_y) {
          sp.scale.y *= -1;
          sp.y = (r + 1) * GROUND_CELL_H;
        } else {
          sp.y = r * GROUND_CELL_H;
        }
        this.groundLayer.addChild(sp);
      }
    }
  }

  private drawEntities(
    scene: RuntimeMapScene | null,
    state: FamilyState,
    watchedId: string,
    activeId: string,
    camX: number,
    camY: number,
    logicalW: number,
    logicalH: number,
    nowMs: number,
    provider: AppearanceProvider,
  ): void {
    const removed = this.entityLayer.removeChildren();
    for (const child of removed) child.destroy({ children: true });

    const snap = state.snapshot;
    if (!snap) return;
    const assets = state.staticData?.assets;

    // 1. 地圖物件與傳送點（僅繪製螢幕附近）
    if (scene) {
      for (const obj of scene.objects ?? []) {
        if (
          obj.world_x + obj.width < camX - 120 ||
          obj.world_x - obj.width > camX + logicalW + 120 ||
          obj.world_y + obj.height < camY - 120 ||
          obj.world_y - obj.height > camY + logicalH + 120
        ) {
          continue;
        }
        if (!obj.file) continue;
        const tex = this.getOrLoadTexture(obj.file);
        if (!tex) continue;
        const sp = new Sprite(tex);
        sp.x = Math.round(obj.world_x - obj.anchor_x);
        sp.y = Math.round(obj.world_y - obj.anchor_y);
        sp.zIndex = obj.depth ?? obj.world_y;
        this.entityLayer.addChild(sp);
      }

      for (const p of scene.portals ?? []) {
        const g = new Graphics();
        g.circle(p.world_x, p.world_y, 16).fill({ color: 0x56d8c4, alpha: 0.25 }).stroke({ color: 0x56d8c4, width: 2 });
        g.zIndex = p.world_y - 2;
        this.entityLayer.addChild(g);
      }

      for (const npc of scene.npcs ?? []) {
        const modelId = npc.runtime_model || npc.model || '';
        const manifest = modelId ? this.loader.getSprite(modelId) ?? null : null;
        const plan = provider.resolveCharacter(
          {
            id: npc.id,
            name: npc.name,
            kind: 'npc',
            modelId,
            action: 0,
            dir: 0,
            nowMs,
          },
          manifest,
          assets,
        );
        this.addCharacterContainer(npc.world_x, npc.world_y, npc.name, plan.layers, false, 0xf2d388);
      }
    }

    // 2. 家族成員（同地圖即時插值移動／工作／方向；若 members 尚未包含當前角色也補上 snapshot.character）
    const sameMapMembers = state.members.filter(m => m.mapId === snap.mapId);
    const renderedIds = new Set<string>();
    for (const m of sameMapMembers) {
      renderedIds.add(m.characterId);
      const isActiveChar = m.characterId === activeId;
      const pose = interpolateMemberPosition(
        {
          x: isActiveChar ? snap.character.x : m.x,
          y: isActiveChar ? snap.character.y : m.y,
          dir: isActiveChar ? snap.character.dir : m.dir,
          action: isActiveChar ? snap.character.action ?? m.action : m.action,
          movePath: isActiveChar ? snap.character.movePath ?? m.movePath : m.movePath,
          activeWork: isActiveChar ? snap.character.activeWork ?? m.activeWork : m.activeWork,
        },
        nowMs,
      );
      const modelId = (isActiveChar ? snap.character.modelId : m.modelId) ?? 'PHM011';
      const weaponModel = isActiveChar ? snap.character.weaponModel : m.weaponModel;
      const tint = isActiveChar ? snap.character.tint : m.tint;
      const manifest = this.loader.getSprite(modelId) ?? null;
      const plan = provider.resolveCharacter(
        {
          id: m.characterId,
          name: m.name ?? m.characterId,
          kind: isActiveChar ? 'player' : 'member',
          modelId,
          weaponModel,
          tint,
          action: pose.actionCode,
          dir: pose.dir,
          nowMs,
        },
        manifest,
        assets,
      );
      this.addCharacterContainer(
        pose.x,
        pose.y,
        m.name ?? m.characterId,
        plan.layers,
        m.characterId === watchedId,
        m.characterId === watchedId ? 0x7cb7ff : 0x5fd38d,
      );
    }

    if (!renderedIds.has(activeId)) {
      const c = snap.character;
      const pose = interpolateMemberPosition(
        { x: c.x, y: c.y, dir: c.dir, action: c.action, movePath: c.movePath, activeWork: c.activeWork },
        nowMs,
      );
      const modelId = c.modelId ?? 'PHM011';
      const manifest = this.loader.getSprite(modelId) ?? null;
      const plan = provider.resolveCharacter(
        {
          id: activeId,
          name: c.name ?? activeId,
          kind: 'player',
          modelId,
          weaponModel: c.weaponModel,
          tint: c.tint,
          action: pose.actionCode,
          dir: pose.dir,
          nowMs,
        },
        manifest,
        assets,
      );
      this.addCharacterContainer(
        pose.x,
        pose.y,
        c.name ?? activeId,
        plan.layers,
        activeId === watchedId,
        0x7cb7ff,
      );
    }
  }

  private addCharacterContainer(
    x: number,
    y: number,
    label: string,
    layers: AppearanceLayerPlan[],
    isWatched: boolean,
    labelColor: number,
  ): void {
    const c = new Container();
    c.x = Math.round(x);
    c.y = Math.round(y);
    c.zIndex = y;

    if (isWatched) {
      const ring = new Graphics();
      ring.ellipse(0, 0, 22, 10).stroke({ color: 0x7cb7ff, width: 2 });
      c.addChild(ring);
    } else {
      const shadow = new Graphics();
      shadow.ellipse(0, 0, 16, 7).fill({ color: 0x000000, alpha: 0.35 });
      c.addChild(shadow);
    }

    let drewAnyLayer = false;
    for (const layer of layers) {
      const tex = this.sliceTexture(layer);
      if (!tex) continue;
      const sp = new Sprite(tex);
      sp.x = Math.round(layer.offsetX);
      sp.y = Math.round(layer.offsetY);
      if (layer.tintColor) {
        sp.tint = Number.parseInt(layer.tintColor.slice(1), 16);
      }
      c.addChild(sp);
      drewAnyLayer = true;
    }

    if (!drewAnyLayer) {
      const marker = new Graphics();
      marker.circle(0, -18, 12).fill({ color: labelColor, alpha: 0.85 }).stroke({ color: 0xffffff, width: 1.5 });
      c.addChild(marker);
    }

    const txt = new Text({
      text: label,
      style: {
        fontFamily: 'sans-serif',
        fontSize: 12,
        fill: labelColor,
        stroke: { color: 0x000000, width: 3 },
      },
    });
    txt.anchor.set(0.5, 1);
    txt.y = -46;
    c.addChild(txt);

    this.entityLayer.addChild(c);
  }

  destroy(): void {
    this.destroyed = true;
    this.initialized = false;
    if (this.app) {
      this.app.destroy(true);
      this.app = null;
    }
  }
}
