import { Window } from 'happy-dom';
import { execFileSync } from 'node:child_process';
import ex from '../src/protocol/examples.json';
import type { StaticAssetManifest } from '../src/protocol/index';
import { applyMessage, initialState } from '../src/state';
import {
  OriginalAppearanceProvider,
  type SpriteModelManifest,
} from '../src/render/appearance';
import {
  computeIntegerScale,
  getDirection8,
  interpolateMemberPosition,
  selectCameraTarget,
} from '../src/render/extrapolation';
import { assert, done, suite } from './helpers';

function assertEq<T>(actual: T, expected: T, msg: string): void {
  assert(actual === expected, `${msg}（實際：${String(actual)}，預期：${String(expected)}）`);
}

const win = new Window({ url: 'http://localhost:5173/family/' });
Object.assign(globalThis, {
  window: win,
  document: win.document,
  HTMLElement: win.HTMLElement,
  HTMLSelectElement: win.HTMLSelectElement,
  HTMLInputElement: win.HTMLInputElement,
  HTMLButtonElement: win.HTMLButtonElement,
  Element: win.Element,
  Node: win.Node,
  Event: win.Event,
  MouseEvent: win.MouseEvent,
  localStorage: win.localStorage,
});

const { mountUi } = await import('../src/ui');

suite('FM1 外觀提供者、FX13 位置插值、彈性版面與無原版素材檢查');

// 1. OriginalAppearanceProvider + FX12 樣板
const provider = new OriginalAppearanceProvider();
const assets: StaticAssetManifest = (ex.staticData.staticData as { assets?: StaticAssetManifest }).assets ?? {
  version: '4',
  baseUrl: '/assets',
  readOnly: true,
  paths: {
    spriteManifest: '/assets/sprites/{modelId}/manifest.json',
    spriteAtlas: '/assets/sprites/{modelId}/{file}',
    mapScene: '/assets/maps/{mapId}/map_{mapId}.json',
    mapAsset: '/assets/maps/{mapId}/{file}',
    spellManifest: '/assets/spells/{spellId}/manifest.json',
    spellAtlas: '/assets/spells/{spellId}/{file}',
    worldCatalog: '/assets/world_catalog.json',
    battleBg: '/assets/battle_bg/{bgId}.png',
    itemIcon: '/assets/items/{iconId}.png',
    digitsManifest: '/assets/digits/manifest.json',
  },
  spriteLayerOrder: ['body', 'head', 'hair', 'armor', 'cape', 'weapon'],
  supportedBlendModes: ['normal', 'additive'],
};
assertEq(
  provider.resolveSpriteManifestUrl('PHM011', assets),
  '/assets/sprites/PHM011/manifest.json',
  'FX12 樣板展開正確的同源 manifest URL',
);

const syntheticManifest: SpriteModelManifest = {
  model: 'PHM011',
  center_x: 60,
  center_y: 80,
  layers: [
    { slot: 'body', key: 'Body', zIndex: 10 },
    { slot: 'weapon', key: 'WP01', variant: 'WP01', zIndex: 20 },
    { slot: 'hair', key: 'Hair', zIndex: 30 },
  ],
  actions: {
    '1': {
      '6': { loop: 1, speed: 8, frames: [10, 11] },
    },
    '21': {
      '0': { loop: 0, speed: 8, frames: [17] },
    },
  },
  frames: {
    Body: {
      '11': { atlas: 'atlas_0.png', x: 10, y: 20, w: 40, h: 60, draw_x: 42, draw_y: 35 },
    },
    WP01: {
      '11': { file: 'WP01/0011.png', w: 20, h: 30, draw_x: 65, draw_y: 45 },
    },
    Hair: {
      '11': { atlas: 'atlas_0.png', x: 50, y: 20, w: 20, h: 20, draw_x: 50, draw_y: 25 },
    },
  },
};

