import { PROTOCOL_VERSION, type CommandMessage, type PluginMessage, type SceneSnapshot, type SnapshotFamilyMember } from '../src/protocol/index';
import fx from '../fixtures/replay_village.json';
import { FamilyController } from '../src/controller';
import { parseInput } from '../src/parse';
import { initialState, applyMessage } from '../src/state';
import { Directory } from '../src/directory';
import type { Transport } from '../src/transport/types';
import { assert, done, suite } from './helpers';

const baseVillage = (fx.steps as any[]).find(s => s.message.kind === 'snapshot').message.snapshot as SceneSnapshot;

function makeP4Snapshot(activeId: 'char_1' | 'char_2' | 'char_3' = 'char_1'): SceneSnapshot {
  const members: SnapshotFamilyMember[] = [
    {
      characterId: 'char_1',
      name: '愛麗絲',
      level: 30,
      mapId: '10001',
      mapName: '吉恩村',
      region: { regionId: 'r-start', name: '起始村' },
      x: 3880,
      y: 3740,
      gold: 5000,
      satiety: 100,
      inventoryCount: 1,
      inventoryCap: 40,
      inBattle: false,
      inventory: [{ itemId: 10234, name: '青銅礦', count: 3 }],
      workSkills: {},
    },
    {
      characterId: 'char_2',
      name: '小石',
      level: 10,
      mapId: '10001',
      mapName: '吉恩村',
      region: { regionId: 'r-start', name: '起始村' },
      x: 3560,
      y: 3880,
      gold: 2000,
      satiety: 100,
      inventoryCount: 1,
      inventoryCap: 40,
      inBattle: false,
      inventory: [{ itemId: 51005, name: '十字鎬', count: 1 }],
      workSkills: { 5: 5, 10: 5, 11: 5 },
    },
    {
      characterId: 'char_3',
      name: '阿花',
      level: 10,
      mapId: '10001',
      mapName: '吉恩村',
      region: { regionId: 'r-start', name: '起始村' },
      x: 3920,
      y: 3760,
      gold: 2000,
      satiety: 100,
      inventoryCount: 0,
      inventoryCap: 40,
      inBattle: false,
      inventory: [],
      workSkills: { 1: 5, 2: 5 },
    },
  ];
  const active = members.find(m => m.characterId === activeId)!;
  return {
    ...baseVillage,
    character: {
      ...baseVillage.character,
      name: active.name,
      level: active.level,
      gold: active.gold,
      x: active.x,
      y: active.y,
      satiety: active.satiety,
      maxSatiety: 100,
      inventoryCount: active.inventoryCount,
      inventoryCap: active.inventoryCap,
      workSkills: active.workSkills,
    },
    inventory: active.inventory,
    family: {
      activeCharacterId: activeId,
      maxSlots: 5,
      members,
      warehouse: {
        gold: 1000,
        cap: 200,
        items: [{ itemId: 51005, name: '十字鎬', count: 1 }],
      },
    },
    gatherPoints: {
      status: 'AVAILABLE',
      points: [
        {
          id: 'gather_10001_starter_mine',
          name: '吉恩村 採礦點#1',
          mapId: '10001',
          mapName: '吉恩村',
          x: 3560,
          y: 3880,
          skillId: 5,
          skillName: '挖礦',
          requiredToolItemId: 51005,
          requiredToolName: '十字鎬',
          materials: [
            { itemId: 10201, name: '煤', reqLevel: 1 },
            { itemId: 10234, name: '青銅礦', reqLevel: 5 },
          ],
        },
      ],
    },
  };
}

