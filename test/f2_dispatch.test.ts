import { PROTOCOL_VERSION, type PluginMessage } from '../src/protocol/index';
import { applyMessage, initialState } from '../src/state';
import { createWorld, type World } from './f2_world';
import type { DispatchSpec } from '../src/dispatch';
import { assert, done, suite } from './helpers';

const GATHER = { skillId: 5, skillName: '挖礦', targetItemId: 90001, targetName: '虛構礦石', count: 'UNTIL_FULL' as const };
const gatherSpec = (stop: Partial<DispatchSpec['stop']> = {}): DispatchSpec => ({
  kind: 'GATHER',
  gather: GATHER,
  stop: { maxMinutes: null, stopOnBagFull: false, minSatiety: null, ...stop },
});
const chainSpec = (stop: Partial<DispatchSpec['stop']> = {}): DispatchSpec => ({
  kind: 'QUEST_CHAIN',
  stop: { maxMinutes: null, stopOnBagFull: false, minSatiety: null, ...stop },
});
const FOREGROUND = new Set(['WALK_TO', 'TALK_TO_NPC', 'CHOOSE_DIALOG_OPTION', 'ACCEPT_QUEST']);
const countBy = (w: World, charId: string, types?: Set<string>, from = 0) =>
  w.sent.slice(from).filter(c => c.characterId === charId && (!types || types.has(c.command.type))).length;
const rec = (w: World, id: string) => w.ctrl.dispatches().find(r => r.characterId === id);
const minutes = (w: World, t0: number) => Math.round(((w.t - t0) / 60000) * 10) / 10;

suite('F2 狀態：背景角色的事件不會改動視角角色的對話與戰鬥');
{
  let s = initialState();
  const w = createWorld();
  s = applyMessage(s, { v: PROTOCOL_VERSION, characterId: 'char_1', ts: 1, kind: 'snapshot', seq: 1, reason: 'STARTED', snapshot: w.snapshotFor('char_1') } as PluginMessage, 1);
  const ev = (characterId: string, event: unknown, seq: number) =>
    applyMessage(s, { v: PROTOCOL_VERSION, characterId, ts: 2, kind: 'event', seq, event } as PluginMessage, 2);
  s = ev('char_2', { type: 'DIALOG_OPENED', npcId: 'x', npcName: '別人', role: null, lines: ['背景對話'], options: [], optionsAvailable: true }, 2);
  assert(s.dialog === null, '背景角色開對話，視角角色畫面沒有對話');
  s = ev('char_2', { type: 'BATTLE_STARTED', battleId: 9, mapId: '99001', enemies: [] }, 3);
  assert(s.battle === null && s.characterId === 'char_1', '背景角色開戰，視角角色不進戰鬥');
  assert(s.members.find(m => m.characterId === 'char_2')?.inBattle === true, '名冊上標出背景角色在戰鬥');
  s = ev('char_2', { type: 'INVENTORY_CHANGED', changes: [{ itemId: 90001, delta: 2, count: 2 }] }, 4);
  assert(s.members.find(m => m.characterId === 'char_2')?.inventoryCount === 2, '背景角色背包變動只更新自己的名冊');
  assert(s.inventory.length === 0, '視角角色背包不受影響');
  assert(s.log.some(l => l.characterId === 'char_2'), '日誌仍記下背景角色的事件');
}

