import ex from '../src/protocol/examples.json';
import {
  PROTOCOL_VERSION,
  type CommandMessage,
  type PluginMessage,
  type SceneSnapshot,
  type SnapshotPortalNode,
  type StaticRegion,
} from '../src/protocol/index';
import { FamilyController } from '../src/controller';
import type { FamilyState } from '../src/state';
import type { Transport } from '../src/transport/types';

/**
 * F7（#48）測試用的假宿主：兩個區域、四張地圖，用傳送點圖相連（起始村 ⇄ 林道 ⇄ 第二村 ⇄ 礦場）。
 * 宿主照協定 v7 送 `region`、STATIC_DATA `regions` 與帶座標的傳送點；走到傳送點座標就換圖。
 * 可以在指定地圖安排一次暗雷遇敵（贏或輸；輸了送回起始村），也可以把某個傳送點標成目的地不存在。
 * 全部是虛構的地圖代號、名稱與座標，沒有任何原版資料。時間是虛擬的，advance() 往前推。
 */

export interface F7Opts {
  /** 第二區任務 NPC 開不開放（false＝宿主任務目錄沒有第二區任務）。 */
  secondRegionQuest?: boolean;
  /** 第一區還有一件可接的任務（設了區域時不能被選到）。 */
  firstRegionDistraction?: boolean;
  /** 林道 → 第二村的傳送點目的地不存在（NOT_IMPORTED）：跨區走不通。 */
  brokenBridge?: boolean;
  /** 礦場採集需要的工具（背包裡沒有就回 MISSING_TOOL）；宿主沒有商店。 */
  requireTool?: boolean;
  bagCap?: number;
}

const R_A: StaticRegion = { regionId: 'r-a', name: '虛構起始區', villageMapId: 'm-a1', mapIds: ['m-a1', 'm-a2'] };
const R_B: StaticRegion = { regionId: 'r-b', name: '虛構第二區', villageMapId: 'm-b1', mapIds: ['m-b1', 'm-b2'] };
const MAP_NAME: Record<string, string> = { 'm-a1': '虛構起始村', 'm-a2': '虛構林道', 'm-b1': '虛構第二村', 'm-b2': '虛構礦場' };
const CHIEF = { id: 'npc-f7-chief', name: '虛構第二村長', mapId: 'm-b1', x: 300, y: 300 };
const TRAVELER = { id: 'npc-f7-traveler', name: '虛構旅人', mapId: 'm-a1', x: 200, y: 200 };
const POINT = { id: 'gather-f7-mine', mapId: 'm-b2', x: 200, y: 200 };
const TOOL = { itemId: 95001, name: '虛構十字鎬' };
const ORE = { itemId: 95002, name: '虛構礦石' };

