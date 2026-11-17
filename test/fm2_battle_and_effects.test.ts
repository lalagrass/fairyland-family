import { execFileSync } from 'node:child_process';
import ex from '../src/protocol/examples.json';
import type { GameEvent, StaticSkillSummary } from '../src/protocol/index';
import { applyMessage, initialState } from '../src/state';
import { defaultEffectRegistry } from '../src/render/effects/registry';
import { ParticleSimulation } from '../src/render/effects/particleEmitter';
import { isValidEffectScript } from '../src/render/effects/schema';
import { buildBattlePlayback, evaluateBattleFrame } from '../src/render/battleTimeline';
import { assert, done, suite } from './helpers';

function assertEq<T>(actual: T, expected: T, msg: string): void {
  assert(actual === expected, `${msg}（實際：${String(actual)}，預期：${String(expected)}）`);
}

suite('FM2 戰鬥時間軸播放器與特效腳本');

// 1. 驗證每個原共用 sp129 的 6 個技能都有各自獨立的腳本（id 不重複）
const sharedSixSkills = [2261, 2262, 2263, 2293, 1021, 1023];
const resolvedScriptIds = new Set<string>();
for (const skillId of sharedSixSkills) {
  const script = defaultEffectRegistry.resolve({ skillId, effectId: 'sp129' });
  assert(isValidEffectScript(script), `技能 ${skillId} 腳本通過格式驗證`);
  assert(!resolvedScriptIds.has(script.id), `技能 ${skillId} 不與其他技能共用腳本（${script.id}）`);
  resolvedScriptIds.add(script.id);
}
assertEq(resolvedScriptIds.size, 6, '6 個原 sp129 技能對應 6 支獨立特效腳本');

// 2. 驗證 staticData.skills 內所有技能都能解析到有效特效腳本（含執行時 FX12 包裝）
const skills = (ex.staticData.staticData.skills ?? []) as StaticSkillSummary[];
for (const sk of skills) {
  const script = defaultEffectRegistry.resolve({ skillId: sk.id, actionName: sk.name, effectId: sk.animId }, skills);
  assert(isValidEffectScript(script), `staticData 技能 ${sk.id} (${sk.name}) 可解析為有效特效腳本`);
}

// 3. 粒子模擬器 step 與衰退
const shockScript = defaultEffectRegistry.resolve({ skillId: 2261 });
assert(Boolean(shockScript.particles), '2261 腳本應帶粒子設定');
const sim = new ParticleSimulation(shockScript.particles!.config, 42);
const initialCount = sim.particles.length;
assert(initialCount > 0, '粒子系統初始產生第一波粒子');
sim.step(0.05);
sim.step(0.05);
assert(sim.particles.length >= initialCount, '持續發射階段維持或增加粒子數');
for (let i = 0; i < 20; i += 1) sim.step(0.05);
assertEq(sim.particles.length, 0, '經過 1 秒後超過 maxAge 的粒子應全部自然消逝');

// 4. FX14 BATTLE_STARTED + BATTLE_TIMELINE 寫入 state 並逐步播放評估
let st = initialState();
st = applyMessage(st, ex.staticData, 1000);
st = applyMessage(st, ex.snapshot, 1000);

const startMsg = {
  v: 4,
  characterId: ex.snapshot.characterId,
  ts: 2000,
  kind: 'event',
  seq: 50,
  event: {
    type: 'BATTLE_STARTED',
    battleId: 77,
    mapId: '10001',
    enemies: [{ id: 'enemy-1', slot: 0, name: '史萊姆', level: 3, modelId: 'MBA011' }],
    allies: [{ id: 'p1', name: '阿武', slot: 0, hp: 100, maxHp: 100, mp: 30, maxMp: 30, modelId: 'PHM011' }],
  } satisfies GameEvent,
};
st = applyMessage(st, startMsg, 2000);
assert(st.battle !== null && st.battle.battleId === 77, 'BATTLE_STARTED 建立戰鬥狀態 #77');
assertEq(st.battle?.enemyVisuals?.[0]?.modelId, 'MBA011', '保留敵方 modelId 與外觀資訊');

