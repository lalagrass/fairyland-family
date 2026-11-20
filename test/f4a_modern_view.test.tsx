import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PROTOCOL_VERSION, type PluginMessage } from '../src/protocol/index';
import { applyMessage, initialState, type FamilyState } from '../src/state';
import { GameViewport } from '../src/render/GameViewport';
import { observerStatus } from '../src/render/observer';
import {
  CharacterViewModeStore,
  buildModernModel,
  clampCamera,
  clampZoom,
  minimapPoint,
  minimapToWorld,
  modernLayout,
  pathAhead,
  stageDisplayState,
  stepCamera,
  type ViewMode,
} from '../src/render/viewMode';
import { createWorld } from './f2_world';
import { assert, done, suite } from './helpers';

// 全部是 f2_world 的虛構資料，沒有任何原版素材。
function booted(w: ReturnType<typeof createWorld>): FamilyState {
  let s = initialState();
  const msg = (m: unknown, now: number) => { s = applyMessage(s, m as PluginMessage, now); };
  msg({ v: PROTOCOL_VERSION, characterId: 'char_1', ts: 1, kind: 'heartbeat', sessionId: 's1', seq: 1, mapId: '99001', phase: 'PLAYING', inBattle: false }, 1000);
  msg({ v: PROTOCOL_VERSION, characterId: 'char_1', ts: 2, kind: 'snapshot', seq: 2, reason: 'STARTED', snapshot: w.snapshotFor('char_1') }, 1000);
  return s;
}

function viewport(state: FamilyState, mode: ViewMode, watch: string | null = null): string {
  return renderToStaticMarkup(
    <GameViewport state={state} watchCharacterId={watch} onSelectWatchCharacter={() => {}} viewModes={{ char_1: mode, char_2: mode }} onSetViewMode={() => {}} />,
  );
}

suite('F4a 顯示模式設定：每個角色各自選，存本機');
{
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
  const a = new CharacterViewModeStore(storage);
  assert(a.get('char_1') === 'original' && a.get(null) === 'original', '預設原版');
  a.set('char_1', 'modern');
  const b = new CharacterViewModeStore(storage);
  assert(b.get('char_1') === 'modern' && b.get('char_2') === 'original', '重開後保留，且只影響該角色');
  b.set('char_1', 'original');
  assert(new CharacterViewModeStore(storage).get('char_1') === 'original', '改回原版也保留');
  mem.set('fairyland_family:char_view_modes:v1', '{壞掉');
  assert(new CharacterViewModeStore(storage).get('char_1') === 'original', '損毀設定退回原版，不丟錯');
  assert(new CharacterViewModeStore({ getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } }).set('c', 'modern') === 'modern', '儲存空間不可用也不丟錯');
}

suite('F4a 切換顯示模式不影響快照／事件處理，也不送任何指令');
{
  const w = createWorld();
  w.boot();
  w.advance(500);
  const ctrl = w.ctrl;
  const sentBefore = w.sent.length;
  const tBefore = w.t;
  const stateBefore = JSON.stringify(ctrl.state);
  ctrl.perform({ kind: 'CHAR_VIEWMODE_UPDATE', characterId: 'char_1', viewMode: 'modern', label: 'x' });
  assert(ctrl.charViewModes()['char_1'] === 'modern', '設定生效');
  assert(JSON.stringify(ctrl.state) === stateBefore, '切換只改本機設定，不動快照／事件狀態');
  assert(w.sent.length === sentBefore, '切換沒有送出任何指令給宿主');
  assert(w.t === tBefore, '切換不動時鐘');
  // 兩種模式下，事件照常套用
  w.emitEvent('char_1', { type: 'MOVED', mapId: '99001', x: 1234, y: 2345, dir: 2 });
  w.advance(500);
  assert(ctrl.state.eventMirror.x === 1234 && ctrl.state.eventMirror.y === 2345, '現代模式下事件照常更新狀態');
  ctrl.perform({ kind: 'CHAR_VIEWMODE_UPDATE', characterId: 'char_1', viewMode: 'original', label: 'x' });
  w.emitEvent('char_1', { type: 'MOVED', mapId: '99001', x: 10, y: 20, dir: 2 });
  w.advance(500);
  assert(ctrl.state.eventMirror.x === 10 && ctrl.state.eventMirror.y === 20, '切回原版後事件照常更新狀態');
  assert(new (ctrl.constructor as typeof import('../src/controller').FamilyController)(w.transport, { storage: w.storage }).charViewModes()['char_1'] === undefined, '設定回原版後重開沒有殘留');
}

suite('F4a 現代畫面模型：只由快照推導，建模不改 state');
{
  const w = createWorld();
  const s = booted(w);
  const before = JSON.stringify(s);
  const sentBefore = w.sent.length;
  const m = buildModernModel(s, null, 1500);
  assert(JSON.stringify(s) === before && w.sent.length === sentBefore, '建模不改 state、不送指令');
  assert(m.status.kind === 'OK' && m.mapName === '虛構草原', '連線且有快照：可畫');
  assert(m.markers.some(x => x.kind === 'npc') && m.markers.some(x => x.kind === 'gather'), '有 NPC 與採集點標記');
  assert(m.markers.filter(x => x.kind === 'member').length === 2 && m.target?.characterId === 'char_1', '兩位成員，鏡頭目標是視角角色');
  assert(m.markers.find(x => x.isTarget)?.id === 'member:char_1', '目標被標記');
  const m2 = buildModernModel(s, 'char_2', 1500);
  assert(m2.target?.characterId === 'char_2', '改看另一位角色：目標跟著換（唯讀）');
}

