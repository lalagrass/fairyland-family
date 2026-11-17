import fx from '../fixtures/replay_village.json';
import { isCommandResultMessage, isEventMessage, isHeartbeatMessage, isPluginMessage, isSnapshotMessage, PROTOCOL_VERSION, type PluginMessage } from '../src/protocol/index';
import { ReplayTransport, type ReplayFixture, type Scheduler } from '../src/transport/replay';
import { FamilyController } from '../src/controller';
import { assert, done, suite } from './helpers';

/** 手動推進時間的排程器。 */
function manual(): Scheduler & { advance(ms: number): void } {
  let t = 1_000_000;
  let id = 0;
  const q = new Map<number, { at: number; fn: () => void; every?: number }>();
  return {
    now: () => t,
    setTimeout: (fn, ms) => { q.set(++id, { at: t + ms, fn }); return id; },
    clearTimeout: h => { q.delete(h as number); },
    setInterval: (fn, ms) => { q.set(++id, { at: t + ms, fn, every: ms }); return id; },
    clearInterval: h => { q.delete(h as number); },
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const next = [...q.entries()].filter(([, e]) => e.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [k, e] = next;
        t = e.at;
        if (e.every) e.at += e.every; else q.delete(k);
        e.fn();
      }
      t = end;
    },
  };
}

const fixture = fx as unknown as ReplayFixture;

suite('replay transport plays the recorded sequence');
{
  const sch = manual();
  const got: PluginMessage[] = [];
  const tr = new ReplayTransport(fixture, { scheduler: sch });
  tr.start(m => got.push(m as PluginMessage));
  assert(got.length === 1 && isHeartbeatMessage(got[0]), 'a heartbeat is sent immediately');
  sch.advance(1000);
  assert(got.filter(isHeartbeatMessage).length >= 2, 'heartbeats keep coming every second');
  sch.advance(30000);
  assert(got.every(isPluginMessage), 'everything replayed passes the guards');
  const evTypes = got.filter(isEventMessage).map(m => m.event.type);
  assert(['GAME_STARTED', 'LOCATION_CHANGED', 'MOVED', 'DIALOG_OPENED', 'BATTLE_STARTED', 'GOLD_CHANGED'].every(t => evTypes.includes(t as never)), 'event types replayed');
  assert(got.filter(isSnapshotMessage).length === 2, 'two snapshots replayed (village, town)');
  const lastHb = got.filter(isHeartbeatMessage).pop()!;
  assert(lastHb.mapId === '20010', 'heartbeat tracks the replayed map');
  tr.stop();
  const n = got.length;
  sch.advance(5000);
  assert(got.length === n, 'stop() halts heartbeats and events');
}

suite('replay answers commands like the host');
{
  const sch = manual();
  const got: PluginMessage[] = [];
  const tr = new ReplayTransport(fixture, { scheduler: sch });
  tr.start(m => got.push(m as PluginMessage));
  const mk = (commandId: string, command: unknown) => ({ v: PROTOCOL_VERSION, characterId: fixture.characterId, ts: 0, kind: 'command', commandId, command }) as any;
  tr.send(mk('c0', { type: 'REQUEST_SNAPSHOT' }));
  const early = got.filter(isCommandResultMessage).find(r => r.commandId === 'c0');
  assert(early?.status === 'REJECTED' && early.reasonCode === 'GAME_NOT_READY', 'snapshot requested before any snapshot -> GAME_NOT_READY');
  sch.advance(1000);
  tr.send(mk('c1', { type: 'REQUEST_SNAPSHOT' }));
  const r1 = got.filter(isCommandResultMessage).find(r => r.commandId === 'c1');
  assert(r1?.status === 'ACCEPTED', 'REQUEST_SNAPSHOT accepted');
  assert(got.some(m => isSnapshotMessage(m) && m.reason === 'REQUESTED' && m.inReplyTo === 'c1'), 'snapshot reply carries inReplyTo');
  tr.send(mk('c2', { type: 'WALK_TO', mapId: '10001', x: 1, y: 2 }));
  const r2 = got.filter(isCommandResultMessage).find(r => r.commandId === 'c2');
  assert(r2?.status === 'REJECTED' && r2.reasonCode === 'NOT_IMPLEMENTED', 'WALK_TO -> NOT_IMPLEMENTED');
  assert(got.some(m => isEventMessage(m) && m.event.type === 'COMMAND_REJECTED' && m.event.commandId === 'c2'), 'COMMAND_REJECTED event too');
  tr.send(mk('c2', { type: 'WALK_TO', mapId: '10001', x: 1, y: 2 }));
  const dup = got.filter(isCommandResultMessage).filter(r => r.commandId === 'c2');
  assert(dup.length === 2 && dup[1].duplicate === true, 'resending a commandId returns the cached result flagged duplicate');
  tr.stop();
}

suite('controller on top of the replay: connected, snapshot, menu click is rejected in the log');
{
  const sch = manual();
  const tr = new ReplayTransport(fixture, { scheduler: sch });
  const c = new FamilyController(tr, { now: () => sch.now() });
  c.start();
  sch.advance(500);
  assert(c.status() === 'RUNNING', 'replay shows 遊戲執行中');
  sch.advance(1000);
  assert(c.state.snapshot?.mapId === '10001', 'snapshot arrives');
  assert(c.state.staticData !== null && c.state.staticData.recipes.length > 0, 'staticData arrives on connect');
  assert(c.state.log.some(l => l.tag === '送出' && l.text.includes('要求快照') && l.text.includes('includeStatic')), 'family asked for snapshot+staticData when connecting');
  const sdId = c.send({ type: 'REQUEST_STATIC_DATA' }, '要求靜態資料');
  assert(!!sdId && c.state.log.some(l => l.tag === '結果' && l.commandId === sdId && l.text.includes('已接受')), 'REQUEST_STATIC_DATA accepted in replay');
  const id = c.send({ type: 'TALK_TO_NPC', npcId: c.state.snapshot!.npcs[0].id }, '對話：測試');
  assert(!!id, 'command was sent');
  const res = c.state.log.find(l => l.tag === '結果' && l.commandId === id);
  assert(!!res && res.text.includes('NOT_IMPLEMENTED'), 'the rejection is shown in the log with the same commandId');
  sch.advance(30000);
  assert(c.state.snapshot?.mapId === '20010' && c.state.location?.mapId === '20010', 'family follows the map change in the replay');
  assert(c.state.log.some(l => l.tag === '事件' && l.text.includes('回合演出')), 'BATTLE_TIMELINE event logged');
  tr.stop();
}
done();
