export interface LdtkEntityInstance {
  __identifier: string;
  px: [number, number];
  width?: number;
  height?: number;
  fieldInstances?: Array<{ __identifier: string; __value: unknown }>;
}

export interface LdtkLayerInstance {
  __identifier: string;
  __type: string;
  entityInstances?: LdtkEntityInstance[];
  gridTiles?: Array<{ px: [number, number]; t: number }>;
}

export interface LdtkLevel {
  identifier: string;
  worldX?: number;
  worldY?: number;
  layerInstances?: LdtkLayerInstance[];
}

export interface LdtkProject {
  __header__?: { app?: string; schema?: string };
  jsonVersion?: string;
  levels?: LdtkLevel[];
}

export interface MapDecorationItem {
  id: string;
  kind: 'lantern' | 'flower_bed' | 'signpost' | 'tile';
  x: number;
  y: number;
  width: number;
  height: number;
  colorHex: string;
  label?: string;
}

const KIND_COLOR: Record<MapDecorationItem['kind'], string> = {
  lantern: '#ffb84d',
  flower_bed: '#63d471',
  signpost: '#d4a373',
  tile: '#7cb7ff',
};

/**
 * 解析標準 LDtk JSON 的裝飾層，回傳原創裝飾物清單（不含任何原版圖檔）。
 * 在 LDtk 中移動任何 Entity 或 GridTile 的 `px` 座標，畫面上的裝飾位置會隨即更新。
 */
export function parseLdtkDecorations(project: LdtkProject, levelId?: string): MapDecorationItem[] {
  const levels = project.levels ?? [];
  const picked = levelId ? levels.filter(l => l.identifier === levelId) : levels;
  const out: MapDecorationItem[] = [];

  for (const lvl of picked) {
    const ox = lvl.worldX ?? 0;
    const oy = lvl.worldY ?? 0;
    for (const layer of lvl.layerInstances ?? []) {
      let idx = 0;
      for (const ent of layer.entityInstances ?? []) {
        const lower = ent.__identifier.toLowerCase();
        const kind: MapDecorationItem['kind'] = lower.includes('lantern')
          ? 'lantern'
          : lower.includes('flower')
            ? 'flower_bed'
            : 'signpost';
        const colorField = ent.fieldInstances?.find(f => f.__identifier === 'color')?.__value;
        const labelField = ent.fieldInstances?.find(f => f.__identifier === 'label')?.__value;
        out.push({
          id: `${lvl.identifier}:${layer.__identifier}:${idx++}`,
          kind,
          x: ox + (ent.px?.[0] ?? 0),
          y: oy + (ent.px?.[1] ?? 0),
          width: ent.width ?? 24,
          height: ent.height ?? 24,
          colorHex: typeof colorField === 'string' && /^#[0-9a-fA-F]{6}$/.test(colorField)
            ? colorField
            : KIND_COLOR[kind],
          ...(typeof labelField === 'string' && labelField ? { label: labelField } : {}),
        });
      }
      for (const tile of layer.gridTiles ?? []) {
        out.push({
          id: `${lvl.identifier}:${layer.__identifier}:t:${idx++}`,
          kind: 'tile',
          x: ox + (tile.px?.[0] ?? 0),
          y: oy + (tile.px?.[1] ?? 0),
          width: 32,
          height: 32,
          colorHex: KIND_COLOR.tile,
        });
      }
    }
  }
  return out;
}
