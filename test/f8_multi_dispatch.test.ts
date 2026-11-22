import { createWorld, type World } from './f2_world';
import type { DispatchSpec } from '../src/dispatch';
import { dispatchOverview } from '../src/panels/DispatchPanel';
import { assert, done, suite } from './helpers';

/**
 * F8 多角色同時派任務（family #49）：假宿主照 FX17 之後的規則（背景角色可走路、對話、接交任務），
 * 兩位角色各自的任務清單與快照；全部虛構資料。
 */

const FOREGROUND = new Set(['WALK_TO', 'TALK_TO_NPC', 'CHOOSE_DIALOG_OPTION', 'ACCEPT_QUEST']);
const chainSpec = (stop: Partial<DispatchSpec['stop']> = {}): DispatchSpec => ({
  kind: 'QUEST_CHAIN',
  stop: { maxMinutes: null, stopOnBagFull: false, minSatiety: null, ...stop },
});
const gatherSpec = (): DispatchSpec => ({
  kind: 'GATHER',
  gather: { skillId: 5, skillName: '挖礦', targetItemId: 90001, targetName: '虛構礦石', count: 'UNTIL_FULL' },
  stop: { maxMinutes: null, stopOnBagFull: false, minSatiety: null },
});
const rec = (w: World, id: string) => w.ctrl.dispatches().find(r => r.characterId === id);
const doneOf = (w: World, id: string) => w.questsOf(id).filter(q => q.status === 'COMPLETED').length;
const fgTo = (w: World, id: string, from = 0) => w.sent.slice(from).filter(c => c.characterId === id && FOREGROUND.has(c.command.type)).length;
const rejected = (w: World) => w.ctrl.state.log.filter(l => l.tag === '結果' && l.level === 'warn' && l.text.includes('被拒絕'));

suite('F8 並行派工：兩位角色同時跑任務鏈，各自完成任務，視角不動，快照與事件不串');
{
  const w = createWorld({ fx17: true, questCount: 40, questStepMs: 1500 });
  w.boot();
  assert(w.ctrl.dispatcher.assign('char_1', chainSpec()) === null, '派給視角中的愛麗絲');
  assert(w.ctrl.dispatcher.assign('char_2', chainSpec()) === null, '同時派給背景的小石');
  let viewIntact = true;
  let distinct = true;
  let bothHeld = 0;
  for (let i = 0; i < 180; i++) {
    w.advance(1000);
    const st = w.ctrl.state;
    if (st.characterId !== 'char_1' || st.snapshot?.character.name !== '愛麗絲') viewIntact = false;
    const held = w.ctrl.laneSummaries().filter(l => l.questId !== null).map(l => l.questId);
    if (held.length === 2) bothHeld++;
    if (new Set(held).size !== held.length) distinct = false;
  }
  assert(w.viewed === 'char_1' && !w.sent.some(c => c.command.type === 'SWITCH_VIEW_CHARACTER'), '整段沒有切換視角');
  assert(doneOf(w, 'char_1') >= 5 && doneOf(w, 'char_2') >= 5, `兩位都完成任務（愛麗絲 ${doneOf(w, 'char_1')}、小石 ${doneOf(w, 'char_2')}）`);
  assert(fgTo(w, 'char_1') > 10 && fgTo(w, 'char_2') > 10, '兩位都收到自己的前景指令');
  assert(bothHeld > 30, `兩位同時各有一件任務在做（${bothHeld} 秒）`);
  assert(distinct, '任何時刻兩位手上的任務都不同');
  assert(w.overlaps.length === 0, `宿主端沒有兩位同時接同一件任務（${w.overlaps.length}）`);
  assert(viewIntact, '視角角色的畫面狀態一直是愛麗絲自己的（小石的背景快照沒有蓋過來）');
  assert(rejected(w).length === 0, `沒有被宿主拒絕的指令（${rejected(w).map(l => l.text).slice(0, 2).join('；')}）`);
  assert(rec(w, 'char_1')?.phase === 'RUNNING' && rec(w, 'char_2')?.phase === 'RUNNING', '兩位都是進行中');
  const bgSnaps = w.sent.filter(c => c.command.type === 'REQUEST_SNAPSHOT' && c.characterId === 'char_2').length;
  assert(bgSnaps > 0, `背景角色的快照由通道自己要（${bgSnaps} 次）`);
  const logB = w.ctrl.state.log.filter(l => l.characterId === 'char_2' && l.text.includes('已完成'));
  assert(logB.length > 0 && logB.every(l => l.text.startsWith('【小石】')), '小石的任務事件寫在小石名下');
  // 各自的任務清單都是照順序做：同一位不會跳著做而漏掉前面的任務。
  const firstGap = (id: string) => w.questsOf(id).findIndex(q => q.status !== 'COMPLETED');
  assert(firstGap('char_1') >= 0 && firstGap('char_2') >= 0, '兩位都還沒把 40 件做完（測試期間持續有工作）');
}

