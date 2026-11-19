import ex from '../src/protocol/examples.json';
import { PROTOCOL_VERSION, type PluginMessage } from '../src/protocol/index';
import { FamilyController } from '../src/controller';
import type { FamilyState } from '../src/state';
import type { Transport } from '../src/transport/types';
import {
  evaluateChainStop,
  IDLE_STUCK_LIMIT,
  nextStuck,
  orderQuests,
  pickQuestGatherForObjective,
  pickQuestGatherPoint,
  planUnmetObjective,
  selectNextQuest,
  sellableItems,
  type ChainMetrics,
  type ChainQuest,
} from '../src/automation/questPlan';
import { assert, done, suite } from './helpers';

function q(partial: Pick<ChainQuest, 'questId' | 'title' | 'minLevel' | 'status'> & Partial<ChainQuest>): ChainQuest {
  return {
    npcName: '測試旅人',
    objectives: [],
    rewardExp: 0,
    rewardCoins: 0,
    ...partial,
  };
}

suite('FM8: 任務排序（前置先於後續，不寫死目錄）');
{
  const quests = [
    q({ questId: 303, title: '測試丙', minLevel: 2, status: 'AVAILABLE', prerequisites: [202] }),
    q({ questId: 101, title: '測試甲', minLevel: 1, status: 'AVAILABLE' }),
    q({ questId: 202, title: '測試乙', minLevel: 1, status: 'AVAILABLE', prerequisites: [101] }),
  ];
  const ordered = orderQuests(quests).map(x => x.questId);
  assert(ordered.join(',') === '101,202,303', '前置任務排在依賴它的任務前面，同層再比等級與編號');

  const first = selectNextQuest(quests, 1);
  assert(first.kind === 'QUEST' && first.quest.questId === 101, '等級 1 先選沒有前置的可接任務');

  const afterFirst = quests.map(x => (x.questId === 101 ? { ...x, status: 'COMPLETED' as const } : x));
  const second = selectNextQuest(afterFirst, 1);
  assert(second.kind === 'QUEST' && second.quest.questId === 202, '甲完成後接著做乙');

  const afterSecond = afterFirst.map(x => (x.questId === 202 ? { ...x, status: 'COMPLETED' as const } : x));
  const locked = selectNextQuest(afterSecond, 1);
  assert(locked.kind === 'LEVEL_LOCKED' && locked.blocked.length === 1, '等級不夠時交給新手循環，不算目錄做完');

  const third = selectNextQuest(afterSecond, 2);
  assert(third.kind === 'QUEST' && third.quest.questId === 303, '等級夠了才選丙');

  const allDone = afterSecond.map(x => ({ ...x, status: 'COMPLETED' as const }));
  assert(selectNextQuest(allDone, 9).kind === 'DONE', '全部完成回 DONE');

  const active = [
    q({ questId: 101, title: '測試甲', minLevel: 1, status: 'COMPLETED' }),
    q({ questId: 404, title: '測試丁', minLevel: 1, status: 'AVAILABLE' }),
    q({ questId: 202, title: '測試乙', minLevel: 1, status: 'IN_PROGRESS', prerequisites: [101] }),
  ];
  const prefer = selectNextQuest(active, 1);
  assert(prefer.kind === 'QUEST' && prefer.quest.questId === 202, '進行中的任務優先於還沒接的');

  const cycled = orderQuests([
    q({ questId: 2, title: '環乙', minLevel: 1, status: 'AVAILABLE', prerequisites: [1] }),
    q({ questId: 1, title: '環甲', minLevel: 1, status: 'AVAILABLE', prerequisites: [2] }),
  ]);
  assert(cycled.length === 2, '互相前置的任務不會讓排序停住');
}

