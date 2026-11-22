import { Window } from 'happy-dom';
import ex from '../src/protocol/examples.json';
import { PROTOCOL_VERSION, type PluginMessage } from '../src/protocol/index';
import { collapseAndFilterLogs, formatLogText } from '../src/log_utils';
import { WorkNotifier, type NotificationAdapter } from '../src/notify';
import { applyMessage, applySent, initialState } from '../src/state';
import { FamilyController } from '../src/controller';
import type { Transport } from '../src/transport/types';
import { assert, done, suite } from './helpers';

suite('DV1 + DV4: 日誌格式切換與連續折疊過濾');
{
  let s = initialState();
  const cmd = {
    v: PROTOCOL_VERSION,
    characterId: 'char_1',
    ts: 10,
    kind: 'command' as const,
    commandId: 'fam-test-0001',
    command: { type: 'WALK_TO' as const, mapId: '10001', x: 100, y: 200 },
  };
  s = applySent(s, cmd, '走到 (100, 200)', 10);
  const sentEntry = s.log[s.log.length - 1];
  const playerTxt = formatLogText(sentEntry, false);
  const devTxt = formatLogText(sentEntry, true);
  assert(playerTxt === '走到 (100, 200)' && !playerTxt.includes('WALK_TO'), '一般模式送出日誌隱藏原始 JSON 與預期碼');
  assert(devTxt.includes('WALK_TO') && devTxt.includes('預期：ARRIVED'), '開發者模式保留完整 JSON 與預期碼');

  // 連續相同移動事件折疊為 ×3
  const baseHb = { v: PROTOCOL_VERSION, characterId: 'char_1', ts: 0, kind: 'heartbeat' as const, sessionId: 's1', seq: 1, mapId: '10001', phase: 'PLAYING' as const, inBattle: false };
  s = applyMessage(s, baseHb, 20);
  s = applyMessage(s, { ...baseHb, characterId: 'char_1', kind: 'event', seq: 2, event: { type: 'GOLD_CHANGED', gold: 100, delta: 10 } }, 21);
  s = applyMessage(s, { ...baseHb, characterId: 'char_1', kind: 'event', seq: 3, event: { type: 'GOLD_CHANGED', gold: 100, delta: 10 } }, 22);
  s = applyMessage(s, { ...baseHb, characterId: 'char_1', kind: 'event', seq: 4, event: { type: 'GOLD_CHANGED', gold: 100, delta: 10 } }, 23);

  const collapsed = collapseAndFilterLogs(s.log, { devMode: false, tagFilter: '事件' });
  assert(collapsed.length === 1 && collapsed[0].count === 3, '連續 3 筆相同事件應折疊為 ×3');
  const sysOnly = collapseAndFilterLogs(s.log, { devMode: false, tagFilter: '送出', charFilter: 'char_2' });
  assert(sysOnly.length === 0, '依角色過濾 char_2 會過濾掉 char_1 的送出日誌');
}