suite('F2 隔離：A 背景採集、B 前景跑任務，指令各帶自己的 characterId，佇列互不干擾');
{
  const w = createWorld({ bagCapA: 70, questCount: 200, questStepMs: 3000 });
  w.boot();
  assert(w.viewed === 'char_1', 'B（愛麗絲）在視角中');
  const eA = w.ctrl.dispatcher.assign('char_2', gatherSpec({ stopOnBagFull: true }));
  const eB = w.ctrl.dispatcher.assign('char_1', chainSpec());
  assert(eA === null && eB === null, '兩個派工都接受');
  w.advance(60_000);
  const workA = w.sent.filter(c => c.command.type === 'WORK_ONCE');
  assert(workA.length >= 4 && workA.every(c => c.characterId === 'char_2'), '採集指令全部送給 A');
  assert(countBy(w, 'char_2', FOREGROUND) === 0, 'A 沒有收到任何前景指令');
  assert(countBy(w, 'char_1', FOREGROUND) > 5, 'B 的前景指令持續送出');
  assert(countBy(w, 'char_1', new Set(['WORK_ONCE'])) === 0, 'B 沒有被排採集');
  assert(w.ctrl.queueStatuses()['char_2']?.phase === 'RUNNING', 'A 的佇列在跑');
  assert((w.ctrl.queueStatuses()['char_1']?.phase ?? 'IDLE') === 'IDLE', 'B 的佇列是閒置的');
  assert(!w.ctrl.state.log.some(l => l.text.includes('WRONG_CHARACTER')), '宿主沒有回 WRONG_CHARACTER');
  assert(rec(w, 'char_1')?.phase === 'RUNNING' && rec(w, 'char_2')?.phase === 'RUNNING', '兩位都是進行中');

  // 舊的文字指令替 A 排採集不會打斷 B 的任務鏈
  const before = w.quests.filter(q => q.status === 'COMPLETED').length;
  const err = w.ctrl.parseAndSend('小石 停止工作');
  w.advance(40_000);
  assert(err === null, '可以用文字停 A');
  assert(w.ctrl.chainStatus().phase !== 'STOPPED', '停 A 的工作不會停掉 B 的任務鏈');
  assert(w.quests.filter(q => q.status === 'COMPLETED').length > before, 'B 繼續完成任務');
  assert(rec(w, 'char_2')?.phase === 'STOPPED' && rec(w, 'char_2')?.stopped?.code === 'USER_STOPPED', 'A 的停工原因是玩家停止');
  assert(rec(w, 'char_1')?.phase === 'RUNNING', 'B 仍在進行中');
}

suite('F2→F8 隔離：切換視角不會打斷派工的任務鏈（FX17 宿主），也不會送指令給錯的角色');
{
  const w = createWorld({ bagCapA: 70, questCount: 200, questStepMs: 3000, fx17: true });
  w.boot();
  w.ctrl.dispatcher.assign('char_2', gatherSpec());
  w.ctrl.dispatcher.assign('char_1', chainSpec());
  w.advance(20_000);
  const mark = w.sent.length;
  // 玩家手動切到小石（A）
  w.ctrl.perform({ kind: 'COMMAND', command: { type: 'SWITCH_VIEW_CHARACTER', characterId: 'char_2' }, label: '切換視角 小石' });
  for (let i = 0; i < 40 && w.ctrl.state.characterId !== 'char_2'; i++) w.advance(50, 50);
  assert(w.viewed === 'char_2' && w.ctrl.state.characterId === 'char_2', '視角換成 A');
  const markViewed = w.sent.length;
  const completed = w.questsOf('char_1').filter(q => q.status === 'COMPLETED').length;
  w.advance(20_000);
  const afterSwitch = w.sent.slice(markViewed);
  assert(afterSwitch.filter(c => FOREGROUND.has(c.command.type) && c.characterId === 'char_2').length === 0, '視角換過去之後，沒有任何前景指令送給 A');
  assert(afterSwitch.filter(c => FOREGROUND.has(c.command.type) && c.characterId === 'char_1').length > 0, 'B 的任務鏈在背景照常送指令給 B');
  assert(rec(w, 'char_1')?.phase === 'RUNNING', 'B 仍是進行中（不再「等待視角」）');
  assert(w.questsOf('char_1').filter(q => q.status === 'COMPLETED').length > completed, 'B 在背景繼續完成任務');
  assert(countBy(w, 'char_2', new Set(['WORK_ONCE']), mark) >= 1, 'A 的採集照常');
  assert(!w.ctrl.state.log.some(l => l.text.includes('WRONG_CHARACTER')), '宿主沒有因為指令送錯角色而拒絕');
  assert(rec(w, 'char_2')?.phase === 'RUNNING', 'A 仍在進行中');
  assert(w.ctrl.state.characterId === 'char_2' && w.ctrl.state.snapshot?.character.name === '小石', '視角角色的畫面狀態沒有被 B 的背景快照蓋掉');
}

