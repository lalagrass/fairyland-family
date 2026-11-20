import { createWorld } from './f2_world';
import { pickDepositItem, sellableItems } from '../src/automation/questPlan';
import type { DispatchSpec } from '../src/dispatch';
import { assert, done, suite } from './helpers';

const GATHER = { skillId: 5, skillName: '挖礦', targetItemId: 90001, targetName: '虛構礦石', count: 'UNTIL_FULL' as const };
const stop = { maxMinutes: null, stopOnBagFull: false, minSatiety: null };
const gatherSpec: DispatchSpec = { kind: 'GATHER', gather: GATHER, stop };
const chainSpec: DispatchSpec = { kind: 'QUEST_CHAIN', stop };

suite('F2b 遠距採集：背景角色離採集點太遠 → 切視角走近 → 採集 → 視角還給前景任務鏈');
{
  const w = createWorld({ startOffsetA: 700, bagCapA: 70, questCount: 200, questStepMs: 3000, gatherMs: 8000 });
  w.boot();
  assert(w.viewed === 'char_1', '一開始 B（愛麗絲）在視角中');
  assert(w.ctrl.dispatcher.assign('char_2', gatherSpec) === null, 'A 派採集');
  assert(w.ctrl.dispatcher.assign('char_1', chainSpec) === null, 'B 派任務鏈');
  w.advance(90_000);
  const works = w.sent.filter(c => c.command.type === 'WORK_ONCE' && c.characterId === 'char_2');
  assert(works.length >= 1, `A 至少採集成功送出 1 次（${works.length}）`);
  assert(w.chars.char_2.bag >= 1, `A 背包有採到東西（${w.chars.char_2.bag}）`);
  const walkA = w.sent.filter(c => c.command.type === 'WALK_TO' && c.characterId === 'char_2');
  assert(walkA.length >= 1, 'A 在視角中時自己走近採集點');
  assert(!w.sent.some(c => c.command.type === 'WORK_ONCE' && c.characterId === 'char_2' && c.ts < (walkA[0]?.ts ?? 0)), '走近之前沒有送採集');
  assert(w.viewed === 'char_1', '走近後視角還給 B');
  assert(w.ctrl.chainStatus().phase !== 'STOPPED', 'B 的任務鏈恢復／仍在跑');
  const before = w.quests.filter(q => q.status === 'COMPLETED').length;
  w.advance(40_000);
  assert(w.quests.filter(q => q.status === 'COMPLETED').length > before, 'B 還給視角後繼續完成任務');
  assert(w.ctrl.dispatches().find(r => r.characterId === 'char_2')?.phase === 'RUNNING', 'A 仍在採集（沒有停工）');
}

suite('F2b 遠距採集：宿主說太遠（TOO_FAR）時，視角中的角色走到採集點旁再採');
{
  const w = createWorld({ startOffsetA: 250, bagCapA: 70, questCount: 0, gatherMs: 5000, viewed: 'char_2' });
  w.boot();
  // 我們自己的距離判斷（預設 240 − 餘裕）已經會走近；用宿主訊息裡的範圍也要能運作。
  assert(w.ctrl.dispatcher.assign('char_2', gatherSpec) === null, '視角中的 A 派採集');
  w.advance(40_000);
  assert(w.chars.char_2.bag >= 1, '視角中離 250px 也能走近並採到');
  assert(w.ctrl.dispatches().find(r => r.characterId === 'char_2')?.stopped === null, '沒有停工');
}

suite('F2b 背包滿：沒有可賣的東西時改存家族倉庫，存不下才停');
{
  const it = (itemId: number, count: number, name: string) => ({ itemId, count, name }) as never;
  const inv = [it(50111, 20, '一級封印石'), it(90001, 10, '虛構礦石'), it(90002, 10, '虛構木材')];
  assert(sellableItems(inv, []).length === 2, '封印石不賣也不存');
  const first = pickDepositItem(inv, [], new Set(), { cap: 200, items: [] });
  assert(first?.itemId === 90001, '先挑第一項可存的物品');
  const second = pickDepositItem(inv, [], new Set([90001]), { cap: 200, items: [] });
  assert(second?.itemId === 90002, '存過的不重複挑');
  assert(pickDepositItem(inv, [], new Set([90001, 90002]), { cap: 200, items: [] }) === undefined, '都試過就沒有了（停下並寫原因）');
  assert(pickDepositItem(inv, ['虛構礦石', '虛構木材'], new Set(), { cap: 200, items: [] }) === undefined, '任務要用的（keep）不存');
  assert(pickDepositItem(inv, [], new Set(), { cap: 5, items: [it(1, 5, '倉庫既有')] }) === undefined, '倉庫已滿不存');
  assert(pickDepositItem(inv, [], new Set(), null)?.itemId === 90001, '沒有倉庫資訊時仍先試著存');
}

done();
