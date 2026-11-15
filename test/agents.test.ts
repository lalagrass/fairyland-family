import { PROTOCOL_VERSION, type CommandMessage, type PluginMessage, type SceneSnapshot } from '../src/protocol/index';
import fx from '../fixtures/replay_village.json';
import { FamilyController } from '../src/controller';
import type { Transport } from '../src/transport/types';
import { assert, done, suite } from './helpers';

const snaps = (fx.steps as any[]).filter(s => s.message.kind === 'snapshot').map(s => s.message.snapshot as SceneSnapshot);
const village = snaps[0], town = snaps[1];
const B = { v: PROTOCOL_VERSION, characterId: 'c1' };

/** 一個很小的假遊戲：兩張圖、走路與換圖、對話、戰鬥回合；測試用 `script` 控制每個走路指令怎麼收場。 */
function harness(opts: { strategy?: 'ATTACK' | 'FLEE' } = {}) {
  let t = 1000;
  let seq = 1;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const sent: CommandMessage[] = [];
  let push: (m: unknown) => void = () => {};
  let map: SceneSnapshot = village;
  const script: Array<(cmd: CommandMessage) => 'AUTO' | 'ENCOUNTER' | 'BLOCKED'> = [];
  const store = new Map<string, string>();
  if (opts.strategy) store.set('family.strategy.v1', opts.strategy);
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  const ev = (event: unknown) => push({ ...B, ts: t, kind: 'event', seq: seq++, event } as PluginMessage);
  const result = (c: CommandMessage, status: 'ACCEPTED' | 'REJECTED', reasonCode?: string) => push({ ...B, ts: t, kind: 'command-result', commandId: c.commandId, status, ...(reasonCode ? { reasonCode } : {}) });
  const sendSnapshot = (reason: string) => push({ ...B, ts: t, kind: 'snapshot', seq: seq++, reason, snapshot: map });
  const completed = (c: CommandMessage, code: string, outcome = 'DONE') => ev({ type: 'COMMAND_COMPLETED', commandId: c.commandId, outcome, code });
  const transport: Transport = {
    name: 'fake-game', start: cb => { push = cb; }, stop: () => {},
    send(cmd) {
      sent.push(cmd);
      const c = cmd.command;
      if (c.type === 'REQUEST_SNAPSHOT') { result(cmd, 'ACCEPTED'); sendSnapshot('REQUESTED'); return; }
      if (c.type === 'WALK_TO') {
        if (c.mapId !== map.mapId) { result(cmd, 'REJECTED', 'WRONG_MAP'); return; }
        result(cmd, 'ACCEPTED');
        const how = script.shift()?.(cmd) ?? 'AUTO';
        if (how === 'ENCOUNTER') { ev({ type: 'BATTLE_STARTED', battleId: 1, mapId: map.mapId, enemies: [{ id: 'e', name: '波姆', level: 1 }] }); completed(cmd, 'ENCOUNTER', 'INTERRUPTED'); ev({ type: 'BATTLE_TURN_READY', battleId: 1, round: 1, enemies: [{ slot: 0, id: 'e', name: '波姆', hp: 3, maxHp: 3 }], canFlee: true }); return; }
        if (how === 'BLOCKED') { completed(cmd, 'BLOCKED', 'FAILED'); return; }
        const exit = map.exits.find(e => e.x === c.x && e.y === c.y);
        if (exit && exit.targetMapId === town.mapId) {
          map = town;
          ev({ type: 'LOCATION_CHANGED', mapId: town.mapId, mapName: town.mapName, fromMapId: village.mapId, x: 1040, y: 500, cause: 'MAP_CHANGE' });
          sendSnapshot('MAP_CHANGED');
          completed(cmd, 'MAP_CHANGED', 'INTERRUPTED');
        } else { ev({ type: 'MOVED', mapId: map.mapId, x: c.x, y: c.y, dir: 2 }); completed(cmd, 'ARRIVED'); }
        return;
      }
      if (c.type === 'TALK_TO_NPC') {
        const n = map.npcs.find(x => x.id === c.npcId)!;
        result(cmd, 'ACCEPTED');
        ev({ type: 'DIALOG_OPENED', npcId: n.id, npcName: n.name, role: n.role, lines: ['你好'], options: [{ id: 'CLOSE', label: '告辭' }], optionsAvailable: true });
        completed(cmd, 'DIALOG_OPENED');
        return;
      }
      if (c.type === 'BATTLE_FLEE') { result(cmd, 'ACCEPTED'); ev({ type: 'BATTLE_ENDED', battleId: 1, outcome: 'FLEE' }); completed(cmd, 'FLED'); return; }
      if (c.type === 'BATTLE_ACTION') { result(cmd, 'ACCEPTED'); completed(cmd, 'TURN_SUBMITTED'); ev({ type: 'BATTLE_ENDED', battleId: 1, outcome: 'WIN' }); return; }
      if (c.type === 'CHOOSE_DIALOG_OPTION') { result(cmd, 'ACCEPTED'); completed(cmd, 'DONE'); return; }
      result(cmd, 'REJECTED', 'NOT_IMPLEMENTED');
    },
  };
  const c = new FamilyController(transport, {
    now: () => t, storage,
    after: (ms, fn) => { timers.push({ at: t + ms, fn }); },
  });
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      t = Math.max(t, next.at);
      next.fn();
    }
    t = end;
  };
  c.start();
  push({ ...B, ts: t, kind: 'heartbeat', sessionId: 's1', seq: seq++, mapId: map.mapId, phase: 'PLAYING', inBattle: false });
  c.tick();
  advance(10);
  push({ ...B, ts: t, kind: 'heartbeat', sessionId: 's1', seq: seq++, mapId: map.mapId, phase: 'PLAYING', inBattle: false });
  return { c, sent, script, advance, ev, heartbeat: () => push({ ...B, ts: t, kind: 'heartbeat', sessionId: 's1', seq: seq++, mapId: map.mapId, phase: 'PLAYING', inBattle: false }), setMapTown: () => { map = town; } };
}