suite('FM8: 停止條件（先符合的那一項）');
{
  const base: ChainMetrics = {
    startedAt: 0,
    now: 1_000,
    level: 2,
    gold: 10,
    inventoryCount: 1,
    inventoryCap: 4,
    deaths: 0,
  };
  const none = { maxDurationMs: null, targetLevel: null, targetGold: null, stopOnBagFull: false, maxDeaths: null };
  assert(evaluateChainStop(none, base) === null, '沒設上限就不停');
  assert(evaluateChainStop({ ...none, maxDurationMs: 1_000 }, base) === 'TIME', '時間到');
  assert(evaluateChainStop({ ...none, targetLevel: 2 }, base) === 'LEVEL', '等級達成');
  assert(evaluateChainStop({ ...none, targetGold: 10 }, base) === 'GOLD', '金錢達成');
  assert(
    evaluateChainStop({ ...none, stopOnBagFull: true }, { ...base, inventoryCount: 4 }) === 'BAG_FULL',
    '背包已滿',
  );
  assert(evaluateChainStop({ ...none, maxDeaths: 1 }, { ...base, deaths: 1 }) === 'DEATHS', '死亡次數達到上限');
  assert(
    evaluateChainStop({ ...none, maxDurationMs: 1_000, targetLevel: 2 }, base) === 'TIME',
    '多個條件同時成立時採用先檢查到的時間',
  );
  assert(evaluateChainStop({ ...none, targetLevel: 3 }, base) === null, '等級還沒到不停');
}

suite('FM8: 卡住偵測與下一步規劃');
{
  let state = nextStuck(null, 'sig', false);
  assert(!state.stuck && state.state.idleTicks === 0, '有在做事時不累積閒置');
  for (let i = 0; i < IDLE_STUCK_LIMIT - 1; i++) state = nextStuck(state.state, 'sig', true);
  assert(!state.stuck, '未達閒置上限還不停');
  state = nextStuck(state.state, 'sig', true);
  assert(state.stuck && state.state.idleTicks === IDLE_STUCK_LIMIT, '閒置且進度沒變到達上限就判定卡住');
  state = nextStuck(state.state, 'sig', false);
  assert(!state.stuck && state.state.idleTicks === 0, '重新開始做事就清掉閒置計數');

  const talk = planUnmetObjective(
    { type: 'TALK_TO_NPC', description: '去找「測試旅人」說一句話', current: 0, required: 1, met: false },
    { npcNames: [], maps: [], gatherPoints: [], recipes: [] },
  );
  assert(talk.kind === 'TALK' && talk.npcName === '測試旅人', '交談目標從描述裡的引號取出，不寫死人名');

  const kill = planUnmetObjective(
    { type: 'KILL_MONSTERS', description: '在測試荒原討伐', current: 0, required: 1, met: false },
    { npcNames: [], maps: [{ mapId: '99001', name: '測試荒原' }], gatherPoints: [], recipes: [] },
  );
  assert(kill.kind === 'STUCK', '戰鬥目標沒有宿主 targetMaps 時回 STUCK');

  const kept = sellableItems(
    [
      { itemId: 900001, name: '測試封印石', count: 1 },
      { itemId: 900002, name: '測試雜物', count: 2 },
    ],
    [],
  );
  assert(kept.length === 1 && kept[0].itemId === 900002, '名稱含封印的道具留下來不賣');

  const points = [
    {
      id: 'short',
      mapId: '99002',
      skillId: 2,
      materials: [{ itemId: 900011, name: '香草' }],
    },
    {
      id: 'home',
      mapId: '99001',
      skillId: 2,
      materials: [{ itemId: 900010, name: '測試香草' }],
    },
    {
      id: 'other',
      mapId: '99004',
      skillId: 2,
      materials: [{ itemId: 900013, name: '測試薄荷' }],
    },
  ];
  const picked = pickQuestGatherPoint('採集並持有測試香草 (2個)', points);
  assert(picked?.point.id === 'home' && picked.itemId === 900010, '較長的材料名優先，不採描述裡較短的子字串，也不採別的目標的材料');
  assert(pickQuestGatherPoint('這個描述沒有任何材料名', points) === null, '描述對不上材料就不要猜一個採集點');

  const fieldTalk = planUnmetObjective(
    { type: 'TALK_TO_NPC', description: '去找「描述裡的人」', current: 0, required: 1, met: false, targetNpcName: '欄位旅人' },
    { npcNames: ['描述裡的人'], maps: [], gatherPoints: [], recipes: [] },
  );
  assert(fieldTalk.kind === 'TALK' && fieldTalk.npcName === '欄位旅人', '有 targetNpcName 就用欄位，不從描述猜');

  const fieldVisit = planUnmetObjective(
    { type: 'VISIT_MAPS', description: '前往 99009', current: 0, required: 1, met: false, targetMapId: '99002' },
    { npcNames: [], maps: [{ mapId: '99002', name: '欄位平原' }], gatherPoints: [], recipes: [] },
  );
  assert(fieldVisit.kind === 'VISIT' && fieldVisit.mapId === '99002' && fieldVisit.mapName === '欄位平原', '有 targetMapId 就用欄位');

  const fieldGather = planUnmetObjective(
    { type: 'COLLECT_ITEMS', description: '收集測試香草', current: 0, required: 1, met: false, itemId: 900013, itemName: '測試薄荷' },
    { npcNames: [], maps: [], gatherPoints: points, recipes: [] },
  );
  assert(fieldGather.kind === 'GATHER', '物品欄位對得上採集點就去採');
  const wrongField = planUnmetObjective(
    { type: 'COLLECT_ITEMS', description: '收集測試香草', current: 0, required: 1, met: false, itemName: '沒有這種葉子' },
    { npcNames: [], maps: [], gatherPoints: points, recipes: [] },
  );
  assert(wrongField.kind === 'STUCK', '欄位對不上就不能改從描述挑別的材料');
  const byField = pickQuestGatherForObjective(
    { description: '收集測試香草', itemId: 900013, itemName: '測試薄荷' },
    points,
  );
  assert(byField?.point.id === 'other' && byField.itemId === 900013, 'itemId 優先，不採描述裡另一個材料');
  const byName = pickQuestGatherForObjective(
    { description: '這個描述沒有任何材料名', itemName: '測試香草' },
    points,
  );
  assert(byName?.point.id === 'home', '沒有 itemId 時用 itemName 全名比對');
  const missingField = pickQuestGatherForObjective(
    { description: '收集測試香草', itemName: '沒有這種葉子' },
    points,
  );
  assert(missingField === null, '欄位對不上採集點就回 null');
}

