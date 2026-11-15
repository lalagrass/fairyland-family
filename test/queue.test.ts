import { PROTOCOL_VERSION, type CommandMessage, type PluginMessage, type SceneSnapshot } from '../src/protocol/index';
import fx from '../fixtures/replay_village.json';
import { FamilyController } from '../src/controller';
import type { Transport } from '../src/transport/types';
import { assert, done, suite } from './helpers';

const snaps = (fx.steps as any[]).filter(s => s.message.kind === 'snapshot').map(s => s.message.snapshot as SceneSnapshot);
const baseVillage = snaps[0];

const villageWithFx6: SceneSnapshot = {
  ...baseVillage,
  character: {
    ...baseVillage.character,
    gold: 5000,
    x: 3880,
    y: 3740,
    satiety: 100,
    maxSatiety: 100,
    inventoryCount: 22,
    inventoryCap: 40,
    workSkills: {},
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
  shops: [
    {
      npcId: 'npc_收破爛阿利',
      npcName: '收破爛阿利',
      goodsStatus: 'RECONSTRUCTED_DEMO',
      goods: [{ itemId: 51005, name: '十字鎬', price: 100 }],
    },
  ],
  recipes: [
    {
      recipeId: 20901,
      resultItemId: 20901,
      name: '青銅塊',
      skillId: 10,
      skillName: '冶煉',
      reqLevel: 1,
      ingredients: [
        { itemId: 10234, name: '青銅礦', count: 1, resolved: true },
        { itemId: 10201, name: '煤', count: 3, resolved: true },
      ],
      unresolvedIngredients: [],
    },
  ],
};

function harness(opts: { initialInv?: Array<{ itemId: number; name: string; count: number }>; rejectWork?: string; store?: Map<string, string> } = {}) {
  let t = 1000;
  let seq = 1;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const sent: CommandMessage[] = [];
  let push: (m: unknown) => void = () => {};
  const store = opts.store ?? new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  let inv = opts.initialInv ? [...opts.initialInv] : [];
  let snap: SceneSnapshot = {
    ...villageWithFx6,
    npcs: villageWithFx6.npcs.some(n => n.name === '收破爛阿利')
      ? villageWithFx6.npcs
      : [...villageWithFx6.npcs, { id: 'npc_收破爛阿利', name: '收破爛阿利', x: 3820, y: 3740, gridX: 47, gridY: 187, role: 'SHOP', talkable: true, isAnimal: false, isShop: true }],
    inventory: inv,
  };
  let px = snap.character.x;
  let py = snap.character.y;
  let rejectNextWork = opts.rejectWork ?? null;
  let scriptWorkEncounter = false;
  let currentSid = 's1';

  const B = { v: PROTOCOL_VERSION, characterId: 'c1' };
  const ev = (event: unknown) => push({ ...B, ts: t, kind: 'event', seq: seq++, event } as PluginMessage);
  const result = (c: CommandMessage, status: 'ACCEPTED' | 'REJECTED', reasonCode?: string, message?: string) =>
    push({ ...B, ts: t, kind: 'command-result', commandId: c.commandId, status, ...(reasonCode ? { reasonCode } : {}), ...(message ? { message } : {}) });
  const completed = (c: CommandMessage, code: string, outcome = 'DONE') => ev({ type: 'COMMAND_COMPLETED', commandId: c.commandId, outcome, code });
  const sendSnap = (reason = 'STARTED') => push({ ...B, ts: t, kind: 'snapshot', seq: seq++, reason, snapshot: { ...snap, character: { ...snap.character, x: px, y: py }, inventory: inv } });

  const transport: Transport = {
    name: 'fake-fx11',
    start: cb => { push = cb; },
    stop: () => {},
    send(cmd) {
      sent.push(cmd);
      const c = cmd.command;
      if (c.type === 'REQUEST_SNAPSHOT') { result(cmd, 'ACCEPTED'); sendSnap('REQUESTED'); return; }
      if (c.type === 'WALK_TO') {
        result(cmd, 'ACCEPTED');
        if (scriptWorkEncounter) {
          scriptWorkEncounter = false;
          ev({ type: 'BATTLE_STARTED', battleId: 9, mapId: '10001', enemies: [{ id: 'e', name: '波姆', level: 1 }] });
          completed(cmd, 'ENCOUNTER', 'INTERRUPTED');
          return;
        }
        px = c.x; py = c.y;
        ev({ type: 'MOVED', mapId: '10001', x: px, y: py, dir: 0 });
        completed(cmd, 'ARRIVED');
        return;
      }
      if (c.type === 'TALK_TO_NPC') {
        result(cmd, 'ACCEPTED');
        ev({ type: 'DIALOG_OPENED', npcId: c.npcId, npcName: '收破爛阿利', role: 'SHOP', lines: ['歡迎'], options: [{ id: 'OPEN_SHOP', label: '開啟商店' }, { id: 'CLOSE', label: '離開' }], optionsAvailable: true });
        completed(cmd, 'DIALOG_OPENED');
        return;
      }
      if (c.type === 'CHOOSE_DIALOG_OPTION') {
        result(cmd, 'ACCEPTED');
        if (c.optionId === 'OPEN_SHOP') {
          ev({ type: 'DIALOG_CLOSED', npcId: 'npc_收破爛阿利' });
          ev({ type: 'SHOP_OPENED', npcId: 'npc_收破爛阿利', npcName: '收破爛阿利', goods: [{ itemId: 51005, name: '十字鎬', price: 100 }] });
        } else if (c.optionId === 'CLOSE_SHOP') {
          ev({ type: 'SHOP_CLOSED', npcId: 'npc_收破爛阿利' });
        } else if (c.optionId === 'CLOSE') {
          ev({ type: 'DIALOG_CLOSED', npcId: 'npc_收破爛阿利' });
        }
        completed(cmd, 'DONE');
        return;
      }
      if (c.type === 'BUY_ITEM') {
        result(cmd, 'ACCEPTED');
        inv = [...inv, { itemId: c.itemId, name: '十字鎬', count: c.count ?? 1 }];
        ev({ type: 'INVENTORY_CHANGED', changes: [{ itemId: c.itemId, delta: c.count ?? 1, count: c.count ?? 1 }] });
        completed(cmd, 'DONE');
        return;
      }
      if (c.type === 'WORK_ONCE') {
        if (rejectNextWork) {
          const code = rejectNextWork;
          rejectNextWork = null;
          result(cmd, 'REJECTED', code, code);
          return;
        }
        if (c.skillId && !inv.some(i => i.itemId === 51005 && i.count > 0)) {
          result(cmd, 'REJECTED', 'MISSING_TOOL', '缺十字鎬');
          return;
        }
        result(cmd, 'ACCEPTED');
        const gainId = c.targetItemId ?? c.recipeId ?? 10234;
        const cur = inv.find(i => i.itemId === gainId)?.count ?? 0;
        inv = [...inv.filter(i => i.itemId !== gainId), { itemId: gainId, name: '產物', count: cur + 1 }];
        ev({ type: 'INVENTORY_CHANGED', changes: [{ itemId: gainId, delta: 1, count: cur + 1 }] });
        completed(cmd, 'DONE');
        return;
      }
    },
  };

  const fc = new FamilyController(transport, {
    now: () => t,
    after: (ms, fn) => { timers.push({ at: t + ms, fn }); },
    storage,
  });
  const step = (ms = 500) => {
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
        push({ ...B, ts: t, kind: 'heartbeat', sessionId: currentSid, seq: seq++, mapId: '10001', phase: 'PLAYING', inBattle: false });
        nextHb = t + 900;
      }
      if (next && next.at <= t) {
        timers.shift();
        next.fn();
      }
    }
    t = end;
    push({ ...B, ts: t, kind: 'heartbeat', sessionId: currentSid, seq: seq++, mapId: '10001', phase: 'PLAYING', inBattle: false });
  };
  const startSession = (sid = 's1') => {
    currentSid = sid;
    fc.start();
    push({ ...B, ts: t, kind: 'heartbeat', sessionId: currentSid, seq: seq++, mapId: '10001', phase: 'PLAYING', inBattle: false });
    ev({ type: 'GAME_STARTED', sessionId: currentSid });
    sendSnap('STARTED');
  };
  return {
    fc,
    sent,
    store,
    step,
    startSession,
    setEncounter: () => { scriptWorkEncounter = true; },
    endBattle: () => { ev({ type: 'BATTLE_ENDED', battleId: 9, outcome: 'FLEE' }); },
    setRejectNextWork: (code: string) => { rejectNextWork = code; },
  };
}

