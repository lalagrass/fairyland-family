import type {
  BattleEnemyBrief,
  BattleEnemyState,
  BattleTimelineItem,
  CharacterVisualAction,
  SnapshotBattleUnitSummary,
  StaticSkillSummary,
} from '../protocol/index';
import { defaultEffectRegistry } from './effects/registry';
import type { EffectScript } from './effects/schema';
import { resolveSkillDisplay } from './skillDisplayMap';

export interface BattleUnitRenderState {
  id: string;
  side: 'ally' | 'enemy';
  name: string;
  modelId: string;
  colorTint?: string;
  x: number;
  y: number;
  dir: number;
  action: CharacterVisualAction;
  hp: number;
  maxHp: number;
  isDead: boolean;
  flashColor?: string;
  statuses: string[];
}

export interface ActiveEffectCue {
  key: string;
  script: EffectScript;
  elapsedMs: number;
  actorId?: string;
  targetId?: string;
}

export interface FloatingPopup {
  key: string;
  x: number;
  y: number;
  text: string;
  color: string;
  progress: number; // 0..1
}

export interface BattleFrameState {
  units: BattleUnitRenderState[];
  effects: ActiveEffectCue[];
  popups: FloatingPopup[];
  shakeOffset: { x: number; y: number };
  finished: boolean;
}

export interface BattleUnitSeed {
  id: string;
  side: 'ally' | 'enemy';
  name: string;
  modelId: string;
  colorTint?: string;
  baseX: number;
  baseY: number;
  dir: number;
  startHp: number;
  maxHp: number;
  isDead: boolean;
  statuses: string[];
}

export interface BattlePlaybackPlan {
  round: number;
  units: BattleUnitSeed[];
  events: BattleTimelineItem[];
  totalDurationMs: number;
  skillsCatalog: StaticSkillSummary[];
  attackerAppearanceId?: string;
}

const ALLY_SLOTS = [
  { x: 600, y: 240 },
  { x: 640, y: 310 },
  { x: 560, y: 350 },
];
const ENEMY_SLOTS = [
  { x: 200, y: 200 },
  { x: 250, y: 265 },
  { x: 165, y: 300 },
  { x: 295, y: 325 },
  { x: 215, y: 365 },
];

/** 建立單場／單回合戰鬥的單位起始狀態與 FX14 時間軸播放計畫。 */
export function buildBattlePlayback(params: {
  round: number;
  player?: SnapshotBattleUnitSummary;
  pet?: SnapshotBattleUnitSummary | null;
  allies?: SnapshotBattleUnitSummary[];
  enemyVisuals?: BattleEnemyBrief[];
  enemyStates: BattleEnemyState[];
  events: BattleTimelineItem[];
  playerModelId?: string;
  skillsCatalog?: StaticSkillSummary[];
  attackerAppearanceId?: string;
}): BattlePlaybackPlan {
  const units: BattleUnitSeed[] = [];

  const allyList: SnapshotBattleUnitSummary[] = [];
  if (params.allies && params.allies.length > 0) {
    allyList.push(...params.allies);
  } else {
    if (params.player) allyList.push(params.player);
    if (params.pet) allyList.push(params.pet);
  }

  allyList.forEach((a, idx) => {
    const slotPos = ALLY_SLOTS[idx % ALLY_SLOTS.length];
    const id = a.id ?? (idx === 0 ? 'p1' : `pet_${idx}`);
    units.push({
      id,
      side: 'ally',
      name: a.name,
      modelId: a.modelId ?? params.playerModelId ?? 'PHM011',
      baseX: slotPos.x,
      baseY: slotPos.y,
      dir: 3, // NW 面向左上方敵人
      startHp: a.hp,
      maxHp: Math.max(1, a.maxHp),
      isDead: Boolean(a.isDead),
      statuses: (a.statuses ?? []).map(s => s.type),
    });
  });

  const enemyCount = Math.max(params.enemyStates.length, params.enemyVisuals?.length ?? 0);
  for (let i = 0; i < enemyCount; i += 1) {
    const st = params.enemyStates[i];
    const vis = params.enemyVisuals?.[i];
    const pos = ENEMY_SLOTS[i % ENEMY_SLOTS.length];
    const slotNum = st?.slot ?? vis?.slot ?? i;
    const id = st?.id || `enemy-${slotNum + 1}`;
    const hp = st?.hp ?? 100;
    const maxHp = Math.max(1, st?.maxHp ?? hp);
    units.push({
      id,
      side: 'enemy',
      name: st?.name ?? vis?.name ?? `敵人 ${i + 1}`,
      modelId: st?.modelId ?? vis?.modelId ?? 'MBA011',
      colorTint: st?.colorTint ?? vis?.colorTint,
      baseX: pos.x,
      baseY: pos.y,
      dir: 7, // SE 面向右下方我方
      startHp: hp,
      maxHp,
      isDead: Boolean(st?.isDead),
      statuses: (st?.statuses ?? []).map(s => s.type),
    });
  }

  const maxT = params.events.reduce((acc, ev) => Math.max(acc, ev.tMs), 0);
  return {
    round: params.round,
    units,
    events: [...params.events].sort((a, b) => a.tMs - b.tMs),
    totalDurationMs: Math.max(800, maxT + 750),
    skillsCatalog: params.skillsCatalog ?? [],
    attackerAppearanceId: params.attackerAppearanceId,
  };
}

