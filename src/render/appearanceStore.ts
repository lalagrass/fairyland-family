import type { AppearanceId } from './appearance';

interface KvStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

const STORAGE_KEY = 'fairyland_family:char_appearances:v1';

/**
 * 每個角色各自選擇的外觀提供者設定（存於 localStorage）。
 */
export class CharacterAppearanceStore {
  private map = new Map<string, AppearanceId>();

  constructor(private storage: KvStorage | null = null) {
    this.load();
  }

  private load(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, string>;
      for (const [cid, aid] of Object.entries(parsed)) {
        if (cid && typeof aid === 'string' && aid.trim()) {
          this.map.set(cid, aid);
        }
      }
    } catch {
      // 忽略損毀資料
    }
  }

  private save(): void {
    if (!this.storage) return;
    try {
      const obj: Record<string, string> = {};
      for (const [k, v] of this.map.entries()) obj[k] = v;
      this.storage.setItem(STORAGE_KEY, JSON.stringify(obj));
    } catch {
      // 忽略空間限制
    }
  }

  get(characterId: string | null | undefined): AppearanceId {
    if (!characterId) return 'original';
    return this.map.get(characterId) ?? 'original';
  }

  set(characterId: string, appearanceId: AppearanceId): AppearanceId {
    this.map.set(characterId, appearanceId);
    this.save();
    return appearanceId;
  }

  snapshotAll(): Record<string, AppearanceId> {
    const out: Record<string, AppearanceId> = {};
    for (const [k, v] of this.map.entries()) out[k] = v;
    return out;
  }
}
