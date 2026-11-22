import { createWorld } from './f2_world';
import { selectGatherPoint } from '../src/gatherRoute';
import { PROTOCOL_VERSION, type CommandMessage, type PluginCommand, type PluginMessage, type SceneSnapshot, type SnapshotGatherPoint, type SnapshotPortalEdge, type SnapshotPortalNode } from '../src/protocol/index';
import { WorkQueue } from '../src/queue';
import { AutoNavigator } from '../src/navigator';
import { Directory } from '../src/directory';
import { initialState } from '../src/state';
import examples from '../src/protocol/examples.json';
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

suite('F7：背景採集借視角尚未確認就停工，不再派新工作，前景任務能恢復');
{
  const w = createWorld({ startOffsetA: 700, bagCapA: 70, questCount: 200, questStepMs: 1000, gatherMs: 8000 });
  w.boot();
  w.ctrl.dispatcher.assign('char_1', chainSpec);
  w.advance(3000);
  const before = w.quests.filter(q => q.status === 'COMPLETED').length;
  w.ctrl.dispatcher.assign('char_2', gatherSpec);
  w.advance(1, 1);
  assert(w.sent.some(c => c.command.type === 'SWITCH_VIEW_CHARACTER' && c.command.characterId === 'char_2')
    && w.ctrl.state.characterId === 'char_1', '已送出借視角切換，但還未收到新角色的快照');
  w.ctrl.dispatcher.stop('char_2');
  const sentAtStop = w.sent.length;
  w.advance(45_000);
  assert(!w.sent.slice(sentAtStop).some(c => c.characterId === 'char_2'
    && ['WORK_ONCE', 'WALK_TO', 'BUY_ITEM'].includes(c.command.type)), '遲來快照不再讓已停工的角色走路、購買或採集');
  assert(w.ctrl.state.characterId === 'char_1' && w.quests.filter(q => q.status === 'COMPLETED').length > before,
    '視角已歸還，前景任務繼續完成');
}

