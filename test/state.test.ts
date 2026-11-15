import { PROTOCOL_VERSION, HEARTBEAT_TIMEOUT_MS, type PluginMessage } from '../src/protocol/index';
import ex from '../src/protocol/examples.json';
import { applyMessage, applySent, connectionStatus, initialState } from '../src/state';
import { FamilyController } from '../src/controller';
import type { Transport } from '../src/transport/types';
import { assert, done, suite } from './helpers';

const B = { v: PROTOCOL_VERSION, characterId: 'c1' };
const hb = (sessionId = 's1', mapId: string | null = '10001'): PluginMessage => ({ ...B, ts: 0, kind: 'heartbeat', sessionId, seq: 1, mapId, phase: 'PLAYING', inBattle: false });
const evt = (event: unknown): PluginMessage => ({ ...B, ts: 0, kind: 'event', seq: 1, event } as PluginMessage);

suite('connection status from heartbeat');
{
  let s = initialState();
  assert(connectionStatus(s, 0) === 'STOPPED', 'no heartbeat -> 遊戲未執行');
  s = applyMessage(s, hb(), 1000);
  assert(connectionStatus(s, 1000) === 'RUNNING' && connectionStatus(s, 1000 + HEARTBEAT_TIMEOUT_MS) === 'RUNNING', 'running within timeout');
  assert(connectionStatus(s, 1000 + HEARTBEAT_TIMEOUT_MS + 1) === 'STOPPED', 'stopped after heartbeat timeout');
  s = applyMessage(s, evt({ type: 'GAME_STOPPED', sessionId: 's1', reason: 'PAGE_HIDE' }), 1500);
  assert(connectionStatus(s, 1600) === 'STOPPED', 'GAME_STOPPED stops immediately');
  s = applyMessage(s, hb('s1'), 1700);
  assert(connectionStatus(s, 1700) === 'STOPPED', 'late heartbeat of the stopped session is ignored');
  s = applyMessage(s, hb('s2'), 2000);
  assert(connectionStatus(s, 2000) === 'RUNNING', 'a new session (game reopened) is running');
  assert(s.log.some(l => l.tag === '連線' && l.text === '遊戲執行中'), 'connection change is logged');
}

suite('events and snapshots update the mirror');
{
  let s = applyMessage(initialState(), hb(), 0);
  s = applyMessage(s, { ...ex.snapshot, characterId: 'c1' }, 10);
  assert(s.snapshot?.mapId === '10001' && s.character?.gold === 1200 && s.location?.mapName === '吉恩村', 'snapshot sets scene, character, location');
  s = applyMessage(s, evt({ type: 'MOVED', mapId: '10001', x: 5, y: 6, dir: 3 }), 20);
  assert(s.character?.x === 5 && s.character?.y === 6, 'MOVED updates position');
  s = applyMessage(s, evt({ type: 'GOLD_CHANGED', gold: 1500, delta: 300 }), 30);
  assert(s.character?.gold === 1500, 'GOLD_CHANGED updates gold');
  s = applyMessage(s, evt({ type: 'DIALOG_OPENED', npcId: 'n', npcName: '阿爾', role: null, lines: ['hi'], options: [], optionsAvailable: false }), 40);
  assert(s.dialog?.npcName === '阿爾', 'dialog opened');
  s = applyMessage(s, evt({ type: 'LOCATION_CHANGED', mapId: '20010', mapName: '市鎮中心', fromMapId: '10001', x: 1, y: 2, cause: 'MAP_CHANGE' }), 50);
  assert(s.location?.mapId === '20010' && s.dialog === null && s.snapshot?.mapId === '10001', 'map change updates location, closes dialog, keeps old snapshot until the new one arrives');
  s = applyMessage(s, evt({ type: 'BATTLE_STARTED', battleId: 3, mapId: '20010', enemies: [{ id: 'a', name: '波姆', level: 1 }] }), 60);
  assert(s.battle?.battleId === 3 && s.character?.inBattle === true, 'battle started');
  s = applyMessage(s, evt({ type: 'BATTLE_ENDED', battleId: 3, outcome: 'WIN' }), 70);
  assert(s.battle === null && s.character?.inBattle === false, 'battle ended');
  const logLen = s.log.length;
  s = applyMessage(s, { not: 'a message' }, 80);
  assert(s.log.length === logLen, 'garbage messages are ignored');
  s = applyMessage(s, { ...B, v: 9, ts: 0, kind: 'event', seq: 1, event: { type: 'GAME_STARTED', sessionId: 'x' } }, 90);
  assert(s.log[s.log.length - 1].level === 'warn', 'incompatible version is logged as a warning');
}

