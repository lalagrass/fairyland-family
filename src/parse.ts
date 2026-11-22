import type { BattleEnemyState, DialogOption, PluginCommand, SceneSnapshot, SnapshotFamilyMember, SnapshotItem, SnapshotWorkRecipe } from './protocol/index';
import type { BattleStrategy } from './battler';
import type { CharacterStrategyConfig } from './automation/strategyStore';
import type { NavGoal } from './navigator';
import type { QueueStopConditions } from './queue';
import type { DispatchSpec } from './dispatch';

/** 選單與文字輸入共用的「動作」：同一份文字或同一顆按鈕，一定走到同一個動作。 */
export type UiAction =
  | { kind: 'COMMAND'; command: PluginCommand; label: string; targetCharacterId?: string }
  | { kind: 'NAV'; goal: NavGoal; label: string }
  | { kind: 'NAV_CANCEL'; label: string }
  | { kind: 'STRATEGY'; strategy: BattleStrategy; label: string }
  | { kind: 'CHAR_STRATEGY_UPDATE'; characterId: string; patch: Partial<CharacterStrategyConfig>; label: string }
  | { kind: 'CHAR_APPEARANCE_UPDATE'; characterId: string; appearanceId: string; label: string }
  /** F4a：只改本機顯示設定（原版／現代地圖），不送給宿主。 */
  | { kind: 'CHAR_VIEWMODE_UPDATE'; characterId: string; viewMode: 'original' | 'modern'; label: string }
  | {
      kind: 'QUEUE_GATHER';
      skillId: number;
      skillName: string;
      targetItemId?: number;
      targetName: string;
      count: number | 'UNTIL_FULL';
      requiredToolItemId?: number;
      requiredToolName?: string;
      label: string;
      targetCharacterId?: string;
    }
  | { kind: 'QUEUE_CRAFT'; recipeId: number; recipeName: string; count: number; label: string; targetCharacterId?: string }
  | { kind: 'QUEUE_STOP'; label: string; targetCharacterId?: string }
  | { kind: 'QUEUE_REMOVE'; index: number; label: string; targetCharacterId?: string }
  | { kind: 'QUEUE_REORDER'; fromIndex: number; toIndex: number; label: string; targetCharacterId?: string }
  | { kind: 'QUEUE_STOP_CONDITIONS'; patch: Partial<QueueStopConditions>; label: string; targetCharacterId?: string }
  | { kind: 'DISMISS_RECAP'; label: string }
  | { kind: 'QUEST_AUTO'; questId: number; label: string }
  | { kind: 'QUEST_AUTO_STOP'; label: string; targetCharacterId?: string }
  /** F9c：把任務派給某位角色；非視角角色走 F8 背景派工通道，不切換視角。 */
  | { kind: 'QUEST_ASSIGN'; questId: number; characterId: string; label: string }
  | { kind: 'QUEST_CHAIN_START'; label: string }
  | { kind: 'QUEST_CHAIN_STOP'; label: string }
  | {
      kind: 'QUEST_CHAIN_CONFIG';
      label: string;
      patch: {
        stop?: {
          maxDurationMs?: number | null;
          targetLevel?: number | null;
          targetGold?: number | null;
          stopOnBagFull?: boolean;
          maxDeaths?: number | null;
        };
        newbieLoop?: boolean;
        loopActivity?: 'HUNT' | 'GATHER' | 'CRAFT';
        returnHpPct?: number;
        loopOnly?: boolean;
        regionId?: string | null;
      };
    }
  /** F7：停工原因可續跑時（背包滿、缺工具、路線走不通…）從原地接著跑，保留已完成的任務。 */
  | { kind: 'QUEST_CHAIN_RESUME'; label: string }
  | { kind: 'DISPATCH_ASSIGN'; characterId: string; spec: DispatchSpec; label: string }
  | { kind: 'DISPATCH_STOP'; characterId: string; label: string };

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
  members?: SnapshotFamilyMember[];
  warehouse?: { gold: number; cap: number; items: SnapshotItem[] } | null;
  recipes?: SnapshotWorkRecipe[];
  /** 已知（看過的）NPC／地圖，用來解析「前往 村長」這種不在目前地圖的目標。 */
  findNpc?: (q: string) => Array<{ name: string; mapId: string }>;
  findMap?: (q: string) => Array<{ mapId: string; name: string }>;
}