suite('FM8: 控制器在找不到下一步時停下，並在等級條件達成時寫回摘要');
{
  let push: (r: unknown) => void = () => {};
  const tr: Transport = {
    name: 'fake',
    start: cb => { push = cb; },
    send: () => {},
    stop: () => {},
  };
  let now = 5_000;
  const seen: { state: FamilyState | null } = { state: null };
  const c = new FamilyController(tr, {
    now: () => now,
    after: () => {},
    onChange: s => { seen.state = s; },
  });
  c.start();

  const snap = JSON.parse(JSON.stringify(ex.snapshot.snapshot));
  snap.mapId = '99001';
  snap.mapName = '測試荒原';
  snap.openingStage = 'DONE';
  snap.character.level = 4;
  snap.character.name = '測試旅人';
  snap.quests = [
    {
      questId: 707,
      title: '測試荒原討伐',
      npcId: 'npc_test',
      npcName: '測試旅人',
      minLevel: 1,
      status: 'IN_PROGRESS',
      objectives: [
        {
          type: 'KILL_MONSTERS',
          description: '討伐測試荒原的影子',
          current: 0,
          required: 1,
          met: false,
        },
      ],
      rewardExp: 12,
      rewardCoins: 0,
    },
  ];

  const B = { v: PROTOCOL_VERSION, characterId: 'c1' };
  const msg = (extra: Record<string, unknown>): PluginMessage => ({ ...B, ts: now, ...extra } as PluginMessage);
  let seq = 0;
  push(msg({ kind: 'heartbeat', sessionId: 's-fm8', seq: ++seq, mapId: '99001', phase: 'PLAYING', inBattle: false }));
  push(msg({ kind: 'snapshot', seq: ++seq, reason: 'STARTED', snapshot: snap }));

  const stuckErr = c.perform({ kind: 'QUEST_CHAIN_START', label: '開始無人任務' });
  const stuck = c.chainStatus();
  const logged = seen.state?.log.some(l => l.text.includes('找不到下一步')) ?? false;
  assert(stuckErr === null, '遊戲執行中可以開始無人任務');
  assert(stuck.phase === 'STOPPED' && stuck.stopReason === 'STUCK', '沒有 targetMaps 的討伐目標會停下');
  assert(logged, '日誌寫明找不到下一步');

  const levelSnap = JSON.parse(JSON.stringify(snap));
  levelSnap.quests = [
    {
      questId: 808,
      title: '測試等級門',
      npcId: 'npc_test',
      npcName: '測試旅人',
      minLevel: 9,
      status: 'AVAILABLE',
      objectives: [
        { type: 'VISIT_MAPS', description: '前往測試荒原', current: 0, required: 1, met: false },
      ],
      rewardExp: 3,
      rewardCoins: 0,
    },
  ];
  now += 100;
  push(msg({ kind: 'heartbeat', sessionId: 's-fm8', seq: ++seq, mapId: '99001', phase: 'PLAYING', inBattle: false }));
  push(msg({ kind: 'snapshot', seq: ++seq, reason: 'REQUESTED', snapshot: levelSnap }));
  const cfgErr = c.perform({
    kind: 'QUEST_CHAIN_CONFIG',
    label: '設定停止等級',
    patch: { stop: { targetLevel: 4 } },
  });
  const levelErr = c.perform({ kind: 'QUEST_CHAIN_START', label: '再開始' });
  const level = c.chainStatus();
  const recap = c.welcomeRecap();
  assert(cfgErr === null && levelErr === null, '可以先設定停止等級再開始');
  assert(level.phase === 'STOPPED' && level.stopReason === 'LEVEL', '目前等級已達設定值就停');
  assert(recap?.automation?.stopReason.includes('等級') === true, '回來摘要帶停止原因');
  assert(Array.isArray(recap?.automation?.completedQuests), '回來摘要帶完成的任務清單');
}

