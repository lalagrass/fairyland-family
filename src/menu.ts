import type { SceneSnapshot } from './protocol/index';
import type { DirNpc } from './directory';
import type { UiAction } from './parse';

export interface MenuItem {
  label: string;
  /** 點下去執行的動作；null＝只是說明文字。 */
  action: UiAction | null;
  hint?: string;
}

export interface MenuSection {
  key: 'talk' | 'goto' | 'known' | 'gather' | 'nearby' | 'animals';
  label: string;
  items: MenuItem[];
  /** 沒有項目時顯示的文字（資料不可得與「本區沒有」要分開說清楚）。 */
  emptyText: string;
}

/**
 * 由場景快照組出文字選單（藍圖「文字介面」：對話／前往／採集／附近可採）。
 * P2：對話＝自動導航到 NPC 再對話；前往＝出口或可到達的地圖（自動導航）；已知地點＝在別張圖看過的重要 NPC（跨圖導航）。
 */
export function buildMenu(snap: SceneSnapshot, known: DirNpc[] = []): MenuSection[] {
  const people = snap.npcs.filter(n => n.talkable && !n.isAnimal);
  const animals = snap.npcs.filter(n => n.talkable && n.isAnimal);

  const seenExit = new Set<string>();
  const exits = snap.exits.filter(e => {
    const k = `${e.name}|${e.targetMapId}`;
    if (seenExit.has(k)) return false;
    seenExit.add(k);
    return true;
  });
  const direct = new Set(snap.exits.map(e => e.targetMapId));
  const far = snap.nav.reachableMaps.filter(r => !direct.has(r.mapId) && r.mapId !== snap.mapId);

  const gatherUnavailable = snap.gatherPoints.status === 'UNAVAILABLE';
  const gatherEmpty = gatherUnavailable
    ? `（採集點資料尚未提供：${snap.gatherPoints.reason ?? 'UNAVAILABLE'}）`
    : '（本區無）';

  const talk = (n: { name: string }, label: string): UiAction => ({ kind: 'NAV', goal: { kind: 'NPC', query: n.name, talk: true }, label });

  const localGatherItems: MenuItem[] = [];
  const seenLocal = new Set<string>();
  for (const pt of snap.gatherPoints.points) {
    const sid = pt.skillId ?? 5;
    const sname = pt.skillName ?? '採集';
    if (pt.materials && pt.materials.length > 0) {
      for (const m of pt.materials) {
        const key = `${sid}:${m.itemId}`;
        if (seenLocal.has(key)) continue;
        seenLocal.add(key);
        localGatherItems.push({
          label: `${sname}：${m.name}`,
          hint: `Lv.${m.reqLevel}`,
          action: {
            kind: 'QUEUE_GATHER',
            skillId: sid,
            skillName: sname,
            targetItemId: m.itemId,
            targetName: m.name,
            count: 1,
            ...(pt.requiredToolItemId ? { requiredToolItemId: pt.requiredToolItemId } : {}),
            ...(pt.requiredToolName ? { requiredToolName: pt.requiredToolName } : {}),
            label: `${sname}：${m.name}`,
          },
        });
      }
    } else {
      localGatherItems.push({
        label: pt.name,
        action: { kind: 'COMMAND', command: { type: 'WALK_TO', mapId: snap.mapId, x: pt.x, y: pt.y }, label: `走到採集點：${pt.name}` },
      });
    }
  }

  const nearbyGatherItems: MenuItem[] = [];
  const seenNearby = new Set<string>();
  for (const pt of snap.nearbyGatherPoints ?? []) {
    const sid = pt.skillId ?? 5;
    const sname = pt.skillName ?? '採集';
    const mapLabel = pt.mapName ?? pt.mapId ?? '';
    for (const m of pt.materials ?? []) {
      const key = `${pt.mapId ?? ''}:${sid}:${m.itemId}`;
      if (seenNearby.has(key)) continue;
      seenNearby.add(key);
      nearbyGatherItems.push({
        label: m.name,
        hint: `${mapLabel}・${sname}`,
        action: {
          kind: 'QUEUE_GATHER',
          skillId: sid,
          skillName: sname,
          targetItemId: m.itemId,
          targetName: m.name,
          count: 1,
          ...(pt.requiredToolItemId ? { requiredToolItemId: pt.requiredToolItemId } : {}),
          ...(pt.requiredToolName ? { requiredToolName: pt.requiredToolName } : {}),
          label: `前往採集：${m.name}`,
        },
      });
      if (nearbyGatherItems.length >= 24) break;
    }
    if (nearbyGatherItems.length >= 24) break;
  }

  return [
    {
      key: 'talk', label: '對話',
      items: people.map(n => ({ label: n.name, hint: n.isShop ? '商店' : n.role ?? undefined, action: talk(n, `對話：${n.name}`) })),
      emptyText: '（本區沒有可對話的人）',
    },
    {
      key: 'animals', label: '動物',
      items: animals.map(n => ({ label: n.name, action: talk(n, `對話：${n.name}`) })),
      emptyText: '（無）',
    },
    {
      key: 'known', label: '已知地點',
      items: known.map(n => ({ label: n.name, hint: n.mapName ?? n.mapId, action: talk(n, `前往並對話：${n.name}`) })),
      emptyText: '（還沒看過其他地圖的重要 NPC）',
    },
    {
      key: 'goto', label: '前往',
      items: [
        ...exits.map(e => ({
          label: e.name, hint: e.targetMapName ?? e.targetMapId,
          action: { kind: 'NAV', goal: { kind: 'MAP', mapId: e.targetMapId, name: e.targetMapName ?? e.name }, label: `前往：${e.name}` } as UiAction,
        })),
        ...far.map(r => ({
          label: r.name ?? r.mapId, hint: `${r.hops} 個出口`,
          action: { kind: 'NAV', goal: { kind: 'MAP', mapId: r.mapId, name: r.name ?? r.mapId }, label: `前往：${r.name ?? r.mapId}` } as UiAction,
        })),
      ],
      emptyText: '（本區沒有出口）',
    },
    {
      key: 'gather', label: '採集',
      items: localGatherItems,
      emptyText: gatherEmpty,
    },
    {
      key: 'nearby', label: '附近可採',
      items: nearbyGatherItems,
      emptyText: gatherUnavailable ? '（資料尚未提供，P3 才會有）' : '（無）',
    },
  ];
}
