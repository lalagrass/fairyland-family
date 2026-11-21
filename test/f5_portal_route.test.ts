/**
 * F5（fairyland-family#43）：傳送點圖上的最短地圖路線與自動移動。
 * 全部使用虛構的地圖 id（m-*）與座標，不含任何原版資料。
 */
import { assert, suite, done } from './helpers';
import { planPortalRoute, describeSkipped } from '../src/portalRoute';
import { AutoNavigator } from '../src/navigator';
import { Directory } from '../src/directory';
import { PROTOCOL_VERSION, type SnapshotPortalEdge, type SnapshotPortalNode, type PluginCommand, type PluginMessage } from '../src/protocol/index';

const edge = (id: string, to: string, x: number, y: number, status: SnapshotPortalEdge['targetStatus'] = 'IMPORTED'): SnapshotPortalEdge =>
  ({ id, name: `門${id}`, x, y, targetMapId: to, targetMapName: null, targetStatus: status, entryX: 1, entryY: 1 });
const node = (mapId: string, portals: SnapshotPortalEdge[]): SnapshotPortalNode =>
  ({ mapId, name: `圖${mapId}`, targets: [...new Set(portals.map(p => p.targetMapId))], portals });

// 虛構世界：a -> b -> d（兩段）；a -> c -> e -> d（較長）；z 是沒有任何出路的孤島；a 另有一個通往不存在地圖 gone 的傳送點。
const world: SnapshotPortalNode[] = [
  node('m-a', [edge('a-b', 'm-b', 10, 10), edge('a-c', 'm-c', 20, 20), edge('a-gone', 'm-gone', 30, 30, 'NOT_IMPORTED')]),
  node('m-b', [edge('b-a', 'm-a', 11, 11), edge('b-d', 'm-d', 12, 12)]),
  node('m-c', [edge('c-a', 'm-a', 21, 21), edge('c-e', 'm-e', 22, 22)]),
  node('m-e', [edge('e-d', 'm-d', 23, 23)]),
  node('m-d', [edge('d-b', 'm-b', 13, 13)]),
  node('m-z', []),
  node('m-gone', []),
];

suite('F5: 最短地圖路線');
{
  const r = planPortalRoute(world, 'm-a', 'm-d');
  assert(r.ok && r.maps.join() === 'm-a,m-b,m-d', '取經過最少張地圖的路線（兩段，不走較長的一條）');
  assert(r.ok && r.legs.map(l => l.edge.id).join() === 'a-b,b-d', '每一段帶著要走的傳送點');
  assert(r.ok && r.skipped.length === 1 && r.skipped[0].reason === 'TARGET_MISSING' && r.skipped[0].portalId === 'a-gone', '路線上遇到的斷點被記下來（通往不存在的地圖）');
  const same = planPortalRoute(world, 'm-a', 'm-a');
  assert(same.ok && same.legs.length === 0 && same.maps.join() === 'm-a', '起點就是終點：不用走');
  const back = planPortalRoute(world, 'm-d', 'm-a');
  assert(back.ok && back.maps.join() === 'm-d,m-b,m-a', '回程也找得到');
}

suite('F5: 斷點（目的地圖不存在）');
{
  const g = [node('m-a', [edge('a-b', 'm-b', 1, 1, 'NOT_IMPORTED'), edge('a-c', 'm-c', 2, 2)]), node('m-b', [edge('b-d', 'm-d', 3, 3)]), node('m-c', [edge('c-d', 'm-d', 4, 4)]), node('m-d', [])];
  const r = planPortalRoute(g, 'm-a', 'm-d');
  assert(r.ok && r.maps.join() === 'm-a,m-c,m-d', '最短的那條有斷點時改走另一條');
  const only = planPortalRoute([node('m-a', [edge('a-b', 'm-b', 1, 1, 'NOT_IMPORTED')]), node('m-b', [])], 'm-a', 'm-b');
  assert(!only.ok && only.code === 'NO_ROUTE' && only.skipped.length === 1 && only.skipped[0].reason === 'TARGET_MISSING', '唯一的路是斷點：沒有路線，並說明被略過的傳送點');
  const text = describeSkipped(only.skipped[0], id => (id === 'm-b' ? '目的地' : null));
  assert(text.includes('門a-b') && text.includes('目的地') && text.includes('不存在'), '面板文字寫出傳送點、目的地圖與原因');
}