suite('FM8: 中途停下時，摘要列出這次完成的任務，開工前就完成的不算');
{
  let push: (r: unknown) => void = () => {};
  let arm = false;
  let injected = false;
  const tr: Transport = {
    name: 'fake',
    start: cb => { push = cb; },
    send: () => {
      if (!arm || injected) return;
      injected = true;
      push(doneMsg);
    },
    stop: () => {},
  };
  let now = 8_000;
  const c = new FamilyController(tr, {
    now: () => now,
    after: () => {},
    onChange: () => {},
  });
  c.start();

  const base = JSON.parse(JSON.stringify(ex.snapshot.snapshot));
  base.mapId = '99001';
  base.mapName = '測試荒原';
  base.openingStage = 'DONE';
  base.character.level = 2;
  base.character.name = '測試旅人';
  base.npcs = [
    {
      id: 'npc_test',
      name: '測試旅人',
      x: 100,
      y: 100,
      gridX: 1,
      gridY: 1,
      role: 'VILLAGER',
      talkable: true,
      isAnimal: false,
      isShop: false,
    },
  ];
  base.activity = {
    dialog: {
      npcId: 'npc_test',
      npcName: '測試旅人',
      lines: ['請收下這份測試委託'],
      options: [{ id: 'ACCEPT_QUEST:501', label: '答應' }],
    },
    shop: null,
    battle: null,
    battleResult: null,
    command: null,
  };
  base.quests = [
    {
      questId: 400,
      title: '測試舊委託',
      npcId: 'npc_test',
      npcName: '測試旅人',
      minLevel: 1,
      status: 'COMPLETED',
      objectives: [],
      rewardExp: 50,
      rewardCoins: 0,
    },
    {
      questId: 501,
      title: '測試回報',
      npcId: 'npc_test',
      npcName: '測試旅人',
      minLevel: 1,
      status: 'AVAILABLE',
      objectives: [
        { type: 'TALK_TO_NPC', description: '與「測試旅人」交談', current: 0, required: 1, met: false },
      ],
      rewardExp: 7,
      rewardCoins: 0,
    },
  ];

  const doneSnap = JSON.parse(JSON.stringify(base));
  doneSnap.activity.dialog = null;
  doneSnap.quests = [
    { ...base.quests[0] },
    { ...base.quests[1], status: 'COMPLETED', objectives: [{ ...base.quests[1].objectives[0], current: 1, met: true }] },
    {
      questId: 502,
      title: '測試討伐',
      npcId: 'npc_test',
      npcName: '測試旅人',
      minLevel: 1,
      status: 'IN_PROGRESS',
      objectives: [
        { type: 'KILL_MONSTERS', description: '討伐測試影子', current: 0, required: 1, met: false },
      ],
      rewardExp: 99,
      rewardCoins: 0,
    },
  ];

  const B = { v: PROTOCOL_VERSION, characterId: 'c1' };
  let seq = 0;
  const msg = (extra: Record<string, unknown>): PluginMessage => ({ ...B, ts: now, ...extra } as PluginMessage);
  const doneMsg = msg({ kind: 'snapshot', seq: 50, reason: 'SCENE_RELOADED', snapshot: doneSnap });

  push(msg({ kind: 'heartbeat', sessionId: 's-fm8b', seq: ++seq, mapId: '99001', phase: 'PLAYING', inBattle: false }));
  push(msg({ kind: 'snapshot', seq: ++seq, reason: 'STARTED', snapshot: base }));
  arm = true;
  const err = c.perform({ kind: 'QUEST_CHAIN_START', label: '開始無人任務' });
  arm = false;
  now += 500;
  c.tick();
  const status = c.chainStatus();
  const recap = c.welcomeRecap();
  assert(err === null, '可以開始無人任務');
  assert(injected, '快照在指令送出期間先寫進狀態，任務模組尚未處理');
  assert(status.phase === 'STOPPED' && status.stopReason === 'STUCK', '下一筆找不到下一步時停下');
  assert(status.completedQuestTitles.join('、') === '測試回報', '摘要只記這次完成的任務');
  assert(recap?.automation?.completedQuests.join('、') === '測試回報', '回來摘要列出這次完成的任務名稱');
  assert(recap?.automation?.questExp === 7, '任務獎勵經驗只加這次完成的任務');
  assert(recap?.automation?.completedQuests.includes('測試舊委託') !== true, '開工前就完成的任務不進摘要');
}