suite('F2→F8 派工：兩位角色可以同時跑任務鏈，視角不被搶走');
{
  const w = createWorld({ questCount: 200, questStepMs: 3000, fx17: true });
  w.boot();
  w.ctrl.dispatcher.assign('char_1', chainSpec());
  w.advance(5_000);
  const err = w.ctrl.dispatcher.assign('char_2', chainSpec());
  assert(err === null, `第二位也接受：${err}`);
  w.advance(10_000);
  assert(w.viewed === 'char_1', '視角沒有被搶走');
  assert(rec(w, 'char_1')?.phase === 'RUNNING' && rec(w, 'char_2')?.phase === 'RUNNING', '兩位都是進行中');
  assert(!w.sent.some(c => c.command.type === 'SWITCH_VIEW_CHARACTER'), '沒有送任何切換視角');
}

suite('F2→F8 派工：任務鏈派給不在視角的角色，直接在背景開始，不切視角');
{
  const w = createWorld({ questCount: 200, questStepMs: 3000, fx17: true });
  w.boot();
  assert(w.viewed === 'char_1', '一開始 B=愛麗絲 在視角');
  const err = w.ctrl.dispatcher.assign('char_2', chainSpec());
  assert(err === null, '接受派工');
  assert(rec(w, 'char_2')?.phase === 'PAUSED', '先等這位角色自己的快照');
  w.advance(10_000);
  assert(w.viewed === 'char_1', '宿主視角沒有動');
  assert(rec(w, 'char_2')?.phase === 'RUNNING', '快照到了就開始跑');
  assert(w.sent.filter(c => FOREGROUND.has(c.command.type)).every(c => c.characterId === 'char_2'), '前景指令只送給被派工的角色');
}

suite('F2 停止條件：背包滿、飽食度、時限、目標數量各自生效，原因寫在各自的紀錄');
{
  const w = createWorld({ bagCapA: 5, gatherMs: 2000 });
  w.boot();
  w.ctrl.dispatcher.assign('char_2', gatherSpec({ stopOnBagFull: true }));
  w.advance(40_000);
  const r = rec(w, 'char_2');
  assert(r?.phase === 'STOPPED' && r.stopped?.code === 'BAG_FULL', `背包滿即停：${r?.stopped?.code}`);
  assert(r?.stopped?.text.includes('背包已滿') === true, '原因文字寫明背包已滿');
}
{
  const w = createWorld({ satietyDropPerGather: 10, gatherMs: 2000, bagCapA: 99 });
  w.boot();
  w.ctrl.dispatcher.assign('char_2', gatherSpec({ minSatiety: 60 }));
  w.advance(60_000);
  const r = rec(w, 'char_2');
  assert(r?.phase === 'STOPPED' && r.stopped?.code === 'NO_STAMINA', `飽食度到門檻就停：${r?.stopped?.code}`);
  assert(w.chars.char_2.satiety <= 60 && w.chars.char_2.satiety > 40, '停在門檻附近');
}
{
  const w = createWorld({ gatherMs: 2000, bagCapA: 99, questCount: 500, questStepMs: 2000 });
  w.boot();
  const t0 = w.t;
  w.ctrl.dispatcher.assign('char_2', gatherSpec({ maxMinutes: 2 }));
  w.ctrl.dispatcher.assign('char_1', chainSpec({ maxMinutes: 3 }));
  w.advance(150_000);
  assert(rec(w, 'char_2')?.stopped?.code === 'TIME_UP' && rec(w, 'char_1')?.phase === 'RUNNING', 'A 滿 2 分鐘先停，B 還在跑');
  w.advance(60_000);
  const rb = rec(w, 'char_1');
  assert(rb?.phase === 'STOPPED' && rb.stopped !== null, 'B 滿 3 分鐘也停');
  assert(minutes(w, t0) >= 3.5 && rb?.stopped?.text.includes('時間') === true, `B 的原因是時間到：${rb?.stopped?.text}`);
  assert(rec(w, 'char_2')?.stopped?.text !== rb?.stopped?.text, '兩位的停工原因各自寫自己的');
}
{
  const w = createWorld({ gatherMs: 1000, bagCapA: 99 });
  w.boot();
  w.ctrl.dispatcher.assign('char_2', { kind: 'GATHER', gather: { ...GATHER, count: 3 }, stop: { maxMinutes: null, stopOnBagFull: false, minSatiety: null } });
  w.advance(30_000);
  const r = rec(w, 'char_2');
  assert(r?.phase === 'DONE' && r.stopped?.code === 'DONE_TARGET', '採集到目標數量算完成');
  assert(w.chars.char_2.bag === 3, '剛好採 3 個');
}

