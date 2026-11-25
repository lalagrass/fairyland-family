import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import ex from '../src/protocol/examples.json';
import { PROTOCOL_VERSION, type PluginMessage, type SceneSnapshot } from '../src/protocol/index';
import { packBlockedCells } from '../src/protocol/terrain';
import { FamilyController } from '../src/controller';
import { applyMessage, connectionStatus, initialState, type FamilyState } from '../src/state';
import type { Transport } from '../src/transport/types';
import { GameViewport } from '../src/render/GameViewport';
import { MultiGameViewport } from '../src/render/MultiGameViewport';
import { observerStatus } from '../src/render/observer';
import {
  FrameThrottle,
  MULTI_VIEW_STORAGE_KEY,
  MultiViewStore,
  applyCarouselSwipe,
  computeMultiViewLayout,
  resolveSwipeStep,
  stepCarouselIndex,
  tileSnapshotPollMs,
  tileTargetFps,
} from '../src/render/multiViewport';
import { MAX_TERRAIN_CACHE_ENTRIES, buildModernModel, terrainCacheSize } from '../src/render/viewMode';
import { createWorld } from './f2_world';
import { assert, done, suite } from './helpers';

// 全部使用虛構測試資料（無任何原版素材、地圖或座標）。

function makeSnapshot(charId: string, name: string, mapId: string, mapName: string, x: number, y: number, memberList: Array<{ id: string; name: string; mapId: string; mapName: string; x: number; y: number }>): SceneSnapshot {
  const base = JSON.parse(JSON.stringify(ex.snapshot.snapshot)) as SceneSnapshot & Record<string, any>;
  base.mapId = mapId;
  base.mapName = mapName;
  base.openingStage = 'DONE';
  base.character = { ...base.character, name, x, y, inBattle: false };
  base.npcs = [];
  base.exits = [];
  base.quests = [];
  base.activity = { dialog: null, shop: null, battle: null, battleResult: null, command: null };
  base.family = {
    activeCharacterId: charId,
    maxSlots: 5,
    warehouse: { gold: 0, cap: 200, items: [] },
    members: memberList.map(m => ({
      characterId: m.id,
      name: m.name,
      level: 5,
      mapId: m.mapId,
      mapName: m.mapName,
      region: null,
      x: m.x,
      y: m.y,
      gold: 100,
      satiety: 90,
      inventoryCount: 0,
      inventoryCap: 40,
      inBattle: false,
      inventory: [],
      workSkills: {},
    })),
  };
  return base as SceneSnapshot;
}

function makeSyntheticState(members: Array<{ id: string; name: string; mapId: string; mapName: string; x: number; y: number }>, activeId: string, now: number): FamilyState {
  const active = members.find(m => m.id === activeId) ?? members[0];
  let s = initialState();
  s = applyMessage(
    s,
    {
      v: PROTOCOL_VERSION,
      characterId: active.id,
      ts: now,
      kind: 'heartbeat',
      sessionId: 's-f14',
      seq: 1,
      mapId: active.mapId,
      phase: 'PLAYING',
      inBattle: false,
    } as PluginMessage,
    now,
  );
  s = applyMessage(
    s,
    {
      v: PROTOCOL_VERSION,
      characterId: active.id,
      ts: now,
      kind: 'snapshot',
      seq: 2,
      reason: 'STARTED',
      snapshot: makeSnapshot(active.id, active.name, active.mapId, active.mapName, active.x, active.y, members),
    } as PluginMessage,
    now,
  );
  return s;
}

