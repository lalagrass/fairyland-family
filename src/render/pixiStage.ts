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
  getAppearanceProvider,
  originalAppearanceProvider,
  type AppearanceLayerPlan,
  type AppearanceProvider,
  type AppearanceRenderPlan,
  type VectorShapeLayer,
} from './appearance';
import { RuntimeAssetLoader, type RuntimeMapScene } from './assetLoader';
import { BattleStageRenderer } from './battleStage';
import {
  computeWeatherParticles,
  resolveAmbientLighting,
  type TimeOfDayMode,
  type WeatherMode,
} from './environmentFx';
import {
  computeIntegerScale,
  interpolateMemberPosition,
  selectCameraTarget,
} from './extrapolation';
import { chunkMacroCellBounds, MapChunkLruTracker, visibleChunkCoords } from './mapChunks';
import { DisplayPool } from './displayPool';
import { computeSeamlessNeighbors, isSeamlessTransition } from './seamlessNeighbors';

const GROUND_CELL_W = 160;
const GROUND_CELL_H = 80;

export type ZoomSetting = 'auto' | 1 | 2;

export interface StageSyncInput {
  state: FamilyState;
  watchCharacterId: string | null;
  zoomSetting: ZoomSetting;
  appearances?: Record<string, string>;
  timeOfDay?: TimeOfDayMode;
  weather?: WeatherMode;
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
  private decorLayer = new Container();
  private entityLayer = new Container();
  private ambientLayer = new Graphics();
  private weatherLayer = new Graphics();
  private battleLayer = new Container();
  private uiOverlay = new Container();
  private loader = new RuntimeAssetLoader();
  private battleRenderer = new BattleStageRenderer();
  private chunkTracker = new MapChunkLruTracker(48);
  private lastMapId: string | null = null;
  private lastMapScene: RuntimeMapScene | null = null;
  private fadeUntilMs = 0;
  private textureCache = new Map<string, Texture>();
  private textureInflight = new Map<string, Promise<Texture | null>>();
  private subTextureCache = new Map<string, Texture>();
  private latestInput: StageSyncInput | null = null;
  private currentScale = 1;
  private initialized = false;
  private destroyed = false;
  private lastGroundKey = '';
  private pool = new DisplayPool(400);

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
      this.worldContainer.addChild(this.groundLayer, this.decorLayer, this.entityLayer, this.uiOverlay);
      this.battleLayer.visible = false;
      app.stage.addChild(this.worldContainer, this.ambientLayer, this.weatherLayer, this.battleLayer);

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
      void this.loader.loadDecorations(mapId);
      void this.loader.loadMap(mapId, assets).then(scene => {
        if (!scene || this.destroyed) return;
        for (const npc of scene.npcs ?? []) {
          const mId = npc.runtime_model || npc.model;
          if (mId) void this.loader.loadSprite(mId, assets);
        }
        for (const n of computeSeamlessNeighbors(scene)) {
          void this.loader.loadMap(n.targetMapId, assets);
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
    const { state, watchCharacterId, zoomSetting, appearances } = this.latestInput;
    const defaultProvider = this.latestInput.provider ?? originalAppearanceProvider;
    const resolveProviderFor = (charId: string) =>
      appearances?.[charId] ? getAppearanceProvider(appearances[charId]) : defaultProvider;
    const snap = state.snapshot;
    if (!snap) return;

    const nowMs = Date.now();
    const viewW = Math.max(1, this.app.screen.width);
    const viewH = Math.max(1, this.app.screen.height);

    // 戰鬥畫面模式（FM2/FM3）：切換至獨立 BattleStageRenderer 播放 FX14 時間軸與每角色外觀＋技能顯示對照
    if (state.battle) {
      this.worldContainer.visible = false;
      this.battleLayer.visible = true;
      this.battleRenderer.render({
        container: this.battleLayer,
        state,
        nowMs,
        viewW,
        viewH,
        appearances,
        provider: defaultProvider,
        getSpriteManifest: id => this.loader.getSprite(id) ?? null,
        ensureSpriteLoaded: (id, assets) => void this.loader.loadSprite(id, assets),
        getTexture: url => this.getOrLoadTexture(url),
      });
      return;
    }

    this.worldContainer.visible = true;
    this.battleLayer.visible = false;
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
    if (snap.mapId !== this.lastMapId) {
      if (this.lastMapId && !isSeamlessTransition(this.lastMapId, snap.mapId, this.lastMapScene)) {
        this.fadeUntilMs = nowMs + 180;
      }
      this.lastMapId = snap.mapId;
    }
    if (scene) this.lastMapScene = scene;

    const mapW = scene?.pixel_width ?? 3200;
    const mapH = scene?.pixel_height ?? 2400;
    const logicalW = viewW / intScale;
    const logicalH = viewH / intScale;
    const camX = Math.round(Math.max(0, Math.min(Math.max(0, mapW - logicalW), camTargetX - logicalW / 2)));
    const camY = Math.round(Math.max(0, Math.min(Math.max(0, mapH - logicalH), camTargetY - logicalH / 2)));
    this.worldContainer.position.set(-camX * intScale, -camY * intScale);

    this.drawGroundWithNeighbors(scene, camX, camY, logicalW, logicalH, nowMs);
    this.drawDecorations(snap.mapId, nowMs, this.latestInput.timeOfDay ?? 'day');
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
      resolveProviderFor,
    );
    this.drawEnvironmentFx(
      viewW,
      viewH,
      nowMs,
      this.latestInput.timeOfDay ?? 'day',
      this.latestInput.weather ?? 'clear',
    );
  }

  private drawGroundWithNeighbors(
    scene: RuntimeMapScene | null,
    camX: number,
    camY: number,
    logicalW: number,
    logicalH: number,
    nowMs: number,
  ): void {
    this.drawGround(scene, camX, camY, logicalW, logicalH, nowMs);
  }

  private drawDecorations(mapId: string, nowMs: number, timeOfDay: TimeOfDayMode): void {
    this.pool.release(this.decorLayer);
    const items = this.loader.getDecorations(mapId);
    if (items.length === 0) return;
    const lighting = resolveAmbientLighting(timeOfDay, new Date(nowMs).getHours());
    for (const d of items) {
      const col = Number.parseInt(d.colorHex.replace(/^#/, ''), 16);
      const glow = d.kind === 'lantern' ? Math.round(lighting.warmGlowAlpha * 100) : 0;
      const g = this.pool.acquire(`dec:${d.kind}:${d.x}:${d.y}:${d.width}:${d.height}:${d.colorHex}:${glow}`, () => new Graphics());
      if (g.children.length === 0 && g.context.instructions.length === 0) {
        this.paintDecoration(g, d, col, lighting.warmGlowAlpha);
      }
      this.decorLayer.addChild(g);
    }
  }

  private paintDecoration(
    g: Graphics,
    d: ReturnType<RuntimeAssetLoader['getDecorations']>[number],
    col: number,
    warmGlowAlpha: number,
  ): void {
    {
      if (d.kind === 'lantern') {
        if (warmGlowAlpha > 0) {
          g.circle(d.x, d.y, 44).fill({ color: 0xffc15e, alpha: warmGlowAlpha });
        }
        g.roundRect(d.x - 6, d.y - 14, 12, 16, 3).fill(col).stroke({ color: 0x3b230a, width: 1.5 });
      } else if (d.kind === 'flower_bed') {
        g.roundRect(d.x - d.width / 2, d.y - d.height / 2, d.width, d.height, 6).fill({ color: col, alpha: 0.78 });
      } else {
        g.rect(d.x - 8, d.y - 16, 16, 18).fill(col).stroke({ color: 0x2b1d0e, width: 1 });
      }
    }
  }

  private drawEnvironmentFx(
    viewW: number,
    viewH: number,
    nowMs: number,
    timeOfDay: TimeOfDayMode,
    weather: WeatherMode,
  ): void {
    const lighting = resolveAmbientLighting(timeOfDay, new Date(nowMs).getHours());
    this.ambientLayer.clear();
    if (lighting.alpha > 0) {
      this.ambientLayer.rect(0, 0, viewW, viewH).fill({ color: lighting.tintColor, alpha: lighting.alpha });
    }
    if (this.fadeUntilMs > nowMs) {
      const k = Math.max(0, Math.min(1, (this.fadeUntilMs - nowMs) / 180));
      this.ambientLayer.rect(0, 0, viewW, viewH).fill({ color: 0x000000, alpha: k * 0.6 });
    }

    this.weatherLayer.clear();
    const drops = computeWeatherParticles(weather, viewW, viewH, nowMs);
    for (const dr of drops) {
      if (weather === 'rain') {
        this.weatherLayer
          .moveTo(dr.x, dr.y)
          .lineTo(dr.x - 4, dr.y + dr.length)
          .stroke({ color: 0x9ecaff, width: 1.2, alpha: dr.alpha });
      } else {
        this.weatherLayer.ellipse(dr.x, dr.y, dr.length, dr.length * 0.35).fill({ color: 0xdbe7f5, alpha: dr.alpha });
      }
    }
  }

  private drawGround(
    scene: RuntimeMapScene | null,
    camX: number,
    camY: number,
    logicalW: number,
    logicalH: number,
    nowMs = Date.now(),
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
    const chunks = visibleChunkCoords(
      scene.map_id,
      camX,
      camY,
      logicalW,
      logicalH,
      scene.pixel_width,
      scene.pixel_height,
    );
    for (const ch of chunks) this.chunkTracker.touch(ch.key, nowMs);

    const neighborSlices: Array<{ scene: RuntimeMapScene; ox: number; oy: number }> = [];
    for (const nb of computeSeamlessNeighbors(scene)) {
      const ns = this.loader.getMap(nb.targetMapId);
      if (ns?.ground?.macro_grid?.length) {
        neighborSlices.push({ scene: ns, ox: nb.offsetX, oy: nb.offsetY });
      }
    }

    const key = `${scene.map_id}:${chunks.map(c => c.key).join('|')}:${neighborSlices.length}:${this.textureCache.size}`;
    if (key === this.lastGroundKey) return;
    this.lastGroundKey = key;

    this.groundLayer.removeChildren().forEach(c => c.destroy());
    const paintedCells = new Set<string>();
    for (const ch of chunks) {
      const b = chunkMacroCellBounds(ch.cx, ch.cy, cols, rows);
      for (let r = b.row0; r <= b.row1; r += 1) {
        for (let c = b.col0; c <= b.col1; c += 1) {
          const ck = `${r},${c}`;
          if (paintedCells.has(ck)) continue;
          paintedCells.add(ck);
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

    // 無縫繪製相鄰戶外地圖在視野範圍內的地表格（避免走向北綠野時邊界黑屏）
    for (const nb of neighborSlices) {
      const ncols = nb.scene.ground!.macro_width;
      const nrows = nb.scene.ground!.macro_height;
      const nc0 = Math.max(0, Math.floor((camX - nb.ox) / GROUND_CELL_W) - 1);
      const nc1 = Math.min(ncols - 1, Math.ceil((camX + logicalW - nb.ox) / GROUND_CELL_W) + 1);
      const nr0 = Math.max(0, Math.floor((camY - nb.oy) / GROUND_CELL_H) - 1);
      const nr1 = Math.min(nrows - 1, Math.ceil((camY + logicalH - nb.oy) / GROUND_CELL_H) + 1);
      for (let r = nr0; r <= nr1; r += 1) {
        for (let c = nc0; c <= nc1; c += 1) {
          const cell = nb.scene.ground!.macro_grid[r * ncols + c];
          if (!cell?.tile_file) continue;
          const tex = this.getOrLoadTexture(cell.tile_file);
          if (!tex) continue;
          const sp = new Sprite(tex);
          sp.width = GROUND_CELL_W;
          sp.height = GROUND_CELL_H;
          sp.x = nb.ox + c * GROUND_CELL_W;
          sp.y = nb.oy + r * GROUND_CELL_H;
          this.groundLayer.addChild(sp);
        }
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
    resolveProviderFor: (charId: string) => AppearanceProvider,
  ): void {
    this.pool.release(this.entityLayer);

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
        const g = this.pool.acquire(`portal:${p.world_x}:${p.world_y}`, () => {
          const pg = new Graphics();
          pg.circle(p.world_x, p.world_y, 16).fill({ color: 0x56d8c4, alpha: 0.25 }).stroke({ color: 0x56d8c4, width: 2 });
          return pg;
        });
        g.zIndex = p.world_y - 2;
        this.entityLayer.addChild(g);
      }

      const npcProvider = originalAppearanceProvider;
      for (const npc of scene.npcs ?? []) {
        const modelId = npc.runtime_model || npc.model || '';
        const manifest = modelId ? this.loader.getSprite(modelId) ?? null : null;
        const plan = npcProvider.resolveCharacter(
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
        this.addCharacterContainer(npc.world_x, npc.world_y, npc.name, plan, false, 0xf2d388);
      }
    }

    // 2. 家族成員（每個成員可各自用「原版」或「新外觀」，同畫面同時存在）
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
      const memberProvider = resolveProviderFor(m.characterId);
      const plan = memberProvider.resolveCharacter(
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
        plan,
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
      const plan = resolveProviderFor(activeId).resolveCharacter(
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
        plan,
        activeId === watchedId,
        0x7cb7ff,
      );
    }
  }

  private addCharacterContainer(
    x: number,
    y: number,
    label: string,
    plan: AppearanceRenderPlan,
    isWatched: boolean,
    labelColor: number,
  ): void {
    const c = new Container();
    c.x = Math.round(x);
    c.y = Math.round(y);
    c.zIndex = y;

    if (isWatched) {
      c.addChild(this.pool.acquire('ring', () => new Graphics().ellipse(0, 0, 22, 10).stroke({ color: 0x7cb7ff, width: 2 })));
    } else {
      c.addChild(this.pool.acquire('shadow', () => new Graphics().ellipse(0, 0, 16, 7).fill({ color: 0x000000, alpha: 0.35 })));
    }

    let drewAnyLayer = false;
    for (const layer of plan.layers) {
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

    if (plan.vectorLayers && plan.vectorLayers.length > 0) {
      const g = new Graphics();
      drawVectorLayers(g, plan.vectorLayers);
      c.addChild(g);
      drewAnyLayer = true;
    }

    if (!drewAnyLayer) {
      c.addChild(
        this.pool.acquire(`marker:${labelColor}`, () =>
          new Graphics().circle(0, -18, 12).fill({ color: labelColor, alpha: 0.85 }).stroke({ color: 0xffffff, width: 1.5 }),
        ),
      );
    }

    const txt = this.pool.acquire(`label:${labelColor}:${label}`, () => {
      const t = new Text({
        text: label,
        style: {
          fontFamily: 'sans-serif',
          fontSize: 12,
          fill: labelColor,
          stroke: { color: 0x000000, width: 3 },
        },
      });
      t.anchor.set(0.5, 1);
      t.y = -46;
      return t;
    });
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

export function drawVectorLayers(g: Graphics, shapes: VectorShapeLayer[]): void {
  for (const s of shapes) {
    const fill = Number.parseInt(s.fillHex.replace(/^#/, ''), 16);
    const stroke = s.strokeHex ? Number.parseInt(s.strokeHex.replace(/^#/, ''), 16) : undefined;
    if (s.shape === 'circle') {
      g.circle(s.x, s.y, s.radius ?? 6).fill(fill);
      if (stroke !== undefined) g.stroke({ color: stroke, width: 1.5 });
    } else if (s.shape === 'rect') {
      g.rect(s.x, s.y, s.w ?? 16, s.h ?? 16).fill(fill);
      if (stroke !== undefined) g.stroke({ color: stroke, width: 1 });
    } else if (s.shape === 'diamond') {
      const hw = (s.w ?? 20) / 2;
      const hh = (s.h ?? 24) / 2;
      g.poly([s.x, s.y - hh, s.x + hw, s.y, s.x, s.y + hh, s.x - hw, s.y]).fill(fill);
      if (stroke !== undefined) g.stroke({ color: stroke, width: 1.5 });
    }
  }
}