suite('FM8: 開場改送宿主指令，不點村長對話');
{
  const sent: PluginMessage[] = [];
  let push: (r: unknown) => void = () => {};
  const tr: Transport = {
    name: 'fake',
    start: cb => { push = cb; },
    send: m => { sent.push(m); },
    stop: () => {},
  };
  let now = 9_000;
  const c = new FamilyController(tr, {
    now: () => now,
    after: () => {},
    onChange: () => {},
  });
  c.start();

  const snap = JSON.parse(JSON.stringify(ex.snapshot.snapshot));
  snap.mapId = '99001';
  snap.mapName = '測試荒原';
  snap.openingStage = 'GO_CHIEF';
  snap.character.level = 1;
  snap.character.name = '測試旅人';
  snap.quests = [];
  snap.activity = { dialog: null, shop: null, battle: null, battleResult: null, command: null };

  const B = { v: PROTOCOL_VERSION, characterId: 'c1' };
  let seq = 0;
  const msg = (extra: Record<string, unknown>): PluginMessage => ({ ...B, ts: now, ...extra } as PluginMessage);
  push(msg({ kind: 'heartbeat', sessionId: 's-fm8c', seq: ++seq, mapId: '99001', phase: 'PLAYING', inBattle: false }));
  push(msg({ kind: 'snapshot', seq: ++seq, reason: 'STARTED', snapshot: snap }));
  const err = c.perform({ kind: 'QUEST_CHAIN_START', label: '開始無人任務' });
  const opening = sent.map(m => (m.kind === 'command' ? m.command : null));
  const advance = opening.find(cmd => cmd?.type === 'GAME_COMMAND' && cmd.command.type === 'OPENING_ADVANCE');
  assert(err === null, '開場中可以開始無人任務');
  assert(c.chainStatus().phase === 'OPENING', '階段還在開場時鏈停在 OPENING');
  assert(
    advance?.type === 'GAME_COMMAND' && advance.command.type === 'OPENING_ADVANCE' && advance.command.to === 'CAPTURE',
    'GO_CHIEF 送出 OPENING_ADVANCE 到 CAPTURE',
  );
  assert(opening.every(cmd => cmd?.type !== 'TALK_TO_NPC'), '開場不跟村長對話');
  const advanceMsg = sent.find(m => m.kind === 'command' && m.command.type === 'GAME_COMMAND');
  now += 50;
  push(msg({
    kind: 'command-result',
    commandId: advanceMsg && advanceMsg.kind === 'command' ? advanceMsg.commandId : '',
    status: 'ACCEPTED',
  }));

  const capture = JSON.parse(JSON.stringify(snap));
  capture.openingStage = 'CAPTURE';
  now += 100;
  push(msg({ kind: 'snapshot', seq: ++seq, reason: 'REQUESTED', snapshot: capture }));
  now += 100;
  push(msg({
    kind: 'event',
    seq: ++seq,
    event: {
      type: 'BATTLE_TIMELINE',
      battleId: 7,
      round: 1,
      events: [{ tMs: 0, type: 'CAPTURE_ATTEMPT', isCaptured: true }],
    },
  }));
  now += 100;
  push(msg({ kind: 'event', seq: ++seq, event: { type: 'BATTLE_ENDED', battleId: 7, outcome: 'WIN' } }));
  const back = JSON.parse(JSON.stringify(capture));
  back.activity = { dialog: null, shop: null, battle: null, battleResult: null, command: null };
  now += 100;
  push(msg({ kind: 'snapshot', seq: ++seq, reason: 'SCENE_RELOADED', snapshot: back }));
  const report = sent.map(m => (m.kind === 'command' ? m.command : null)).find(
    cmd => cmd?.type === 'GAME_COMMAND' && cmd.command.type === 'OPENING_ADVANCE' && cmd.command.to === 'REPORT',
  );
  assert(report !== undefined, '捕捉成功後送出 OPENING_ADVANCE 到 REPORT');

  const claimed = JSON.parse(JSON.stringify(capture));
  claimed.openingStage = 'REPORT';
  now += 100;
  push(msg({ kind: 'snapshot', seq: ++seq, reason: 'REQUESTED', snapshot: claimed }));
  const reward = sent.map(m => (m.kind === 'command' ? m.command : null)).find(
    cmd => cmd?.type === 'GAME_COMMAND' && cmd.command.type === 'OPENING_CLAIM_REWARD',
  );
  assert(
    reward?.type === 'GAME_COMMAND'
      && reward.command.type === 'OPENING_CLAIM_REWARD'
      && reward.command.eggChoice === 0
      && typeof reward.command.petId === 'string'
      && reward.command.petId.length > 0,
    'REPORT 送出 OPENING_CLAIM_REWARD',
  );
}