suite('DV1 + DV3: React UI 一般畫面隱藏除錯資訊與工作倒數進度條');
{
  const win = new Window({ url: 'http://localhost:5173/family/' });
  Object.assign(globalThis, {
    window: win,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
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
  const root = win.document.createElement('div');
  win.document.body.appendChild(root);
  const ui = mountUi(root as unknown as HTMLElement, 'TEST', () => null, () => null);

  let s = applyMessage(
    initialState(),
    { v: PROTOCOL_VERSION, characterId: 'char_1', ts: 1, kind: 'heartbeat', sessionId: 'sess-abcd1234', seq: 1, mapId: '10001', phase: 'PLAYING', inBattle: false },
    10,
  );
  const snapMsg = JSON.parse(JSON.stringify(ex.snapshot));
  snapMsg.snapshot.character.activeWork = {
    kind: 'GATHER',
    skillId: 5,
    targetItemId: 10201,
    label: '挖礦・煤',
    startedAt: Date.now() - 500,
    endsAt: Date.now() + 1000,
  };
  snapMsg.snapshot.family = {
    activeCharacterId: 'char_1',
    maxSlots: 5,
    warehouse: { gold: 0, cap: 200, items: [] },
    members: [
      {
        characterId: 'char_1',
        name: '阿草',
        level: 5,
        mapId: '10001',
        mapName: '吉恩村',
        region: { regionId: 'r-start', name: '起始村' },
        x: 3880,
        y: 3740,
        gold: 1200,
        satiety: 95,
        inventoryCount: 2,
        inventoryCap: 40,
        inBattle: false,
        inventory: [],
        workSkills: {},
        activeWork: snapMsg.snapshot.character.activeWork,
      },
    ],
  };
  s = applyMessage(s, snapMsg, 20);
  s = applySent(s, { v: PROTOCOL_VERSION, characterId: 'char_1', ts: 25, kind: 'command', commandId: 'fam-hide-99', command: { type: 'REQUEST_SNAPSHOT' } }, '更新畫面', 25);

  const baseAux = { nav: { phase: 'IDLE' as const, goal: null, route: [], text: '閒置' }, strategy: 'MANUAL' as const, known: [] };
  ui.render(s, 'RUNNING', { ...baseAux, devMode: false });
  assert(root.querySelector('[data-testid="compare-panel"]') === null, '一般模式不得顯示 compare-panel');
  assert(!root.querySelector('[data-testid="log"]')!.textContent!.includes('fam-hide-99'), '一般模式日誌不得露出 commandId');
  assert(!root.querySelector('[data-testid="log"]')!.textContent!.includes('REQUEST_SNAPSHOT'), '一般模式日誌不得露出原始指令 JSON');
  assert(root.querySelectorAll('[data-testid="portrait-slot"]').length >= 2, '成員卡片與角色面板皆顯示立繪預留框');
  assert(root.querySelectorAll('[data-testid="member-work-progress"]').length >= 2, '工作進行中顯示即時倒數進度條');

  ui.render(s, 'RUNNING', { ...baseAux, devMode: true });
  assert(root.querySelector('[data-testid="compare-panel"]') !== null, '?dev=1 模式顯示 compare-panel');
  assert(root.querySelector('[data-testid="log"]')!.textContent!.includes('fam-hide-99'), '?dev=1 模式顯示 commandId');

  win.close();
}

suite('DV5: 瀏覽器背景通知條件與去重');
{
  let hidden = true;
  let perm: 'granted' | 'denied' | 'default' = 'granted';
  const sentNotifications: Array<{ title: string; body: string }> = [];
  const adapter: NotificationAdapter = {
    isHidden: () => hidden,
    permission: () => perm,
    send: (title, body) => sentNotifications.push({ title, body }),
  };
  const notifier = new WorkNotifier(adapter);
  const idleQ = { phase: 'IDLE' as const, jobs: [], activeJobIndex: 0, stopReason: null, text: '閒置' };
  const s0 = initialState();

  notifier.check(s0, { char_1: { ...idleQ, phase: 'RUNNING' } });
  // 使用者主動停止不得發通知
  notifier.check(s0, { char_1: { ...idleQ, phase: 'STOPPED', stopReason: 'USER_STOPPED' } });
  assert(sentNotifications.length === 0, 'USER_STOPPED 不發通知');

  // 背包滿意外停止應發通知
  notifier.check(s0, { char_1: { ...idleQ, phase: 'RUNNING' } });
  notifier.check(s0, { char_1: { ...idleQ, phase: 'STOPPED', stopReason: 'BAG_FULL' } });
  assert(sentNotifications.length === 1 && sentNotifications[0].title.includes('意外中止'), '背景 BAG_FULL 發出意外中止通知');

  // 完成目標應發通知
  notifier.check(s0, { char_1: { ...idleQ, phase: 'DONE', stopReason: 'DONE_TARGET' } });
  assert(sentNotifications.length === 2 && sentNotifications[1].title.includes('目標達成'), '背景 DONE_TARGET 發出目標達成通知');

  // 戰鬥落敗應發通知，且重複 check 不洗版
  notifier.check({ ...s0, battleResult: 'DEFEAT' }, { char_1: idleQ });
  notifier.check({ ...s0, battleResult: 'DEFEAT' }, { char_1: idleQ });
  assert(sentNotifications.length === 3 && sentNotifications[2].title.includes('戰鬥落敗'), '戰鬥落敗發出一次通知且不重複');

  // 前景時不發通知
  hidden = false;
  notifier.check(s0, { char_1: { ...idleQ, phase: 'RUNNING' } });
  notifier.check(s0, { char_1: { ...idleQ, phase: 'STOPPED', stopReason: 'BAG_FULL' } });
  assert(sentNotifications.length === 3, '前景時不發背景通知');
}

suite('D2 + D3: 任務自動推進依 targetMaps 全程巡邏討伐並自動回報（無地圖正則）');
{
  const sentCmds: Array<{ commandId: string; command: any }> = [];
  let push: (r: unknown) => void = () => {};
  const tr: Transport = {
    name: 'fake',
    start: cb => { push = cb; },
    send: m => { sentCmds.push(m as any); },
    stop: () => {},
  };
  let now = 1000;
  const scheduled: Array<() => void> = [];
  const c = new FamilyController(tr, {
    now: () => now,
    after: (_ms, fn) => scheduled.push(fn),
  });
  c.start();

  const villageSnap = JSON.parse(JSON.stringify(ex.snapshot.snapshot));
  // 注意測試使用完全自訂的地圖名稱「測試荒原」，驗證 D2 不依賴任何地圖名稱正則！
  villageSnap.mapId = '10001';
  villageSnap.mapName = '吉恩村';
  villageSnap.exits = [
    { id: 'ex_custom', name: '荒原閘口', targetMapId: '99001', targetMapName: '測試荒原', x: 100, y: 100 },
  ];
  villageSnap.nav = {
    ...villageSnap.nav,
    status: 'AVAILABLE',
    reachableMaps: [{ mapId: '99001', name: '測試荒原', hops: 1 }],
    portalGraph: [
      { mapId: '10001', name: '吉恩村', targets: ['99001'], portals: [] },
      { mapId: '99001', name: '測試荒原', targets: ['10001'], portals: [] },
    ],
  };
  const floro = { id: 'npc_floro', name: '佛洛', role: 'QUEST', x: 300, y: 300, gridX: 15, gridY: 15, talkable: true, isAnimal: false, isShop: false };
  villageSnap.npcs = [floro];
  villageSnap.quests = [
    {
      questId: 13,
      title: '佛洛的巡邏',
      npcId: 'npc_floro',
      npcName: '佛洛',
      minLevel: 1,
      status: 'AVAILABLE',
      objectives: [
        {
          type: 'KILL_MONSTERS',
          description: '於測試區域討伐魔物 (1場)',
          current: 0,
          required: 1,
          met: false,
          targetMaps: [{ mapId: '99001', mapName: '測試荒原', reason: 'ENCOUNTER_AREA', x: 500, y: 500 }],
        },
      ],
      rewardExp: 180,
      rewardCoins: 400,
    },
  ];

  const B = { v: PROTOCOL_VERSION, characterId: 'c1' };
  const msg = (extra: Record<string, unknown>): PluginMessage => ({ ...B, ts: now, ...extra } as PluginMessage);
  let seq = 0;

  push(msg({ kind: 'heartbeat', sessionId: 's1', seq: ++seq, mapId: '10001', phase: 'PLAYING', inBattle: false }));
  push(msg({ kind: 'snapshot', seq: ++seq, reason: 'STARTED', snapshot: villageSnap }));

  // 1) 點擊自動接取：應自動導航去佛洛
  const err = c.perform({ kind: 'QUEST_AUTO', questId: 13, label: '自動佛洛' });
  assert(err === null && c.activeQuest() === 13, 'QUEST_AUTO 啟動成功');
  const walkToNpc = sentCmds.filter(x => x.command.type === 'WALK_TO').pop()!;
  assert(walkToNpc?.command.x === 300 && walkToNpc?.command.y === 300, '步驟1：走向任務 NPC 佛洛');

  // 模擬抵達並開啟對話 -> 接取任務
  push(msg({ kind: 'command-result', commandId: walkToNpc.commandId, status: 'ACCEPTED' }));
  push(msg({ kind: 'event', seq: ++seq, event: { type: 'COMMAND_COMPLETED', commandId: walkToNpc.commandId, outcome: 'DONE', code: 'ARRIVED' } }));
  const talkNpc = sentCmds[sentCmds.length - 1];
  assert(talkNpc.command.type === 'TALK_TO_NPC', '步驟2：抵達後送出 TALK_TO_NPC');
  push(msg({ kind: 'command-result', commandId: talkNpc.commandId, status: 'ACCEPTED' }));
  push(msg({ kind: 'event', seq: ++seq, event: { type: 'COMMAND_COMPLETED', commandId: talkNpc.commandId, outcome: 'DONE', code: 'DIALOG_OPENED' } }));
  push(msg({
    kind: 'event',
    seq: ++seq,
    event: {
      type: 'DIALOG_OPENED',
      npcId: 'npc_floro',
      npcName: '佛洛',
      role: 'QUEST',
      lines: ['巡邏去吧'],
      options: [
        { id: 'ACCEPT_QUEST:13', label: '原版任務（不可接）' },
        { id: 'ENABLE_DEMO_MODE', label: '切換示範任務模式' },
        { id: 'CLOSE', label: '告辭' },
      ],
      optionsAvailable: true,
    },
  }));
  const demoCmd = sentCmds[sentCmds.length - 1];
  assert(demoCmd.command.type === 'CHOOSE_DIALOG_OPTION' && demoCmd.command.optionId === 'ENABLE_DEMO_MODE', '步驟3a：有 ENABLE_DEMO_MODE 時優先切換示範任務模式');
  push(msg({ kind: 'command-result', commandId: demoCmd.commandId, status: 'ACCEPTED' }));
  push(msg({ kind: 'event', seq: ++seq, event: { type: 'COMMAND_COMPLETED', commandId: demoCmd.commandId, outcome: 'DONE', code: 'DIALOG_UPDATED' } }));
  now += 800;
  push(msg({
    kind: 'event',
    seq: ++seq,
    event: {
      type: 'DIALOG_UPDATED',
      npcId: 'npc_floro',
      lines: ['巡邏去吧（示範）'],
      options: [
        { id: 'ACCEPT_QUEST:13', label: '接受任務' },
        { id: 'CLOSE', label: '告辭' },
      ],
    },
  }));
  const acceptCmd = sentCmds[sentCmds.length - 1];
  assert(acceptCmd.command.type === 'CHOOSE_DIALOG_OPTION' && acceptCmd.command.optionId === 'ACCEPT_QUEST:13', '步驟3b：切入示範後自動點擊 ACCEPT_QUEST:13');

  // 任務變 IN_PROGRESS（宿主對話仍開著），關閉對話 -> 自動前往 targetMaps['99001']（「測試荒原」）
  const inProgSnap = JSON.parse(JSON.stringify(villageSnap));
  inProgSnap.quests[0].status = 'IN_PROGRESS';
  inProgSnap.activity.dialog = {
    npcId: 'npc_floro',
    npcName: '佛洛',
    lines: ['巡邏去吧'],
    options: [{ id: 'CLOSE', label: '告辭' }],
  };
  push(msg({ kind: 'command-result', commandId: acceptCmd.commandId, status: 'ACCEPTED' }));
  push(msg({ kind: 'event', seq: ++seq, event: { type: 'COMMAND_COMPLETED', commandId: acceptCmd.commandId, outcome: 'DONE', code: 'DIALOG_UPDATED' } }));
  push(msg({ kind: 'snapshot', seq: ++seq, reason: 'PHASE_CHANGED', snapshot: inProgSnap }));
  now += 1000;
  c.tick();
  const closeCmd = sentCmds[sentCmds.length - 1];
  assert(closeCmd.command.type === 'CHOOSE_DIALOG_OPTION' && closeCmd.command.optionId === 'CLOSE', '步驟4：關閉接取後的對話視窗');
  push(msg({ kind: 'event', seq: ++seq, event: { type: 'DIALOG_CLOSED', npcId: 'npc_floro' } }));
  now += 500;
  c.tick();

  const walkToExit = sentCmds[sentCmds.length - 1];
  assert(walkToExit.command.type === 'WALK_TO' && walkToExit.command.x === 100, '步驟5：自動走往「測試荒原」出口（無寫死地圖正則）');

  // 抵達測試荒原後送出換圖完成 + 新地圖快照 -> 應自動切換攻擊策略並在 (500,500) 附近巡邏
  const fieldSnap = JSON.parse(JSON.stringify(inProgSnap));
  fieldSnap.activity.dialog = null;
  fieldSnap.mapId = '99001';
  fieldSnap.mapName = '測試荒原';
  fieldSnap.character.x = 50;
  fieldSnap.character.y = 50;
  fieldSnap.npcs = [];
  fieldSnap.exits = [{ id: 'ex_back', name: '回吉恩村', targetMapId: '10001', targetMapName: '吉恩村', x: 40, y: 40 }];
  fieldSnap.nav = {
    ...fieldSnap.nav,
    status: 'AVAILABLE',
    reachableMaps: [{ mapId: '10001', name: '吉恩村', hops: 1 }],
  };
  push(msg({ kind: 'command-result', commandId: walkToExit.commandId, status: 'ACCEPTED' }));
  push(msg({ kind: 'event', seq: ++seq, event: { type: 'COMMAND_COMPLETED', commandId: walkToExit.commandId, outcome: 'DONE', code: 'MAP_CHANGED' } }));
  push(msg({ kind: 'event', seq: ++seq, event: { type: 'LOCATION_CHANGED', mapId: '99001', mapName: '測試荒原', fromMapId: '10001', x: 50, y: 50, cause: 'MAP_CHANGE' } }));
  push(msg({ kind: 'snapshot', seq: ++seq, reason: 'MAP_CHANGED', snapshot: fieldSnap }));
  while (scheduled.length) scheduled.shift()!();

  const patrolCmd = sentCmds[sentCmds.length - 1];
  assert(patrolCmd.command.type === 'WALK_TO' && patrolCmd.command.mapId === '99001' && patrolCmd.command.x === 500 && patrolCmd.command.y === 500, '步驟6：抵達目標地圖後依 targetMaps 座標開始巡邏遇敵');
  assert(c.strategy() === 'ATTACK', '步驟6b：戰鬥策略自動切換為 ATTACK');

  // 模擬戰鬥觸發並勝利，快照變 READY -> 自動回吉恩村並點擊 COMPLETE_QUEST:13
  push(msg({ kind: 'event', seq: ++seq, event: { type: 'COMMAND_COMPLETED', commandId: patrolCmd.commandId, outcome: 'DONE', code: 'ENCOUNTER' } }));
  push(msg({ kind: 'event', seq: ++seq, event: { type: 'BATTLE_STARTED', battleId: 7, mapId: '99001', enemies: [{ id: 'm1', name: '野狼', level: 1 }] } }));
  push(msg({ kind: 'event', seq: ++seq, event: { type: 'BATTLE_ENDED', battleId: 7, outcome: 'WIN' } }));
  while (scheduled.length) scheduled.shift()!();
  const readyFieldSnap = JSON.parse(JSON.stringify(fieldSnap));
  readyFieldSnap.quests[0].status = 'READY';
  readyFieldSnap.quests[0].objectives[0].current = 1;
  readyFieldSnap.quests[0].objectives[0].met = true;
  push(msg({ kind: 'snapshot', seq: ++seq, reason: 'PHASE_CHANGED', snapshot: readyFieldSnap }));

  const returnWalk = sentCmds[sentCmds.length - 1];
  assert(returnWalk.command.type === 'WALK_TO' && returnWalk.command.mapId === '99001' && returnWalk.command.x === 40, '步驟7：任務目標達成 READY 後自動走回吉恩村');

  const readyVillageSnap = JSON.parse(JSON.stringify(villageSnap));
  readyVillageSnap.quests[0].status = 'READY';
  readyVillageSnap.quests[0].objectives[0].current = 1;
  readyVillageSnap.quests[0].objectives[0].met = true;
  push(msg({ kind: 'command-result', commandId: returnWalk.commandId, status: 'ACCEPTED' }));
  push(msg({ kind: 'event', seq: ++seq, event: { type: 'COMMAND_COMPLETED', commandId: returnWalk.commandId, outcome: 'DONE', code: 'MAP_CHANGED' } }));
  push(msg({ kind: 'event', seq: ++seq, event: { type: 'LOCATION_CHANGED', mapId: '10001', mapName: '吉恩村', fromMapId: '99001', x: 100, y: 100, cause: 'MAP_CHANGE' } }));
  push(msg({ kind: 'snapshot', seq: ++seq, reason: 'MAP_CHANGED', snapshot: readyVillageSnap }));
  while (scheduled.length) scheduled.shift()!();

  const walkBackFloro = sentCmds[sentCmds.length - 1];
  assert(walkBackFloro.command.type === 'WALK_TO' && walkBackFloro.command.x === 300, '步驟8：回到吉恩村後走回佛洛身旁');
  push(msg({ kind: 'command-result', commandId: walkBackFloro.commandId, status: 'ACCEPTED' }));
  push(msg({ kind: 'event', seq: ++seq, event: { type: 'COMMAND_COMPLETED', commandId: walkBackFloro.commandId, outcome: 'DONE', code: 'ARRIVED' } }));
  const talkReturn = sentCmds[sentCmds.length - 1];
  push(msg({ kind: 'command-result', commandId: talkReturn.commandId, status: 'ACCEPTED' }));
  push(msg({ kind: 'event', seq: ++seq, event: { type: 'COMMAND_COMPLETED', commandId: talkReturn.commandId, outcome: 'DONE', code: 'DIALOG_OPENED' } }));
  push(msg({
    kind: 'event',
    seq: ++seq,
    event: {
      type: 'DIALOG_OPENED',
      npcId: 'npc_floro',
      npcName: '佛洛',
      role: 'QUEST',
      lines: ['辛苦了！'],
      options: [{ id: 'COMPLETE_QUEST:13', label: '回報任務' }],
      optionsAvailable: true,
    },
  }));
  const completeCmd = sentCmds[sentCmds.length - 1];
  assert(completeCmd.command.type === 'CHOOSE_DIALOG_OPTION' && completeCmd.command.optionId === 'COMPLETE_QUEST:13', '步驟9：自動點擊 COMPLETE_QUEST:13 完成回報');

  const doneSnap = JSON.parse(JSON.stringify(readyVillageSnap));
  doneSnap.quests[0].status = 'COMPLETED';
  push(msg({ kind: 'snapshot', seq: ++seq, reason: 'PHASE_CHANGED', snapshot: doneSnap }));
  assert(c.activeQuest() === null, '步驟10：任務 COMPLETED 後自動清空 activeQuestId');
}

done();