suite('P4 parseInput: character prefix, SWITCH_VIEW_CHARACTER, warehouse');
{
  const snap = makeP4Snapshot('char_1');
  const members = snap.family!.members;
  const warehouse = snap.family!.warehouse;
  const dir = new Directory(null);
  dir.learn(snap);
  const pCtx = { members, warehouse, findNpc: (q: string) => dir.findNpc(q), findMap: (q: string) => dir.findMap(q) };

  const pGather = parseInput('小石 採集 青銅礦 2', snap, pCtx);
  if (!pGather.ok) throw new Error(pGather.error);
  assert(pGather.action.kind === 'QUEUE_GATHER', 'expected QUEUE_GATHER');
  if (pGather.action.kind === 'QUEUE_GATHER') {
    assert(pGather.action.targetCharacterId === 'char_2', `expected char_2, got ${pGather.action.targetCharacterId}`);
    assert(pGather.action.count === 2, 'expected count 2');
  }

  const pStop = parseInput('阿花 停止工作', snap, pCtx);
  if (!pStop.ok) throw new Error(pStop.error);
  assert(pStop.action.kind === 'QUEUE_STOP' && pStop.action.targetCharacterId === 'char_3', 'expected QUEUE_STOP for char_3');

  const pSwitch = parseInput('切換視角 小石', snap, pCtx);
  if (!pSwitch.ok) throw new Error(pSwitch.error);
  assert(pSwitch.action.kind === 'COMMAND' && pSwitch.action.command.type === 'SWITCH_VIEW_CHARACTER', 'expected SWITCH_VIEW_CHARACTER');
  if (pSwitch.action.kind === 'COMMAND' && pSwitch.action.command.type === 'SWITCH_VIEW_CHARACTER') {
    assert(pSwitch.action.command.characterId === 'char_2', 'expected target char_2');
  }

  const pDepGold = parseInput('存倉 1000 金', snap, pCtx);
  if (!pDepGold.ok) throw new Error(pDepGold.error);
  assert(
    pDepGold.action.kind === 'COMMAND' &&
      pDepGold.action.command.type === 'WAREHOUSE_DEPOSIT' &&
      pDepGold.action.command.gold === 1000,
    'deposit 1000 gold',
  );

  const pWithItem = parseInput('小石 取倉 十字鎬 1', snap, pCtx);
  if (!pWithItem.ok) throw new Error(pWithItem.error);
  assert(
    pWithItem.action.kind === 'COMMAND' &&
      pWithItem.action.targetCharacterId === 'char_2' &&
      pWithItem.action.command.type === 'WAREHOUSE_WITHDRAW' &&
      pWithItem.action.command.itemId === 51005 &&
      pWithItem.action.command.count === 1,
    'withdraw itemId 51005 ×1 for char_2',
  );

  const pDepItem = parseInput('存倉 青銅礦 2', snap, pCtx);
  if (!pDepItem.ok) throw new Error(pDepItem.error);
  assert(
    pDepItem.action.kind === 'COMMAND' &&
      pDepItem.action.command.type === 'WAREHOUSE_DEPOSIT' &&
      pDepItem.action.command.itemId === 10234 &&
      pDepItem.action.command.count === 2,
    'deposit itemId 10234 ×2',
  );
}

suite('P4 state: family members, warehouse, character switch events');
{
  let s = initialState();
  const snap = makeP4Snapshot('char_1');
  s = applyMessage(s, {
    v: PROTOCOL_VERSION, characterId: 'char_1', ts: 1000, kind: 'snapshot', seq: 1, reason: 'STARTED', snapshot: snap,
  }, 1000);
  assert(s.members.length === 3, '3 members loaded');
  assert(s.activeCharacterId === 'char_1', 'activeCharacterId char_1');
  assert(s.warehouse?.gold === 1000 && s.warehouse.cap === 200, 'warehouse loaded');

  s = applyMessage(s, {
    v: PROTOCOL_VERSION, characterId: 'char_1', ts: 1010, kind: 'event', seq: 2,
    event: { type: 'WAREHOUSE_CHANGED', gold: 1500, items: [{ itemId: 51005, name: '十字鎬', count: 1 }, { itemId: 10234, name: '青銅礦', count: 2 }] },
  }, 1010);
  assert(s.warehouse?.gold === 1500 && s.warehouse.items.length === 2, 'WAREHOUSE_CHANGED updates warehouse');
  assert(s.members.length === 3, 'members preserved across WAREHOUSE_CHANGED');

  s = applyMessage(s, {
    v: PROTOCOL_VERSION, characterId: 'char_2', ts: 1020, kind: 'event', seq: 3,
    event: { type: 'ACTIVE_CHARACTER_CHANGED', characterId: 'char_2' },
  }, 1020);
  assert(s.activeCharacterId === 'char_2', 'activeCharacterId switched to char_2');
  assert(s.characterId === 'char_2', 'state.characterId updated to char_2');
  assert(s.members.length === 3 && s.warehouse?.gold === 1500, 'members and warehouse preserved on switch');
}

