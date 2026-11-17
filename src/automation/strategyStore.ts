import type { BattleStrategy } from '../battler';

export type BagFullPolicy = 'STOP' | 'NOTIFY' | 'SELL';

export interface CharacterStrategyConfig {
  battleStrategy: BattleStrategy;
  /** HP 低於此百分比（0..90，0=關閉）時自動傾向撤退／逃跑。 */
  lowHpRetreatPct: number;
  /** 背包滿時的處理策略（保留原本停機原因 STOP，或提示／自動賣出準備）。 */
  bagFullPolicy: BagFullPolicy;
  /** 飽食度低於此門檻（0..80，0=關閉）時由示範休息模組發出提醒。 */
  autoRestMinSatiety: number;
}

export const DEFAULT_CHARACTER_STRATEGY: CharacterStrategyConfig = {
  battleStrategy: 'MANUAL',
  lowHpRetreatPct: 25,
  bagFullPolicy: 'STOP',
  autoRestMinSatiety: 0,
};

interface KvStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

const STORAGE_KEY = 'fairyland_family:char_strategies:v1';

/**
 * 每個角色各自一份自動化策略設定（存於 localStorage，沒傳 storage 時存記憶體）。
 */
export class CharacterStrategyStore {
  private map = new Map<string, CharacterStrategyConfig>();

  constructor(private storage: KvStorage | null = null) {
    this.load();
  }

  private load(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, Partial<CharacterStrategyConfig>>;
      for (const [id, cfg] of Object.entries(parsed)) {
        if (!id || !cfg || typeof cfg !== 'object') continue;
        this.map.set(id, { ...DEFAULT_CHARACTER_STRATEGY, ...cfg });
      }
    } catch {
      // 忽略損毀的舊設定
    }
  }

  private save(): void {
    if (!this.storage) return;
    try {
      const obj: Record<string, CharacterStrategyConfig> = {};
      for (const [k, v] of this.map.entries()) obj[k] = v;
      this.storage.setItem(STORAGE_KEY, JSON.stringify(obj));
    } catch {
      // localStorage 滿或無權限時忽略
    }
  }

  get(characterId: string | null | undefined): CharacterStrategyConfig {
    const key = characterId || '_default';
    return { ...(this.map.get(key) ?? DEFAULT_CHARACTER_STRATEGY) };
  }

  update(
    characterId: string | null | undefined,
    patch: Partial<CharacterStrategyConfig>,
  ): CharacterStrategyConfig {
    const key = characterId || '_default';
    const current = this.get(key);
    const next: CharacterStrategyConfig = {
      battleStrategy: patch.battleStrategy ?? current.battleStrategy,
      lowHpRetreatPct: Math.max(0, Math.min(90, Math.round(patch.lowHpRetreatPct ?? current.lowHpRetreatPct))),
      bagFullPolicy: patch.bagFullPolicy ?? current.bagFullPolicy,
      autoRestMinSatiety: Math.max(
        0,
        Math.min(80, Math.round(patch.autoRestMinSatiety ?? current.autoRestMinSatiety)),
      ),
    };
    this.map.set(key, next);
    this.save();
    return { ...next };
  }

  snapshotAll(): Record<string, CharacterStrategyConfig> {
    const out: Record<string, CharacterStrategyConfig> = {};
    for (const [k, v] of this.map.entries()) out[k] = { ...v };
    return out;
  }
}
