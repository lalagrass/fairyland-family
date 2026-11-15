import type { BattleEnemyState, DialogOption, PluginCommand, SceneSnapshot, SnapshotItem } from './protocol/index';
import type { BattleStrategy } from './battler';
import type { NavGoal } from './navigator';

/** 選單與文字輸入共用的「動作」：同一份文字或同一顆按鈕，一定走到同一個動作。 */
export type UiAction =
  | { kind: 'COMMAND'; command: PluginCommand; label: string }
  | { kind: 'NAV'; goal: NavGoal; label: string }
  | { kind: 'NAV_CANCEL'; label: string }
  | { kind: 'STRATEGY'; strategy: BattleStrategy; label: string };

export type ParseResult =
  | { ok: true; action: UiAction }
  | { ok: false; error: string };

/** 解析時可參考的外掛端資料（都是選用）。 */
export interface ParseContext {
  /** 目前所在地圖（事件追蹤的位置）；宿主在沒有場景資料的地圖不送快照時，快照的 mapId 會是上一張圖。 */
  mapId?: string | null;
  dialogOptions?: DialogOption[];
  enemies?: BattleEnemyState[];
  battleId?: number | null;
  inventory?: SnapshotItem[];
  /** 已知（看過的）NPC／地圖，用來解析「前往 村長」這種不在目前地圖的目標。 */
  findNpc?: (q: string) => Array<{ name: string; mapId: string }>;
  findMap?: (q: string) => Array<{ mapId: string; name: string }>;
}

export const INPUT_HELP =
  '可輸入：前往 村長｜對話 阿爾｜走到 1000 700｜選項 接受任務｜買 50001 [數量]｜賣 100000 [數量]｜攻擊 [目標]｜防禦｜逃跑｜策略 手動/普通攻擊/逃跑｜停止導航｜快照';

const fail = (error: string): ParseResult => ({ ok: false, error });
const cmd = (command: PluginCommand, label: string): ParseResult => ({ ok: true, action: { kind: 'COMMAND', command, label } });
const nav = (goal: NavGoal, label: string): ParseResult => ({ ok: true, action: { kind: 'NAV', goal, label } });

function pick<T extends { name: string }>(items: T[], q: string): { hit?: T; error?: string } {
  const exact = items.filter(i => i.name === q);
  const pool = exact.length ? exact : items.filter(i => i.name.includes(q) || q.includes(i.name));
  if (pool.length === 1) return { hit: pool[0] };
  if (pool.length === 0) return {};
  return { error: `有多個符合「${q}」：${pool.slice(0, 6).map(p => p.name).join('、')}${pool.length > 6 ? '…' : ''}，請輸入更完整的名稱` };
}