suite('F14 版面計算：單一 / 1–4 人 / 2 欄 Grid / 窄螢幕 Carousel');
{
  const single = computeMultiViewLayout({
    memberIds: ['c1', 'c2', 'c3'],
    mode: 'single',
    focusId: 'c2',
    viewportWidth: 1280,
  });
  assert(single.presentation === 'single' && single.columns === 1 && single.tileIds.join() === 'c2', '單一模式只顯示 1 格且跟隨指定焦點');

  const one = computeMultiViewLayout({
    memberIds: ['c1'],
    mode: 'grid',
    viewportWidth: 1280,
  });
  assert(one.presentation === 'grid' && one.tileIds.length === 1 && one.columns === 1 && one.rows === 1, '只有 1 位成員時全選該 1 位');

  const two = computeMultiViewLayout({
    memberIds: ['c1', 'c2'],
    mode: 'grid',
    viewportWidth: 768,
  });
  assert(two.presentation === 'grid' && two.columns === 2 && two.rows === 1 && two.tileIds.join() === 'c1,c2', '768px 寬度 2 位成員為 1x2 Grid');

  const three = computeMultiViewLayout({
    memberIds: ['c1', 'c2', 'c3'],
    mode: 'grid',
    viewportWidth: 1024,
  });
  assert(three.presentation === 'grid' && three.columns === 2 && three.rows === 2 && three.tileIds.length === 3, '3 位成員為 2x2 Grid');

  const five = computeMultiViewLayout({
    memberIds: ['c1', 'c2', 'c3', 'c4', 'c5'],
    mode: 'grid',
    selectedIds: ['c2', 'c3', 'c4', 'c5', 'c1', 'c2', 'invalid'],
    focusId: 'c4',
    viewportWidth: 1440,
  });
  assert(five.tileIds.join() === 'c2,c3,c4,c5' && five.rows === 2 && five.columns === 2 && five.focusId === 'c4', '5 位成員去重、過濾無效 id 並夾在 4 格');

  const padMinTwo = computeMultiViewLayout({
    memberIds: ['c1', 'c2', 'c3'],
    mode: 'grid',
    selectedIds: ['c3', 'stale'],
    focusId: 'c2',
    viewportWidth: 1200,
  });
  assert(padMinTwo.tileIds.length === 2 && padMinTwo.tileIds[0] === 'c3' && padMinTwo.tileIds.includes('c2'), '選取不足 2 位時自動補滿 2 位並優先納入 focusId');

  const narrow = computeMultiViewLayout({
    memberIds: ['c1', 'c2', 'c3'],
    mode: 'grid',
    selectedIds: ['c1', 'c2', 'c3'],
    focusId: 'c2',
    viewportWidth: 390,
  });
  assert(narrow.presentation === 'carousel' && narrow.columns === 1 && narrow.activeIndex === 1 && narrow.focusId === 'c2', '390px 窄版改為 1 欄 carousel 並對準 activeIndex');
}

suite('F14 滑動邏輯、幀率與輪詢間隔、FrameThrottle 與 MultiViewStore');
{
  assert(resolveSwipeStep(200, 160) === 1, '左滑 >= 40px 切下一位');
  assert(resolveSwipeStep(160, 200) === -1, '右滑 >= 40px 切上一位');
  assert(resolveSwipeStep(200, 161) === 0, '滑動不足 40px 不切換');
  assert(resolveSwipeStep(200, 100, 100, 300) === 0, '垂直捲動大於水平位移時不誤觸左右切換');
  assert(stepCarouselIndex(0, 3, -1) === 2 && stepCarouselIndex(2, 3, 1) === 0, '輪播索引邊界安全循環');
  assert(applyCarouselSwipe(['c1', 'c2', 'c3'], 'c1', -50) === 'c2', '套用左滑從 c1 切到 c2');
  assert(applyCarouselSwipe(['c1', 'c2', 'c3'], 'c1', 50) === 'c3', '套用右滑從 c1 切到 c3');

  assert(tileTargetFps('c1', 'c1', true) === 60, '可見焦點格 60fps');
  assert(tileTargetFps('c2', 'c1', true) === 10, '可見非焦點格 10fps');
  assert(tileTargetFps('c2', 'c2', false) === 0, '輪播隱藏格 0fps');

  assert(tileSnapshotPollMs('c1', 'c2', true) === 0, '宿主主視角角色不輪詢 (0)');
  assert(tileSnapshotPollMs('c2', 'c2', false) === 1500, '背景焦點格每 1500ms 輪詢');
  assert(tileSnapshotPollMs('c3', 'c2', false) === 4500, '背景非焦點格每 4500ms 輪詢');

  const throttle = new FrameThrottle(10);
  assert(throttle.shouldRender(1000) === true, '第一幀立即允許繪製');
  assert(throttle.shouldRender(1050) === false, '10fps 下 50ms 未滿 100ms 間隔應略過');
  assert(throttle.shouldRender(1099) === false, '10fps 下 99ms 仍略過');
  assert(throttle.shouldRender(1100) === true, '10fps 下滿 100ms 放行');
  throttle.setTargetFps(60);
  assert(throttle.shouldRender(1105) === true, 'FPS 提升（獲得焦點）時立即放行下一幀');
  assert(throttle.shouldRender(1110) === false, '60fps 下 5ms 間隔略過');
  assert(throttle.shouldRender(1121) === true, '60fps 下 >= 16ms 放行');
  throttle.setTargetFps(0);
  assert(throttle.shouldRender(5000) === false, '0fps（隱藏）封鎖繪製');
  assert(throttle.shouldRender(5000, true) === true, 'force=true 時即使 0fps 也強制繪製一次');

  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
  const s1 = new MultiViewStore(storage);
  s1.setMode('grid');
  s1.setSelectedIds(['c1', 'c2', 'c3']);
  s1.setFocusId('c2');
  const s2 = new MultiViewStore(storage);
  assert(s2.get().mode === 'grid' && s2.get().selectedIds.join() === 'c1,c2,c3' && s2.get().focusId === 'c2', 'MultiViewStore 正確寫入與還原 localStorage');
  s2.toggleSelected('c1', ['c1', 'c2', 'c3']);
  assert(s2.get().selectedIds.join() === 'c2,c3', '3 人時可取消選取其中 1 位剩下 2 位');
  s2.toggleSelected('c2', ['c1', 'c2', 'c3']);
  assert(s2.get().selectedIds.length === 2, '成員 >= 2 時至少保留 2 位並排');
  mem.set(MULTI_VIEW_STORAGE_KEY, '{bad-json');
  assert(new MultiViewStore(storage).get().mode === 'single', '損毀 JSON 安全退回 single');
  const throwingStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert(new MultiViewStore(throwingStorage).setMode('grid').mode === 'grid', '儲存空間拋錯時不中斷');
}