suite('commands: pending, results, log with commandId');
{
  let s = applyMessage(initialState(), hb(), 0);
  const cmd = { ...B, ts: 5, kind: 'command' as const, commandId: 'fam-x-0001', command: { type: 'TALK_TO_NPC' as const, npcId: 'n1' } };
  s = applySent(s, cmd, '對話：阿爾', 5);
  assert(!!s.pending['fam-x-0001'] && s.log[s.log.length - 1].commandId === 'fam-x-0001', 'sent command is pending and logged with its commandId');
  s = applyMessage(s, { ...B, ts: 6, kind: 'command-result', commandId: 'fam-x-0001', status: 'REJECTED', reasonCode: 'WRONG_MAP' }, 6);
  const last = s.log[s.log.length - 1];
  assert(!s.pending['fam-x-0001'] && last.tag === '結果' && last.level === 'warn' && last.text.includes('WRONG_MAP') && last.commandId === 'fam-x-0001', 'rejected result shown in the log and clears pending');
}

suite('controller refuses to send while the game is not running');
{
  const sent: unknown[] = [];
  let push: (r: unknown) => void = () => {};
  const tr: Transport = { name: 'fake', start: cb => { push = cb; }, send: m => { sent.push(m); }, stop: () => {} };
  let t = 0;
  const c = new FamilyController(tr, { now: () => t });
  c.start();
  assert(c.send({ type: 'REQUEST_SNAPSHOT' }, 'x') === null && sent.length === 0, 'no heartbeat -> nothing sent');
  push(hb());
  c.tick();
  assert(c.status() === 'RUNNING', 'running after heartbeat');
  assert(sent.length === 1 && (sent[0] as any).command.type === 'REQUEST_SNAPSHOT', 'snapshot is requested automatically on connect');
  const id = c.send({ type: 'WALK_TO', mapId: '10001', x: 1, y: 2 }, '走');
  assert(typeof id === 'string' && sent.length === 2 && (sent[1] as any).commandId === id && (sent[1] as any).characterId === 'c1', 'command carries commandId and characterId');
  t += 5000;
  c.tick();
  assert(c.status() === 'STOPPED' && c.state.log.some(l => l.text === '遊戲未執行'), 'heartbeat timeout -> 遊戲未執行');
  assert(c.send({ type: 'BATTLE_FLEE' }, '逃') === null && sent.length === 2, 'not sent after the game stopped');
}