suite('F2 回來摘要與事件欄：每位角色各自寫停工原因');
{
  const w = createWorld({ gatherMs: 2000, bagCapA: 4, questCount: 500, questStepMs: 2000 });
  w.boot();
  w.ctrl.dispatcher.assign('char_2', gatherSpec({ stopOnBagFull: true }));
  w.ctrl.dispatcher.assign('char_1', chainSpec({ maxMinutes: 1 }));
  w.advance(90_000);
  const recaps = w.ctrl.dispatchRecaps();
  const a = recaps.find(r => r.characterId === 'char_2');
  const b = recaps.find(r => r.characterId === 'char_1');
  assert(Boolean(a?.reason?.includes('背包已滿')) && a?.line.includes('小石') === true, `A 的摘要：${a?.line}`);
  assert(Boolean(b?.reason?.includes('時間')) && b?.line.includes('愛麗絲') === true, `B 的摘要：${b?.line}`);
  const logA = w.ctrl.state.log.filter(l => l.characterId === 'char_2' && l.text.includes('停工'));
  const logB = w.ctrl.state.log.filter(l => l.characterId === 'char_1' && l.text.includes('停工'));
  assert(logA.length === 1 && logA[0].text.includes('背包已滿'), '事件欄：A 一筆停工原因');
  assert(logB.length === 1 && logB[0].text.includes('時間'), '事件欄：B 一筆停工原因');
}

suite('F2 恢復：關掉 family 分頁再打開，各角色的派工從存檔與宿主快照接回去');
{
  const w = createWorld({ gatherMs: 2000, bagCapA: 99, questCount: 500, questStepMs: 2000 });
  w.boot();
  w.ctrl.dispatcher.assign('char_2', gatherSpec({ maxMinutes: 6 }));
  w.ctrl.dispatcher.assign('char_1', chainSpec({ maxMinutes: 6 }));
  w.advance(60_000);
  const bagBefore = w.chars.char_2.bag;
  const questsBefore = w.quests.filter(q => q.status === 'COMPLETED').length;
  w.closeFamilyTab();
  w.hostOnly(30_000);
  const reopened = w.reopen();
  assert(reopened.dispatches().length === 2, '重開後讀回兩位的派工紀錄');
  assert(reopened.dispatches().find(r => r.characterId === 'char_1')?.phase === 'PAUSED', '任務鏈先暫停（佇列保留），等宿主與快照');
  w.advance(25_000);
  assert(reopened.dispatches().find(r => r.characterId === 'char_1')?.phase === 'RUNNING', 'B 的任務鏈恢復');
  assert(w.quests.filter(q => q.status === 'COMPLETED').length > questsBefore, 'B 繼續做任務');
  assert(w.chars.char_2.bag > bagBefore, 'A 繼續採集');
  assert(reopened.queueStatuses()['char_2']?.phase === 'RUNNING', 'A 的佇列自己從存檔恢復');
  // 時限用絕對時間：原本派工起 6 分鐘，不因重開而重算。
  w.advance(5 * 60_000);
  assert(reopened.dispatches().every(r => r.phase === 'STOPPED' && r.stopped?.code !== undefined), '到原本的截止時間，兩位各自停下');
  assert(w.t - 1_000_000 < 8.5 * 60_000, `沒有因重開而延長（已過 ${Math.round((w.t - 1_000_000) / 1000)} 秒）`);
}