suite('P4 controller: background member WorkQueue & SWITCH_VIEW_CHARACTER');
{
  let t = 2000;
  let seq = 1;
  let snap = makeP4Snapshot('char_1');
  const timers: Array<{ at: number; fn: () => void }> = [];
  const sent: CommandMessage[] = [];
  let push: (m: unknown) => void = () => {};
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };

  const sendEv = (charId: string, event: unknown) =>
    push({ v: PROTOCOL_VERSION, characterId: charId, ts: t, kind: 'event', seq: seq++, event } as PluginMessage);
  const sendRes = (c: CommandMessage, status: 'ACCEPTED' | 'REJECTED') =>
    push({ v: PROTOCOL_VERSION, characterId: c.characterId, ts: t, kind: 'command-result', commandId: c.commandId, status });
  const sendSnap = (charId: string, reason: 'STARTED' | 'REQUESTED' | 'SCENE_RELOADED' = 'STARTED') =>
    push({ v: PROTOCOL_VERSION, characterId: charId, ts: t, kind: 'snapshot', seq: seq++, reason, snapshot: snap });

  const transport: Transport = {
    name: 'fake-p4',
    start: cb => { push = cb; },
    stop: () => {},
    send(cmd) {
      sent.push(cmd);
      const c = cmd.command;
      if (c.type === 'REQUEST_SNAPSHOT') {
        sendRes(cmd, 'ACCEPTED');
        sendSnap(snap.family!.activeCharacterId, 'REQUESTED');
        return;
      }
      if (c.type === 'WORK_ONCE') {
        sendRes(cmd, 'ACCEPTED');
        const m = snap.family!.members.find(x => x.characterId === cmd.characterId)!;
        const idx = m.inventory.findIndex(it => it.itemId === 10234);
        if (idx >= 0) m.inventory[idx] = { ...m.inventory[idx], count: m.inventory[idx].count + 1 };
        else m.inventory.push({ itemId: 10234, name: '青銅礦', count: 1 });
        m.inventoryCount += 1;
        m.satiety = Math.max(0, m.satiety - 1);
        sendEv(cmd.characterId, { type: 'INVENTORY_CHANGED', changes: [{ itemId: 10234, delta: 1, count: m.inventory.find(it => it.itemId === 10234)!.count }] });
        sendEv(cmd.characterId, { type: 'COMMAND_COMPLETED', commandId: cmd.commandId, outcome: 'DONE', code: 'DONE' });
        return;
      }
      if (c.type === 'SWITCH_VIEW_CHARACTER') {
        sendRes(cmd, 'ACCEPTED');
        snap = makeP4Snapshot(c.characterId as 'char_1' | 'char_2' | 'char_3');
        sendEv(c.characterId, { type: 'ACTIVE_CHARACTER_CHANGED', characterId: c.characterId });
        sendEv(c.characterId, { type: 'COMMAND_COMPLETED', commandId: cmd.commandId, outcome: 'DONE', code: 'DONE' });
        sendSnap(c.characterId, 'SCENE_RELOADED');
        return;
      }
      sendRes(cmd, 'REJECTED');
    },
  };

  const ctrl = new FamilyController(transport, {
    storage,
    now: () => t,
    after: (ms, fn) => { timers.push({ at: t + ms, fn }); },
  });
  const step = (ms = 3000) => {
    const end = t + ms;
    let nextHb = t + 900;
    while (true) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      const nextEventAt = next && next.at <= end ? next.at : Infinity;
      const targetAt = Math.min(nextEventAt, nextHb <= end ? nextHb : Infinity);
      if (targetAt === Infinity) break;
      t = Math.max(t, targetAt);
      if (nextHb <= t) {
        push({ v: PROTOCOL_VERSION, characterId: snap.family!.activeCharacterId, ts: t, kind: 'heartbeat', sessionId: 's1', seq: seq++, mapId: '10001', phase: 'PLAYING', inBattle: false });
        nextHb = t + 900;
      }
      if (next && next.at <= t) {
        timers.shift();
        next.fn();
      }
    }
    t = end;
    push({ v: PROTOCOL_VERSION, characterId: snap.family!.activeCharacterId, ts: t, kind: 'heartbeat', sessionId: 's1', seq: seq++, mapId: '10001', phase: 'PLAYING', inBattle: false });
  };

  ctrl.start();
  push({ v: PROTOCOL_VERSION, characterId: 'char_1', ts: t, kind: 'heartbeat', sessionId: 's1', seq: seq++, mapId: '10001', phase: 'PLAYING', inBattle: false });
  sendEv('char_1', { type: 'GAME_STARTED', sessionId: 's1' });
  sendSnap('char_1', 'STARTED');

  const err1 = ctrl.parseAndSend('小石 採集 青銅礦 2');
  step(3000);
  assert(err1 === null, `background command failed: ${err1}`);
  const workCmds = sent.filter(c => c.command.type === 'WORK_ONCE');
  assert(workCmds.length === 2, `expected 2 background WORK_ONCE commands, got ${workCmds.length}`);
  assert(workCmds.every(c => c.characterId === 'char_2'), 'all background WORK_ONCE targeted char_2');
  const qs = ctrl.queueStatuses();
  assert(qs['char_2']?.phase === 'DONE' && qs['char_2']?.stopReason === 'DONE_TARGET', `char_2 queue should complete, got ${qs['char_2']?.phase}/${qs['char_2']?.stopReason}`);
  assert((qs['char_1']?.phase ?? 'IDLE') === 'IDLE', 'foreground char_1 queue stays IDLE');
  assert(ctrl.state.activeCharacterId === 'char_1', 'foreground viewed character stays char_1 during background work');
  const char2Member = ctrl.state.members.find(m => m.characterId === 'char_2')!;
  assert(char2Member.inventory.find(i => i.itemId === 10234)?.count === 2, 'char_2 member inventory updated to 2');
  assert(ctrl.state.inventory.find(i => i.itemId === 10234)?.count === 3, 'char_1 foreground inventory untouched');

  const err2 = ctrl.parseAndSend('切換視角 小石');
  assert(err2 === null, `switch command failed: ${err2}`);
  assert(ctrl.state.activeCharacterId === 'char_2', 'activeCharacterId switched to char_2');
  assert(ctrl.state.character?.name === '小石', 'foreground snapshot now shows 小石');
  ctrl.stop();
}

