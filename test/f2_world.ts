import ex from '../src/protocol/examples.json';
import { PROTOCOL_VERSION, type CommandMessage, type PluginMessage, type SceneSnapshot } from '../src/protocol/index';
import { FamilyController } from '../src/controller';
import type { Transport } from '../src/transport/types';

/**
 * F2 測試用的假宿主：兩位家族成員，宿主規則照 fairyland command_router——
 * 只有採集（WORK_ONCE）能替背景角色做，走路／對話／任務指令只接受視角角色，否則 WRONG_CHARACTER。
 * 時間是虛擬的（world.t），測試用 advance() 往前推；全部虛構資料，沒有任何原版素材。
 */

export interface WorldChar {
  id: string;
  name: string;
  level: number;
  gold: number;
  satiety: number;
  x: number;
  y: number;
  bag: number;
  cap: number;
}

export interface WorldOpts {
  /** 每次採集要花的虛擬毫秒。 */
  gatherMs?: number;
  /** 每一段任務動作（接取、回報）宿主回應要花的虛擬毫秒。 */
  questStepMs?: number;
  questCount?: number;
  bagCapA?: number;
  satietyDropPerGather?: number;
  storage?: Map<string, string>;
  /** 重開測試用：沿用先前的虛擬時鐘。 */
  startAt?: number;
  viewed?: string;
  /** A（小石）一開始離採集點多遠（px）；預設貼著採集點。 */
  startOffsetA?: number;
}

interface Quest {
  questId: number;
  title: string;
  status: 'AVAILABLE' | 'READY' | 'COMPLETED';
}

const NPC = { id: 'npc_f2_guide', name: '虛構嚮導', x: 3880, y: 3740 };
const POINT = { id: 'gather_f2_a', x: 3560, y: 3880, mapId: '99001' };