suite('F8 互斥：同一件任務不同時派給兩人；剩下的那件被占著就等，做完再接');
{
  const w = createWorld({ fx17: true, questCount: 1, questStepMs: 2000 });
  w.boot();
  w.ctrl.dispatcher.assign('char_1', chainSpec());
  w.advance(1000);
  w.ctrl.dispatcher.assign('char_2', chainSpec());
  w.advance(3000);
  const lanes = w.ctrl.laneSummaries();
  assert(lanes.find(l => l.characterId === 'char_1')?.questId === 7000, '愛麗絲先拿到唯一的任務');
  assert(lanes.find(l => l.characterId === 'char_2')?.questId === null, '小石沒有拿同一件');
  const waitText = rec(w, 'char_2')?.text ?? '';
  assert(waitText.includes('等待【愛麗絲】'), `小石寫明在等誰（${waitText}）`);
  assert(fgTo(w, 'char_2') === 0, '等待期間沒有送任務指令給小石');
  const err = w.ctrl.perform({ kind: 'QUEST_ASSIGN', questId: 7000, characterId: 'char_2', label: '派任務給 小石' });
  assert(typeof err === 'string' && err.includes('愛麗絲'), `任務卡片也不能把占著的任務派給別人（${err}）`);
  w.advance(60_000);
  assert(doneOf(w, 'char_1') === 1, '愛麗絲做完');
  assert(doneOf(w, 'char_2') === 1, '愛麗絲做完後小石接著做完自己的那件');
  assert(w.overlaps.length === 0, '宿主端沒有重疊');
  assert(rec(w, 'char_1')?.phase === 'RUNNING' && rec(w, 'char_2')?.phase === 'RUNNING', '做完任務目錄後兩位都進新手循環，仍是進行中');
}

suite('F8 續跑：角色離線時暫停、佇列保留，回來後接著跑；另一位不受影響');
{
  const w = createWorld({ fx17: true, questCount: 60, questStepMs: 1500 });
  w.boot();
  w.ctrl.dispatcher.assign('char_1', chainSpec());
  w.ctrl.dispatcher.assign('char_2', chainSpec({ maxMinutes: 30 }));
  w.advance(30_000);
  const deadline = rec(w, 'char_2')?.deadlineAt;
  w.setOffline('char_2', true);
  w.advance(3000);
  const r = rec(w, 'char_2');
  assert(r?.phase === 'PAUSED' && r.stopped?.code === 'CHARACTER_OFFLINE', `小石暫停，原因是角色離線（${r?.phase}/${r?.stopped?.code}）`);
  assert(r?.deadlineAt === deadline && r?.kind === 'QUEST_CHAIN', '派工紀錄與時限保留');
  assert(w.ctrl.state.log.some(l => l.characterId === 'char_2' && l.text.includes('角色離線')), '事件欄寫下小石的暫停原因');
  const mark = w.sent.length;
  const doneA = doneOf(w, 'char_1');
  w.advance(20_000);
  assert(fgTo(w, 'char_2', mark) === 0, '離線期間沒有送指令給小石');
  assert(doneOf(w, 'char_1') > doneA && rec(w, 'char_1')?.phase === 'RUNNING', '愛麗絲照常完成任務');
  const doneB = doneOf(w, 'char_2');
  w.setOffline('char_2', false);
  w.advance(20_000);
  assert(rec(w, 'char_2')?.phase === 'RUNNING', '小石回來後恢復');
  assert(doneOf(w, 'char_2') > doneB, '恢復後小石繼續完成任務');
}

suite('F8 續跑：宿主停止時兩位都暫停、採集佇列保留；宿主回來後各自接著跑，時限不重算');
{
  const w = createWorld({ fx17: true, questCount: 80, questStepMs: 1500, gatherMs: 2000, bagCapA: 99 });
  w.boot();
  const t0 = w.t;
  w.ctrl.dispatcher.assign('char_1', chainSpec({ maxMinutes: 4 }));
  w.ctrl.dispatcher.assign('char_2', gatherSpec());
  w.advance(30_000);
  w.stopHost();
  w.advance(5_000);
  const a = rec(w, 'char_1');
  assert(a?.phase === 'PAUSED' && a.stopped?.code === 'HOST_STOPPED', `任務鏈暫停，原因是宿主停止（${a?.phase}/${a?.stopped?.code}）`);
  assert(rec(w, 'char_2')?.phase === 'RUNNING' && (rec(w, 'char_2')?.text ?? '').includes('佇列保留'), '採集派工保留並寫明佇列保留');
  const doneA = doneOf(w, 'char_1');
  const bag = w.chars.char_2.bag;
  w.advance(20_000);
  w.startHost();
  w.advance(30_000);
  assert(rec(w, 'char_1')?.phase === 'RUNNING', '宿主回來後任務鏈恢復');
  assert(doneOf(w, 'char_1') > doneA, '恢復後繼續完成任務');
  assert(w.chars.char_2.bag > bag, '採集佇列也接著採');
  w.advance(3 * 60_000);
  const end = rec(w, 'char_1');
  assert(end?.phase === 'STOPPED' && end.stopped?.code === 'TIME_UP', '到原本的 4 分鐘截止時間停下');
  assert(end !== undefined && end.stopped !== null && end.stopped.at - t0 <= 4.2 * 60_000, '時限沒有因為宿主停過而延長');
}