suite('v2 state: dialog options, shop, inventory, battle, 預期 vs 實際');
{
  let s = applyMessage(initialState(), hb(), 0);
  s = applyMessage(s, { ...ex.snapshot, characterId: 'c1' }, 10);
  s = applyMessage(s, evt({ type: 'DIALOG_OPENED', npcId: 'n', npcName: '村長傑夫', role: 'CHIEF', lines: ['hi'], options: [{ id: 'ENABLE_DEMO_MODE', label: '啟用' }], optionsAvailable: true }), 20);
  assert(s.dialog?.options[0].id === 'ENABLE_DEMO_MODE', 'dialog keeps its options');
  s = applyMessage(s, evt({ type: 'DIALOG_UPDATED', npcId: 'n', lines: ['again'], options: [{ id: 'ACCEPT_QUEST:1', label: '接受' }] }), 21);
  assert(s.dialog?.options[0].id === 'ACCEPT_QUEST:1' && s.dialog.lines[0] === 'again', 'DIALOG_UPDATED replaces lines and options');
  s = applyMessage(s, evt({ type: 'SHOP_OPENED', npcId: 'n2', npcName: '阿利', goods: [{ itemId: 1, name: '藥', price: 5 }] }), 22);
  assert(s.shop?.goods.length === 1, 'shop opened');
  s = applyMessage(s, evt({ type: 'SHOP_CLOSED', npcId: 'n2' }), 23);
  assert(s.shop === null, 'shop closed');
  s = applyMessage(s, evt({ type: 'INVENTORY_CHANGED', changes: [{ itemId: 999, delta: 2, count: 2 }] }), 24);
  assert(s.inventory.some(i => i.itemId === 999 && i.count === 2), 'INVENTORY_CHANGED adds a new stack');
  s = applyMessage(s, evt({ type: 'INVENTORY_CHANGED', changes: [{ itemId: 999, delta: -2, count: 0 }] }), 25);
  assert(!s.inventory.some(i => i.itemId === 999), 'a stack that reaches 0 is removed');
  s = applyMessage(s, evt({ type: 'BATTLE_STARTED', battleId: 4, mapId: '10001', enemies: [{ id: 'a', name: '波姆', level: 1 }] }), 30);
  s = applyMessage(s, evt({ type: 'BATTLE_TURN_READY', battleId: 4, round: 1, enemies: [{ slot: 1, id: 'a', name: '波姆', hp: 5, maxHp: 5 }], canFlee: true }), 31);
  assert(s.battle?.ready === true && s.battle.enemyStates[0].slot === 1, 'turn ready exposes enemy slots');
  const flee = { ...B, ts: 32, kind: 'command' as const, commandId: 'fam-x-0009', command: { type: 'BATTLE_FLEE' as const } };
  s = applySent(s, flee, '逃跑', 32);
  assert(s.battle?.ready === false && s.pending['fam-x-0009'].expect === 'FLED', 'sending a battle action closes the turn and records the expectation');
  s = applyMessage(s, { ...B, ts: 33, kind: 'command-result', commandId: 'fam-x-0009', status: 'ACCEPTED' }, 33);
  assert(!!s.inflight['fam-x-0009'], 'accepted command waits for completion');
  s = applyMessage(s, evt({ type: 'COMMAND_COMPLETED', commandId: 'fam-x-0009', outcome: 'DONE', code: 'FLEE_FAILED' }), 34);
  const done1 = s.log[s.log.length - 1];
  assert(!s.inflight['fam-x-0009'] && done1.text.includes('預期 FLED') && done1.text.includes('實際 FLEE_FAILED') && done1.level === 'warn', 'mismatch between expected and actual is logged as a warning');
  const walk = { ...B, ts: 40, kind: 'command' as const, commandId: 'fam-x-0010', command: { type: 'WALK_TO' as const, mapId: '10001', x: 1, y: 1 } };
  s = applyMessage(applySent(s, walk, '走', 40), { ...B, ts: 41, kind: 'command-result', commandId: 'fam-x-0010', status: 'ACCEPTED' }, 41);
  s = applyMessage(s, evt({ type: 'COMMAND_COMPLETED', commandId: 'fam-x-0010', outcome: 'DONE', code: 'ARRIVED' }), 42);
  assert(s.log[s.log.length - 1].text.includes('✓') && s.log[s.log.length - 1].level === 'info', 'matching result is logged with a check mark');
  s = applyMessage(s, evt({ type: 'BATTLE_ENDED', battleId: 4, outcome: 'WIN' }), 50);
  assert(s.battleResult === 'VICTORY', 'WIN opens the victory result window');
  const ret = { ...B, ts: 51, kind: 'command' as const, commandId: 'fam-x-0011', command: { type: 'CHOOSE_DIALOG_OPTION' as const, optionId: 'RETURN_TO_MAP' } };
  assert(applySent(s, ret, '關窗', 51).battleResult === null, 'sending RETURN_TO_MAP closes the result window locally');
}

suite('battle statuses & player/pet summaries in state');
{
  let s = applyMessage(initialState(), hb(), 0);
  s = applyMessage(s, { ...ex.snapshot, characterId: 'c1' }, 10);
  s = applyMessage(s, evt({
    type: 'BATTLE_TURN_READY',
    battleId: 9,
    round: 2,
    canFlee: true,
    enemies: [{ slot: 0, id: 'e0', name: '軟軟史萊姆', hp: 12, maxHp: 20, isChanting: true, statuses: [{ type: 'POISON', duration: 2, stacks: 1 }] }],
    player: { id: 'p1', name: '阿草', hp: 65, maxHp: 100, mp: 30, maxMp: 50, isDefending: false, isChanting: false, statuses: [{ type: 'ATK_UP', duration: 3, value: 20 }] },
    pet: { id: 'pet1', name: '土來姆', hp: 35, maxHp: 45, mp: 18, maxMp: 20, isDefending: true, statuses: [{ type: 'SHIELD', duration: 2, value: 10 }] },
  }), 20);
  assert(s.battle?.player?.statuses?.[0]?.type === 'ATK_UP', 'BATTLE_TURN_READY saves player statuses');
  assert(s.battle?.pet?.name === '土來姆' && s.battle.pet.isDefending === true, 'BATTLE_TURN_READY saves active pet summary');
  assert(s.battle?.enemyStates[0]?.statuses?.[0]?.type === 'POISON' && s.battle.enemyStates[0].isChanting === true, 'BATTLE_TURN_READY saves enemy statuses');
  assert(s.character?.hp === 65 && s.character?.statuses?.[0]?.type === 'ATK_UP' && s.character?.activePet?.name === '土來姆', 'character synced from BATTLE_TURN_READY');
  s = applyMessage(s, evt({ type: 'BATTLE_ENDED', battleId: 9, outcome: 'WIN' }), 30);
  assert(s.battle === null && s.character?.statuses?.length === 0 && !s.character?.isDefending, 'BATTLE_ENDED clears transient battle statuses');
}
done();
