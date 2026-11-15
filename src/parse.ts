import type { PluginCommand, SceneSnapshot } from './protocol/index';

export type ParseResult =
  | { ok: true; command: PluginCommand; label: string }
  | { ok: false; error: string };

export const INPUT_HELP =
  '可輸入：前往 村長｜對話 阿爾｜走到 1000 700｜接任務 1｜買 50001 [數量]｜賣 100000 [數量]｜工作 4｜逃跑｜快照';

const fail = (error: string): ParseResult => ({ ok: false, error });

function pick<T extends { name: string }>(items: T[], q: string): { hit?: T; error?: string } {
  const exact = items.filter(i => i.name === q);
  const pool = exact.length ? exact : items.filter(i => i.name.includes(q) || q.includes(i.name));
  if (pool.length === 1) return { hit: pool[0] };
  if (pool.length === 0) return {};
  return { error: `有多個符合「${q}」：${pool.slice(0, 6).map(p => p.name).join('、')}${pool.length > 6 ? '…' : ''}，請輸入更完整的名稱` };
}

/** 把一行文字解析成和選單點擊相同的指令物件（「文字＝點滑鼠」）。 */
export function parseInput(text: string, snap: SceneSnapshot | null): ParseResult {
  const t = text.replace(/　/g, ' ').trim().replace(/\s+/g, ' ');
  if (!t) return fail('請輸入指令。' + INPUT_HELP);
  const m = /^(\S+?)(?:\s+(.*))?$/.exec(t);
  const verb = m![1].toLowerCase();
  const rest = (m![2] ?? '').trim();
  const nums = rest.split(' ').filter(Boolean).map(Number);

  switch (verb) {
    case '快照': case '刷新': case 'snapshot':
      return { ok: true, command: { type: 'REQUEST_SNAPSHOT' }, label: '要求快照' };

    case '逃跑': case 'flee':
      return { ok: true, command: { type: 'BATTLE_FLEE' }, label: '戰鬥逃跑' };

    case '走到': case 'walk': {
      if (nums.length !== 2 || nums.some(n => !Number.isFinite(n))) return fail('用法：走到 <x> <y>（世界座標）');
      if (!snap) return fail('還沒有場景快照，無法知道目前地圖');
      return { ok: true, command: { type: 'WALK_TO', mapId: snap.mapId, x: nums[0], y: nums[1] }, label: `走到 (${nums[0]}, ${nums[1]})` };
    }

    case '接任務': case 'accept': {
      if (nums.length !== 1 || !Number.isInteger(nums[0])) return fail('用法：接任務 <任務編號>');
      return { ok: true, command: { type: 'ACCEPT_QUEST', questId: nums[0] }, label: `接任務 ${nums[0]}` };
    }

    case '工作': case 'work': {
      if (nums.length !== 1 || !Number.isInteger(nums[0])) return fail('用法：工作 <技能編號>');
      return { ok: true, command: { type: 'WORK_ONCE', skillId: nums[0] }, label: `工作一次（技能 ${nums[0]}）` };
    }

    case '選項': case 'option':
      return rest ? { ok: true, command: { type: 'CHOOSE_DIALOG_OPTION', optionId: rest }, label: `對話選項 ${rest}` } : fail('用法：選項 <選項編號>');

    case '買': case '賣': case 'buy': case 'sell': {
      const buy = verb === '買' || verb === 'buy';
      const parts = rest.split(' ').filter(Boolean);
      if (!parts.length) return fail(`用法：${buy ? '買' : '賣'} <道具編號或名稱> [數量]`);
      let count = 1;
      if (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])) count = Number(parts.pop());
      const what = parts.join(' ');
      let itemId: number | null = /^\d+$/.test(what) ? Number(what) : null;
      if (itemId === null) {
        const goods = (snap?.shops ?? []).flatMap(s => s.goods).filter(g => g.name).map(g => ({ name: g.name as string, itemId: g.itemId }));
        const r = pick(goods, what);
        if (r.error) return fail(r.error);
        if (!r.hit) return fail(`找不到道具「${what}」（只能用名稱找本區商店的商品，或直接輸入道具編號）`);
        itemId = r.hit.itemId;
      }
      return { ok: true, command: { type: buy ? 'BUY_ITEM' : 'SELL_ITEM', itemId, count }, label: `${buy ? '買' : '賣'} #${itemId} ×${count}` };
    }

    case '對話': case '聊天': case 'talk': case '前往': case '去': case 'go': {
      if (!rest) return fail(`用法：${verb} <名稱>`);
      if (!snap) return fail('還沒有場景快照（遊戲未執行或場景載入中）');
      const talkOnly = verb === '對話' || verb === '聊天' || verb === 'talk';
      const npc = pick(snap.npcs, rest);
      if (npc.error) return fail(npc.error);
      if (npc.hit) return { ok: true, command: { type: 'TALK_TO_NPC', npcId: npc.hit.id }, label: `${talkOnly ? '對話' : '前往並對話'}：${npc.hit.name}` };
      if (talkOnly) return fail(`本區找不到 NPC「${rest}」`);
      const ex = pick(snap.exits.map(e => ({ ...e, name: e.name })), rest);
      if (ex.error) return fail(ex.error);
      if (ex.hit) return { ok: true, command: { type: 'WALK_TO', mapId: snap.mapId, x: ex.hit.x, y: ex.hit.y }, label: `前往出口：${ex.hit.name}` };
      const far = pick(snap.nav.reachableMaps.map(r => ({ ...r, name: r.name ?? r.mapId })), rest);
      if (far.hit) return fail(`「${far.hit.name}」在 ${far.hit.hops} 個出口之外；跨圖導航要等 P2 的外掛導航器，目前只能前往本圖的 NPC 或出口`);
      return fail(`找不到「${rest}」（本圖的 NPC、出口或可到達地圖）`);
    }

    default:
      return fail(`看不懂「${verb}」。${INPUT_HELP}`);
  }
}