suite('FM8: 開場換圖後放下舊的巡邏，改走新地圖的出口');
{
  const sent: PluginMessage[] = [];
  let push: (r: unknown) => void = () => {};
  const tr: Transport = {
    name: 'fake',
    start: cb => { push = cb; },
    send: m => { sent.push(m); },
    stop: () => {},
  };
  let now = 12_000;
  const c = new FamilyController(tr, { now: () => now, after: () => {}, onChange: () => {} });
  c.start();
  const snap = JSON.parse(JSON.stringify(ex.snapshot.snapshot));
  snap.mapId = '99001';
  snap.mapName = '測試荒原';
  snap.openingStage = 'CAPTURE';
  snap.quests = [{
    questId: 1,
    title: '測試狩獵',
    npcId: 'npc-test',
    npcName: '測試旅人',
    minLevel: 1,
    status: 'AVAILABLE',
    objectives: [{
      type: 'KILL_MONSTERS',
      description: '在測試荒原打一隻',
      current: 0,
      required: 1,
      met: false,
      targetMaps: [{ mapId: '99001', mapName: '測試荒原', reason: 'ENCOUNTER_AREA', x: 100, y: 200 }],
    }],
    rewardExp: 0,
    rewardCoins: 0,
  }];
  snap.activity = { dialog: null, shop: null, battle: null, battleResult: null, command: null };
  const B = { v: PROTOCOL_VERSION, characterId: 'c1' };
  let seq = 0;
  const msg = (extra: Record<string, unknown>): PluginMessage => ({ ...B, ts: now, ...extra } as PluginMessage);
  push(msg({ kind: 'heartbeat', sessionId: 's-fm8d', seq: ++seq, mapId: '99001', phase: 'PLAYING', inBattle: false }));
  push(msg({ kind: 'snapshot', seq: ++seq, reason: 'STARTED', snapshot: snap }));
  const err = c.perform({ kind: 'QUEST_CHAIN_START', label: '開始無人任務' });
  assert(err === null, '捕捉階段可以開始');
  const hospital = JSON.parse(JSON.stringify(snap));
  hospital.mapId = '99007';
  hospital.mapName = '測試醫務室';
  hospital.exits = [{ id: 'door-test', name: '回到荒原', x: 12, y: 34, targetMapId: '99001', targetMapName: '測試荒原' }];
  now += 100;
  push(msg({ kind: 'snapshot', seq: ++seq, reason: 'MAP_CHANGED', snapshot: hospital }));
  const walks = sent.flatMap(m => (m.kind === 'command' && m.command.type === 'WALK_TO' ? [m.command] : []));
  assert(walks.some(w => w.mapId === '99001'), '原本在遇敵地圖巡邏');
  const last = walks[walks.length - 1];
  assert(last?.mapId === '99007', '人已經換圖後，下一步走的是新地圖');
  assert(c.chainStatus().phase === 'OPENING', '換圖之後鏈還在開場');
}

