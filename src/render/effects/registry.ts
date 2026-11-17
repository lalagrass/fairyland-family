import rawScripts from './scripts/sp129_split_and_core.json';
import type { StaticSkillSummary } from '../../protocol/index';
import { isValidEffectScript, type EffectScript } from './schema';

const BUILTIN_SCRIPTS: EffectScript[] = (rawScripts as unknown[]).filter(isValidEffectScript);

export interface EffectQuery {
  skillId?: number;
  actionName?: string;
  effectId?: string;
}

export class EffectScriptRegistry {
  private byId = new Map<string, EffectScript>();
  private bySkillId = new Map<number, EffectScript>();
  private byEffectId = new Map<string, EffectScript>();

  constructor(scripts: EffectScript[] = BUILTIN_SCRIPTS) {
    for (const s of scripts) this.register(s);
  }

  register(script: EffectScript): void {
    if (!isValidEffectScript(script)) {
      throw new Error(`無效的特效腳本格式：${String((script as { id?: unknown })?.id ?? '?')}`);
    }
    this.byId.set(script.id, script);
    for (const sid of script.skillIds ?? []) this.bySkillId.set(sid, script);
    for (const eid of script.effectIds ?? []) this.byEffectId.set(eid, script);
  }

  listAll(): EffectScript[] {
    return [...this.byId.values()];
  }

  /**
   * 依優先序解析特效腳本：
   * 1) `skillId` 專屬腳本（每個原共用 sp129 的技能皆各自對應獨立腳本）
   * 2) 內建 `effectId` 腳本
   * 3) 若宿主傳入 FX12/FX15 `effectId` 或 `animId`，即時包成序列幀＋粒子混合腳本（不含任何像素）
   * 4) 預設基礎斬擊腳本
   */
  resolve(query: EffectQuery, catalogSkills: StaticSkillSummary[] = []): EffectScript {
    if (query.skillId != null) {
      const exact = this.bySkillId.get(query.skillId);
      if (exact) return exact;
    }

    if (query.effectId && this.byEffectId.has(query.effectId)) {
      return this.byEffectId.get(query.effectId)!;
    }

    const catalogMatch =
      query.skillId != null
        ? catalogSkills.find(s => s.id === query.skillId)
        : query.actionName
          ? catalogSkills.find(s => s.name === query.actionName)
          : undefined;

    const animOrEffectId = query.effectId || catalogMatch?.animId;
    if (animOrEffectId && animOrEffectId !== 'sp129') {
      const matchedByEffect = this.byEffectId.get(animOrEffectId);
      if (matchedByEffect) return matchedByEffect;
      return {
        id: query.skillId != null ? `runtime_skill_${query.skillId}_${animOrEffectId}` : `runtime_spell_${animOrEffectId}`,
        label: query.actionName || animOrEffectId,
        ...(query.skillId != null ? { skillIds: [query.skillId] } : {}),
        effectIds: [animOrEffectId],
        frames: {
          spellId: animOrEffectId,
          blend: animOrEffectId.startsWith('c') || animOrEffectId.startsWith('sp') ? 'additive' : 'normal',
          scale: 1,
          anchorTarget: 'target',
        },
        hitFlash: { color: '#ffffff', durationMs: 120 },
        durationMs: 480,
      };
    }

    // 即使未知 skillId 被標記為 sp129，也依 skillId 產生不撞 ID 的獨立變體色調腳本
    if (query.skillId != null && animOrEffectId === 'sp129') {
      const palette = ['#ffd166', '#6ecbff', '#ff7597', '#95f985', '#c89eff', '#ff9b54'];
      const tint = palette[Math.abs(query.skillId) % palette.length];
      return {
        id: `skill_${query.skillId}_distinct`,
        label: query.actionName || `技能 ${query.skillId}`,
        skillIds: [query.skillId],
        frames: {
          spellId: 'sp129',
          blend: 'additive',
          tint,
          scale: 1.05,
          anchorTarget: 'target',
        },
        particles: {
          anchorTarget: 'target',
          blend: 'additive',
          config: {
            lifetime: { min: 0.18, max: 0.34 },
            frequency: 0.015,
            emitterLifetime: 0.1,
            maxParticles: 18,
            particlesPerWave: 9,
            behaviors: [
              { type: 'scale', config: { start: 1.15, end: 0.2 } },
              { type: 'color', config: { start: '#ffffff', end: tint } },
              { type: 'alpha', config: { start: 0.95, end: 0 } },
              { type: 'moveSpeed', config: { start: 190, end: 40 } },
            ],
          },
        },
        hitFlash: { color: tint, durationMs: 130 },
        shakePx: 4,
        durationMs: 480,
      };
    }

    return this.byId.get('basic_attack_slash')!;
  }
}

export const defaultEffectRegistry = new EffectScriptRegistry();
