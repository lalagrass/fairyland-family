import { Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import type { StaticAssetManifest } from '../protocol/index';
import type { FamilyState } from '../state';
import {
  getAppearanceProvider,
  originalAppearanceProvider,
  type AppearanceProvider,
  type SpriteModelManifest,
} from './appearance';
import { buildBattlePlayback, evaluateBattleFrame } from './battleTimeline';
import { visualActionToCode } from './extrapolation';
import { drawVectorLayers } from './pixiStage';
import { EffectPlayer } from './effects/effectPlayer';

export const BATTLE_ARENA_W = 800;
export const BATTLE_ARENA_H = 480;

export class BattleStageRenderer {
  private effectPlayer = new EffectPlayer();

  render(params: {
    container: Container;
    state: FamilyState;
    nowMs: number;
    viewW: number;
    viewH: number;
    appearances?: Record<string, string>;
    provider?: AppearanceProvider;
    getSpriteManifest: (modelId: string) => SpriteModelManifest | null;
    ensureSpriteLoaded: (modelId: string, assets?: StaticAssetManifest) => void;
    getTexture: (url: string) => Texture | null;
  }): void {
    const { container, state, nowMs, viewW, viewH, appearances, getSpriteManifest, ensureSpriteLoaded, getTexture } = params;
    const defaultProvider = params.provider ?? originalAppearanceProvider;
    const activeCharId = state.characterId ?? state.activeCharacterId ?? 'active';
    const battle = state.battle;
    if (!battle) return;

    const old = container.removeChildren();
    for (const c of old) c.destroy({ children: true });

    const fitScale = Math.max(0.5, Math.min(viewW / BATTLE_ARENA_W, viewH / BATTLE_ARENA_H));
    const arena = new Container();
    arena.scale.set(fitScale, fitScale);
    arena.x = Math.round((viewW - BATTLE_ARENA_W * fitScale) / 2);
    arena.y = Math.round((viewH - BATTLE_ARENA_H * fitScale) / 2);

    const bg = new Graphics();
    bg.rect(0, 0, BATTLE_ARENA_W, BATTLE_ARENA_H).fill(0x111924);
    bg.ellipse(230, 290, 190, 95).fill({ color: 0x1b2838, alpha: 0.75 });
    bg.ellipse(585, 305, 165, 85).fill({ color: 0x1d312d, alpha: 0.75 });
    arena.addChild(bg);

    const tl = battle.timeline;
    const attackerAppearanceId = appearances?.[activeCharId] ?? defaultProvider.id;
    const plan = buildBattlePlayback({
      round: tl?.round ?? battle.round ?? 1,
      player: battle.player,
      pet: battle.pet,
      allies: battle.allies,
      enemyVisuals: battle.enemyVisuals,
      enemyStates: battle.enemyStates,
      events: tl?.events ?? [],
      playerModelId: state.snapshot?.character.modelId,
      skillsCatalog: state.staticData?.skills ?? [],
      attackerAppearanceId,
    });

    const elapsedMs = tl ? Math.max(0, nowMs - tl.receivedAt) : 0;
    const frame = evaluateBattleFrame(plan, elapsedMs);
    arena.x += frame.shakeOffset.x;
    arena.y += frame.shakeOffset.y;

    const assets = state.staticData?.assets;
    const posMap = new Map<string, { x: number; y: number }>();
    for (const u of frame.units) posMap.set(u.id, { x: u.x, y: u.y });

    // 1. 單位（依 Y 排序，每個角色可用各自選定的外觀）
    const sortedUnits = [...frame.units].sort((a, b) => a.y - b.y);
    for (const u of sortedUnits) {
      const unitProvider =
        u.side === 'ally'
          ? getAppearanceProvider(appearances?.[u.id] ?? appearances?.[activeCharId] ?? defaultProvider.id)
          : originalAppearanceProvider;
      ensureSpriteLoaded(u.modelId, assets);
      const manifest = getSpriteManifest(u.modelId);
      const renderPlan = unitProvider.resolveCharacter(
        {
          id: u.id,
          name: u.name,
          kind: u.side === 'ally' ? 'player' : 'npc',
          modelId: u.modelId,
          action: visualActionToCode(u.action),
          dir: u.dir,
          nowMs,
        },
        manifest,
        assets,
      );

      const unitBox = new Container();
      unitBox.x = Math.round(u.x);
      unitBox.y = Math.round(u.y);
      unitBox.alpha = u.isDead ? 0.32 : 1;

      const shadow = new Graphics();
      shadow.ellipse(0, 0, 20, 8).fill({ color: 0x000000, alpha: 0.4 });
      unitBox.addChild(shadow);

      if (renderPlan.vectorLayers && renderPlan.vectorLayers.length > 0) {
        const g = new Graphics();
        drawVectorLayers(g, renderPlan.vectorLayers);
        unitBox.addChild(g);
      } else if (renderPlan.layers.length === 0) {
        const body = new Graphics();
        body.circle(0, -24, 15).fill(u.side === 'ally' ? 0x5fd38d : 0xff7b7b);
        unitBox.addChild(body);
      } else {
        for (const layer of renderPlan.layers) {
          const base = getTexture(layer.imageUrl);
          if (!base) continue;
          const sp = new Sprite(base);
          sp.x = Math.round(layer.offsetX);
          sp.y = Math.round(layer.offsetY);
          if (u.flashColor) {
            const flashHex = Number.parseInt(u.flashColor.replace(/^#/, ''), 16);
            if (Number.isFinite(flashHex)) sp.tint = flashHex;
          }
          unitBox.addChild(sp);
        }
      }

      // HP Bar
      const ratio = u.maxHp > 0 ? Math.max(0, Math.min(1, u.hp / u.maxHp)) : 0;
      const bar = new Graphics();
      bar.rect(-24, 8, 48, 5).fill(0x0b0f14);
      bar.rect(-24, 8, Math.round(48 * ratio), 5).fill(u.side === 'ally' ? 0x5fd38d : 0xff6b6b);
      unitBox.addChild(bar);

      const nameTxt = new Text({
        text: `${u.name} ${u.hp}/${u.maxHp}`,
        style: { fontFamily: 'sans-serif', fontSize: 11, fill: 0xe4eaf3, stroke: { color: 0x000000, width: 3 } },
      });
      nameTxt.anchor.set(0.5, 0);
      nameTxt.y = 15;
      unitBox.addChild(nameTxt);

      arena.addChild(unitBox);
    }

    // 2. 統一特效播放器（序列幀＋粒子）
    for (let i = 0; i < frame.effects.length; i += 1) {
      const cue = frame.effects[i];
      const actorPos = (cue.actorId && posMap.get(cue.actorId)) || { x: 600, y: 240 };
      const targetPos = (cue.targetId && posMap.get(cue.targetId)) || { x: 200, y: 200 };
      const fxContainer = this.effectPlayer.renderEffect(
        cue.script,
        cue.elapsedMs,
        { actor: actorPos, target: targetPos, center: { x: BATTLE_ARENA_W / 2, y: BATTLE_ARENA_H / 2 } },
        i + 1 + plan.round * 31,
        assets,
        getTexture,
      );
      arena.addChild(fxContainer);
    }

    // 3. 傷害／補血飄字
    for (const p of frame.popups) {
      const txt = new Text({
        text: p.text,
        style: {
          fontFamily: 'sans-serif',
          fontSize: 16,
          fontWeight: 'bold',
          fill: p.color,
          stroke: { color: 0x000000, width: 4 },
        },
      });
      txt.anchor.set(0.5, 0.5);
      txt.x = p.x;
      txt.y = p.y;
      txt.alpha = Math.max(0, 1 - Math.max(0, p.progress - 0.6) / 0.4);
      arena.addChild(txt);
    }

    container.addChild(arena);
  }
}
