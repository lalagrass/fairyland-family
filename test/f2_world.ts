import ex from '../src/protocol/examples.json';
import { PROTOCOL_VERSION, type CommandMessage, type PluginMessage, type SceneSnapshot } from '../src/protocol/index';
import { FamilyController } from '../src/controller';
import type { Transport } from '../src/transport/types';

/**
 * F2 測試用的假宿主：兩位家族成員，宿主規則照 fairyland command_router——
 * 只有採集（WORK_ONCE）能替背景角色做，走路／對話／任務指令只接受視角角色，否則 WRONG_CHARACTER。
 * `fx17: true` 時改照 FX17 之後的宿主（fairyland #111）：背景角色也能走路、對話、接交任務；
 * 每位角色各有自己的任務清單；背景角色的快照宿主不會主動送，只在 `REQUEST_SNAPSHOT`（信封帶該角色）時
 * 回該角色自己的快照（`inReplyTo`＝請求的 commandId，`family.activeCharacterId` 跟真宿主一樣寫成該角色）。
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
  /** F8：照 FX17 之後的宿主規則（背景角色可跑任務、各自的任務清單）。 */
  fx17?: boolean;
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
  const fx17 = Boolean(opts.fx17);
  const makeQuests = (): Quest[] => Array.from({ length: opts.questCount ?? 60 }, (_, i) => ({
    questId: 7000 + i,
    title: `虛構委託${i + 1}`,
    status: 'AVAILABLE' as const,
  }));
  const quests: Quest[] = makeQuests();
  // FX17 之前只有視角角色有任務（共用一份）；FX17 之後每位角色各自一份。
  const questsByChar: Record<string, Quest[]> = { char_1: quests, char_2: fx17 ? makeQuests() : quests };
  const questsOf = (id: string): Quest[] => questsByChar[id] ?? [];
  /** 每位角色在宿主那邊「進行中」的任務（同時有兩位在做同一件時記下來，測試互斥用）。 */
  const working: Record<string, number | null> = {};
  const overlaps: Array<{ questId: number; a: string; b: string; at: number }> = [];
  const dialogs: Record<string, string | null> = {}; // 每位角色各自開著的對話（任務編號字串）
  let t = opts.startAt ?? 1_000_000;
  let seq = 1;
  let push: (m: unknown) => void = () => {};
  const timers: Array<{ at: number; fn: () => void }> = [];
  const hostEvents: Array<{ at: number; fn: () => void }> = [];
  const sent: CommandMessage[] = [];
  let sessionId = 's-f2';
  let connected = true;
  /** false＝宿主（fairyland 分頁）關掉：不送心跳、不回指令。 */
  let hostUp = true;
  /** 名冊裡暫時拿掉的角色（模擬角色離線）。 */
  const offline = new Set<string>();

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
    base.region = { regionId: 'r-f2', name: '虛構區' };
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
    base.quests = fx17 || id === viewed ? questsOf(id).map(q => ({
      questId: q.questId, title: q.title, npcId: NPC.id, npcName: NPC.name, minLevel: 1, status: q.status,
      objectives: [{ type: 'TALK_TO_NPC', description: `與「${NPC.name}」交談`, current: q.status === 'AVAILABLE' ? 0 : 1, required: 1, met: q.status !== 'AVAILABLE' }],
      rewardExp: 5, rewardCoins: 0,
    })) : [];
    const open = (fx17 || id === viewed) && dialogs[id] ? questsOf(id).find(q => String(q.questId) === dialogs[id]) : undefined;
    base.activity = {
      dialog: open
        ? { npcId: NPC.id, npcName: NPC.name, lines: ['虛構對白'], options: [{ id: open.status === 'AVAILABLE' ? `ACCEPT_QUEST:${open.questId}` : `COMPLETE_QUEST:${open.questId}`, label: open.status === 'AVAILABLE' ? '答應' : '回報' }, { id: 'CLOSE', label: '離開' }] }
        : null,
      shop: null, battle: null, battleResult: null, command: null,
    };
    (base as any).family = {
      // 真宿主的背景快照把 activeCharacterId 寫成該角色自己（fairyland background_runtime.snapshot）。
      activeCharacterId: fx17 ? id : viewed,
      maxSlots: 5,
      warehouse: { gold: 0, cap: 200, items: [] },
      members: Object.values(chars).filter(c => !offline.has(c.id)).map(c => ({
        characterId: c.id, name: c.name, level: c.level, mapId: '99001', mapName: '虛構草原', region: { regionId: 'r-f2', name: '虛構區' }, x: c.x, y: c.y, gold: c.gold, satiety: c.satiety,
        inventoryCount: c.bag, inventoryCap: c.cap, inBattle: false,
        inventory: c.bag > 0 ? [{ itemId: 90001, name: '虛構礦石', count: c.bag }] : [], workSkills: { 5: 5 },
      })),
    };
    return base as SceneSnapshot;
  }

  const sendSnapshot = (reason: 'STARTED' | 'REQUESTED' | 'SCENE_RELOADED' = 'REQUESTED') =>
    push({ ...envelope(viewed), kind: 'snapshot', seq: seq++, reason, snapshot: snapshotFor(viewed) });
  /** FX17：回某位角色自己的快照（背景角色只有在要求時才送）。 */
  const sendSnapshotOf = (id: string, inReplyTo?: string) =>
    push({ ...envelope(id), kind: 'snapshot', seq: seq++, reason: 'REQUESTED', ...(inReplyTo ? { inReplyTo } : {}), snapshot: snapshotFor(id) });
  /** 視角角色的進度變動宿主會主動推快照；背景角色不會。 */
  const refreshAfter = (id: string) => { if (!fx17 || id === viewed) sendSnapshot('REQUESTED'); };
  const heartbeat = () =>
    push({ ...envelope(viewed), kind: 'heartbeat', sessionId, seq: seq++, mapId: '99001', phase: 'PLAYING', inBattle: false });

  const transport: Transport = {
    name: 'f2-fake-host',
    start: cb => { push = cb; },
    stop: () => {},
    send(cmd) {
      if (!connected || !hostUp) return;
      sent.push(cmd);
      const c = cmd.command as { type: string; [k: string]: any };
      const fromViewed = cmd.characterId === viewed;
      const reject = (code: string, msg?: string) => emitResult(cmd, 'REJECTED', code, msg);
      switch (c.type) {
        case 'REQUEST_SNAPSHOT':
          emitResult(cmd, 'ACCEPTED');
          if (fx17) later(50, () => sendSnapshotOf(cmd.characterId, cmd.commandId));
          else later(50, () => sendSnapshot('REQUESTED'));
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
          if (!fromViewed && !fx17) return reject('WRONG_CHARACTER', '此操作需要在主畫面觀察中才能執行');
          if (!chars[cmd.characterId]) return reject('CHARACTER_NOT_FOUND');
          emitResult(cmd, 'ACCEPTED');
          const done = (code: string, after: () => void = () => {}) => later(questStepMs, () => {
            after();
            emitEvent(cmd.characterId, { type: 'COMMAND_COMPLETED', commandId: cmd.commandId, outcome: 'DONE', code });
          });
          if (c.type === 'WALK_TO') {
            done('ARRIVED', () => {
              const me = chars[cmd.characterId]; me.x = c.x; me.y = c.y;
              if (fx17 && cmd.characterId !== viewed) emitEvent(cmd.characterId, { type: 'MOVED', mapId: '99001', x: c.x, y: c.y, dir: 0 });
              refreshAfter(cmd.characterId);
            });
            return;
          }
          if (c.type === 'TALK_TO_NPC') {
            const mine = questsOf(cmd.characterId);
            // FX17：對話列出這位角色所有可接／可回報的任務；之前只給下一件。
            const open = fx17 ? mine.filter(q => q.status !== 'COMPLETED') : mine.filter(q => q.status !== 'COMPLETED').slice(0, 1);
            done('DIALOG_OPENED', () => {
              dialogs[cmd.characterId] = open[0] ? String(open[0].questId) : null;
              emitEvent(cmd.characterId, {
                type: 'DIALOG_OPENED', npcId: NPC.id, npcName: NPC.name, role: null, lines: ['虛構對白'], optionsAvailable: true,
                options: [
                  ...open.map(q => ({ id: q.status === 'AVAILABLE' ? `ACCEPT_QUEST:${q.questId}` : `COMPLETE_QUEST:${q.questId}`, label: q.title })),
                  { id: 'CLOSE', label: '離開' },
                ],
              });
            });
            return;
          }
          const optionId: string = c.type === 'ACCEPT_QUEST' ? `ACCEPT_QUEST:${c.questId}` : c.optionId;
          done('DONE', () => {
            const [kind, rawId] = optionId.split(':');
            const q = questsOf(cmd.characterId).find(x => String(x.questId) === rawId);
            if (kind === 'ACCEPT_QUEST' && q) {
              q.status = 'READY'; dialogs[cmd.characterId] = String(q.questId);
              working[cmd.characterId] = q.questId;
              for (const [other, qid] of Object.entries(working)) {
                if (other !== cmd.characterId && qid === q.questId) overlaps.push({ questId: q.questId, a: other, b: cmd.characterId, at: t });
              }
            }
            else if (kind === 'COMPLETE_QUEST' && q) { q.status = 'COMPLETED'; dialogs[cmd.characterId] = null; if (working[cmd.characterId] === q.questId) working[cmd.characterId] = null; }
            else if (optionId === 'CLOSE') dialogs[cmd.characterId] = null;
            if (kind === 'ACCEPT_QUEST' || kind === 'COMPLETE_QUEST' || optionId === 'CLOSE') {
              emitEvent(cmd.characterId, { type: 'DIALOG_CLOSED', npcId: NPC.id });
              refreshAfter(cmd.characterId);
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
      if (connected && hostUp && t - lastBeat >= 1000) { lastBeat = t; heartbeat(); }
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
    questsOf,
    /** 兩位角色同時在做同一件任務的紀錄（應該永遠是空的）。 */
    overlaps,
    /** 宿主分頁關掉：送一則 GAME_STOPPED，之後不送心跳、不回指令。 */
    stopHost() {
      push({ ...envelope(viewed), kind: 'event', seq: seq++, event: { type: 'GAME_STOPPED', sessionId, reason: 'SHUTDOWN' } });
      hostUp = false;
    },
    /** 宿主分頁重開：新的 session，重新送心跳與快照。 */
    startHost() {
      hostUp = true;
      sessionId = `${sessionId}+`;
      lastBeat = -1e9;
      heartbeat();
      sendSnapshot('STARTED');
    },
    setOffline(id: string, off: boolean) { if (off) offline.add(id); else offline.delete(id); sendSnapshot('REQUESTED'); },
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