suite('F14 FX17 快照隔離、輪詢頻率、GAME_NOT_READY 600ms 重試與通道覆疊');
{
  const w = createWorld({ fx17: true });
  w.boot();
  // 新增第 3 位虛構角色測試 1500ms vs 4500ms 輪詢間隔，並透過名冊更新通知控制器
  w.chars['char_3'] = { id: 'char_3', name: '阿花', level: 3, gold: 50, satiety: 100, x: 3700, y: 3800, bag: 0, cap: 40 };
  w.setOffline('char_3', false);

  const origSentCount = w.sent.length;
  w.ctrl.setMultiViewWatch(['char_1', 'char_2', 'char_3'], 'char_2');
  const firstPoll = w.sent.slice(origSentCount);
  assert(firstPoll.filter(c => c.command.type === 'REQUEST_SNAPSHOT' && c.characterId === 'char_1').length === 0, '主視角 char_1 不額外輪詢 REQUEST_SNAPSHOT');
  assert(firstPoll.filter(c => c.command.type === 'REQUEST_SNAPSHOT' && c.characterId === 'char_2').length === 1, '焦點背景角色 char_2 立即要求初始快照');
  assert(firstPoll.filter(c => c.command.type === 'REQUEST_SNAPSHOT' && c.characterId === 'char_3').length === 1, '非焦點背景角色 char_3 立即要求初始快照');

  w.advance(100);
  const states1 = w.ctrl.characterStates();
  assert(w.ctrl.state.characterId === 'char_1' && w.ctrl.state.snapshot?.character.name === '愛麗絲', '主視角 state.snapshot 未被背景快照覆寫');
  assert(states1['char_2']?.snapshot?.character.name === '小石', 'char_2 的快照更新至 characterStates[char_2]');
  assert(states1['char_3']?.snapshot?.character.name === '阿花', 'char_3 的快照更新至 characterStates[char_3]');
  assert(connectionStatus(states1['char_2'], w.t) === 'RUNNING', '背景角色覆疊心跳後為 RUNNING');
  assert(observerStatus(states1['char_2'], 'char_2', w.t).kind === 'OK', '背景角色覆疊後 observerStatus 為 OK');

  // 檢驗 1500ms vs 4500ms 輪詢頻率
  const mark = w.sent.length;
  w.advance(4600);
  const pollSlice = w.sent.slice(mark);
  const c1Reqs = pollSlice.filter(c => c.command.type === 'REQUEST_SNAPSHOT' && c.characterId === 'char_1').length;
  const c2Reqs = pollSlice.filter(c => c.command.type === 'REQUEST_SNAPSHOT' && c.characterId === 'char_2').length;
  const c3Reqs = pollSlice.filter(c => c.command.type === 'REQUEST_SNAPSHOT' && c.characterId === 'char_3').length;
  assert(c1Reqs === 0 && c2Reqs >= 2 && c3Reqs === 1, `4.6 秒內主視角 0 次、焦點 >=2 次、非焦點 1 次（實際 ${c1Reqs}/${c2Reqs}/${c3Reqs}）`);

  // 檢驗背景 EVENT 路由隔離（MOVED / BATTLE_* / LOCATION_CHANGED）
  w.emitEvent('char_2', { type: 'MOVED', mapId: '99001', x: 3456, y: 3789, dir: 6 });
  assert(w.ctrl.characterStates()['char_2']?.character?.x === 3456, '背景 MOVED 更新 char_2 座標');
  assert(w.ctrl.state.snapshot?.character.x !== 3456, '背景 MOVED 不改主視角座標');

  w.emitEvent('char_2', {
    type: 'BATTLE_STARTED',
    battleId: 88,
    mapId: '99001',
    enemies: [{ id: 'e1', name: '虛構怪', level: 1, hp: 10, maxHp: 10 }],
  });
  w.emitEvent('char_2', {
    type: 'BATTLE_TURN_READY',
    battleId: 88,
    round: 1,
    enemies: [{ id: 'e1', name: '虛構怪', slot: 0, hp: 10, maxHp: 10 }],
    canFlee: true,
  });
  assert(w.ctrl.characterStates()['char_2']?.battle?.battleId === 88 && w.ctrl.state.battle === null, '背景戰鬥事件只進 char_2 狀態池，不動主視角');
  w.emitEvent('char_2', { type: 'BATTLE_ENDED', battleId: 88, outcome: 'WIN' });
  assert(w.ctrl.characterStates()['char_2']?.battle === null, '背景戰鬥結束清掉 char_2 battle');

  // 檢驗 GAME_NOT_READY -> 600ms 重試
  const timers: Array<{ at: number; fn: () => void }> = [];
  let t = 5000;
  const sentCmds: Array<{ characterId: string; commandId: string; type: string }> = [];
  const retryTransport: Transport = {
    name: 'retry-test',
    start: () => {},
    stop: () => {},
    send: msg => {
      sentCmds.push({ characterId: msg.characterId, commandId: msg.commandId, type: msg.command.type });
    },
  };
  const rc = new FamilyController(retryTransport, {
    now: () => t,
    after: (ms, fn) => { timers.push({ at: t + ms, fn }); },
  });
  rc.start();
  const baseMembers = [
    { id: 'c1', name: '一號', mapId: 'm1', mapName: '虛構圖一', x: 100, y: 100 },
    { id: 'c2', name: '二號', mapId: 'm2', mapName: '虛構圖二', x: 200, y: 200 },
  ];
  const bootState = makeSyntheticState(baseMembers, 'c1', t);
  (rc as unknown as { receive: (m: unknown) => void }).receive({
    v: PROTOCOL_VERSION, characterId: 'c1', ts: t, kind: 'heartbeat', sessionId: 'sr', seq: 1, mapId: 'm1', phase: 'PLAYING', inBattle: false,
  });
  (rc as unknown as { receive: (m: unknown) => void }).receive({
    v: PROTOCOL_VERSION, characterId: 'c1', ts: t, kind: 'snapshot', seq: 2, reason: 'STARTED', snapshot: bootState.snapshot,
  });
  sentCmds.length = 0;
  rc.setMultiViewWatch(['c1', 'c2'], 'c2');
  const req1 = sentCmds.find(c => c.characterId === 'c2' && c.type === 'REQUEST_SNAPSHOT');
  assert(Boolean(req1), '對未就緒背景地圖送出 REQUEST_SNAPSHOT');
  (rc as unknown as { receive: (m: unknown) => void }).receive({
    v: PROTOCOL_VERSION,
    characterId: 'c2',
    ts: t,
    kind: 'command-result',
    commandId: req1!.commandId,
    status: 'REJECTED',
    reasonCode: 'GAME_NOT_READY',
    message: '場景尚未載入完成',
  });
  const countBefore600 = sentCmds.filter(c => c.characterId === 'c2').length;
  t += 500;
  for (const tm of timers.splice(0).filter(x => { if (x.at <= t) return true; timers.push(x); return false; })) tm.fn();
  assert(sentCmds.filter(c => c.characterId === 'c2').length === countBefore600, '600ms 之前尚未重試');
  t += 150;
  for (const tm of timers.splice(0).filter(x => { if (x.at <= t) return true; timers.push(x); return false; })) tm.fn();
  const req2 = sentCmds.filter(c => c.characterId === 'c2' && c.type === 'REQUEST_SNAPSHOT');
  assert(req2.length === countBefore600 + 1, 'GAME_NOT_READY 滿 600ms 自動排程重試');
  const snapC2 = makeSnapshot('c2', '二號', 'm2', '虛構圖二', 222, 333, baseMembers);
  (rc as unknown as { receive: (m: unknown) => void }).receive({
    v: PROTOCOL_VERSION,
    characterId: 'c2',
    ts: t,
    kind: 'snapshot',
    seq: 9,
    reason: 'REQUESTED',
    inReplyTo: req2[req2.length - 1].commandId,
    snapshot: snapC2,
  });
  assert(rc.characterStates()['c2']?.snapshot?.mapId === 'm2' && rc.state.snapshot?.mapId === 'm1', '重試取得 c2 異地地圖快照且未蓋掉 c1 主視角快照');

  // 檢驗 CharacterLane 已有快照時覆疊 heartbeat / staticData / members
  const wLane = createWorld({ fx17: true });
  wLane.boot();
  wLane.ctrl.perform({ kind: 'DISPATCH_ASSIGN', characterId: 'char_2', spec: { kind: 'QUEST_CHAIN', stop: { maxMinutes: null, stopOnBagFull: false, minSatiety: null } }, label: '派工' });
  wLane.advance(250);
  const laneView = wLane.ctrl.characterStates()['char_2'];
  assert(Boolean(laneView?.snapshot) && connectionStatus(laneView!, wLane.t) === 'RUNNING' && observerStatus(laneView!, 'char_2', wLane.t).kind === 'OK', 'CharacterLane 已有快照時覆疊主狀態 heartbeat/members 使連線與觀察狀態為 OK');
}