function matchUnitId(unit: BattleUnitSeed, queryId?: string): boolean {
  if (!queryId) return false;
  if (unit.id === queryId) return true;
  if (unit.side === 'enemy') {
    const qNorm = queryId.replace(/^e_?/, 'enemy-').replace(/^enemy_/, 'enemy-');
    if (unit.id === qNorm) return true;
  }
  return false;
}

/**
 * 純函式評估指定播放時間點 `elapsedMs` 的戰鬥舞台狀態（單位位移、血量變化、特效進度、飄字與震動）。
 */
export function evaluateBattleFrame(plan: BattlePlaybackPlan, elapsedMs: number): BattleFrameState {
  const unitMap = new Map<string, BattleUnitRenderState>();
  for (const seed of plan.units) {
    unitMap.set(seed.id, {
      id: seed.id,
      side: seed.side,
      name: seed.name,
      modelId: seed.modelId,
      colorTint: seed.colorTint,
      x: seed.baseX,
      y: seed.baseY,
      dir: seed.dir,
      action: 'BATTLE',
      hp: seed.startHp,
      maxHp: seed.maxHp,
      isDead: seed.isDead,
      statuses: [...seed.statuses],
    });
  }

  const findUnit = (id?: string) => {
    if (!id) return undefined;
    for (const seed of plan.units) {
      if (matchUnitId(seed, id)) return unitMap.get(seed.id);
    }
    return undefined;
  };

  const effects: ActiveEffectCue[] = [];
  const popups: FloatingPopup[] = [];
  let shakePx = 0;

  for (let i = 0; i < plan.events.length; i += 1) {
    const ev = plan.events[i];
    if (elapsedMs < ev.tMs) continue;
    const localMs = elapsedMs - ev.tMs;

    if (ev.type === 'ACTION_START') {
      const actor = findUnit(ev.actorId);
      if (actor && localMs < 460) {
        const lunge = Math.sin((localMs / 460) * Math.PI);
        const dirSign = actor.side === 'ally' ? -1 : 1;
        actor.x += Math.round(dirSign * lunge * 46);
        actor.y += Math.round(dirSign * lunge * 16);
      }

      const appId = actor?.side === 'ally' ? (plan.attackerAppearanceId ?? 'original') : 'original';
      const mappedDisplay = resolveSkillDisplay(appId, ev.skillId, ev.actionName);
      let script = defaultEffectRegistry.resolve(
        { skillId: ev.skillId, actionName: mappedDisplay.displayName, effectId: ev.effectId },
        plan.skillsCatalog,
      );
      if (mappedDisplay.overrideScriptId) {
        const overridden = defaultEffectRegistry.listAll().find(x => x.id === mappedDisplay.overrideScriptId);
        if (overridden) script = overridden;
      }
      if (actor && localMs < 360 && mappedDisplay.displayName) {
        popups.push({
          key: `skill-${i}`,
          x: actor.x,
          y: Math.round(actor.y - 68),
          text: `${mappedDisplay.iconGlyph} ${mappedDisplay.displayName}`,
          color: '#7cb7ff',
          progress: localMs / 420,
        });
      }
      if (localMs >= 0 && localMs <= script.durationMs) {
        effects.push({
          key: `fx-${i}-${ev.tMs}`,
          script,
          elapsedMs: localMs,
          actorId: ev.actorId,
          targetId: ev.targetId ?? ev.targetIds?.[0],
        });
        if (script.hitFlash && localMs <= script.hitFlash.durationMs) {
          const tId = ev.targetId ?? ev.targetIds?.[0];
          const target = findUnit(tId);
          if (target) target.flashColor = script.hitFlash.color;
        }
        if (script.shakePx && localMs < 180) {
          shakePx = Math.max(shakePx, script.shakePx);
        }
      }
    } else if (ev.type === 'DAMAGE' || ev.type === 'COUNTER') {
      const target = findUnit(ev.targetId);
      const dmg = Math.max(0, ev.damage ?? 0);
      if (target) {
        target.hp = Math.max(0, target.hp - dmg);
        if (target.hp === 0) target.isDead = true;
        if (localMs < 140) target.flashColor = ev.isCrit ? '#ffcb6b' : '#ffffff';
        if (localMs < 700) {
          const progress = localMs / 700;
          popups.push({
            key: `dmg-${i}`,
            x: target.x,
            y: Math.round(target.y - 54 - progress * 26),
            text: ev.isCrit ? `暴擊 -${dmg}` : `-${dmg}`,
            color: ev.isCrit ? '#ffcb6b' : '#ff6b6b',
            progress,
          });
        }
      }
    } else if (ev.type === 'HEAL') {
      const target = findUnit(ev.targetId);
      const heal = Math.max(0, ev.heal ?? 0);
      if (target) {
        target.hp = Math.min(target.maxHp, target.hp + heal);
        if (localMs < 700) {
          const progress = localMs / 700;
          popups.push({
            key: `heal-${i}`,
            x: target.x,
            y: Math.round(target.y - 54 - progress * 24),
            text: `+${heal}`,
            color: '#5fd38d',
            progress,
          });
        }
      }
    } else if (ev.type === 'DEATH') {
      const target = findUnit(ev.targetId);
      if (target) {
        target.hp = 0;
        target.isDead = true;
      }
    } else if (ev.type === 'STATUS_APPLY' && ev.statusType) {
      const target = findUnit(ev.targetId);
      if (target && !target.statuses.includes(ev.statusType)) {
        target.statuses.push(ev.statusType);
      }
    } else if (ev.type === 'STATUS_REMOVE' && ev.statusType) {
      const target = findUnit(ev.targetId);
      if (target) {
        target.statuses = target.statuses.filter(s => s !== ev.statusType);
      }
    }
  }

  const shakeOffset =
    shakePx > 0
      ? {
          x: Math.round(Math.sin(elapsedMs * 0.19) * shakePx),
          y: Math.round(Math.cos(elapsedMs * 0.23) * (shakePx * 0.6)),
        }
      : { x: 0, y: 0 };

  return {
    units: [...unitMap.values()],
    effects,
    popups,
    shakeOffset,
    finished: elapsedMs >= plan.totalDurationMs,
  };
}