suite('F2 恢復：重開後先看到的是哪位角色，都不會把佇列接錯人');
{
  const w = createWorld({ gatherMs: 2000, bagCapA: 99 });
  w.boot();
  w.ctrl.dispatcher.assign('char_2', gatherSpec());
  w.advance(10_000);
  w.closeFamilyTab();
  w.setViewed('char_2'); // 重開時宿主視角已經是 A
  const reopened = w.reopen();
  w.advance(10_000);
  const sentToB = w.sent.filter(c => c.command.type === 'WORK_ONCE' && c.characterId === 'char_1').length;
  assert(sentToB === 0, '採集佇列沒有被接到另一位角色身上');
  assert(reopened.queueStatuses()['char_2']?.phase === 'RUNNING', 'A 的佇列照樣在跑');
}

suite('F2 實跑（模擬宿主）：A 採集、B 跑任務，各至少 10 分鐘遊戲時間，最後各自依條件停下');
{
  const w = createWorld({ gatherMs: 10_000, bagCapA: 70, questCount: 400, questStepMs: 3000 });
  w.boot();
  const t0 = w.t;
  w.ctrl.dispatcher.assign('char_2', gatherSpec({ stopOnBagFull: true }));
  w.ctrl.dispatcher.assign('char_1', chainSpec({ maxMinutes: 10 }));
  const lines: string[] = [];
  let stoppedAt: Record<string, number> = {};
  for (let i = 0; i < 14 * 60; i++) {
    w.advance(1000);
    for (const r of w.ctrl.dispatches()) {
      if ((r.phase === 'STOPPED' || r.phase === 'DONE') && stoppedAt[r.characterId] === undefined) stoppedAt[r.characterId] = w.t - t0;
    }
    if (i % 120 === 119) {
      lines.push(`  第 ${(i + 1) / 60} 分：A 背包 ${w.chars.char_2.bag}/70、B 完成任務 ${w.quests.filter(q => q.status === 'COMPLETED').length} 件`);
    }
  }
  const a = rec(w, 'char_2')!;
  const b = rec(w, 'char_1')!;
  const mm = (ms: number) => (ms / 60000).toFixed(1);
  console.log('REPORT 模擬宿主兩角色 10 分鐘實跑');
  lines.forEach(l => console.log('REPORT' + l));
  console.log(`REPORT  A 小石（採集）：${a.phase} 於 ${mm(stoppedAt['char_2'])} 分鐘；原因：${a.stopped?.text}`);
  console.log(`REPORT  B 愛麗絲（任務鏈）：${b.phase} 於 ${mm(stoppedAt['char_1'])} 分鐘；原因：${b.stopped?.text}；完成任務 ${w.quests.filter(q => q.status === 'COMPLETED').length} 件`);
  console.log(`REPORT  送給 A 的指令：${[...new Set(w.sent.filter(c => c.characterId === 'char_2').map(c => c.command.type))].join('、')}（共 ${countBy(w, 'char_2')} 筆）`);
  console.log(`REPORT  送給 B 的指令：${[...new Set(w.sent.filter(c => c.characterId === 'char_1').map(c => c.command.type))].join('、')}（共 ${countBy(w, 'char_1')} 筆）`);
  const rejected = w.ctrl.state.log.filter(l => l.tag === '結果' && l.level === 'warn' && l.text.includes('被拒絕'));
  assert(stoppedAt['char_2'] >= 10 * 60_000, `A 跑滿至少 10 分鐘才停（${mm(stoppedAt['char_2'])} 分）`);
  assert(stoppedAt['char_1'] >= 10 * 60_000 && stoppedAt['char_1'] <= 10.5 * 60_000, `B 在 10 分鐘的時限停（${mm(stoppedAt['char_1'])} 分）`);
  assert(a.stopped?.code === 'BAG_FULL' && b.stopped?.text.includes('時間到') === true, '兩位依各自的條件停下，原因不同');
  assert(countBy(w, 'char_2', FOREGROUND) === 0, '整段期間 A 沒有收到前景指令');
  assert(countBy(w, 'char_1', new Set(['WORK_ONCE'])) === 0, '整段期間 B 沒有收到採集指令');
  assert(rejected.length === 0, `整段期間沒有被宿主拒絕的指令（${rejected.length}）`);
  assert(w.chars.char_2.bag === 70, 'A 的背包剛好採滿');
  assert(w.quests.filter(q => q.status === 'COMPLETED').length >= 30, 'B 在 10 分鐘內完成了許多任務');
}

done();
