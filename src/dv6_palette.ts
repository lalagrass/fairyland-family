import type { UiAction } from './parse';
import type { FamilyState } from './state';

export interface PaletteSuggestion {
  id: string;
  category: '系統' | '導航' | '採集' | '製作' | '家族';
  label: string;
  hint: string;
  commandText: string;
  action?: UiAction;
}

/** 依當前場景快照與輸入關鍵字建立 Ctrl+K 自動完成候選指令清單。 */
export function buildPaletteSuggestions(state: FamilyState, rawQuery: string): PaletteSuggestion[] {
  const q = rawQuery.trim().toLowerCase();
  const snap = state.snapshot;
  const items: PaletteSuggestion[] = [
    {
      id: 'sys-snapshot',
      category: '系統',
      label: '重讀場景快照',
      hint: '快照',
      commandText: '快照',
      action: { kind: 'COMMAND', command: { type: 'REQUEST_SNAPSHOT' }, label: '快照' },
    },
    {
      id: 'sys-stop-work',
      category: '系統',
      label: '停止目前工作佇列',
      hint: '停止工作',
      commandText: '停止工作',
      action: { kind: 'QUEUE_STOP', label: '停止工作' },
    },
    {
      id: 'sys-stop-nav',
      category: '系統',
      label: '取消目前導航',
      hint: '停止導航',
      commandText: '取消導航',
      action: { kind: 'NAV_CANCEL', label: '取消導航' },
    },
  ];

  if (snap) {
    for (const npc of snap.npcs.slice(0, 10)) {
      items.push({
        id: `npc-${npc.id}`,
        category: '導航',
        label: `前往並對話：${npc.name}`,
        hint: `前往 ${npc.name}`,
        commandText: `前往 ${npc.name}`,
        action: { kind: 'NAV', goal: { kind: 'NPC', query: npc.name, talk: true }, label: `前往 ${npc.name}` },
      });
    }
    for (const ex of snap.exits.slice(0, 10)) {
      const targetName = ex.targetMapName ?? ex.name;
      items.push({
        id: `exit-${ex.id}`,
        category: '導航',
        label: `跨圖前往：${targetName}`,
        hint: `前往 ${targetName}`,
        commandText: `前往 ${targetName}`,
        action: { kind: 'NAV', goal: { kind: 'MAP', mapId: ex.targetMapId, name: targetName }, label: `前往 ${targetName}` },
      });
    }
    for (const gp of snap.gatherPoints.points) {
      for (const m of gp.materials ?? []) {
        items.push({
          id: `gather-${gp.id}-${m.itemId}`,
          category: '採集',
          label: `採集 ${m.name} ×5`,
          hint: `採集 ${m.name} 5`,
          commandText: `採集 ${m.name} 5`,
          action: {
            kind: 'QUEUE_GATHER',
            skillId: gp.skillId ?? 5,
            skillName: gp.skillName ?? '採礦',
            targetItemId: m.itemId,
            targetName: m.name,
            count: 5,
            label: `採集 ${m.name} ×5`,
          },
        });
      }
    }
    for (const r of (snap.recipes ?? state.staticData?.recipes ?? []).slice(0, 10)) {
      items.push({
        id: `craft-${r.recipeId}`,
        category: '製作',
        label: `製作 ${r.name} ×1`,
        hint: `製作 ${r.name} 1`,
        commandText: `製作 ${r.name} 1`,
        action: {
          kind: 'QUEUE_CRAFT',
          recipeId: r.recipeId,
          recipeName: r.name,
          count: 1,
          label: `製作 ${r.name} ×1`,
        },
      });
    }
  }

  for (const m of state.members) {
    const name = m.name ?? m.characterId;
    items.push({
      id: `member-${m.characterId}`,
      category: '家族',
      label: `切換視角：${name}`,
      hint: `切換視角 ${name}`,
      commandText: `切換視角 ${name}`,
      action: {
        kind: 'COMMAND',
        command: { type: 'SWITCH_VIEW_CHARACTER', characterId: m.characterId },
        label: `切換視角 ${name}`,
      },
    });
  }

  if (!q) return items.slice(0, 12);
  return items
    .filter(
      it =>
        it.label.toLowerCase().includes(q) ||
        it.commandText.toLowerCase().includes(q) ||
        it.category.toLowerCase().includes(q),
    )
    .slice(0, 12);
}