const types = (h: ReturnType<typeof harness>) => h.sent.map(m => m.command.type);

suite('navigator: 前往 村長 across maps (route + walk legs + talk)');
{
  const h = harness();
  assert(h.c.state.snapshot?.mapId === '10001', 'connected and snapshot received');
  const err = h.c.parseAndSend('前往 村長');
  assert(err === null, '前往 村長 is accepted from the village (村長 only known via directory)');
  h.advance(50); h.heartbeat();
  const t = types(h).filter(x => x !== 'REQUEST_SNAPSHOT');
  assert(t[0] === 'WALK_TO' && t.includes('TALK_TO_NPC'), 'walk leg to the exit, then (after the map change) approach and talk');
  const walks = h.sent.filter(m => m.command.type === 'WALK_TO').map(m => m.command as any);
  assert(walks[0].mapId === '10001' && walks[walks.length - 1].mapId === '20010', 'first leg is on the village map, last on the town map (never cross-map in one command)');
  assert(h.c.navStatus().phase === 'DONE' && h.c.state.dialog?.npcName === '村長傑夫', 'ends DONE with the chief dialog open');
  assert(h.c.state.log.some(l => l.tag === '結果' && l.text.includes('預期 MAP_CHANGED／實際 MAP_CHANGED')), 'log shows 預期 vs 實際');
}

suite('navigator: encounter pauses, battle end resumes');
{
  const h = harness();
  h.script.push(() => 'ENCOUNTER');
  h.c.parseAndSend('前往 村長');
  h.advance(50);
  assert(h.c.navStatus().phase === 'PAUSED_BATTLE', 'ENCOUNTER pauses navigation');
  const before = h.sent.length;
  h.advance(5000);
  assert(h.sent.length === before, 'nothing is sent while the battle is running (manual strategy does nothing)');
  h.heartbeat();
  h.c.parseAndSend('逃跑');
  h.advance(3000);
  assert(h.c.navStatus().phase === 'DONE' && h.c.state.dialog?.npcName === '村長傑夫', 'after the battle ends the navigator continues and talks to 村長');
}