suite('F7：玩家在借視角未確認時點選角色，舊歸還只在玩家未成功切換時執行');
{
  for (const outcome of ['accepted', 'rejected', 'timeout'] as const) {
    const w = createWorld({ startOffsetA: 700, bagCapA: 70, questCount: 0, gatherMs: 8000 });
    w.boot();
    w.ctrl.dispatcher.assign('char_2', gatherSpec);
    w.advance(1, 1);
    assert(w.ctrl.state.characterId === 'char_1'
      && w.sent.some(c => c.command.type === 'SWITCH_VIEW_CHARACTER' && c.command.characterId === 'char_2'),
      `${outcome}：背景借視角已送出，宿主尚未確認`);

    const held: CommandMessage[] = [];
    const sendNow = w.transport.send.bind(w.transport);
    w.transport.send = msg => {
      if (msg.command.type === 'SWITCH_VIEW_CHARACTER' && msg.command.characterId === 'char_2') held.push(msg);
      else sendNow(msg);
    };
    w.ctrl.perform({ kind: 'COMMAND', command: { type: 'SWITCH_VIEW_CHARACTER', characterId: 'char_2' }, label: '玩家選擇小石' });
    w.advance(12_000);
    const manual = held[0];
    assert(held.length === 1 && w.ctrl.state.characterId === 'char_2'
      && w.sent.some(c => c.characterId === 'char_2' && c.command.type === 'WORK_ONCE')
      && !w.sent.some(c => c.command.type === 'SWITCH_VIEW_CHARACTER' && c.command.characterId === 'char_1'),
      `${outcome}：已收到早先借視角的快照且已開工，但玩家切換未回覆前不自動歸還`);

    w.transport.send = sendNow;
    if (outcome === 'accepted') sendNow(manual);
    if (outcome === 'rejected') {
      w.push({ v: PROTOCOL_VERSION, kind: 'command-result', characterId: manual.characterId,
        ts: w.t, commandId: manual.commandId, status: 'REJECTED', reasonCode: 'GAME_BUSY' });
    }
    w.advance(outcome === 'timeout' ? 12_000 : 1000);
    const expected = outcome === 'accepted' ? 'char_2' : 'char_1';
    const restores = w.sent.filter(c => c.command.type === 'SWITCH_VIEW_CHARACTER' && c.command.characterId === 'char_1');
    assert(w.ctrl.state.characterId === expected && restores.length === (outcome === 'accepted' ? 0 : 1),
      `${outcome}：確認成功保留玩家選擇，拒絕或逾時則原借用正常歸還`);
  }
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

// F7：只從宿主快照挑採集地圖，不包含真實地圖或素材。
const f7Point = (id: string, mapId: string, x = 30): SnapshotGatherPoint => ({
  id, name: id, mapId, mapName: mapId, x, y: 0, skillId: 88, skillName: '測試技能',
  requiredToolItemId: null, requiredToolName: null,
  materials: [{ itemId: 881, name: '測試材料', reqLevel: 1 }],
});
const f7Edge = (id: string, targetMapId: string, targetStatus: SnapshotPortalEdge['targetStatus'] = 'IMPORTED'): SnapshotPortalEdge =>
  ({ id, name: id, targetMapId, targetMapName: targetMapId, x: 10, y: 0, targetStatus });
const f7Node = (mapId: string, portals: SnapshotPortalEdge[] = []): SnapshotPortalNode =>
  ({ mapId, name: mapId, portals, targets: portals.map(p => p.targetMapId) });
const remote = {
  blocked: f7Point('blocked-resource', 'f7-blocked'),
  far: f7Point('far-resource', 'f7-far'),
  near: f7Point('near-resource', 'f7-near'),
  unseen: f7Point('unseen-resource', 'f7-unseen'),
};
const f7Graph = [
  f7Node('f7-start', [
    f7Edge('blocked', 'f7-blocked', 'NOT_IMPORTED'),
    f7Edge('first-leg', 'f7-middle'),
    f7Edge('direct', 'f7-near'),
  ]),
  f7Node('f7-blocked'), f7Node('f7-middle', [f7Edge('second-leg', 'f7-far')]),
  f7Node('f7-near'), f7Node('f7-far'),
];
type F7Scene = Parameters<typeof selectGatherPoint>[1];
const f7Snap = (nearbyGatherPoints: SnapshotGatherPoint[], points: SnapshotGatherPoint[] = []): F7Scene => ({
  mapId: 'f7-start', mapName: '起點', exits: [], nearbyGatherPoints,
  gatherPoints: { status: 'AVAILABLE', points },
  nav: { status: 'AVAILABLE', reachableMaps: [], pixelWidth: null, pixelHeight: null },
});
const f7Member = { mapId: 'f7-start', x: 0, y: 0, isViewed: true };
const f7Job = { skillId: 88, targetItemId: 881 };
const f7Selection = (snap: F7Scene, graph?: SnapshotPortalNode[], skip = new Set<string>()) =>
  selectGatherPoint(f7Job, snap, f7Member, skip, graph);

suite('F7 採集找路：先就地採，否則從宿主路線選最近可達地圖');
{
  const r = f7Selection(f7Snap([remote.blocked, remote.far, remote.near]), f7Graph);
  assert(r.kind === 'POINT' && r.point.id === remote.near.id, '首選是斷點、次選較遠時，走最短的可達路線');
  const skip = f7Selection(f7Snap([remote.blocked, remote.far, remote.near]), f7Graph, new Set([remote.near.id]));
  assert(skip.kind === 'POINT' && skip.point.id === remote.far.id, '避開已失敗的採集點，選仍可達的遠點');
  const close = f7Point('local-close', 'f7-start', 10);
  const local = f7Selection(f7Snap([remote.near], [f7Point('local-far', 'f7-start', 90), close]), f7Graph);
  assert(local.kind === 'POINT' && local.point.id === close.id, '同圖優先，即使遠點可達；有多點時選角色附近');
}
suite('F7 採集找路：區分快照缺資料、尚未能確認、宿主明示的斷點');
{
  assert(f7Selection(f7Snap([remote.blocked]), f7Graph).kind === 'NO_ROUTE', '明確斷點沒有替代地圖，不派移動');
  assert(f7Selection(f7Snap([]), f7Graph).kind === 'NO_POINT', '沒有符合材料的候選，與沒有路線不同');
  for (const graph of [undefined, [], f7Graph.slice(1), f7Graph]) {
    const r = f7Selection(f7Snap([remote.unseen]), graph);
    assert(r.kind === 'POINT' && r.point.id === remote.unseen.id, '尚無目錄或圖未收錄目的地時保留原導航');
  }
  const disconnected = f7Selection(f7Snap([remote.unseen, remote.near]), [...f7Graph, f7Node('f7-unseen')]);
  assert(disconnected.kind === 'POINT' && disconnected.point.id === remote.near.id, '已知可達優先於目錄有地圖但找不到路的候選');
  const snapshotGraph = [f7Node('f7-start', [f7Edge('updated', 'f7-blocked')]), f7Node('f7-blocked')];
  const patched = f7Snap([remote.blocked, remote.near]);
  patched.nav.portalGraph = snapshotGraph;
  const recent = f7Selection(patched, f7Graph);
  assert(recent.kind === 'POINT' && recent.point.id === remote.blocked.id, '使用宿主最新快照的傳送關係，不依過期靜態圖拒絕');
  const background = selectGatherPoint(f7Job, f7Snap([remote.blocked, remote.near]), { ...f7Member, mapId: 'f7-near', isViewed: false }, new Set(), f7Graph);
  assert(background.kind === 'POINT' && background.point.id === remote.near.id, '背景選自己的地圖而不是視角地圖');
}

suite('F7 採集派工：假宿主確認換圖後才開工，找不到路時不送任何指令');
{
  const testQueue = (points: SnapshotGatherPoint[], local: SnapshotGatherPoint[] = []) => {
    const makeSnap = (mapId: string, nearby: SnapshotGatherPoint[], local: SnapshotGatherPoint[] = []): SceneSnapshot => ({
      ...(examples.snapshot.snapshot as SceneSnapshot),
      ...f7Snap(nearby, local), mapId, mapName: mapId,
      character: { ...(examples.snapshot.snapshot.character as SceneSnapshot['character']), x: 0, y: 0 },
      inventory: [],
      nav: { ...f7Snap([]).nav, portalGraph: f7Graph },
    });
    const start = makeSnap('f7-start', points, local);
    const state = { ...initialState(), phase: 'PLAYING' as const, characterId: 'f7-character',
      location: { mapId: start.mapId, mapName: start.mapName }, snapshot: start, character: start.character };
    const sent: Array<{ id: string; command: PluginCommand }> = [];
    const timers: Array<{ ms: number; fn: () => void }> = [];
    const after = (ms: number, fn: () => void) => timers.push({ ms, fn });
    const send = (command: PluginCommand) => {
      const id = `f7-command-${sent.length + 1}`;
      sent.push({ id, command });
      return id;
    };
    const log = () => {};
    const dir = new Directory(null);
    dir.learnPortalGraph(f7Graph);
    const host = { state: () => state, send, after, log, onChange: () => {} };
    const navigator = new AutoNavigator({ ...host, dir });
    const queue = new WorkQueue({ ...host, navigator });
    const inbound = (m: PluginMessage) => { navigator.onMessage(m); queue.onMessage(m); };
    const drain = () => {
      for (let guard = 0; guard < 20; guard++) {
        const i = timers.findIndex(timer => timer.ms <= 100);
        if (i < 0) break;
        timers.splice(i, 1)[0].fn();
      }
    };
    const messageBase = { v: PROTOCOL_VERSION, characterId: 'f7-character', ts: 1, seq: 1 } as const;
    queue.enqueue({ kind: 'GATHER', ...f7Job, skillName: '測試技能', targetName: '測試材料', targetCount: 1 });
    drain();
    return {
      sent, queue, navigator, drain,
      complete(id: string, code: 'MAP_CHANGED' | 'DONE') {
        inbound({ ...messageBase, kind: 'event', event: { type: 'COMMAND_COMPLETED', commandId: id, outcome: 'DONE', code } });
        drain();
      },
      reject(id: string) {
        inbound({ ...messageBase, kind: 'event', event: { type: 'COMMAND_REJECTED', commandId: id, reasonCode: 'WRONG_CHARACTER' } });
        drain();
      },
      snapshot() {
        inbound({ ...messageBase, kind: 'snapshot', reason: 'REQUESTED', snapshot: state.snapshot });
        drain();
      },
      enter(point: SnapshotGatherPoint) {
        const snap = makeSnap(point.mapId!, [], [point]);
        state.location = { mapId: snap.mapId, mapName: snap.mapName };
        state.snapshot = snap;
        state.character = snap.character;
        inbound({ ...messageBase, kind: 'snapshot', reason: 'REQUESTED', snapshot: snap });
        drain();
      },
    };
  };
  const run = testQueue([remote.blocked, remote.far, remote.near]);
  const move = run.sent[0];
  assert(move?.command.type === 'WALK_TO' && move.command.mapId === 'f7-start', '由 F5 導航器派發跨圖第一段');
  run.complete(move.id, 'MAP_CHANGED');
  assert(!run.sent.some(x => x.command.type === 'WORK_ONCE'), '舊快照不開工');
  run.enter(remote.near);
  const work = run.sent[1];
  assert(work?.command.type === 'WORK_ONCE' && work.command.targetItemId === f7Job.targetItemId, '抵達可達的目的地才採集一次');
  run.complete(work.id, 'DONE');
  assert(run.queue.getStatus().phase === 'DONE' && run.queue.getStatus().jobs[0]?.doneCount === 1, '宿主完成事件結算一單位');
  const blocked = testQueue([remote.blocked]);
  assert(blocked.sent.length === 0 && blocked.queue.getStatus().stopReason === 'NAV_FAILED', '只有斷點：不派指令，明確停工原因');

  suite('F7 停止採集：只取消這條佇列啟動的導航');
  const manualGoal = { kind: 'MAP', mapId: 'f7-near', name: '手動目的地' } as const;
  const local = testQueue([], [f7Point('local-resource', 'f7-start')]);
  local.navigator.go(manualGoal);
  const manualCount = local.sent.length;
  local.queue.stop();
  assert(local.navigator.isActive() && local.sent.length === manualCount, '停止同圖工作，不取消正在走的手動路線或額外送原地停止');

  const own = testQueue([remote.near]);
  own.queue.stop();
  assert(own.navigator.getStatus().phase === 'CANCELLED' && own.sent.length === 2, '停止跨圖工作仍取消自己的移動');

  const replaced = testQueue([remote.near]);
  replaced.navigator.go(manualGoal);
  const replaceCount = replaced.sent.length;
  replaced.snapshot();
  assert(replaced.sent.length === replaceCount, '收到新快照時，舊佇列仍等手動路線，不覆蓋它');
  replaced.queue.stop();
  assert(replaced.navigator.isActive() && replaced.sent.length === replaceCount, '手動接管到同一地圖時，舊佇列的停止不取消新路線');

  const ownFailure = testQueue([remote.near]);
  ownFailure.reject(ownFailure.sent[0].id);
  assert(ownFailure.queue.getStatus().stopReason === 'NAV_FAILED', '宿主拒絕佇列自己的路線時仍回報 NAV_FAILED');

  const foreignFailure = testQueue([remote.near]);
  foreignFailure.navigator.go(manualGoal);
  foreignFailure.reject(foreignFailure.sent[1].id);
  assert(foreignFailure.queue.isActive() && foreignFailure.sent.length === 3, '手動路線失敗不算採集停工；結束後重新規劃採集');
}

done();