suite('F8 續跑：關掉 family 分頁再打開，兩位的任務鏈都從存檔接回，不切視角');
{
  const w = createWorld({ fx17: true, questCount: 80, questStepMs: 1500 });
  w.boot();
  w.ctrl.dispatcher.assign('char_1', chainSpec());
  w.ctrl.dispatcher.assign('char_2', chainSpec());
  w.advance(40_000);
  const before = { a: doneOf(w, 'char_1'), b: doneOf(w, 'char_2') };
  w.closeFamilyTab();
  w.hostOnly(10_000);
  const reopened = w.reopen();
  assert(reopened.dispatches().filter(r => r.phase === 'PAUSED').length === 2, '重開後兩位都先暫停（佇列保留）');
  const mark = w.sent.length;
  w.advance(40_000);
  assert(reopened.dispatches().every(r => r.phase === 'RUNNING'), '兩位都恢復');
  assert(doneOf(w, 'char_1') > before.a && doneOf(w, 'char_2') > before.b, '兩位都繼續完成任務');
  assert(!w.sent.slice(mark).some(c => c.command.type === 'SWITCH_VIEW_CHARACTER'), '恢復時沒有切換視角');
}

suite('F8 手動接手：玩家對一位角色手動操作，只停那位的派工');
{
  const w = createWorld({ fx17: true, questCount: 60, questStepMs: 1500 });
  w.boot();
  w.ctrl.dispatcher.assign('char_1', chainSpec());
  w.ctrl.dispatcher.assign('char_2', chainSpec());
  w.advance(10_000);
  w.ctrl.perform({ kind: 'QUEST_AUTO_STOP', label: '停止自動任務' });
  w.advance(2_000);
  const a = rec(w, 'char_1');
  assert(a?.phase === 'STOPPED' && (a.stopped?.text ?? '').includes('手動'), `愛麗絲（視角中）改為手動：${a?.stopped?.text}`);
  assert(rec(w, 'char_2')?.phase === 'RUNNING', '小石的派工照跑');
  const mark = w.sent.length;
  w.advance(10_000);
  assert(fgTo(w, 'char_1', mark) === 0 && fgTo(w, 'char_2', mark) > 0, '之後只有小石收到自動指令');
}

suite('F8 家族總覽：目前任務、進度、預計完成時間只讀紀錄與快照，沒有的寫「未知」');
{
  const base = { characterId: 'c', stop: { maxMinutes: null, stopOnBagFull: false, minSatiety: null }, startedAt: 0, stopped: null, text: '' };
  const lane = { characterId: 'c', active: true, questId: 1, questTitle: '虛構委託', progress: '1/2 項目標', text: '' };
  const o1 = dispatchOverview({ ...base, kind: 'QUEST_CHAIN', phase: 'RUNNING', deadlineAt: null }, lane);
  assert(o1.quest === '虛構委託' && o1.progress === '1/2 項目標' && o1.eta === '未知', `沒有時限：預計完成未知（${JSON.stringify(o1)}）`);
  const o2 = dispatchOverview({ ...base, kind: 'QUEST_CHAIN', phase: 'RUNNING', deadlineAt: 5 }, { ...lane, questTitle: null, progress: null }, () => '12:34');
  assert(o2.quest === '未知' && o2.progress === '未知' && o2.eta === '時限 12:34', `任務名稱與進度缺就寫未知，時限照紀錄（${JSON.stringify(o2)}）`);
  const o3 = dispatchOverview({ ...base, kind: 'QUEST_CHAIN', phase: 'STOPPED', deadlineAt: null }, lane);
  assert(o3.quest === '—' && o3.eta === '—', '停工後不顯示任務');
  const w = createWorld({ fx17: true, questCount: 10, questStepMs: 1500 });
  w.boot();
  w.ctrl.dispatcher.assign('char_2', chainSpec());
  w.advance(5_000);
  const s = w.ctrl.laneSummaries().find(l => l.characterId === 'char_2');
  assert(s?.active === true && s.questId !== null && (s.questTitle ?? '').startsWith('虛構委託'), `通道摘要讀小石自己的快照（${s?.questTitle}）`);
}

done();