export function createF7World(opts: F7Opts = {}) {
  const portals: Record<string, Array<{ id: string; to: string; x: number; y: number; ex: number; ey: number }>> = {
    'm-a1': [{ id: 'p-a1-a2', to: 'm-a2', x: 100, y: 100, ex: 40, ey: 40 }],
    'm-a2': [{ id: 'p-a2-a1', to: 'm-a1', x: 110, y: 110, ex: 120, ey: 120 }, { id: 'p-a2-b1', to: 'm-b1', x: 900, y: 900, ex: 60, ey: 60 }],
    'm-b1': [{ id: 'p-b1-a2', to: 'm-a2', x: 120, y: 120, ex: 880, ey: 880 }, { id: 'p-b1-b2', to: 'm-b2', x: 500, y: 500, ex: 70, ey: 70 }],
    'm-b2': [{ id: 'p-b2-b1', to: 'm-b1', x: 130, y: 130, ex: 480, ey: 480 }],
  };
  let broken = !!opts.brokenBridge;
  const graph = (): SnapshotPortalNode[] => Object.entries(portals).map(([mapId, list]) => ({
    mapId,
    name: MAP_NAME[mapId],
    targets: list.map(p => p.to),
    portals: list.map(p => ({
      id: p.id, name: `往${MAP_NAME[p.to]}`, x: p.x, y: p.y, targetMapId: p.to, targetMapName: MAP_NAME[p.to],
      targetStatus: broken && p.id === 'p-a2-b1' ? 'NOT_IMPORTED' as const : 'IMPORTED' as const, entryX: p.ex, entryY: p.ey,
    })),
  }));
  const regionOf = (mapId: string) => [R_A, R_B].find(r => r.mapIds.includes(mapId)) ?? null;

  const me = { mapId: 'm-a1', x: 400, y: 400, level: 5, hp: 100, bag: [] as Array<{ itemId: number; name: string; count: number }>, cap: opts.bagCap ?? 40 };
  type Q = { questId: number; title: string; npc: typeof CHIEF; regionId: string; status: 'AVAILABLE' | 'READY' | 'COMPLETED' };
  const quests: Q[] = [{ questId: 8801, title: '虛構起始委託', npc: TRAVELER, regionId: 'r-a', status: 'COMPLETED' }];
  if (opts.firstRegionDistraction) quests.push({ questId: 8802, title: '虛構旁支委託', npc: TRAVELER, regionId: 'r-a', status: 'AVAILABLE' });
  if (opts.secondRegionQuest !== false) quests.push({ questId: 8803, title: '虛構第二村的請託', npc: CHIEF, regionId: 'r-b', status: 'AVAILABLE' });

  let dialog: { npc: typeof CHIEF; questId: number | null } | null = null;
  let battle: { battleId: number; lose: boolean } | null = null;
  let battleResult: 'VICTORY' | 'DEFEAT' | null = null;
  let encounter: { mapId: string; lose: boolean } | null = null;
  let battleSeq = 0;
  const sent: CommandMessage[] = [];
  const log: string[] = [];
  let t = 1_000_000;
  let seq = 1;
  let push: (m: unknown) => void = () => {};
  const timers: Array<{ at: number; fn: () => void }> = [];
  const hostEvents: Array<{ at: number; fn: () => void }> = [];
  const characterId = 'char-f7';
  const env = () => ({ v: PROTOCOL_VERSION, characterId, ts: t });
  const emit = (event: unknown) => push({ ...env(), kind: 'event', seq: seq++, event } as PluginMessage);
  const result = (c: CommandMessage, status: 'ACCEPTED' | 'REJECTED', reasonCode?: string, message?: string) =>
    push({ ...env(), kind: 'command-result', commandId: c.commandId, status, ...(reasonCode ? { reasonCode } : {}), ...(message ? { message } : {}) });
  const later = (ms: number, fn: () => void) => { hostEvents.push({ at: t + ms, fn }); };
  const complete = (c: CommandMessage, code: string, outcome: 'DONE' | 'INTERRUPTED' | 'FAILED' = 'DONE', message?: string) =>
    emit({ type: 'COMMAND_COMPLETED', commandId: c.commandId, outcome, code, ...(message ? { message } : {}) });

  function snapshot(): SceneSnapshot {
    const base = JSON.parse(JSON.stringify(ex.snapshot.snapshot)) as SceneSnapshot;
    base.mapId = me.mapId;
    base.mapName = MAP_NAME[me.mapId];
    const r = regionOf(me.mapId);
    base.region = r ? { regionId: r.regionId, name: r.name } : null;
    base.openingStage = 'DONE';
    base.character = { ...base.character, name: '虛構旅者', level: me.level, hp: me.hp, maxHp: 100, x: me.x, y: me.y, inBattle: !!battle, inventoryCap: me.cap, inventoryCount: me.bag.reduce((n, i) => n + i.count, 0) };
    base.inventory = me.bag.map(i => ({ ...i }));
    const npcs = [CHIEF, TRAVELER].filter(n => n.mapId === me.mapId);
    base.npcs = npcs.map((n, i) => ({ id: n.id, name: n.name, x: n.x, y: n.y, gridX: i, gridY: i, role: 'VILLAGER', talkable: true, isAnimal: false, isShop: false }));
    base.exits = portals[me.mapId].map(p => ({ id: p.id, name: `往${MAP_NAME[p.to]}`, x: p.x, y: p.y, targetMapId: p.to, targetMapName: MAP_NAME[p.to] }));
    base.shops = [];
    const point = {
      id: POINT.id, name: '虛構礦脈', mapId: POINT.mapId, mapName: MAP_NAME[POINT.mapId], x: POINT.x, y: POINT.y, skillId: 5, skillName: '挖礦',
      requiredToolItemId: opts.requireTool ? TOOL.itemId : null, ...(opts.requireTool ? { requiredToolName: TOOL.name } : {}),
      materials: [{ itemId: ORE.itemId, name: ORE.name, reqLevel: 1 }],
    };
    base.gatherPoints = { status: 'AVAILABLE', points: me.mapId === POINT.mapId ? [point] : [] };
    base.nearbyGatherPoints = me.mapId === 'm-b1' ? [point] : [];
    base.quests = quests.map(q => ({
      questId: q.questId, title: q.title, npcId: q.npc.id, npcName: q.npc.name, minLevel: 1, status: q.status, regionId: q.regionId,
      objectives: [{ type: 'TALK_TO_NPC', description: `與「${q.npc.name}」交談`, current: q.status === 'AVAILABLE' ? 0 : 1, required: 1, met: q.status !== 'AVAILABLE' }],
      rewardExp: 10, rewardCoins: 0,
    }));
    base.activity = {
      dialog: dialog ? { npcId: dialog.npc.id, npcName: dialog.npc.name, lines: ['虛構對白'], options: dialogOptions() } : null,
      shop: null,
      battleResult,
      battle: battle ? { battleId: battle.battleId, round: 1, enemies: [{ slot: 0, id: 'mob', name: '虛構野狼', hp: 10, maxHp: 10 }], canFlee: true } : null,
      command: null,
    };
    base.nav = { status: 'AVAILABLE', reachableMaps: [], pixelWidth: 1000, pixelHeight: 1000 };
    delete (base as Partial<SceneSnapshot>).family;
    return base;
  }

  function dialogOptions() {
    if (!dialog) return [];
    const q = dialog.questId !== null ? quests.find(x => x.questId === dialog!.questId) : undefined;
    const opts2 = [];
    if (q?.status === 'AVAILABLE') opts2.push({ id: `ACCEPT_QUEST:${q.questId}`, label: '答應' });
    if (q?.status === 'READY') opts2.push({ id: `COMPLETE_QUEST:${q.questId}`, label: '回報' });
    opts2.push({ id: 'CLOSE', label: '離開' });
    return opts2;
  }

  const sendSnapshot = (reason: 'STARTED' | 'REQUESTED' | 'MAP_CHANGED' | 'SCENE_RELOADED' = 'REQUESTED') =>
    push({ ...env(), kind: 'snapshot', seq: seq++, reason, snapshot: snapshot() });
  const sendStatic = () => push({
    ...env(), kind: 'static-data', seq: seq++,
    staticData: { ...JSON.parse(JSON.stringify(ex.staticData.staticData)), portalGraph: graph(), regions: [R_A, R_B] },
  });
  const heartbeat = () => push({ ...env(), kind: 'heartbeat', sessionId: 's-f7', seq: seq++, mapId: me.mapId, phase: 'PLAYING', inBattle: !!battle });

  function moveTo(mapId: string, x: number, y: number) {
    const from = me.mapId;
    me.mapId = mapId; me.x = x; me.y = y;
    log.push(`map:${mapId}`);
    emit({ type: 'LOCATION_CHANGED', mapId, mapName: MAP_NAME[mapId], fromMapId: from, x, y, cause: 'MAP_CHANGE' });
    sendSnapshot('MAP_CHANGED');
  }

  function startBattle(lose: boolean) {
    battle = { battleId: ++battleSeq, lose };
    log.push(`battle:${battle.battleId}`);
    emit({ type: 'BATTLE_STARTED', battleId: battle.battleId, mapId: me.mapId, enemies: [{ id: 'mob', name: '虛構野狼', level: 1, slot: 0 }] });
    emit({ type: 'BATTLE_TURN_READY', battleId: battle.battleId, round: 1, canFlee: true, player: { id: 'p', name: '虛構旅者', hp: me.hp, maxHp: 100 }, enemies: [{ slot: 0, id: 'mob', name: '虛構野狼', hp: 10, maxHp: 10 }] });
  }

  function endBattle(outcome: 'WIN' | 'LOSE' | 'FLEE') {
    if (!battle) return;
    const id = battle.battleId;
    battle = null;
    battleResult = outcome === 'WIN' ? 'VICTORY' : outcome === 'LOSE' ? 'DEFEAT' : null;
    log.push(`battle-end:${outcome}`);
    emit({ type: 'BATTLE_ENDED', battleId: id, outcome });
    sendSnapshot('REQUESTED');
  }

  const transport: Transport = {
    name: 'f7-fake-host',
    start: cb => { push = cb; },
    stop: () => {},
    send(cmd) {
      sent.push(cmd);
      const c = cmd.command as { type: string; [k: string]: any };
      const reject = (code: string, msg?: string) => result(cmd, 'REJECTED', code, msg);
      switch (c.type) {
        case 'REQUEST_SNAPSHOT':
          result(cmd, 'ACCEPTED');
          later(20, () => { if (c.includeStatic) sendStatic(); sendSnapshot('REQUESTED'); });
          return;
        case 'REQUEST_STATIC_DATA':
          result(cmd, 'ACCEPTED');
          later(20, sendStatic);
          return;
        case 'WALK_TO': {
          if (battle) return reject('IN_BATTLE');
          if (c.mapId !== me.mapId) return reject('WRONG_MAP');
          result(cmd, 'ACCEPTED');
          later(300, () => {
            if (encounter && encounter.mapId === me.mapId) {
              const e = encounter;
              encounter = null;
              complete(cmd, 'ENCOUNTER', 'INTERRUPTED');
              startBattle(e.lose);
              return;
            }
            if (me.mapId !== c.mapId) { complete(cmd, 'SUPERSEDED', 'INTERRUPTED', '已不在這張地圖'); return; }
            const portal = portals[me.mapId].find(p => p.x === c.x && p.y === c.y);
            if (portal) {
              if (broken && portal.id === 'p-a2-b1') { complete(cmd, 'BLOCKED', 'FAILED', '目的地圖不存在'); return; }
              complete(cmd, 'MAP_CHANGED');
              moveTo(portal.to, portal.ex, portal.ey);
              return;
            }
            me.x = c.x; me.y = c.y;
            complete(cmd, 'ARRIVED');
          });
          return;
        }
        case 'TALK_TO_NPC': {
          const npc = [CHIEF, TRAVELER].find(n => n.id === c.npcId);
          if (!npc || npc.mapId !== me.mapId) return reject('NPC_NOT_FOUND');
          result(cmd, 'ACCEPTED');
          later(200, () => {
            const q = quests.find(x => x.npc.id === npc.id && x.status !== 'COMPLETED');
            dialog = { npc, questId: q?.questId ?? null };
            log.push(`talk:${npc.name}`);
            emit({ type: 'DIALOG_OPENED', npcId: npc.id, npcName: npc.name, role: null, lines: ['虛構對白'], optionsAvailable: true, options: dialogOptions() });
            complete(cmd, 'DIALOG_OPENED');
          });
          return;
        }
        case 'ACCEPT_QUEST':
        case 'CHOOSE_DIALOG_OPTION': {
          const optionId: string = c.type === 'ACCEPT_QUEST' ? `ACCEPT_QUEST:${c.questId}` : c.optionId;
          result(cmd, 'ACCEPTED');
          later(200, () => {
            if (optionId === 'RETURN_TO_MAP' || optionId === 'DEFEAT_RESCUE') {
              const lost = battleResult === 'DEFEAT';
              battleResult = null;
              complete(cmd, 'DONE');
              if (lost) moveTo('m-a1', 400, 400); else sendSnapshot('REQUESTED');
              return;
            }
            const [kind, raw] = optionId.split(':');
            const q = quests.find(x => String(x.questId) === raw);
            if (kind === 'ACCEPT_QUEST' && q && q.npc.mapId === me.mapId) { q.status = 'READY'; log.push(`accept:${q.questId}`); }
            else if (kind === 'COMPLETE_QUEST' && q && q.status === 'READY') { q.status = 'COMPLETED'; log.push(`complete:${q.questId}`); }
            dialog = null;
            emit({ type: 'DIALOG_CLOSED', npcId: q?.npc.id ?? 'npc' });
            complete(cmd, 'DONE');
            sendSnapshot('REQUESTED');
          });
          return;
        }
        case 'BATTLE_ACTION': {
          if (!battle) return reject('NOT_IN_BATTLE');
          result(cmd, 'ACCEPTED');
          const lose = battle.lose;
          later(200, () => { complete(cmd, 'TURN_SUBMITTED'); endBattle(lose ? 'LOSE' : 'WIN'); });
          return;
        }
        case 'BATTLE_FLEE': {
          if (!battle) return reject('NOT_IN_BATTLE');
          result(cmd, 'ACCEPTED');
          const lose = battle.lose;
          later(200, () => { complete(cmd, lose ? 'FLEE_FAILED' : 'FLED'); endBattle(lose ? 'LOSE' : 'FLEE'); });
          return;
        }
        case 'WORK_ONCE': {
          if (me.mapId !== POINT.mapId || Math.hypot(me.x - POINT.x, me.y - POINT.y) > 240) return reject('TOO_FAR', '離採集點太遠（需要 ≤ 240px），請先 WALK_TO');
          if (opts.requireTool && !me.bag.some(i => i.itemId === TOOL.itemId)) return reject('MISSING_TOOL', `缺少工具【${TOOL.name}】`);
          const used = me.bag.reduce((n, i) => n + i.count, 0);
          if (used >= me.cap) return reject('INVENTORY_FULL', '背包已滿');
          result(cmd, 'ACCEPTED');
          later(1_000, () => {
            const ore = me.bag.find(i => i.itemId === ORE.itemId);
            if (ore) ore.count += 1; else me.bag.push({ ...ORE, count: 1 });
            log.push('gather');
            emit({ type: 'INVENTORY_CHANGED', changes: [{ itemId: ORE.itemId, delta: 1, count: me.bag.find(i => i.itemId === ORE.itemId)!.count }] });
            complete(cmd, 'DONE');
            sendSnapshot('REQUESTED');
          });
          return;
        }
        default:
          return reject('NOT_IMPLEMENTED');
      }
    },
  };

  let state: FamilyState | null = null;
  const ctrl = new FamilyController(transport, { now: () => t, after: (ms, fn) => { timers.push({ at: t + ms, fn }); }, onChange: st => { state = st; } });
  let lastBeat = -1e9;
  function advance(ms: number, stepMs = 100): void {
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
      if (t - lastBeat >= 1000) { lastBeat = t; heartbeat(); }
      ctrl.tick();
    }
  }
  /** 一直推進直到條件成立（或超過上限）；回傳是否成立。 */
  function until(cond: () => boolean, maxMs = 120_000): boolean {
    const end = t + maxMs;
    while (t < end) {
      if (cond()) return true;
      advance(200);
    }
    return cond();
  }

  return {
    ctrl,
    me,
    quests,
    sent,
    log,
    regions: [R_A, R_B],
    tool: TOOL,
    get t() { return t; },
    get state() { return state; },
    boot() {
      ctrl.start();
      heartbeat();
      sendSnapshot('STARTED');
      advance(1_000);
    },
    advance,
    until,
    /** 下次在這張圖送出 WALK_TO 時被暗雷遇敵打斷；lose＝這場會輸（送回起始村）。 */
    armEncounter(mapId: string, lose = false) { encounter = { mapId, lose }; },
    fixBridge() { broken = false; sendStatic(); },
    giveTool() { me.bag.push({ ...TOOL, count: 1 }); sendSnapshot('REQUESTED'); },
    sendSnapshot,
  };
}

export type F7World = ReturnType<typeof createF7World>;