export function createWorld(opts: WorldOpts = {}) {
  const gatherMs = opts.gatherMs ?? 10_000;
  const questStepMs = opts.questStepMs ?? 1_500;
  const store = opts.storage ?? new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };

  const chars: Record<string, WorldChar> = {
    char_1: { id: 'char_1', name: '愛麗絲', level: 3, gold: 300, satiety: 100, x: NPC.x, y: NPC.y, bag: 0, cap: 40 },
    char_2: { id: 'char_2', name: '小石', level: 3, gold: 200, satiety: 100, x: POINT.x + (opts.startOffsetA ?? 40), y: POINT.y, bag: 0, cap: opts.bagCapA ?? 40 },
  };
  let viewed = opts.viewed ?? 'char_1';
  const quests: Quest[] = Array.from({ length: opts.questCount ?? 60 }, (_, i) => ({
    questId: 7000 + i,
    title: `虛構委託${i + 1}`,
    status: 'AVAILABLE' as const,
  }));
  const dialogs: Record<string, string | null> = {}; // 每位角色各自開著的對話（任務編號字串）
  let t = opts.startAt ?? 1_000_000;
  let seq = 1;
  let push: (m: unknown) => void = () => {};
  const timers: Array<{ at: number; fn: () => void }> = [];
  const hostEvents: Array<{ at: number; fn: () => void }> = [];
  const sent: CommandMessage[] = [];
  let sessionId = 's-f2';
  let connected = true;

  const envelope = (characterId: string) => ({ v: PROTOCOL_VERSION, characterId, ts: t });
  const emitEvent = (characterId: string, event: unknown) =>
    push({ ...envelope(characterId), kind: 'event', seq: seq++, event } as PluginMessage);
  const emitResult = (c: CommandMessage, status: 'ACCEPTED' | 'REJECTED', reasonCode?: string, message?: string) =>
    push({ ...envelope(c.characterId), kind: 'command-result', commandId: c.commandId, status, ...(reasonCode ? { reasonCode } : {}), ...(message ? { message } : {}) });
  const later = (ms: number, fn: () => void) => { hostEvents.push({ at: t + ms, fn }); };

  function snapshotFor(id: string): SceneSnapshot {
    const base = JSON.parse(JSON.stringify(ex.snapshot.snapshot)) as SceneSnapshot & Record<string, any>;
    const me = chars[id];
    base.mapId = '99001';
    base.mapName = '虛構草原';
    base.openingStage = 'DONE';
    base.character = { ...base.character, name: me.name, level: me.level, gold: me.gold, x: me.x, y: me.y, satiety: me.satiety, maxSatiety: 100, inventoryCount: me.bag, inventoryCap: me.cap, inBattle: false };
    base.inventory = me.bag > 0 ? [{ itemId: 90001, name: '虛構礦石', count: me.bag }] : [];
    base.npcs = [{ id: NPC.id, name: NPC.name, x: NPC.x, y: NPC.y, gridX: 48, gridY: 187, role: 'VILLAGER', talkable: true, isAnimal: false, isShop: false }];
    base.exits = [];
    base.gatherPoints = {
      status: 'AVAILABLE',
      points: [{
        id: POINT.id, name: '虛構採集點', mapId: POINT.mapId, mapName: '虛構草原', x: POINT.x, y: POINT.y, skillId: 5, skillName: '挖礦',
        requiredToolItemId: null, materials: [{ itemId: 90001, name: '虛構礦石', reqLevel: 1 }],
      }],
    };
    base.quests = id === viewed ? quests.map(q => ({
      questId: q.questId, title: q.title, npcId: NPC.id, npcName: NPC.name, minLevel: 1, status: q.status,
      objectives: [{ type: 'TALK_TO_NPC', description: `與「${NPC.name}」交談`, current: q.status === 'AVAILABLE' ? 0 : 1, required: 1, met: q.status !== 'AVAILABLE' }],
      rewardExp: 5, rewardCoins: 0,
    })) : [];
    const open = id === viewed && dialogs[id] ? quests.find(q => String(q.questId) === dialogs[id]) : undefined;
    base.activity = {
      dialog: open
        ? { npcId: NPC.id, npcName: NPC.name, lines: ['虛構對白'], options: [{ id: open.status === 'AVAILABLE' ? `ACCEPT_QUEST:${open.questId}` : `COMPLETE_QUEST:${open.questId}`, label: open.status === 'AVAILABLE' ? '答應' : '回報' }, { id: 'CLOSE', label: '離開' }] }
        : null,
      shop: null, battle: null, battleResult: null, command: null,
    };
    (base as any).family = {
      activeCharacterId: viewed,
      maxSlots: 5,
      warehouse: { gold: 0, cap: 200, items: [] },
      members: Object.values(chars).map(c => ({
        characterId: c.id, name: c.name, level: c.level, mapId: '99001', mapName: '虛構草原', x: c.x, y: c.y, gold: c.gold, satiety: c.satiety,
        inventoryCount: c.bag, inventoryCap: c.cap, inBattle: false,
        inventory: c.bag > 0 ? [{ itemId: 90001, name: '虛構礦石', count: c.bag }] : [], workSkills: { 5: 5 },
      })),
    };
    return base as SceneSnapshot;
  }

  const sendSnapshot = (reason: 'STARTED' | 'REQUESTED' | 'SCENE_RELOADED' = 'REQUESTED') =>
    push({ ...envelope(viewed), kind: 'snapshot', seq: seq++, reason, snapshot: snapshotFor(viewed) });
  const heartbeat = () =>
    push({ ...envelope(viewed), kind: 'heartbeat', sessionId, seq: seq++, mapId: '99001', phase: 'PLAYING', inBattle: false });

  const transport: Transport = {
    name: 'f2-fake-host',
    start: cb => { push = cb; },
    stop: () => {},
    send(cmd) {
      if (!connected) return;
      sent.push(cmd);
      const c = cmd.command as { type: string; [k: string]: any };
      const fromViewed = cmd.characterId === viewed;
      const reject = (code: string, msg?: string) => emitResult(cmd, 'REJECTED', code, msg);
      switch (c.type) {
        case 'REQUEST_SNAPSHOT':
          emitResult(cmd, 'ACCEPTED');
          later(50, () => sendSnapshot('REQUESTED'));
          return;
        case 'SWITCH_VIEW_CHARACTER': {
          emitResult(cmd, 'ACCEPTED');
          viewed = c.characterId;
          later(100, () => {
            emitEvent(viewed, { type: 'ACTIVE_CHARACTER_CHANGED', characterId: viewed });
            emitEvent(viewed, { type: 'COMMAND_COMPLETED', commandId: cmd.commandId, outcome: 'DONE', code: 'DONE' });
            sendSnapshot('SCENE_RELOADED');
          });
          return;
        }
        case 'WORK_ONCE': {
          const me = chars[cmd.characterId];
          if (!me) return reject('CHARACTER_NOT_FOUND');
          if (Math.hypot(me.x - POINT.x, me.y - POINT.y) > 240) return reject('TOO_FAR', `離採集點【虛構採集點】太遠（${Math.round(Math.hypot(me.x - POINT.x, me.y - POINT.y))}px，需要 ≤ 240px），請先 WALK_TO`);
          if (me.bag >= me.cap) return reject('BAG_FULL', '背包已滿');
          emitResult(cmd, 'ACCEPTED');
          later(gatherMs, () => {
            me.bag += 1;
            me.satiety = Math.max(0, me.satiety - (opts.satietyDropPerGather ?? 0));
            emitEvent(me.id, { type: 'INVENTORY_CHANGED', changes: [{ itemId: 90001, delta: 1, count: me.bag }] });
            emitEvent(me.id, { type: 'COMMAND_COMPLETED', commandId: cmd.commandId, outcome: 'DONE', code: 'DONE' });
            // 宿主在背景成員進度改變時刷新快照（名冊的飽食度、背包才會更新）。
            sendSnapshot('REQUESTED');
          });
          return;
        }
        case 'WALK_TO':
        case 'TALK_TO_NPC':
        case 'CHOOSE_DIALOG_OPTION':
        case 'ACCEPT_QUEST': {
          if (!fromViewed) return reject('WRONG_CHARACTER', '此操作需要在主畫面觀察中才能執行');
          emitResult(cmd, 'ACCEPTED');
          const done = (code: string, after: () => void = () => {}) => later(questStepMs, () => {
            after();
            emitEvent(cmd.characterId, { type: 'COMMAND_COMPLETED', commandId: cmd.commandId, outcome: 'DONE', code });
          });
          if (c.type === 'WALK_TO') { done('ARRIVED', () => { const me = chars[cmd.characterId]; me.x = c.x; me.y = c.y; sendSnapshot('REQUESTED'); }); return; }
          if (c.type === 'TALK_TO_NPC') {
            const next = quests.find(q => q.status !== 'COMPLETED');
            done('DIALOG_OPENED', () => {
              dialogs[cmd.characterId] = next ? String(next.questId) : null;
              const open = next;
              emitEvent(cmd.characterId, {
                type: 'DIALOG_OPENED', npcId: NPC.id, npcName: NPC.name, role: null, lines: ['虛構對白'], optionsAvailable: true,
                options: open ? [{ id: open.status === 'AVAILABLE' ? `ACCEPT_QUEST:${open.questId}` : `COMPLETE_QUEST:${open.questId}`, label: '繼續' }, { id: 'CLOSE', label: '離開' }] : [{ id: 'CLOSE', label: '離開' }],
              });
            });
            return;
          }
          const optionId: string = c.type === 'ACCEPT_QUEST' ? `ACCEPT_QUEST:${c.questId}` : c.optionId;
          done('DONE', () => {
            const [kind, rawId] = optionId.split(':');
            const q = quests.find(x => String(x.questId) === rawId);
            if (kind === 'ACCEPT_QUEST' && q) { q.status = 'READY'; dialogs[cmd.characterId] = String(q.questId); }
            else if (kind === 'COMPLETE_QUEST' && q) { q.status = 'COMPLETED'; dialogs[cmd.characterId] = null; }
            else if (optionId === 'CLOSE') dialogs[cmd.characterId] = null;
            if (kind === 'ACCEPT_QUEST' || kind === 'COMPLETE_QUEST' || optionId === 'CLOSE') {
              emitEvent(cmd.characterId, { type: 'DIALOG_CLOSED', npcId: NPC.id });
              sendSnapshot('REQUESTED');
            }
          });
          return;
        }
        default:
          return reject('NOT_IMPLEMENTED');
      }
    },
  };

  const newController = () => new FamilyController(transport, {
    storage,
    now: () => t,
    after: (ms, fn) => { timers.push({ at: t + ms, fn }); },
  });
  let ctrl = newController();

  let lastBeat = -1e9;
  function advance(ms: number, stepMs = 250): void {
    const end = t + ms;
    while (t < end) {
      t = Math.min(end, t + stepMs);
      for (let guard = 0; guard < 500; guard++) {
        const hi = hostEvents.findIndex(e => e.at <= t);
        const ti = timers.findIndex(e => e.at <= t);
        if (hi < 0 && ti < 0) break;
        if (hi >= 0 && (ti < 0 || hostEvents[hi].at <= timers[ti].at)) hostEvents.splice(hi, 1)[0].fn();
        else timers.splice(ti, 1)[0].fn();
      }
      if (connected && t - lastBeat >= 1000) { lastBeat = t; heartbeat(); }
      ctrl.tick();
    }
  }

  return {
    get ctrl() { return ctrl; },
    chars,
    quests,
    sent,
    store,
    storage,
    get t() { return t; },
    get viewed() { return viewed; },
    sessionId: () => sessionId,
    boot() {
      ctrl.start();
      heartbeat();
      sendSnapshot('STARTED');
      advance(1_000);
    },
    advance,
    /** 模擬關掉 family 分頁：停止控制器，宿主照常跑。 */
    closeFamilyTab() { connected = false; ctrl.stop(); },
    /** 宿主在 family 關掉期間照常推進（只推宿主事件，沒有控制器）。 */
    hostOnly(ms: number) {
      const end = t + ms;
      while (t < end) {
        t = Math.min(end, t + 250);
        for (let guard = 0; guard < 500; guard++) {
          const hi = hostEvents.findIndex(e => e.at <= t);
          if (hi < 0) break;
          hostEvents.splice(hi, 1)[0].fn();
        }
      }
    },
    setViewed(id: string) { viewed = id; },
    emitEvent,
    snapshotFor,
    /** 宿主送給控制器的原始訊息（測試直接餵事件用）。 */
    push: (m: unknown) => push(m),
    transport,
    /** 重新打開 family 分頁：同一份 localStorage、新的控制器。 */
    reopen(): FamilyController {
      connected = true;
      lastBeat = -1e9;
      timers.length = 0;
      ctrl = newController();
      ctrl.start();
      return ctrl;
    },
  };
}

export type World = ReturnType<typeof createWorld>;