suite('F5: 無路可走與其他略過原因');
{
  const r = planPortalRoute(world, 'm-a', 'm-z');
  assert(!r.ok && r.code === 'NO_ROUTE', '孤島：無路可走');
  const u = planPortalRoute(world, 'm-nowhere', 'm-a');
  assert(!u.ok && u.code === 'UNKNOWN_START', '起點不在圖裡：UNKNOWN_START');
  const blocked = planPortalRoute(world, 'm-a', 'm-d', { blocked: new Set(['a-b']) });
  assert(blocked.ok && blocked.maps.join() === 'm-a,m-c,m-e,m-d', '走不通的傳送點被排除，改走較長的路');
  const noPos: SnapshotPortalEdge = { id: 'p', name: '無座標', targetMapId: 'm-b', targetMapName: null, targetStatus: 'IMPORTED' };
  const g = [node('m-a', [noPos]), node('m-b', [])];
  const np = planPortalRoute(g, 'm-a', 'm-b');
  assert(!np.ok && np.skipped[0].reason === 'NO_POSITION', '宿主沒給座標的傳送點無法送 WALK_TO');
  const known = planPortalRoute(g, 'm-a', 'm-b', { knownPositions: new Set(['p']) });
  assert(known.ok, '起點圖的座標由快照補上時可走');
  const unk = planPortalRoute([node('m-a', [edge('a-b', 'm-b', 1, 1, 'UNKNOWN')]), node('m-b', [])], 'm-a', 'm-b');
  assert(unk.ok, '目的地圖狀態 UNKNOWN（宿主沒有世界目錄）仍可嘗試');
}

// ---- 導航器 ----------------------------------------------------------------------------------
type Sent = { id: string; cmd: PluginCommand };
function rig(startMap: string, graph: SnapshotPortalNode[]) {
  const sent: Sent[] = [];
  const timers: Array<{ ms: number; fn: () => void }> = [];
  const logs: string[] = [];
  let clock = 0;
  const dir = new Directory(null);
  dir.learnPortalGraph(graph);
  const snapOf = (mapId: string) => {
    const n = graph.find(g => g.mapId === mapId)!;
    return {
      mapId, mapName: n.name, npcs: [], nav: { portalGraph: undefined, reachableMaps: [] },
      exits: n.portals.map(p => ({ id: p.id, name: p.name, x: p.x ?? 0, y: p.y ?? 0, targetMapId: p.targetMapId, targetMapName: p.targetMapName })),
    };
  };
  const state: any = { snapshot: snapOf(startMap), location: { mapId: startMap, mapName: `圖${startMap}` }, character: { x: 0, y: 0 }, battle: null, dialog: null, shop: null };
  let n = 0;
  const nav = new AutoNavigator({
    state: () => state, send: c => { const id = `c${++n}`; sent.push({ id, cmd: c }); return id; },
    log: t => logs.push(t), after: (ms, fn) => { timers.push({ ms, fn }); return null; }, now: () => clock, dir, onChange: () => {},
  });
  const ev = (event: object): PluginMessage => ({ v: PROTOCOL_VERSION, characterId: 'c', ts: 1, kind: 'event', seq: 1, event } as never);
  const flush = () => { for (let i = timers.findIndex(t => t.ms === 0); i >= 0; i = timers.findIndex(t => t.ms === 0)) timers.splice(i, 1)[0].fn(); };
  const complete = (id: string, code: string) => { nav.onMessage(ev({ type: 'COMMAND_COMPLETED', commandId: id, outcome: code === 'ARRIVED' || code === 'MAP_CHANGED' ? 'DONE' : 'FAILED', code })); flush(); };
  const enter = (mapId: string) => {
    state.snapshot = snapOf(mapId); state.location = { mapId, mapName: `圖${mapId}` };
    nav.onMessage(ev({ type: 'LOCATION_CHANGED', mapId, mapName: `圖${mapId}`, fromMapId: null, x: 0, y: 0, cause: 'MAP_CHANGE' })); flush();
  };
  return { nav, sent, timers, logs, advance: (ms: number) => { clock += ms; }, state, complete, enter, ev, flush, snapOf };
}

suite('F5: 自動移動：逐段走傳送點、換圖後等場景再走下一段');
{
  const r = rig('m-a', world);
  r.nav.go({ kind: 'MAP', mapId: 'm-d', name: '終點' });
  assert(r.sent.length === 1 && r.sent[0].cmd.type === 'WALK_TO' && (r.sent[0].cmd as any).x === 10 && (r.sent[0].cmd as any).y === 10, '第一段：走到通往 m-b 的傳送點（座標來自傳送點圖）');
  assert(r.nav.getStatus().route.join() === 'm-a,m-b,m-d', '面板顯示整條路線');
  assert((r.nav.getStatus().skipped ?? []).some(t => t.includes('不存在')), '面板顯示跳過了通往不存在地圖的傳送點');
  r.complete('c1', 'MAP_CHANGED');
  assert(r.nav.getStatus().phase === 'WAIT_MAP' && r.sent.length === 1, '換圖後在新場景準備好之前不送下一段');
  r.enter('m-b');
  assert(r.sent.length === 2 && (r.sent[1].cmd as any).x === 12, '場景到了才送第二段（走到通往 m-d 的傳送點）');
  r.complete('c2', 'MAP_CHANGED');
  r.enter('m-d');
  assert(r.nav.getStatus().phase === 'DONE' && r.sent.length === 2, '到達目標地圖：完成，不多送指令');
}