suite('FX11 WorkQueue auto-buy tool + gather loop');
{
  const h = harness();
  h.startSession();
  h.step(200);
  const err = h.fc.parseAndSend('採集 青銅礦 2');
  assert(err === null, 'parse 採集 青銅礦 2 succeeds');
  h.step(5000);
  assert(h.sent.some(c => c.command.type === 'BUY_ITEM' && c.command.itemId === 51005), 'auto-buys missing 51005 tool from shop');
  const works = h.sent.filter(c => c.command.type === 'WORK_ONCE');
  assert(works.length === 2, `executes WORK_ONCE twice (got ${works.length})`);
  assert(h.fc.queueStatus().phase === 'DONE' && h.fc.queueStatus().stopReason === 'DONE_TARGET', 'queue completes with DONE_TARGET');
}

suite('FX11 stop reasons: INVENTORY_FULL & INSUFFICIENT_MATERIALS');
{
  const h = harness({ initialInv: [{ itemId: 51005, name: '十字鎬', count: 1 }] });
  h.startSession();
  h.step(200);
  h.setRejectNextWork('INVENTORY_FULL');
  h.fc.parseAndSend('挖礦 煤 到滿');
  h.step(3000);
  assert(h.fc.queueStatus().phase === 'STOPPED' && h.fc.queueStatus().stopReason === 'BAG_FULL', 'INVENTORY_FULL stops queue with BAG_FULL');

  h.setRejectNextWork('INSUFFICIENT_MATERIALS');
  h.fc.parseAndSend('製作 青銅塊 1');
  h.step(1000);
  assert(h.fc.queueStatus().phase === 'STOPPED' && h.fc.queueStatus().stopReason === 'MISSING_MATERIALS', 'INSUFFICIENT_MATERIALS stops with MISSING_MATERIALS');
}