suite('F4a 路徑線與鏡頭、縮放、小地圖');
{
  const mp = { waypoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], startedAt: 1000, endsAt: 3000 };
  assert(pathAhead(null, 1500).length === 0 && pathAhead(mp, 3000).length === 0, '沒路徑或走完：沒有路徑線');
  const mid = pathAhead(mp, 2000);
  assert(mid.length === 2 && mid[1].x === 100 && mid[1].y === 100 && mid[0].x === 100, '走到一半：從目前位置到終點，已走過的點被丟掉');
  const start = pathAhead(mp, 1000);
  assert(start.length === 3, '剛出發：整條路徑');

  let cam = stepCamera(null, { x: 0, y: 0 }, 'a', 16);
  cam = stepCamera(cam, { x: 1000, y: 0 }, 'a', 120);
  assert(Math.abs(cam.x - 500) < 1, '半衰期 120ms：一個半衰期走一半（平滑跟隨）');
  const far = stepCamera(cam, { x: 9000, y: 0 }, 'a', 16);
  assert(far.x === 9000, '距離太遠直接定位');
  assert(stepCamera(cam, { x: 5, y: 5 }, 'b', 16).x === 5, '換地圖直接定位');
  assert(stepCamera(cam, { x: 1000, y: 0 }, 'a', 0).x === cam.x, 'dt=0 不動');

  assert(clampZoom(0) === 0.1 && clampZoom(99) === 2 && clampZoom(NaN) === 1 && clampZoom(0.5) === 0.5, '縮放夾在範圍內');
  const c = clampCamera({ x: -50, y: 99999 }, 1000, 1000, 400, 300, 1);
  assert(c.x === 200 && c.y === 850, '鏡頭不出地圖');
  assert(clampCamera({ x: 0, y: 0 }, 100, 100, 400, 300, 1).x === 50, '地圖比視窗小：置中');

  const p = minimapPoint(500, 250, 1000, 1000, 100, 100);
  assert(p.x === 50 && p.y === 25, '小地圖座標換算');
  const back = minimapToWorld(50, 25, 1000, 1000, 100, 100);
  assert(back.x === 500 && back.y === 250, '小地圖點擊換回世界座標');
  assert(minimapPoint(-5, 99999, 1000, 1000, 100, 100).y === 100, '超出範圍夾在邊內');
}

suite('F4a 窄螢幕版面');
{
  const phone = modernLayout(360, 450, 8000, 8000);
  const desk = modernLayout(900, 500, 8000, 8000);
  assert(phone.narrow && !desk.narrow, '寬度 < 480 視為窄螢幕');
  assert(phone.miniW <= 360 * 0.3 && phone.miniH <= 450 * 0.4, '窄螢幕小地圖不超過畫面 30%／40%');
  assert(desk.miniW > phone.miniW, '桌面版小地圖較大');
  const wide = modernLayout(360, 450, 8000, 2000);
  assert(wide.miniW > wide.miniH, '小地圖依地圖長寬比');
}

suite('F4a 未連線：兩種模式都有明確顯示');
{
  for (const mode of ['original', 'modern'] as const) {
    const off = stageDisplayState(initialState(), mode, null, 5000);
    assert(off.status.kind === 'OFFLINE' && off.status.text.includes('未連線'), `${mode}：從未連線 → 明確說宿主未連線`);
    // 從未連線的初始狀態沒有角色可存設定，只能是原版；現代模式用「連過線、心跳已逾時」的狀態驗證
    const stale = booted(createWorld());
    const html = viewport(mode === 'modern' ? stale : initialState(), mode);
    assert(html.includes('data-testid="observer-status"') && html.includes('data-kind="OFFLINE"') && html.includes('宿主未連線'), `${mode}：畫面上有未連線提示`);
    assert(html.includes(`data-view-mode="${mode}"`), `${mode}：畫面標明目前模式`);
  }
  const w = createWorld();
  const s = booted(w);
  assert(observerStatus(s, null, 1000 + 60_000).kind === 'OFFLINE', '心跳逾時＝未連線');
  assert(buildModernModel(s, null, 1000 + 60_000).status.kind === 'OFFLINE', '現代模型：心跳逾時也標示未連線（不把過期地圖當現況）');
  for (const mode of ['original', 'modern'] as const) {
    const html = renderToStaticMarkup(
      <GameViewport state={s} watchCharacterId={null} onSelectWatchCharacter={() => {}} viewModes={{ char_1: mode }} onSetViewMode={() => {}} />,
    );
    // 靜態渲染用 Date.now()，離 1000ms 的測試時間很遠 → 一定逾時
    assert(html.includes('data-kind="OFFLINE"'), `${mode}：心跳逾時的畫面標示未連線`);
  }
  const noSnap = applyMessage(initialState(), { v: PROTOCOL_VERSION, characterId: 'char_1', ts: 1, kind: 'heartbeat', sessionId: 's', seq: 1, mapId: null, phase: 'OPENING', inBattle: false } as PluginMessage, Date.now());
  for (const mode of ['original', 'modern'] as const) {
    assert(viewport(noSnap, mode).includes('data-kind="NO_SNAPSHOT"'), `${mode}：有心跳沒快照 → 等待快照提示`);
  }
}

suite('F4a 模式切換器');
{
  const html = viewport(booted(createWorld()), 'modern');
  assert(html.includes('data-testid="stage-view-mode-select"') && html.includes('data-testid="modern-zoom-in"'), '現代模式有切換器與縮放鈕');
  assert(html.includes('data-testid="modern-host"') && !html.includes('data-testid="original-host"'), '現代模式使用現代畫布');
  const orig = viewport(initialState(), 'original');
  assert(orig.includes('data-testid="original-host"') && !orig.includes('modern-zoom-in'), '原版模式不顯示現代縮放鈕');
}

done();