export const INPUT_HELP =
  '可輸入：[角色名] 指令｜切換視角 <角色名>｜存倉 <物品> [數量] / <金額> 金｜取倉 <物品> [數量] / <金額> 金｜前往 村長｜採集 青銅礦 2｜製作 青銅塊 2｜停止工作｜快照';

const fail = (error: string): ParseResult => ({ ok: false, error });
const cmd = (command: PluginCommand, label: string, targetCharacterId?: string): ParseResult => ({
  ok: true,
  action: { kind: 'COMMAND', command, label, ...(targetCharacterId ? { targetCharacterId } : {}) },
});
const nav = (goal: NavGoal, label: string): ParseResult => ({ ok: true, action: { kind: 'NAV', goal, label } });

function pick<T extends { name: string }>(items: T[], q: string): { hit?: T; error?: string } {
  const exact = items.filter(i => i.name === q);
  const pool = exact.length ? exact : items.filter(i => i.name.includes(q) || q.includes(i.name));
  if (pool.length === 1) return { hit: pool[0] };
  if (pool.length === 0) return {};
  return { error: `有多個符合「${q}」：${pool.slice(0, 6).map(p => p.name).join('、')}${pool.length > 6 ? '…' : ''}，請輸入更完整的名稱` };
}

function findFamilyMember(members: SnapshotFamilyMember[], query: string): SnapshotFamilyMember | undefined {
  const clean = query.replace(/^@/, '').trim();
  if (!clean) return undefined;
  return members.find(m => m.characterId === clean || (m.name && m.name === clean))
    ?? members.find(m => m.name && (m.name.includes(clean) || clean.includes(m.name)));
}

