/**
 * 產生 fixtures/replay_village.json（假 fairyland 的事件序列）。
 *   npx tsx scripts/make-replay-fixture.ts            （需要並排的 ../fairyland，或設 FL_FAIRYLAND_DIR）
 *
 * 場景快照由 fairyland 的 buildSceneSnapshot 對真實地圖資料（吉恩村 10001、市鎮中心 20010）產生；
 * 事件序列是「依真實遊戲會送出的順序」手排的（走路、NPC 對話、金錢、換圖、戰鬥），不是實機錄製。
 * 真實遊戲的錄製請用 fairyland 的 scripts/plugin_bridge_check.mjs。
 */
import fs from 'node:fs';
import path from 'node:path';

const fl = path.resolve(process.env.FL_FAIRYLAND_DIR || path.join(process.cwd(), '..', 'fairyland'));
const shared = await import(path.join(fl, 'packages/shared/src/index.ts'));
const { buildSceneSnapshot, buildStaticDataPayload, PROTOCOL_VERSION } = shared;
const readMap = (id: string) => JSON.parse(fs.readFileSync(path.join(fl, `packages/shared/src/data/maps/${id}.json`), 'utf8'));

const characterId = 'replay-char-1';
const village = readMap('10001');
const town = readMap('20010');
const catalog = { maps: { '20001': { name: '雜貨店' }, '20007': { name: '醫院' }, '20009': { name: '打鐵舖' }, '20010': { name: '吉恩村市鎮中心' }, '10001': { name: '吉恩村' } } };
const profile = { name: '阿草', level: 5, coins: 1200, hp: 90, mp: 40, stats: { str: 8, con: 8, int: 5, agi: 6, cha: 5, luk: 5 }, inventory: [], modelId: 'PHM011', weaponModel: 'WP01' };
// 本 repo 公開：原版提取的完整配方表與全地圖列表不放進 fixture，只留極少數示範（AGENTS.md：不轉載提取資料）。
const FIXTURE_RECIPE_LIMIT = 3;
const buildStatic = () => {
  const full = buildStaticDataPayload({ catalog });
  return {
    ...full,
    recipes: (full.recipes ?? []).slice(0, FIXTURE_RECIPE_LIMIT),
    portalGraph: (full.portalGraph ?? []).filter((n: { mapId: string }) => ['10001', '20010', '20001', '20007', '20009'].includes(n.mapId)),
    skills: (full.skills ?? []).slice(0, 6),
    assets: full.assets,
  };
};
const snap = (scene: unknown, x: number, y: number) =>
  buildSceneSnapshot({ scene, profile: { ...profile }, position: { x, y, dir: 2 }, catalog, includeStatic: false });

let seq = 0;
const base = { v: PROTOCOL_VERSION, characterId, ts: 0 };
const ev = (at: number, event: unknown) => ({ at, message: { ...base, kind: 'event', seq: ++seq, event } });
const sn = (at: number, reason: string, snapshot: unknown) => ({ at, message: { ...base, kind: 'snapshot', seq: ++seq, reason, snapshot } });
const sd = (at: number, staticData: unknown) => ({ at, message: { ...base, kind: 'static-data', seq: ++seq, staticData } });
const al = village.npcs.find((n: any) => n.name === '阿爾');
const chief = town.npcs.find((n: any) => n.role === 'CHIEF');

const steps = [
  ev(0, { type: 'GAME_STARTED', sessionId: 'replay-session' }),
  sd(30, buildStatic()),
  ev(60, { type: 'LOCATION_CHANGED', mapId: '10001', mapName: '吉恩村', fromMapId: null, x: 3880, y: 3740, cause: 'LOAD' }),
  sn(120, 'STARTED', snap(village, 3880, 3740)),
  ev(2000, { type: 'MOVED', mapId: '10001', x: 3700, y: 3700, dir: 2, action: 'WALK', movePath: { waypoints: [{ x: 3880, y: 3740 }, { x: 3700, y: 3700 }], startedAt: 1400, endsAt: 2000, speedPxPerSec: 300 } }),
  ev(2600, { type: 'MOVED', mapId: '10001', x: 3500, y: 3650, dir: 2, action: 'WALK' }),
  ev(3200, { type: 'MOVED', mapId: '10001', x: 3300, y: 3600, dir: 2, action: 'IDLE' }),
  ev(4500, { type: 'DIALOG_OPENED', npcId: al.id, npcName: al.name, role: al.role, lines: al.dialogues, options: [{ id: 'CLOSE', label: '告辭' }], optionsAvailable: true }),
  ev(7000, { type: 'DIALOG_CLOSED', npcId: al.id }),
  ev(8000, { type: 'BATTLE_STARTED', battleId: 1, mapId: '10001', enemies: [{ id: 'e1', name: '土來姆', level: 2, modelId: 'MBS101' }], allies: [{ id: 'player', name: '阿草', hp: 90, maxHp: 90, mp: 40, maxMp: 40, modelId: 'PHM011', weaponModel: 'WP01' }] }),
  ev(8100, { type: 'BATTLE_TURN_READY', battleId: 1, round: 1, enemies: [{ slot: 0, id: 'e1', name: '土來姆', hp: 30, maxHp: 30, modelId: 'MBS101' }], canFlee: true }),
  ev(9200, { type: 'BATTLE_TIMELINE', battleId: 1, round: 1, events: [{ tMs: 250, type: 'ATTACK_HIT', actorId: 'player', targetId: 'e1', actionName: '普通攻擊', damage: 18 }] }),
  ev(10000, { type: 'BATTLE_TURN_READY', battleId: 1, round: 2, enemies: [{ slot: 0, id: 'e1', name: '土來姆', hp: 12, maxHp: 30, modelId: 'MBS101' }], canFlee: true }),
  ev(12000, { type: 'BATTLE_ENDED', battleId: 1, outcome: 'WIN' }),
  ev(12500, { type: 'GOLD_CHANGED', gold: 1350, delta: 150 }),
  ev(12600, { type: 'INVENTORY_CHANGED', changes: [{ itemId: 100000, delta: 2, count: 2 }] }),
  ev(15000, { type: 'LOCATION_CHANGED', mapId: '20010', mapName: '吉恩村市鎮中心', fromMapId: '10001', x: 880, y: 1040, cause: 'MAP_CHANGE' }),
  sn(15400, 'MAP_CHANGED', snap(town, 880, 1040)),
  ev(17000, { type: 'MOVED', mapId: '20010', x: 1000, y: 900, dir: 1 }),
  ev(18500, { type: 'MOVED', mapId: '20010', x: 1060, y: 740, dir: 1 }),
  ev(20000, { type: 'DIALOG_OPENED', npcId: chief.id, npcName: chief.name, role: chief.role, lines: chief.dialogues, options: [{ id: 'CLOSE', label: '告辭' }], optionsAvailable: true }),
  ev(23000, { type: 'DIALOG_CLOSED', npcId: chief.id }),
];

const fixture = {
  format: 'fairyland-replay/1',
  description: '吉恩村→市鎮中心的示範序列：走路、阿爾對話、一場戰鬥、金錢道具、換圖、村長對話。快照來自真實地圖資料；事件順序為手排。回放模式只回應 REQUEST_SNAPSHOT，其他指令回 NOT_IMPLEMENTED（不模擬遊戲）。',
  protocolVersion: PROTOCOL_VERSION,
  characterId,
  steps,
};
fs.writeFileSync(path.join(process.cwd(), 'fixtures/replay_village.json'), JSON.stringify(fixture, null, 1) + '\n');
console.log(`fixtures/replay_village.json：${steps.length} 步`);
