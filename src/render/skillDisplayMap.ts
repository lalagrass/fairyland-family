import type { AppearanceId } from './appearance';

export interface SkillDisplayOverride {
  skillId: number;
  displayName: string;
  iconGlyph: string;
  effectScriptId: string;
}

/**
 * 新外觀專用技能顯示對照表（FM3）：
 * 只覆寫呈現名稱、圖示與特效腳本；實際戰果與傷害數值完全由宿主 FX14 事件決定。
 */
export const WUXIA_SKILL_DISPLAY_MAP: Record<number, SkillDisplayOverride> = {
  2251: {
    skillId: 2251,
    displayName: '雙龍探爪',
    iconGlyph: '🐉',
    effectScriptId: 'spell_sp126_combo_slash',
  },
  2261: {
    skillId: 2261,
    displayName: '破風寸勁',
    iconGlyph: '⚡',
    effectScriptId: 'skill_2261_shock_dash',
  },
  2262: {
    skillId: 2262,
    displayName: '鐵山靠',
    iconGlyph: '💥',
    effectScriptId: 'skill_2262_heavy_ram',
  },
  2263: {
    skillId: 2263,
    displayName: '碎甲崩拳',
    iconGlyph: '🔱',
    effectScriptId: 'skill_2263_armor_break',
  },
  2293: {
    skillId: 2293,
    displayName: '開碑裂石',
    iconGlyph: '⛰️',
    effectScriptId: 'skill_2293_earth_shatter',
  },
  1021: {
    skillId: 1021,
    displayName: '虎嘯勁',
    iconGlyph: '🔥',
    effectScriptId: 'skill_1021_body_boost',
  },
  1023: {
    skillId: 1023,
    displayName: '金鐘護體',
    iconGlyph: '🛡️',
    effectScriptId: 'skill_1023_loyal_guard',
  },
};

export function resolveSkillDisplay(
  appearanceId: AppearanceId,
  skillId?: number,
  fallbackName?: string,
): { displayName: string; iconGlyph: string; overrideScriptId?: string } {
  if (appearanceId !== 'wuxia-test' || skillId == null) {
    return { displayName: fallbackName ?? (skillId != null ? `技能 ${skillId}` : ''), iconGlyph: '⚔️' };
  }
  const hit = WUXIA_SKILL_DISPLAY_MAP[skillId];
  if (!hit) {
    return { displayName: fallbackName ?? `技能 ${skillId}`, iconGlyph: '🥊' };
  }
  return {
    displayName: hit.displayName,
    iconGlyph: hit.iconGlyph,
    overrideScriptId: hit.effectScriptId,
  };
}