const turnReadyMsg = {
  v: 4,
  characterId: ex.snapshot.characterId,
  ts: 2050,
  kind: 'event',
  seq: 50.5,
  event: {
    type: 'BATTLE_TURN_READY',
    battleId: 77,
    round: 1,
    enemies: [{ slot: 0, id: 'enemy-1', name: '史萊姆', hp: 50, maxHp: 50, modelId: 'MBA011' }],
    canFlee: true,
    player: { id: 'p1', name: '阿武', hp: 100, maxHp: 100, mp: 30, maxMp: 30, modelId: 'PHM011' },
  } satisfies GameEvent,
};
st = applyMessage(st, turnReadyMsg, 2050);

const tlMsg = {
  v: 4,
  characterId: ex.snapshot.characterId,
  ts: 2100,
  kind: 'event',
  seq: 51,
  event: {
    type: 'BATTLE_TIMELINE',
    battleId: 77,
    round: 1,
    events: [
      { tMs: 0, type: 'ROUND_START' },
      { tMs: 180, type: 'ACTION_START', actorId: 'p1', targetId: 'enemy-1', actionName: '破甲重擊', skillId: 2263, effectId: 'sp129' },
      { tMs: 480, type: 'DAMAGE', actorId: 'p1', targetId: 'enemy-1', damage: 50, isCrit: true },
      { tMs: 520, type: 'STATUS_APPLY', targetId: 'enemy-1', statusType: 'DEF_DOWN' },
      { tMs: 650, type: 'DEATH', targetId: 'enemy-1' },
    ],
  } satisfies GameEvent,
};
st = applyMessage(st, tlMsg, 2100);
assert(st.battle?.timeline?.events.length === 5, 'BATTLE_TIMELINE 正確儲存在 state.battle.timeline');

const plan = buildBattlePlayback({
  round: st.battle!.timeline!.round,
  allies: st.battle!.allies,
  enemyVisuals: st.battle!.enemyVisuals,
  enemyStates: st.battle!.enemyStates,
  events: st.battle!.timeline!.events,
  skillsCatalog: st.staticData?.skills ?? [],
});

const at0 = evaluateBattleFrame(plan, 0);
assertEq(at0.units.find(u => u.id === 'enemy-1')?.hp, 50, 't=0ms 敵方滿血 50');
assertEq(at0.effects.length, 0, 't=0ms 尚未觸發特效');

const at220 = evaluateBattleFrame(plan, 220);
assertEq(at220.effects.length, 1, 't=220ms 正在播放 破甲重擊 特效');
assertEq(at220.effects[0].script.id, 'skill_2263_armor_break', 't=220ms 命中的是獨立腳本 skill_2263_armor_break 而非共用 sp129');
const actor220 = at220.units.find(u => u.id === 'p1')!;
assert(actor220.x < 600, 't=220ms 出手角色向前踏步接近左方敵人');

const at540 = evaluateBattleFrame(plan, 540);
const enemy540 = at540.units.find(u => u.id === 'enemy-1')!;
assertEq(enemy540.hp, 0, 't=540ms DAMAGE 事件扣除敵方 HP 至 0');
assert(at540.popups.some(p => p.text.includes('暴擊 -50')), 't=540ms 顯示暴擊飄字');
assert(enemy540.statuses.includes('DEF_DOWN'), 't=540ms 套用 DEF_DOWN 狀態');

const at700 = evaluateBattleFrame(plan, 700);
assert(at700.units.find(u => u.id === 'enemy-1')?.isDead === true, 't=700ms 敵方標記死亡');

// 5. CLI check-effects.mjs 通過
const checkOut = execFileSync('node', ['scripts/check-effects.mjs'], { encoding: 'utf8' });
assert(checkOut.includes('OK'), 'scripts/check-effects.mjs 檢查通過');

done();