suite('FM8: 戰鬥落敗後再接同一件任務，有恢復道具時先喝');
{
  const sent: PluginMessage[] = [];
  let push: (r: unknown) => void = () => {};
  const tr: Transport = {
    name: 'fake',
    start: cb => { push = cb; },
    send: m => { sent.push(m); },
    stop: () => {},
  };
  let now = 20_000;
  const c = new FamilyController(tr, { now: () => now, after: () => {}, onChange: () => {} });
  c.start();
  const snap = JSON.parse(JSON.stringify(ex.snapshot.snapshot));
  snap.mapId = '99001';
  snap.mapName = '測試荒原';
  snap.openingStage = 'DONE';
  snap.character.level = 2;
  snap.character.name = '測試旅人';
  snap.character.hp = 100;
  snap.character.maxHp = 100;
  snap.inventory = [{ itemId: 9, name: '測試恢復劑', count: 2 }];
  snap.quests = [{
    questId: 601,
    title: '測試討伐',
    npcId: 'npc-test',
    npcName: '測試旅人',
    minLevel: 1,
    status: 'IN_PROGRESS',
    objectives: [{
      type: 'KILL_MONSTERS',
      description: '在測試荒原打一隻',
      current: 0,
      required: 1,
      met: false,
      targetMaps: [{ mapId: '99001', mapName: '測試荒原', reason: 'ENCOUNTER_AREA', x: 100, y: 200 }],
    }],
    rewardExp: 0,
    rewardCoins: 0,
  }];
  snap.activity = { dialog: null, shop: null, battle: null, battleResult: null, command: null };
  const B = { v: PROTOCOL_VERSION, characterId: 'c1' };
  let seq = 0;
  const msg = (extra: Record<string, unknown>): PluginMessage => ({ ...B, ts: now, ...extra } as PluginMessage);
  push(msg({ kind: 'heartbeat', sessionId: 's-fm8e', seq: ++seq, mapId: '99001', phase: 'PLAYING', inBattle: false }));
  push(msg({ kind: 'snapshot', seq: ++seq, reason: 'STARTED', snapshot: snap }));
  const err = c.perform({ kind: 'QUEST_CHAIN_START', label: '開始無人任務' });
  assert(err === null && c.chainStatus().phase === 'QUESTS', '討伐任務可以開始');
  assert(c.activeQuest() === 601, '鏈接上這件進行中的任務');
  assert(c.strategy() === 'ATTACK', '有恢復道具時打怪不改成逃跑');

  now += 100;
  push(msg({
    kind: 'event',
    seq: ++seq,
    event: {
      type: 'BATTLE_TURN_READY',
      battleId: 3,
      round: 1,
      canFlee: true,
      player: { id: 'p', name: '測試旅人', hp: 10, maxHp: 100 },
      enemies: [{ slot: 0, id: 'm', name: '測試影子', hp: 20, maxHp: 20 }],
    },
  }));
  const drink = sent.flatMap(m => (m.kind === 'command' && m.command.type === 'BATTLE_ACTION' ? [m.command] : []));
  assert(drink.some(a => a.action.kind === 'ITEM' && a.action.itemId === 9), '血量低於回村門檻時使用背包裡的恢復道具');
  assert(!sent.some(m => m.kind === 'command' && m.command.type === 'BATTLE_FLEE'), '這一回合不逃跑');

  now += 100;
  push(msg({ kind: 'event', seq: ++seq, event: { type: 'BATTLE_ENDED', battleId: 3, outcome: 'LOSE' } }));
  const waiting = c.chainStatus();
  assert(waiting.phase === 'QUESTS' && waiting.stopReason === null, '一次落敗不把鏈停住');
  assert(waiting.text.includes('恢復後再試同一件任務'), '結算視窗還在時先寫下會再接');
  assert(c.activeQuest() === null, '任務模組先停下，等視窗關掉');

  const back = JSON.parse(JSON.stringify(snap));
  back.activity = { dialog: null, shop: null, battle: null, battleResult: null, command: null };
  now += 100;
  push(msg({ kind: 'snapshot', seq: ++seq, reason: 'SCENE_RELOADED', snapshot: back }));
  const again = c.chainStatus();
  assert(again.phase === 'QUESTS' && again.stopReason === null, '視窗關掉後鏈還在跑任務');
  assert(c.activeQuest() === 601, '同一件任務重新接上');
  assert(again.text.includes('測試討伐'), '狀態改回這件任務');
}