suite('F14 UI：單一保留原有 testid、寬版 2 欄並排、焦點切換、獨立原版/現代檢視、390px 輪播滑動');
{
  const win = new Window({ url: 'http://localhost/family/' });
  Object.assign(globalThis, {
    window: win,
    document: win.document,
    HTMLElement: win.HTMLElement,
    Element: win.Element,
    Node: win.Node,
    Event: win.Event,
    MouseEvent: win.MouseEvent,
    TouchEvent: win.TouchEvent,
    localStorage: win.localStorage,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  const now = Date.now();
  const members = [
    { id: 'c1', name: '青衫', mapId: 'm1', mapName: '虛構村', x: 100, y: 120 },
    { id: 'c2', name: '鏢客', mapId: 'm2', mapName: '虛構林', x: 240, y: 310 },
    { id: 'c3', name: '掌櫃', mapId: 'm3', mapName: '虛構鎮', x: 400, y: 500 },
  ];
  const mainState = makeSyntheticState(members, 'c1', now);
  const c2State = makeSyntheticState(members, 'c2', now);
  const c3State = makeSyntheticState(members, 'c3', now);
  const charStates = { c1: mainState, c2: c2State, c3: c3State };

  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
  const viewModes: Record<string, 'original' | 'modern'> = { c1: 'original', c2: 'modern', c3: 'original' };
  const switches: string[] = [];
  const watchCalls: Array<{ ids: string[]; focus: string | null }> = [];

  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);

  const renderAt = (width: number) =>
    act(() => {
      root.render(
        <MultiGameViewport
          state={mainState}
          characterStates={charStates}
          watchCharacterId={null}
          onSelectWatchCharacter={() => {}}
          onSwitchHostCharacter={id => switches.push(id)}
          onWatchChange={(ids, focus) => watchCalls.push({ ids, focus })}
          viewModes={viewModes}
          onSetViewMode={(cid, mode) => {
            viewModes[cid] = mode;
            renderAt(width);
          }}
          running
          storage={storage}
          viewportWidth={width}
        />,
      );
    });

  // 1. 單一模式保留原有 GameViewport data-testid
  renderAt(1024);
  assert(container.querySelector('[data-testid="multiview-toolbar"]') !== null, '渲染並排工具列');
  assert(container.querySelector('[data-testid="game-stage-panel"]') !== null, '單一模式保留原有 game-stage-panel testid');
  assert(container.querySelector('[data-testid="stage-view-mode-select"]') !== null, '單一模式保留原有 stage-view-mode-select testid');

  // 2. 切至並排模式（1024px 寬版 -> 2 欄 Grid）
  act(() => {
    (container.querySelector('[data-testid="multiview-toggle"]') as unknown as HTMLButtonElement).click();
  });
  await new Promise(r => setTimeout(r, 20));
  assert(container.querySelector('[data-testid="multiview-grid"]')?.getAttribute('data-columns') === '2', '寬版並排使用 2 欄 Grid');
  const tile1 = container.querySelector('[data-testid="multiview-tile-c1"]')!;
  const tile2 = container.querySelector('[data-testid="multiview-tile-c2"]')!;
  assert(tile1.getAttribute('data-focused') === 'true' && tile1.getAttribute('data-target-fps') === '60', '預設焦點格為 60fps');
  assert(tile2.getAttribute('data-focused') === 'false' && tile2.getAttribute('data-target-fps') === '10', '非焦點可見格為 10fps');

  // F4a 每格各自原版 / 現代模式互不影響
  assert(tile1.querySelector('[data-testid="multiview-c1-original-host"]') !== null, 'c1 顯示原版畫布');
  assert(tile2.querySelector('[data-testid="multiview-c2-modern-host"]') !== null, 'c2 顯示現代畫布');
  const modeSel1 = container.querySelector('[data-testid="multiview-view-mode-c1"]') as unknown as HTMLSelectElement;
  act(() => {
    modeSel1.value = 'modern';
    modeSel1.dispatchEvent(new win.Event('change', { bubbles: true }) as unknown as Event);
  });
  assert(viewModes.c1 === 'modern' && viewModes.c2 === 'modern', '切換 c1 檢視模式更新並保留 c2 設定');

  // 點擊 c2 切換焦點
  act(() => {
    (tile2 as unknown as HTMLElement).click();
  });
  assert(container.querySelector('[data-testid="multiview-tile-c2"]')?.getAttribute('data-focused') === 'true', '點擊 c2 格後變為焦點');
  assert(container.querySelector('[data-testid="multiview-tile-c2"]')?.getAttribute('data-target-fps') === '60', 'c2 升為 60fps');
  assert(container.querySelector('[data-testid="multiview-tile-c1"]')?.getAttribute('data-target-fps') === '10', '原焦點 c1 降為 10fps');

  // 設為主視角按鈕只在非主視角格出現
  assert(container.querySelector('[data-testid="multiview-set-host-c1"]') === null, '主視角格不顯示設為主視角鈕');
  act(() => {
    (container.querySelector('[data-testid="multiview-set-host-c2"]') as unknown as HTMLButtonElement).click();
  });
  assert(switches.join() === 'c2', '點擊設為主視角觸發切換指令給 c2');

  // 3. 窄版 390px：carousel 單格可見 (60fps)，其餘隱藏 (0fps)，支援 >= 40px 觸控滑動與按鈕切換
  renderAt(390);
  const carousel = container.querySelector('[data-testid="multiview-carousel"]')!;
  assert(carousel !== null && container.querySelector('[data-testid="multiview-carousel-nav"]') !== null, '390px 進入 carousel 模式');
  assert(container.querySelector('[data-testid="multiview-tile-c2"]')?.getAttribute('data-visible') === 'true', '目前焦點 c2 為可見投影片');
  assert(container.querySelector('[data-testid="multiview-tile-c2"]')?.getAttribute('data-target-fps') === '60', '可見投影片 60fps');
  assert(container.querySelector('[data-testid="multiview-tile-c1"]')?.getAttribute('data-visible') === 'false', '非當前投影片 c1 隱藏');
  assert(container.querySelector('[data-testid="multiview-tile-c1"]')?.getAttribute('data-target-fps') === '0', '隱藏投影片 0fps');

  // 模擬觸控左滑 60px（>= 40px）切換至 c3
  act(() => {
    const startEvt = new win.Event('touchstart', { bubbles: true });
    Object.defineProperty(startEvt, 'touches', { value: [{ clientX: 240, clientY: 120 }] });
    carousel.dispatchEvent(startEvt);
    const endEvt = new win.Event('touchend', { bubbles: true });
    Object.defineProperty(endEvt, 'changedTouches', { value: [{ clientX: 180, clientY: 122 }] });
    carousel.dispatchEvent(endEvt);
  });
  assert(container.querySelector('[data-testid="multiview-tile-c3"]')?.getAttribute('data-visible') === 'true', '左滑 >= 40px 切換到 c3');
  assert(container.querySelector('[data-testid="multiview-tile-c3"]')?.getAttribute('data-target-fps') === '60', '切到的投影片 c3 啟用 60fps');
  assert(container.querySelector('[data-testid="multiview-tile-c2"]')?.getAttribute('data-target-fps') === '0', '滑走的 c2 降為 0fps');

  // 點「上一位」回到 c2
  act(() => {
    (container.querySelector('[data-testid="multiview-prev"]') as unknown as HTMLButtonElement).click();
  });
  assert(container.querySelector('[data-testid="multiview-tile-c2"]')?.getAttribute('data-visible') === 'true', '點上一位切回 c2');
  assert(watchCalls.length > 0, '通知 controller 更新並排觀察成員清單');

  act(() => root.unmount());
  await win.close();
}

suite('F14 有限 LRU 地形快取 (<= 8) 與 PixiJS v8 釋放安全靜態檢查');
{
  const base = makeSnapshot('c1', '旅人', 'm0', '虛構圖', 100, 100, [{ id: 'c1', name: '旅人', mapId: 'm0', mapName: '虛構圖', x: 100, y: 100 }]);
  let s = initialState();
  s = applyMessage(s, { v: PROTOCOL_VERSION, characterId: 'c1', ts: 1, kind: 'heartbeat', sessionId: 'slru', seq: 1, mapId: 'm0', phase: 'PLAYING', inBattle: false } as PluginMessage, 1000);
  for (let i = 0; i < 12; i += 1) {
    const grid = new Uint8Array(4);
    grid[i % 4] = 1;
    const packed = packBlockedCells(grid, 2 + (i % 3), 2)!;
    const snap = JSON.parse(JSON.stringify(base)) as SceneSnapshot;
    snap.mapId = `m-${i}`;
    snap.nav.terrain = packed;
    const st = applyMessage(s, { v: PROTOCOL_VERSION, characterId: 'c1', ts: 2 + i, kind: 'snapshot', seq: 2 + i, reason: 'REQUESTED', snapshot: snap } as PluginMessage, 1000);
    buildModernModel(st, 'c1', 1000);
  }
  assert(terrainCacheSize() <= MAX_TERRAIN_CACHE_ENTRIES && MAX_TERRAIN_CACHE_ENTRIES === 8, `地形快取維持有界 LRU <= 8（實際 ${terrainCacheSize()}）`);

  const renderDir = path.resolve(process.cwd(), 'src/render');
  const panelDir = path.resolve(process.cwd(), 'src/panels');
  const files = [
    ...fs.readdirSync(renderDir).filter(f => f.endsWith('.ts') || f.endsWith('.tsx')).map(f => path.join('src/render', f)),
    ...fs.readdirSync(panelDir).filter(f => f.endsWith('.ts') || f.endsWith('.tsx')).map(f => path.join('src/panels', f)),
  ];
  for (const rel of files) {
    const src = fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
    assert(!/app\.destroy\(\s*true\b/.test(src), `${rel} 不可呼叫 app.destroy(true)`);
    if (src.includes('new Application(')) {
      assert(src.includes('removeView: true'), `${rel} 必須以 { removeView: true } 釋放 Pixi Application`);
      assert(src.includes('ResizeObserver') && src.includes('.disconnect()'), `${rel} 必須在 destroy 斷開 ResizeObserver`);
      assert(src.includes('this.destroyed') && src.includes('app?.renderer'), `${rel} renderFrame 必須檢查 destroyed 與 renderer`);
    }
  }
  const modernSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/render/modernStage.ts'), 'utf8');
  assert(modernSrc.includes('terrainTex?.destroy(true)'), 'modernStage.ts 必須銷毀 terrainTex');
}

done();
