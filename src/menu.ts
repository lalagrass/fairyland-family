import type { PluginCommand, SceneSnapshot } from './protocol/index';

export interface MenuItem {
  label: string;
  /** 點下去送出的指令；null＝只是說明文字。 */
  command: PluginCommand | null;
  hint?: string;
}

export interface MenuSection {
  key: 'talk' | 'goto' | 'gather' | 'nearby' | 'shop' | 'animals';
  label: string;
  items: MenuItem[];
  /** 沒有項目時顯示的文字（資料不可得與「本區沒有」要分開說清楚）。 */
  emptyText: string;
}

/** 由場景快照組出文字選單（藍圖「文字介面」：對話／前往／採集／附近可採）。 */
export function buildMenu(snap: SceneSnapshot): MenuSection[] {
  const people = snap.npcs.filter(n => n.talkable && !n.isAnimal);
  const animals = snap.npcs.filter(n => n.talkable && n.isAnimal);

  const seenExit = new Set<string>();
  const exits = snap.exits.filter(e => {
    const k = `${e.name}|${e.targetMapId}`;
    if (seenExit.has(k)) return false;
    seenExit.add(k);
    return true;
  });

  const gatherUnavailable = snap.gatherPoints.status === 'UNAVAILABLE';
  const gatherEmpty = gatherUnavailable
    ? `（採集點資料尚未提供：${snap.gatherPoints.reason ?? 'UNAVAILABLE'}）`
    : '（本區無）';

  return [
    {
      key: 'talk', label: '對話',
      items: people.map(n => ({ label: n.name, hint: n.isShop ? '商店' : n.role ?? undefined, command: { type: 'TALK_TO_NPC', npcId: n.id } })),
      emptyText: '（本區沒有可對話的人）',
    },
    {
      key: 'animals', label: '動物',
      items: animals.map(n => ({ label: n.name, command: { type: 'TALK_TO_NPC', npcId: n.id } })),
      emptyText: '（無）',
    },
    {
      key: 'goto', label: '前往',
      items: exits.map(e => ({
        label: e.name, hint: e.targetMapName ?? e.targetMapId,
        command: { type: 'WALK_TO', mapId: snap.mapId, x: e.x, y: e.y },
      })),
      emptyText: '（本區沒有出口）',
    },
    {
      key: 'gather', label: '採集',
      items: snap.gatherPoints.points.map(p => ({ label: p.name, command: { type: 'WALK_TO', mapId: snap.mapId, x: p.x, y: p.y } })),
      emptyText: gatherEmpty,
    },
    {
      key: 'nearby', label: '附近可採',
      items: [],
      emptyText: gatherUnavailable ? '（資料尚未提供，P3 才會有）' : '（無）',
    },
    {
      key: 'shop', label: '商店',
      items: snap.shops.flatMap(s => s.goods.slice(0, 40).map(g => ({
        label: `${s.npcName}：買 ${g.name ?? `#${g.itemId}`}`,
        hint: `${g.price} 金${s.goodsStatus === 'RECONSTRUCTED_DEMO' ? '（重建示範資料）' : ''}`,
        command: { type: 'BUY_ITEM', itemId: g.itemId, count: 1 } as PluginCommand,
      }))),
      emptyText: '（本區沒有商店）',
    },
  ];
}