suite('navigator: re-dispatch / cancel invalidate the old arrival handler');
{
  const h = harness();
  // 讓第一段走路「懸著」：不自動完成
  let held: CommandMessage | null = null;
  h.script.push(cmd => { held = cmd; return 'BLOCKED'; });
  h.c.parseAndSend('前往 村長');
  h.advance(50);
  assert(h.c.navStatus().phase === 'FAILED', 'BLOCKED fails the navigation with a reason');
  assert(h.c.navStatus().text.includes('BLOCKED'), 'failure text names the code');
  assert(!!held, 'sanity');
  // 重新派發後，舊指令的完成事件不得推進新的導航
  const h2 = harness();
  h2.c.parseAndSend('前往 村長');
  const idOld = h2.sent.filter(m => m.command.type === 'WALK_TO')[0].commandId;
  h2.c.parseAndSend('前往 村長');
  const walksBefore = h2.sent.filter(m => m.command.type === 'WALK_TO').length;
  h2.ev({ type: 'COMMAND_COMPLETED', commandId: idOld, outcome: 'DONE', code: 'ARRIVED' });
  assert(h2.sent.filter(m => m.command.type === 'WALK_TO').length === walksBefore, 'a stale COMMAND_COMPLETED does not trigger another step');
  const h3 = harness();
  h3.script.push(() => 'ENCOUNTER');
  h3.c.parseAndSend('前往 村長');
  h3.c.parseAndSend('停止導航');
  assert(h3.c.navStatus().phase === 'CANCELLED', 'cancel sets CANCELLED');
  h3.advance(5000);
  assert(!types(h3).includes('TALK_TO_NPC'), 'cancelled navigation never talks');
}

suite('navigator: GAME_BUSY is retried, other rejections fail');
{
  const h = harness();
  const orig = (h.c as any).transport.send.bind((h.c as any).transport);
  let busy = 2;
  (h.c as any).transport.send = (cmd: CommandMessage) => {
    if (cmd.command.type === 'WALK_TO' && busy > 0) {
      busy--; h.sent.push(cmd);
      h.ev({ type: 'COMMAND_REJECTED', commandId: cmd.commandId, reasonCode: 'GAME_BUSY' });
      return;
    }
    orig(cmd);
  };
  h.c.parseAndSend('前往 村長');
  h.advance(4000);
  assert(h.c.navStatus().phase === 'DONE', 'two GAME_BUSY rejections are retried until it works');
}

suite('auto-battler: strategies');
{
  const h = harness();
  h.setMapTown();
  h.ev({ type: 'BATTLE_STARTED', battleId: 1, mapId: '20010', enemies: [{ id: 'e', name: '波姆', level: 1 }] });
  h.ev({ type: 'BATTLE_TURN_READY', battleId: 1, round: 1, enemies: [{ slot: 0, id: 'e', name: '波姆', hp: 3, maxHp: 3 }], canFlee: true });
  h.advance(2000);
  assert(h.c.strategy() === 'MANUAL' && !types(h).includes('BATTLE_FLEE') && !types(h).includes('BATTLE_ACTION'), 'default MANUAL: nothing is sent');
}
{
  const h = harness({ strategy: 'FLEE' });
  h.ev({ type: 'BATTLE_STARTED', battleId: 1, mapId: '10001', enemies: [{ id: 'e', name: '波姆', level: 1 }] });
  h.ev({ type: 'BATTLE_TURN_READY', battleId: 1, round: 1, enemies: [{ slot: 0, id: 'e', name: '波姆', hp: 3, maxHp: 3 }], canFlee: true });
  h.ev({ type: 'BATTLE_TURN_READY', battleId: 1, round: 1, enemies: [{ slot: 0, id: 'e', name: '波姆', hp: 3, maxHp: 3 }], canFlee: true });
  h.advance(100);
  assert(types(h).filter(x => x === 'BATTLE_FLEE').length === 1, 'FLEE strategy flees exactly once per (battle, round) even if TURN_READY repeats');
}
{
  const h = harness({ strategy: 'ATTACK' });
  h.ev({ type: 'BATTLE_STARTED', battleId: 1, mapId: '10001', enemies: [{ id: 'e', name: '波姆', level: 1 }] });
  h.ev({ type: 'BATTLE_TURN_READY', battleId: 1, round: 1, enemies: [{ slot: 4, id: 'e', name: '波姆', hp: 3, maxHp: 3 }], canFlee: true });
  h.advance(1000);
  const a = h.sent.find(m => m.command.type === 'BATTLE_ACTION')?.command as any;
  assert(a?.action.kind === 'ATTACK' && a.action.targetSlot === 4 && a.battleId === 1, 'ATTACK strategy attacks the first enemy slot');
  assert(h.sent.some(m => m.command.type === 'CHOOSE_DIALOG_OPTION' && (m.command as any).optionId === 'RETURN_TO_MAP'), 'after a WIN a non-manual strategy closes the victory window');
  h.c.battler.setStrategy('MANUAL');
  assert(h.c.strategy() === 'MANUAL', 'strategy can be switched back');
}
done();
