import { execFileSync, spawnSync } from 'node:child_process';
import ex from '../src/protocol/examples.json';
import type { GameEvent } from '../src/protocol/index';
import { FamilyController } from '../src/controller';
import {
  getAppearanceProvider,
  originalAppearanceProvider,
  wuxiaTestAppearanceProvider,
} from '../src/render/appearance';
import { buildBattlePlayback, evaluateBattleFrame } from '../src/render/battleTimeline';
import { resolveSkillDisplay } from '../src/render/skillDisplayMap';
import type { Transport } from '../src/transport/types';
import { assert, done, suite } from './helpers';

function assertEq<T>(actual: T, expected: T, msg: string): void {
  assert(actual === expected, `${msg}（實際：${String(actual)}，預期：${String(expected)}）`);
}

function makeMemoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
  };
}

function makeDummyTransport(): Transport {
  return { name: 'dummy', start() {}, stop() {}, send() {} };
}

suite('FM3 可替換外觀、同畫面混用原版與測試外觀、技能顯示對照與 FL4 缺漏檢查');

// 1. 同一畫面可以分別使用 原版 與 新外觀(幾何測試)
assertEq(getAppearanceProvider('original').id, 'original', '支援 original 外觀提供者');
assertEq(getAppearanceProvider('wuxia-test').id, 'wuxia-test', '支援 wuxia-test 第二外觀提供者');

for (const actionCode of [1, 20, 4] as const) {
  const plan = wuxiaTestAppearanceProvider.resolveCharacter({
    id: 'char_2',
    name: '二號武者',
    kind: 'member',
    modelId: 'PHM011',
    action: actionCode,
    dir: 6,
    nowMs: 160,
  });
  assert((plan.vectorLayers?.length ?? 0) >= 4, `新外觀動作 ${actionCode} 應輸出多層幾何圖層`);
  assertEq(originalAppearanceProvider.resolveCharacter({
    id: 'char_1',
    name: '一號原版',
    kind: 'player',
    modelId: 'PHM011',
    action: actionCode,
    dir: 6,
    nowMs: 160,
  }).providerId, 'original', `同一畫面角色可並行保留 original 外觀`);
}

// 2. 每角色各自設定外觀並持久化到 localStorage
const storage = makeMemoryStorage();
const ctrl = new FamilyController(makeDummyTransport(), { storage });
ctrl.perform({
  kind: 'CHAR_APPEARANCE_UPDATE',
  characterId: 'char_1',
  appearanceId: 'original',
  label: 'char_1 原版',
});
ctrl.perform({
  kind: 'CHAR_APPEARANCE_UPDATE',
  characterId: 'char_2',
  appearanceId: 'wuxia-test',
  label: 'char_2 測試新外觀',
});

const reloaded = new FamilyController(makeDummyTransport(), { storage });
assertEq(reloaded.charAppearances()['char_1'], 'original', '重啟保留 char_1 為 original');
assertEq(reloaded.charAppearances()['char_2'], 'wuxia-test', '重啟保留 char_2 為 wuxia-test');

// 3. 技能顯示對照表（新外觀改顯示名稱／圖示／特效腳本，傷害仍照原版事件）
const origDisp = resolveSkillDisplay('original', 2261, '衝擊');
assertEq(origDisp.displayName, '衝擊', '原版外觀維持原技能名稱');
const wuxiaDisp = resolveSkillDisplay('wuxia-test', 2261, '衝擊');
assertEq(wuxiaDisp.displayName, '破風寸勁', '新外觀映射技能顯示名稱');
assert(wuxiaDisp.iconGlyph !== '⚔️', '新外觀附專屬技能圖示符號');
assertEq(wuxiaDisp.overrideScriptId, 'skill_2261_shock_dash', '新外觀綁定對應特效腳本');

const plan = buildBattlePlayback({
  round: 1,
  allies: [{ id: 'p1', name: '二號武者', hp: 100, maxHp: 100 }],
  enemyStates: [{ slot: 0, id: 'enemy-1', name: '史萊姆', hp: 80, maxHp: 80 }],
  events: [
    { tMs: 100, type: 'ACTION_START', actorId: 'p1', targetId: 'enemy-1', actionName: '衝擊', skillId: 2261 },
    { tMs: 300, type: 'DAMAGE', actorId: 'p1', targetId: 'enemy-1', damage: 25 },
  ],
  attackerAppearanceId: 'wuxia-test',
});
const at200 = evaluateBattleFrame(plan, 200);
assert(at200.popups.some(p => p.text.includes('破風寸勁')), '戰鬥播放使用新外觀映射後的技能名稱');
const at350 = evaluateBattleFrame(plan, 350);
assertEq(at350.units.find(u => u.id === 'enemy-1')?.hp, 55, '傷害數值仍嚴格照原版事件（80 - 25 = 55）');

// 4. 對照 FL4 無圖規格做缺漏檢查：能正確列出 wuxia_test 測試包還缺哪些項目
const res = spawnSync(
  'node',
  ['scripts/appearance_spec/check_appearance_spec.mjs', 'public/assets/appearances/wuxia_test', '--json'],
  { encoding: 'utf8' },
);
assert(res.stdout.trim().length > 0, 'FL4 缺漏檢查輸出 JSON');
const report = JSON.parse(res.stdout);
assert(report.totalMissing > 0, '測試外觀刻意精簡，應正確回報缺漏數量');
assert(report.missing.actions.length > 0, '正確列出缺少的高階／神智異常動作幀');
assert(report.missing.portraits.includes('create_human_m'), '正確列出缺少的新建角立繪');
assert(report.missing.sfx.includes('2201'), '正確列出缺少的武鬥家音效');

// 且無原版二進位素材檢查依然通過
const assetsOut = execFileSync('node', ['scripts/check-no-original-assets.mjs'], { encoding: 'utf8' });
assert(assetsOut.includes('OK'), '測試外觀與 FL4 規格加入後 repo 仍無任何原版或二進位圖檔');

done();