// Regression: SCENE_RELOADED snapshot while navigator is walking to NPC shop must NOT
// cause WorkQueue to emit a competing TALK_TO_NPC that supersedes WALK_TO with NAV_FAILED.
suite('WorkQueue navStartedKey + SCENE_RELOADED regression');
{
  let t = 5000;
  let seq = 1;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const sent: CommandMessage[] = [];
  let push: (m: unknown) => void = () => {};
  const snapBase = makeP4Snapshot('char_1');
  const baseShop = snapBase.shops[0];
  const shop = { ...baseShop, goods: [...baseShop.goods, { itemId: 51005, name: '十字鎬', price: 150, category: 'TOOL' }] };
  const shopNpc = snapBase.npcs.find(n => n.id === shop.npcId || n.name === shop.npcName)!;
  let charX = 3560;
  let charY = 3880;
  let hasPick = false;

  const makeSnap = (): SceneSnapshot => ({
    ...snapBase,
    character: { ...snapBase.character, x: charX, y: charY, inventoryCount: hasPick ? 2 : 1 },
    shops: [shop, ...snapBase.shops.filter(s => s.npcId !== shop.npcId)],
    inventory: hasPick
      ? [{ itemId: 10234, name: '青銅礦', count: 3 }, { itemId: 51005, name: '十字鎬', count: 1 }]
      : [{ itemId: 10234, name: '青銅礦', count: 3 }],
  });

  let walkCmdId: string | null = null;
  let stepMoved = false;
  const sendEv = (event: unknown) => push({ v: PROTOCOL_VERSION, characterId: 'char_1', ts: t, kind: 'event', seq: seq++, event } as PluginMessage);
  const sendSnap = (reason: 'STARTED' | 'REQUESTED' | 'SCENE_RELOADED' = 'STARTED') =>
    push({ v: PROTOCOL_VERSION, characterId: 'char_1', ts: t, kind: 'snapshot', seq: seq++, reason, snapshot: makeSnap() });

  const transport: Transport = {
    name: 'fake-buy-race',
    start: cb => { push = cb; },
    stop: () => {},
    send(cmd) {
      sent.push(cmd);
      push({ v: PROTOCOL_VERSION, characterId: 'char_1', ts: t, kind: 'command-result', commandId: cmd.commandId, status: 'ACCEPTED' });
      const c = cmd.command;
      if (c.type === 'REQUEST_SNAPSHOT') { sendSnap('REQUESTED'); return; }
      if (c.type === 'WALK_TO') {
        walkCmdId = cmd.commandId;
        return;
      }
      if (c.type === 'TALK_TO_NPC') {
        if (walkCmdId) {
          // Simulate host superseding an active WALK_TO if TALK_TO_NPC interrupts it!
          sendEv({ type: 'COMMAND_COMPLETED', commandId: walkCmdId, outcome: 'INTERRUPTED', code: 'SUPERSEDED' });
          walkCmdId = null;
        }
        sendEv({ type: 'DIALOG_OPENED', npcId: shopNpc.id, npcName: shopNpc.name, role: shopNpc.role ?? 'SHOP', lines: ['hi'], options: [{ id: 'OPEN_SHOP', label: '開商店' }, { id: 'CLOSE', label: '離開' }], optionsAvailable: true });
        sendEv({ type: 'COMMAND_COMPLETED', commandId: cmd.commandId, outcome: 'DONE', code: 'DIALOG_OPENED' });
        return;
      }
      if (c.type === 'CHOOSE_DIALOG_OPTION' && c.optionId === 'OPEN_SHOP') {
        sendEv({ type: 'SHOP_OPENED', npcId: shopNpc.id, npcName: shopNpc.name, goods: shop.goods });
        sendEv({ type: 'DIALOG_CLOSED', npcId: shopNpc.id });
        sendEv({ type: 'COMMAND_COMPLETED', commandId: cmd.commandId, outcome: 'DONE', code: 'DONE' });
        return;
      }
      if (c.type === 'BUY_ITEM') {
        hasPick = true;
        sendEv({ type: 'COMMAND_COMPLETED', commandId: cmd.commandId, outcome: 'DONE', code: 'DONE' });
        // Simulate host React useEffect delay: INVENTORY_CHANGED arrives 80ms AFTER COMMAND_COMPLETED
        timers.push({ at: t + 80, fn: () => sendEv({ type: 'INVENTORY_CHANGED', changes: [{ itemId: 51005, delta: 1, count: 1 }] }) });
        return;
      }
      if (c.type === 'CHOOSE_DIALOG_OPTION' && c.optionId === 'CLOSE_SHOP') {
        sendEv({ type: 'SHOP_CLOSED', npcId: shopNpc.id });
        sendEv({ type: 'COMMAND_COMPLETED', commandId: cmd.commandId, outcome: 'DONE', code: 'DONE' });
        return;
      }
      if (c.type === 'WORK_ONCE') {
        sendEv({ type: 'COMMAND_COMPLETED', commandId: cmd.commandId, outcome: 'DONE', code: 'DONE' });
        return;
      }
    },
  };

  const ctrl = new FamilyController(transport, {
    now: () => t,
    after: (ms, fn) => { timers.push({ at: t + ms, fn }); },
  });
  ctrl.start();
  push({ v: PROTOCOL_VERSION, characterId: 'char_1', ts: t, kind: 'heartbeat', sessionId: 's2', seq: seq++, mapId: '10001', phase: 'PLAYING', inBattle: false });
  sendEv({ type: 'GAME_STARTED', sessionId: 's2' });
  sendSnap('STARTED');

  const err = ctrl.parseAndSend('採集 青銅礦 1');
  assert(err === null, `gather start error: ${err}`);

  // Run loop; mid-walk (1st walk to shop), move player inside TALK_NEAR (140px) and push SCENE_RELOADED BEFORE WALK_TO completes;
  // on 2nd walk (back to gather point), move player to target and complete ARRIVED.
  for (let iter = 0; iter < 50; iter++) {
    timers.sort((a, b) => a.at - b.at);
    if (walkCmdId) {
      const w = walkCmdId;
      walkCmdId = null;
      if (!stepMoved) {
        stepMoved = true;
        charX = shopNpc.x + 50; charY = shopNpc.y; // dist 50 < TALK_NEAR while WALK_TO still pending!
        sendSnap('SCENE_RELOADED');
        for (let j = 0; j < 4; j++) {
          timers.sort((a, b) => a.at - b.at);
          if (!timers.length) break;
          const n = timers.shift()!;
          t = Math.max(t, n.at);
          n.fn();
        }
      } else {
        charX = 3560; charY = 3880;
        sendEv({ type: 'MOVED', mapId: '10001', x: 3560, y: 3880, dir: 0 });
      }
      sendEv({ type: 'COMMAND_COMPLETED', commandId: w, outcome: 'DONE', code: 'ARRIVED' });
    }
    if (!timers.length) break;
    const next = timers.shift()!;
    t = Math.max(t, next.at);
    next.fn();
  }

  const qSt = ctrl.queueStatus();
  assert(qSt.phase === 'DONE' && qSt.stopReason === 'DONE_TARGET', `expected DONE/DONE_TARGET after buy-tool race, got ${qSt.phase}/${qSt.stopReason} (${qSt.text})`);
  assert(sent.filter(c => c.command.type === 'BUY_ITEM' && c.command.itemId === 51005).length === 1, 'bought missing pickaxe exactly once');
  assert(sent.filter(c => c.command.type === 'TALK_TO_NPC').length === 1, 'sent TALK_TO_NPC exactly once (no duplicate racing walk)');
  ctrl.stop();
}

done();