suite('F5: 宿主還沒準備好（GAME_NOT_READY）時重試，有上限');
{
  const r = rig('m-a', world);
  r.nav.go({ kind: 'MAP', mapId: 'm-b', name: 'b' });
  r.nav.onMessage(r.ev({ type: 'COMMAND_REJECTED', commandId: 'c1', reasonCode: 'GAME_NOT_READY', message: '場景還在載入' }));
  assert(r.nav.getStatus().phase === 'WALKING' && r.timers.length > 0, '被拒 GAME_NOT_READY：排程重試，不算失敗');
  let guard = 0;
  while (r.nav.getStatus().phase !== 'FAILED' && guard++ < 500) {
    const t = r.timers.shift(); if (!t) break; t.fn();
    const last = r.sent[r.sent.length - 1];
    if (last && r.nav.getStatus().phase === 'WALKING') r.nav.onMessage(r.ev({ type: 'COMMAND_REJECTED', commandId: last.id, reasonCode: 'GAME_NOT_READY' }));
  }
  assert(r.nav.getStatus().phase === 'FAILED' && guard < 500, '一直沒準備好：到上限就失敗，不會無限重試');
}

suite('F5: 斷點與無路可走顯示原因，不空轉');
{
  const g = [node('m-a', [edge('a-b', 'm-b', 1, 1, 'NOT_IMPORTED')]), node('m-b', [])];
  const r = rig('m-a', g);
  r.nav.go({ kind: 'MAP', mapId: 'm-b', name: 'b' });
  const s = r.nav.getStatus();
  assert(s.phase === 'FAILED' && r.sent.length === 0, '只有斷點：不送任何 WALK_TO');
  assert(s.text.includes('不存在') && (s.skipped ?? []).length === 1, '失敗原因與略過清單都顯示出來');
  const r2 = rig('m-a', world);
  r2.nav.go({ kind: 'MAP', mapId: 'm-z', name: 'z' });
  assert(r2.nav.getStatus().phase === 'FAILED' && r2.sent.length === 0 && r2.nav.getStatus().text.includes('找不到'), '無路可走：直接失敗並說明');
}

suite('F5: 走不通的傳送點改走別條路');
{
  const r = rig('m-a', world);
  r.nav.go({ kind: 'MAP', mapId: 'm-d', name: 'd' });
  r.complete('c1', 'BLOCKED'); // 第一次：稍後重試
  r.timers.shift()?.fn();
  r.complete('c2', 'BLOCKED'); // 第二次：確定走不通
  const last = r.sent[r.sent.length - 1].cmd as any;
  assert(last.x === 20 && last.y === 20, '確定走不通後改走另一條路的第一個傳送點');
  assert(r.nav.getStatus().route.join() === 'm-a,m-c,m-e,m-d', '路線改成較長的那條');
}

suite('F5: 傳送點把人帶回原處也不會繞圈');
{
  const loop: SnapshotPortalNode[] = [node('m-a', [edge('a-b', 'm-b', 1, 1), edge('a-t', 'm-t', 9, 9)]), node('m-b', [edge('b-a', 'm-a', 2, 2)]), node('m-t', [])];
  // 規劃以為 a-t 通到 m-t，實際上每次都把人送到 m-a 與 m-b 之間來回。
  const r = rig('m-a', loop);
  r.nav.go({ kind: 'MAP', mapId: 'm-t', name: 't' });
  let i = 0;
  while (r.nav.isActive() && i++ < 200) {
    const last = r.sent[r.sent.length - 1];
    r.complete(last.id, 'MAP_CHANGED');
    r.enter(r.state.location.mapId === 'm-a' ? 'm-b' : 'm-a');
  }
  assert(r.nav.getStatus().phase === 'FAILED' && i < 200, '換圖次數有上限，超過就失敗');
}

suite('F5: 換圖後一直等不到場景會逾時');
{
  const r = rig('m-a', world);
  r.nav.go({ kind: 'MAP', mapId: 'm-d', name: 'd' });
  r.complete('c1', 'MAP_CHANGED');
  const wait = r.timers.find(t => t.ms >= 10000);
  assert(!!wait && r.nav.getStatus().phase === 'WAIT_MAP', '進入等待並排了逾時');
  wait!.fn();
  assert(r.nav.getStatus().phase === 'WAIT_MAP', '計時器提前觸發但實際時間未到：不誤殺');
  r.advance(30000);
  wait!.fn();
  assert(r.nav.getStatus().phase === 'FAILED', '逾時就失敗，不永遠等');
}

suite('F5: 宿主沒有世界目錄時退回舊做法（只用看過的出口）');
{
  const bare = [node('m-a', [edge('a-b', 'm-b', 5, 5, 'UNKNOWN')]), node('m-b', [])];
  const r = rig('m-a', bare);
  r.nav.go({ kind: 'MAP', mapId: 'm-b', name: 'b' });
  assert(r.sent.length === 1 && (r.sent[0].cmd as any).x === 5, '目的地圖狀態 UNKNOWN 仍照出口走');
}

done();