/** 把一行文字解析成和選單點擊相同的動作（「文字＝點滑鼠」）。 */
export function parseInput(text: string, snap: SceneSnapshot | null, ctx: ParseContext = {}): ParseResult {
  const raw = text.replace(/　/g, ' ').trim().replace(/\s+/g, ' ');
  if (!raw) return fail('請輸入指令。' + INPUT_HELP);

  const members = ctx.members ?? snap?.family?.members ?? [];
  let targetCharacterId: string | undefined;
  let t = raw;
  const firstSplit = /^(\S+)\s+(.+)$/.exec(raw);
  if (firstSplit && members.length > 0) {
    const memberHit = findFamilyMember(members, firstSplit[1]);
    if (memberHit) {
      targetCharacterId = memberHit.characterId;
      t = firstSplit[2].trim();
    }
  }
  const targetMember = targetCharacterId ? members.find(m => m.characterId === targetCharacterId) : undefined;
  const targetInv = targetMember?.inventory ?? ctx.inventory ?? snap?.inventory ?? [];
  const labelPrefix = targetMember?.name ? `[${targetMember.name}] ` : '';

  const m = /^(\S+?)(?:\s+(.*))?$/.exec(t);
  const verb = m![1].toLowerCase();
  const rest = (m![2] ?? '').trim();
  const nums = rest.split(' ').filter(Boolean).map(Number);

  switch (verb) {
    case '切換視角': case '視角': case 'switch': {
      if (!rest) return fail('用法：切換視角 <角色名或ID>');
      const hit = findFamilyMember(members, rest);
      if (!hit) return fail(`找不到家族成員「${rest}」`);
      return cmd({ type: 'SWITCH_VIEW_CHARACTER', characterId: hit.characterId }, `切換視角：${hit.name ?? hit.characterId}`);
    }

    case '存倉': case '取倉': case 'deposit': case 'withdraw': {
      const isDeposit = verb === '存倉' || verb === 'deposit';
      const cmdType = isDeposit ? 'WAREHOUSE_DEPOSIT' : 'WAREHOUSE_WITHDRAW';
      if (!rest) return fail(`用法：${isDeposit ? '存倉' : '取倉'} <物品名或編號> [數量] 或 <金額> 金`);
      const goldMatch = /^(\d+)\s*(?:金|可因|gold|g)$/i.exec(rest);
      if (goldMatch) {
        const gold = Number(goldMatch[1]);
        if (!(gold > 0)) return fail('金額必須大於 0');
        return cmd(
          { type: cmdType, gold },
          `${labelPrefix}${isDeposit ? '存倉' : '取倉'} ${gold} 可因`,
          targetCharacterId
        );
      }
      const parts = rest.split(' ').filter(Boolean);
      let count = 1;
      if (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])) {
        count = Math.max(1, Number(parts.pop()));
      }
      const what = parts.join(' ').trim();
      let itemId: number | null = /^\d+$/.test(what) ? Number(what) : null;
      if (itemId === null) {
        const sourceItems = isDeposit
          ? targetInv
          : (ctx.warehouse?.items ?? snap?.family?.warehouse?.items ?? []);
        const pool = sourceItems.filter(i => i.name).map(i => ({ name: i.name as string, itemId: i.itemId }));
        const hit = pick(pool, what);
        if (hit.error) return fail(hit.error);
        if (!hit.hit) {
          return fail(`在${isDeposit ? '角色背包' : '家族倉庫'}找不到「${what}」，可改輸入道具編號`);
        }
        itemId = hit.hit.itemId;
      }
      return cmd(
        { type: cmdType, itemId, count },
        `${labelPrefix}${isDeposit ? '存倉' : '取倉'} #${itemId} ×${count}`,
        targetCharacterId
      );
    }
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
      return cmd({ type: 'WORK_ONCE', skillId: nums[0] }, `${labelPrefix}工作一次（技能 ${nums[0]}）`, targetCharacterId);
    }

    case '停止工作': case 'stopwork':
      return { ok: true, action: { kind: 'QUEUE_STOP', label: `${labelPrefix}停止工作佇列`, ...(targetCharacterId ? { targetCharacterId } : {}) } };

    case '採集': case '挖礦': case '伐木': case '釣魚': case '狩獵': case '農事': case 'gather': {
      if (!snap) return fail('還沒有場景快照（遊戲未執行或場景載入中）');
      const skillVerbMap: Record<string, number> = { '伐木': 1, '釣魚': 3, '狩獵': 4, '挖礦': 5, '農事': 8 };
      const forcedSkillId = skillVerbMap[verb];
      const parts = rest.split(' ').filter(Boolean);
      let count: number | 'UNTIL_FULL' = 1;
      if (parts.length > 0) {
        const last = parts[parts.length - 1];
        if (last === '到滿' || last.toLowerCase() === 'full') {
          count = 'UNTIL_FULL';
          parts.pop();
        } else if (/^\d+$/.test(last)) {
          const n = Number(last);
          if (n >= 1 && n <= 999) {
            count = n;
            parts.pop();
          }
        }
      }
      const query = parts.join(' ').trim();
      const allPts = [...snap.gatherPoints.points, ...(snap.nearbyGatherPoints ?? [])];
      const scopedPts = forcedSkillId !== undefined ? allPts.filter(p => p.skillId === forcedSkillId) : allPts;

      if (!query) {
        if (forcedSkillId !== undefined && scopedPts.length > 0) {
          const pt = scopedPts[0];
          const firstMat = pt.materials?.[0];
          return {
            ok: true,
            action: {
              kind: 'QUEUE_GATHER',
              skillId: forcedSkillId,
              skillName: pt.skillName ?? verb,
              ...(firstMat ? { targetItemId: firstMat.itemId, targetName: firstMat.name } : { targetName: pt.skillName ?? verb }),
              count,
              ...(pt.requiredToolItemId ? { requiredToolItemId: pt.requiredToolItemId } : {}),
              ...(pt.requiredToolName ? { requiredToolName: pt.requiredToolName } : {}),
              label: `${labelPrefix}${pt.skillName ?? verb}`,
              ...(targetCharacterId ? { targetCharacterId } : {}),
            },
          };
        }
        return fail('用法：採集 <材料名稱或技能> [數量|到滿]');
      }

      // 1) 依材料編號或名稱比對（先找本圖，再找鄰近地圖）
      const candidates: Array<{
        skillId: number; skillName: string; itemId: number; name: string;
        toolId?: number; toolName?: string; local: boolean;
      }> = [];
      const seenMat = new Set<string>();
      for (const pt of scopedPts) {
        const local = pt.mapId === undefined || pt.mapId === snap.mapId;
        for (const m of pt.materials ?? []) {
          const k = `${pt.skillId}:${m.itemId}`;
          if (seenMat.has(k)) continue;
          seenMat.add(k);
          candidates.push({
            skillId: pt.skillId ?? 5,
            skillName: pt.skillName ?? '採集',
            itemId: m.itemId,
            name: m.name,
            toolId: pt.requiredToolItemId ?? undefined,
            toolName: pt.requiredToolName ?? undefined,
            local,
          });
        }
      }
      const isNumQuery = /^\d+$/.test(query);
      const exact = candidates.filter(c => (isNumQuery ? c.itemId === Number(query) : c.name === query));
      const matched = exact.length ? exact : candidates.filter(c => c.name.includes(query) || query.includes(c.name));
      matched.sort((a, b) => Number(b.local) - Number(a.local));
      if (matched.length > 0) {
        const hit = matched[0];
        const countLabel = count === 'UNTIL_FULL' ? '到滿' : `×${count}`;
        return {
          ok: true,
          action: {
            kind: 'QUEUE_GATHER',
            skillId: hit.skillId,
            skillName: hit.skillName,
            targetItemId: hit.itemId,
            targetName: hit.name,
            count,
            ...(hit.toolId ? { requiredToolItemId: hit.toolId } : {}),
            ...(hit.toolName ? { requiredToolName: hit.toolName } : {}),
            label: `${labelPrefix}${hit.skillName}：${hit.name} ${countLabel}`,
            ...(targetCharacterId ? { targetCharacterId } : {}),
          },
        };
      }

      // 2) 依技能名稱比對（如：採集 挖礦 3）
      const bySkill = scopedPts.find(p => (p.skillName ?? '') === query || (p.skillName ?? '').includes(query));
      if (bySkill && bySkill.skillId !== null) {
        const firstMat = bySkill.materials?.[0];
        return {
          ok: true,
          action: {
            kind: 'QUEUE_GATHER',
            skillId: bySkill.skillId,
            skillName: bySkill.skillName ?? query,
            ...(firstMat ? { targetItemId: firstMat.itemId, targetName: firstMat.name } : { targetName: bySkill.skillName ?? query }),
            count,
            ...(bySkill.requiredToolItemId ? { requiredToolItemId: bySkill.requiredToolItemId } : {}),
            ...(bySkill.requiredToolName ? { requiredToolName: bySkill.requiredToolName } : {}),
            label: `${labelPrefix}${bySkill.skillName ?? query}`,
            ...(targetCharacterId ? { targetCharacterId } : {}),
          },
        };
      }
      return fail(`找不到可採集的材料或技能「${query}」`);
    }

    case '製作': case '冶煉': case '鍛造': case '調配': case '料理': case 'craft': {
      if (!snap) return fail('還沒有場景快照（遊戲未執行或場景載入中）');
      const recipes = snap.recipes ?? ctx.recipes ?? [];
      if (recipes.length === 0) return fail('目前尚未載入配方目錄（請等待靜態資料同步）');
      const parts = rest.split(' ').filter(Boolean);
      if (!parts.length) return fail(`用法：${verb} <配方名稱或編號> [數量]`);
      let count = 1;
      if (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])) {
        count = Math.max(1, Number(parts.pop()));
      }
      const query = parts.join(' ').trim();
      const byId = /^\d+$/.test(query) ? recipes.find(r => r.recipeId === Number(query) || r.resultItemId === Number(query)) : undefined;
      if (byId) {
        return { ok: true, action: { kind: 'QUEUE_CRAFT', recipeId: byId.recipeId, recipeName: byId.name, count, label: `${labelPrefix}製作：${byId.name} ×${count}`, ...(targetCharacterId ? { targetCharacterId } : {}) } };
      }
      const hit = pick(recipes, query);
      if (hit.error) return fail(hit.error);
      if (!hit.hit) return fail(`找不到製作配方「${query}」`);
      return {
        ok: true,
        action: {
          kind: 'QUEUE_CRAFT',
          recipeId: hit.hit.recipeId,
          recipeName: hit.hit.name,
          count,
          label: `${labelPrefix}製作：${hit.hit.name} ×${count}`,
          ...(targetCharacterId ? { targetCharacterId } : {}),
        },
      };
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