const plan = provider.resolveCharacter(
  {
    id: 'c1',
    name: '阿武',
    kind: 'player',
    modelId: 'PHM011',
    weaponModel: 'WP01',
    tint: { hair: [255, 128, 0], skin: [250, 210, 180], outfit: [30, 80, 160] },
    action: 1,
    dir: 6,
    nowMs: 125, // step = 1 => frame 11
  },
  syntheticManifest,
  assets,
);
assertEq(plan.resolvedAction, 1, '走路動作命中動作 1');
assertEq(plan.frameNumber, 11, '依速度 8fps 在 125ms 取第 2 幀');
assertEq(plan.layers.length, 3, '三層圖層均解析完成');
assertEq(plan.layers[0].slot, 'body', '依 zIndex 排序（body -> weapon -> hair）');
assertEq(plan.layers[0].imageUrl, '/assets/sprites/PHM011/atlas_0.png', 'FX12 spriteAtlas 樣板展開正確');
assertEq(plan.layers[0].offsetX, -18, 'offsetX = draw_x - center_x');
assertEq(plan.layers[2].tintColor, '#ff8000', '頭髮染色轉為十六進位色碼');

// 2. getDirection8 + FX13 movePath 插值
assertEq(getDirection8(0, 10), 0, '正南 direction = 0');
assertEq(getDirection8(-10, 0), 2, '正西 direction = 2');
assertEq(getDirection8(0, -10), 4, '正北 direction = 4');
assertEq(getDirection8(10, 0), 6, '正東 direction = 6');

const movingPose = interpolateMemberPosition(
  {
    x: 200,
    y: 100,
    dir: 0,
    action: 'WALK',
    movePath: {
      waypoints: [
        { x: 100, y: 100 },
        { x: 200, y: 100 },
      ],
      startedAt: 1000,
      endsAt: 2000,
    },
  },
  1500,
);
assertEq(movingPose.x, 150, 'movePath 50% 時間正確插值 X=150');
assertEq(movingPose.y, 100, 'movePath 50% 時間正確插值 Y=100');
assertEq(movingPose.dir, 6, '往東移動方向應為 6 (E)');
assertEq(movingPose.actionCode, 1, '移動中為 WALK 動作碼 1');

const workPose = interpolateMemberPosition(
  {
    x: 320,
    y: 240,
    dir: 2,
    action: 'WORK',
    movePath: null,
  },
  3000,
);
assertEq(workPose.actionCode, 20, 'WORK 對應原版動作碼 20');
assertEq(computeIntegerScale(1280, 720), 1, '720p 寬畫面自動 1x 整數倍率');
assertEq(computeIntegerScale(1920, 1080), 2, '1080p 寬畫面自動 2x 整數倍率');

// 3. UI 掛載：clockOnly -> 時鐘運作中、Radix 分頁、選角色切鏡頭、selectCameraTarget
let st = initialState();
st = applyMessage(st, ex.staticData, 1000);
st = applyMessage(st, ex.snapshot, 1000);
st.clockOnly = true;

const baseMembers = st.members;
if (baseMembers.length >= 2) {
  const camTarget = selectCameraTarget(st, baseMembers[1].characterId);
  assert(camTarget !== null && camTarget.characterId === baseMembers[1].characterId, 'selectCameraTarget 可鎖定第二位家族成員');
}

const root = win.document.createElement('div');
win.document.body.appendChild(root);
const ui = mountUi(root as unknown as HTMLElement, 'TEST', () => null, () => null);
ui.render(st, 'RUNNING');

const clockPill = root.querySelector('[data-testid="clock-only-pill"]');
assertEq(clockPill?.textContent, '時鐘運作中', '宿主 ?clock=1 時狀態列顯示「時鐘運作中」');
assert(root.querySelector('[data-testid="game-stage-panel"]') !== null, '畫面區渲染 GameViewport');

const tabs = root.querySelectorAll('[data-testid="mobile-tabs"] [role="tab"]');
assertEq(tabs.length, 4, 'Radix 手機版分頁應包含 4 個頁籤（畫面 / 名冊 / 目前角色 / 事件流）');

const watchBtns = root.querySelectorAll('[data-testid="watch-char-btn"]');
if (watchBtns.length >= 2) {
  (watchBtns[1] as unknown as HTMLButtonElement).click();
  const camText = root.querySelector('[data-testid="stage-camera-target"]')?.textContent ?? '';
  assert(camText.includes(baseMembers[1].name ?? baseMembers[1].characterId), '按看鏡頭後畫面追蹤目標切換至該成員');
}

// 4. 檢查腳本 check-no-original-assets.mjs
const out = execFileSync('node', ['scripts/check-no-original-assets.mjs'], { encoding: 'utf8' });
assert(out.includes('OK'), 'check-no-original-assets.mjs 應檢查通過且 repo 無原版圖檔');

done();