suite('FM8: 勝利結算的一連串事件不算任務閒置');
{
  const sent: PluginMessage[] = [];
  let push: (r: unknown) => void = () => {};
  const tr: Transport = {
    name: 'fake',
    start: cb => { push = cb; },
    send: m => { sent.push(m); },
    stop: () => {},
  };
  let now = 30_000;
  const c = new FamilyController(tr, { now: () => now, after: () => {}, onChange: () => {} });
  c.start();
  const snap = JSON.parse(JSON.stringify(ex.snapshot.snapshot));
  snap.mapId = '99001';
  snap.mapName = '測試荒原';
  snap.openingStage = 'DONE';
  snap.character.level = 2;
  snap.character.name = '測試旅人';
  snap.npcs = [{
    id: 'npc-test',
    name: '測試旅人',
    x: 120,
    y: 80,
    gridX: 1,
    gridY: 1,
    role: 'VILLAGER',
    talkable: true,
    isAnimal: false,
    isShop: false,
  }];
  snap.quests = [{
    questId: 602,
    title: '測試回報',
    npcId: 'npc-test',
    npcName: '測試旅人',
    minLevel: 1,
    status: 'READY',
    objectives: [{
      type: 'KILL_MONSTERS',
      description: '討伐測試影子',
      current: 1,
      required: 1,
      met: true,
      targetMaps: [{ mapId: '99001', mapName: '測試荒原', reason: 'ENCOUNTER_AREA', x: 100, y: 200 }],
    }],
    rewardExp: 0,
    rewardCoins: 0,
  }];
  snap.activity = { dialog: null, shop: null, battle: null, battleResult: 'VICTORY', command: null };
  const B = { v: PROTOCOL_VERSION, characterId: 'c1' };
  let seq = 0;
  const msg = (extra: Record<string, unknown>): PluginMessage => ({ ...B, ts: now, ...extra } as PluginMessage);
  push(msg({ kind: 'heartbeat', sessionId: 's-fm8f', seq: ++seq, mapId: '99001', phase: 'PLAYING', inBattle: false }));
  push(msg({ kind: 'snapshot', seq: ++seq, reason: 'STARTED', snapshot: snap }));
  const err = c.perform({ kind: 'QUEST_CHAIN_START', label: '開始無人任務' });
  assert(err === null && c.chainStatus().phase === 'QUESTS', '可回報的任務可以開始');
  for (let i = 0; i < 8; i += 1) {
    now += 10;
    push(msg({ kind: 'event', seq: ++seq, event: { type: 'GOLD_CHANGED', gold: 10 + i, delta: 1 } }));
  }
  const during = c.chainStatus();
  assert(during.phase === 'QUESTS' && during.stopReason === null, '勝利視窗還沒關時，結算事件不會把任務判成沒有進展');
  const back = JSON.parse(JSON.stringify(snap));
  back.activity = { dialog: null, shop: null, battle: null, battleResult: null, command: null };
  now += 10;
  push(msg({ kind: 'snapshot', seq: ++seq, reason: 'SCENE_RELOADED', snapshot: back }));
  assert(c.chainStatus().phase === 'QUESTS' && c.chainStatus().stopReason === null, '視窗關掉後繼續這件可回報的任務');
  assert(c.activeQuest() === 602, '任務模組還在推進回報');
}

done();