/** 把一行文字解析成和選單點擊相同的動作（「文字＝點滑鼠」）。 */
export function parseInput(text: string, snap: SceneSnapshot | null, ctx: ParseContext = {}): ParseResult {
  const t = text.replace(/　/g, ' ').trim().replace(/\s+/g, ' ');
  if (!t) return fail('請輸入指令。' + INPUT_HELP);
  const m = /^(\S+?)(?:\s+(.*))?$/.exec(t);
  const verb = m![1].toLowerCase();
  const rest = (m![2] ?? '').trim();
  const nums = rest.split(' ').filter(Boolean).map(Number);

  switch (verb) {
    case '快照': case '刷新': case 'snapshot':
      return cmd({ type: 'REQUEST_SNAPSHOT' }, '要求快照');

    case '逃跑': case 'flee':
      return cmd({ type: 'BATTLE_FLEE', ...(ctx.battleId ? { battleId: ctx.battleId } : {}) }, '戰鬥逃跑');

    case '攻擊': case 'attack': {
      const enemies = ctx.enemies ?? [];
      let target: BattleEnemyState | undefined;
      if (rest) {
        target = /^\d+$/.test(rest) ? enemies.find(e => e.slot === Number(rest)) : enemies.find(e => e.name.includes(rest));
        if (!target) return fail(`找不到目標「${rest}」${enemies.length ? `（現有：${enemies.map(e => `${e.slot}:${e.name}`).join('、')}）` : ''}`);
      } else target = enemies[0];
      return cmd({ type: 'BATTLE_ACTION', ...(ctx.battleId ? { battleId: ctx.battleId } : {}), action: { kind: 'ATTACK', ...(target ? { targetSlot: target.slot } : {}) } },
        `攻擊${target ? ` ${target.name}` : ''}`);
    }

    case '防禦': case 'defend':
      return cmd({ type: 'BATTLE_ACTION', ...(ctx.battleId ? { battleId: ctx.battleId } : {}), action: { kind: 'DEFEND' } }, '防禦');

    case '策略': case 'strategy': {
      const map: Record<string, BattleStrategy> = { '手動': 'MANUAL', manual: 'MANUAL', '普通攻擊': 'ATTACK', '攻擊': 'ATTACK', attack: 'ATTACK', '逃跑': 'FLEE', flee: 'FLEE' };
      const s = map[rest.toLowerCase()];
      return s ? { ok: true, action: { kind: 'STRATEGY', strategy: s, label: `戰鬥策略：${rest}` } } : fail('用法：策略 手動｜普通攻擊｜逃跑');
    }

    case '停止': case '取消': case '停止導航': case 'stop':
      return { ok: true, action: { kind: 'NAV_CANCEL', label: '取消導航' } };

    case '走到': case 'walk': {
      if (nums.length !== 2 || nums.some(n => !Number.isFinite(n))) return fail('用法：走到 <x> <y>（世界座標）');
      const mapId = ctx.mapId ?? snap?.mapId;
      if (!mapId) return fail('還沒有場景快照，無法知道目前地圖');
      return cmd({ type: 'WALK_TO', mapId, x: nums[0], y: nums[1] }, `走到 (${nums[0]}, ${nums[1]})`);
    }

    case '接任務': case 'accept': {
      if (nums.length !== 1 || !Number.isInteger(nums[0])) return fail('用法：接任務 <任務編號>（需先對話並由宿主提供該任務選項）');
      return cmd({ type: 'ACCEPT_QUEST', questId: nums[0] }, `接任務 ${nums[0]}`);
    }

    case '工作': case 'work': {
      if (nums.length !== 1 || !Number.isInteger(nums[0])) return fail('用法：工作 <技能編號>');
      return cmd({ type: 'WORK_ONCE', skillId: nums[0] }, `工作一次（技能 ${nums[0]}）`);
    }

    case '選項': case 'option': {
      if (!rest) return fail('用法：選項 <選項編號或文字>');
      const opts = ctx.dialogOptions ?? [];
      const hit = opts.find(o => o.id === rest) ?? opts.find(o => o.label === rest) ?? opts.filter(o => o.label.includes(rest))[0];
      const id = hit?.id ?? rest;
      return cmd({ type: 'CHOOSE_DIALOG_OPTION', optionId: id }, `對話選項 ${hit ? hit.label : id}`);
    }

    case '買': case '賣': case 'buy': case 'sell': {
      const buy = verb === '買' || verb === 'buy';
      const parts = rest.split(' ').filter(Boolean);
      if (!parts.length) return fail(`用法：${buy ? '買' : '賣'} <道具編號或名稱> [數量]`);
      let count = 1;
      if (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])) count = Number(parts.pop());
      const what = parts.join(' ');
      let itemId: number | null = /^\d+$/.test(what) ? Number(what) : null;
      if (itemId === null) {
        const pool = buy
          ? (snap?.shops ?? []).flatMap(s => s.goods).filter(g => g.name).map(g => ({ name: g.name as string, itemId: g.itemId }))
          : (ctx.inventory ?? snap?.inventory ?? []).filter(i => i.name).map(i => ({ name: i.name as string, itemId: i.itemId }));
        const r = pick(pool, what);
        if (r.error) return fail(r.error);
        if (!r.hit) return fail(`找不到道具「${what}」（${buy ? '只能用名稱找本區商店的商品' : '只能用名稱找背包裡的道具'}，或直接輸入道具編號）`);
        itemId = r.hit.itemId;
      }
      return cmd({ type: buy ? 'BUY_ITEM' : 'SELL_ITEM', itemId, count }, `${buy ? '買' : '賣'} #${itemId} ×${count}`);
    }

    case 'talk': case '直接對話': {
      if (!rest) return fail(`用法：${verb} <NPC 名稱>（不先走過去；距離太遠會被拒絕 TOO_FAR）`);
      if (!snap) return fail('還沒有場景快照（遊戲未執行或場景載入中）');
      const npc = pick(snap.npcs, rest);
      if (npc.error) return fail(npc.error);
      return npc.hit ? cmd({ type: 'TALK_TO_NPC', npcId: npc.hit.id }, `直接對話：${npc.hit.name}`) : fail(`本區找不到 NPC「${rest}」`);
    }

    case '對話': case '聊天': case '前往': case '去': case 'go': {
      if (!rest) return fail(`用法：${verb} <名稱>`);
      const talkOnly = verb === '對話' || verb === '聊天';
      // 1) 目前這張圖的 NPC：自動走過去再對話
      const here = snap ? pick(snap.npcs.filter(n => n.talkable), rest) : {};
      if (here.error) return fail(here.error);
      if (here.hit) return nav({ kind: 'NPC', query: here.hit.name, talk: true }, `${talkOnly ? '對話' : '前往並對話'}：${here.hit.name}`);
      // 2) 目前這張圖的出口
      if (!talkOnly && snap) {
        const ex = pick(snap.exits.filter((e, i, a) => a.findIndex(x => x.name === e.name && x.targetMapId === e.targetMapId) === i), rest);
        if (ex.error) return fail(ex.error);
        if (ex.hit) return nav({ kind: 'MAP', mapId: ex.hit.targetMapId, name: ex.hit.targetMapName ?? ex.hit.name }, `前往：${ex.hit.name}`);
      }
      // 3) 看過的其他地圖的 NPC（跨圖）
      const known = ctx.findNpc?.(rest) ?? [];
      const names = [...new Set(known.map(k => k.name))];
      if (names.length > 1) return fail(`有多個符合「${rest}」：${names.slice(0, 6).join('、')}，請輸入更完整的名稱`);
      if (names.length === 1) return nav({ kind: 'NPC', query: names[0], talk: true }, `${talkOnly ? '對話' : '前往並對話'}：${names[0]}`);
      if (talkOnly) return fail(`找不到 NPC「${rest}」（目前地圖與已看過的地圖都沒有）`);
      // 4) 地圖名稱
      const reach = snap ? snap.nav.reachableMaps.filter(r => (r.name ?? r.mapId).includes(rest) || r.mapId === rest).map(r => ({ mapId: r.mapId, name: r.name ?? r.mapId })) : [];
      const maps = reach.length ? reach : ctx.findMap?.(rest) ?? [];
      if (maps.length === 1) return nav({ kind: 'MAP', mapId: maps[0].mapId, name: maps[0].name }, `前往地圖：${maps[0].name}`);
      if (maps.length > 1) return fail(`有多個符合「${rest}」：${maps.slice(0, 6).map(x => x.name).join('、')}，請輸入更完整的名稱`);
      if (!snap) return fail('還沒有場景快照（遊戲未執行或場景載入中）');
      return fail(`找不到「${rest}」（目前地圖與已看過的地圖裡的 NPC、出口、地圖名稱）`);
    }

    default:
      return fail(`看不懂「${verb}」。${INPUT_HELP}`);
  }
}
