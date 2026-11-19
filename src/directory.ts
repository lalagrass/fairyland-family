import type { MapAdjacency, SceneSnapshot, SnapshotPortalNode } from './protocol/index';

/** 外掛自己「看過」的世界：每張地圖的名稱、NPC 與出口。宿主沒有世界目錄，所以跨圖資料只能一張一張學。 */
export interface DirNpc { name: string; mapId: string; mapName: string | null; role?: string | null; seed?: boolean }
export interface DirMap { mapId: string; name: string | null; npcs: Array<{ id: string; name: string; role: string | null }>; targets: Record<string, string | null> }

interface KvStorage { getItem(k: string): string | null; setItem(k: string, v: string): void }

/**
 * 預先寫入的已知 NPC（來自 fairyland 的地圖資料：村長傑夫在市鎮中心 20010）。
 * 這只是「去哪裡找」的提示，真正的 NPC id 與座標到了該圖仍以快照為準。
 */
export const SEED_NPCS: DirNpc[] = [
  { name: '村長傑夫', mapId: '20010', mapName: '市鎮中心', role: 'CHIEF', seed: true },
];

const KEY = 'family.directory.v1';

export class Directory {
  private maps: Record<string, DirMap> = {};

  constructor(private storage: KvStorage | null = null) {
    try {
      const raw = storage?.getItem(KEY);
      if (raw) this.maps = JSON.parse(raw) as Record<string, DirMap>;
    } catch { this.maps = {}; }
  }

  /** 從靜態資料或快照學到世界鄰接（FX15：portalGraph 已移至 static-data，不一定在每份快照內）。 */
  learnPortalGraph(graph: SnapshotPortalNode[]): void {
    for (const node of graph) {
      const m = this.maps[node.mapId] ?? { mapId: node.mapId, name: node.name, npcs: [], targets: {} };
      if (node.name && !m.name) m.name = node.name;
      for (const t of node.targets) if (!(t in m.targets)) m.targets[t] = null;
      this.maps[node.mapId] = m;
    }
    try { this.storage?.setItem(KEY, JSON.stringify(this.maps)); } catch { /* 無法儲存不影響功能 */ }
  }

  /** 從一份快照學到這張圖的 NPC、出口，以及快照附帶的世界鄰接。 */
  learn(snap: SceneSnapshot, fallbackGraph?: SnapshotPortalNode[]): void {
    const targets: Record<string, string | null> = {};
    for (const e of snap.exits) targets[e.targetMapId] = e.targetMapName;
    this.maps[snap.mapId] = {
      mapId: snap.mapId, name: snap.mapName, targets,
      npcs: snap.npcs.filter(n => n.talkable).map(n => ({ id: n.id, name: n.name, role: n.role })),
    };
    this.learnPortalGraph(snap.nav.portalGraph ?? fallbackGraph ?? []);
  }

  mapName(mapId: string): string | null {
    return this.maps[mapId]?.name ?? null;
  }

  /** 已學到的 NPC，加上還沒走過、但預先知道位置的種子 NPC。 */
  allNpcs(): DirNpc[] {
    const all: DirNpc[] = [];
    for (const m of Object.values(this.maps)) {
      for (const n of m.npcs) all.push({ name: n.name, mapId: m.mapId, mapName: m.name, role: n.role });
    }
    for (const s of SEED_NPCS) {
      if (!all.some(a => a.name === s.name && a.mapId === s.mapId)) all.push(s);
    }
    return all;
  }

  allMaps(): Array<{ mapId: string; name: string }> {
    return Object.values(this.maps)
      .filter(m => m.name)
      .map(m => ({ mapId: m.mapId, name: m.name as string }));
  }

  /** 以名稱（完全相符優先，其次包含）找 NPC；已學到的優先於預設清單。 */
  findNpc(query: string): DirNpc[] {
    const all: DirNpc[] = [];
    for (const m of Object.values(this.maps)) for (const n of m.npcs) all.push({ name: n.name, mapId: m.mapId, mapName: m.name, role: n.role });
    for (const s of SEED_NPCS) if (!all.some(a => a.name === s.name && a.mapId === s.mapId)) all.push(s);
    const q = query.trim();
    if (!q) return [];
    const exact = all.filter(n => n.name === q);
    return exact.length ? exact : all.filter(n => n.name.includes(q) || (q.length > 1 && q.includes(n.name)));
  }

  findMap(query: string): Array<{ mapId: string; name: string }> {
    const q = query.trim();
    const all = Object.values(this.maps).filter(m => m.name).map(m => ({ mapId: m.mapId, name: m.name as string }));
    const exact = all.filter(m => m.name === q || m.mapId === q);
    return exact.length ? exact : all.filter(m => m.name.includes(q));
  }

  /** 世界鄰接：已學到的各圖出口 ＋ 目前快照的 portalGraph。 */
  adjacency(snap: SceneSnapshot | null): MapAdjacency {
    const adj: MapAdjacency = {};
    const add = (from: string, to: string) => { (adj[from] ??= []); if (!adj[from].includes(to)) adj[from].push(to); };
    for (const m of Object.values(this.maps)) for (const t of Object.keys(m.targets)) add(m.mapId, t);
    if (snap) {
      for (const n of snap.nav.portalGraph ?? []) for (const t of n.targets) add(n.mapId, t);
      for (const e of snap.exits) add(snap.mapId, e.targetMapId);
    }
    return adj;
  }

  /** 已知、但不在這張圖的 NPC（選單「已知地點」）。 */
  knownElsewhere(currentMapId: string | null): DirNpc[] {
    const out: DirNpc[] = [];
    for (const m of Object.values(this.maps)) {
      if (m.mapId === currentMapId) continue;
      for (const n of m.npcs) if (n.role === 'CHIEF' || n.role === 'MENTOR' || n.name.includes('村長')) out.push({ name: n.name, mapId: m.mapId, mapName: m.name, role: n.role });
    }
    for (const s of SEED_NPCS) if (s.mapId !== currentMapId && !out.some(o => o.name === s.name)) out.push(s);
    return out;
  }
}