suite('FX11 battle interruption pause/resume & localStorage persistence');
{
  const sharedStore = new Map<string, string>();
  const h1 = harness({ initialInv: [{ itemId: 51005, name: '十字鎬', count: 1 }], store: sharedStore });
  h1.startSession('s1');
  h1.setEncounter();
  h1.fc.parseAndSend('採集 青銅礦 2');
  h1.step(1000);
  assert(h1.fc.queueStatus().phase === 'PAUSED_BATTLE', 'battle encounter pauses WorkQueue');
  h1.endBattle();
  h1.step(2000);
  assert(h1.fc.queueStatus().phase === 'DONE', 'battle end resumes and completes WorkQueue');

  // Reopen persistence test
  const freshStore = new Map<string, string>();
  const h2 = harness({ initialInv: [{ itemId: 51005, name: '十字鎬', count: 1 }], store: freshStore });
  h2.fc.queue.enqueue({ kind: 'GATHER', skillId: 5, skillName: '挖礦', targetItemId: 10234, targetName: '青銅礦', targetCount: 1, requiredToolItemId: 51005 });
  const h3 = harness({ initialInv: [{ itemId: 51005, name: '十字鎬', count: 1 }], store: freshStore });
  assert(h3.fc.queueStatus().jobs.length === 1 && h3.fc.queueStatus().phase === 'RUNNING', 'queue restored from localStorage');
  h3.startSession('s2');
  h3.step(3000);
  assert(h3.fc.queueStatus().phase === 'DONE', 'restored queue resumes on GAME_STARTED and finishes');
}

done();
