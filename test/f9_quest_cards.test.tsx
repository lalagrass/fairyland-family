/**
 * F9（fairyland-family#50）：任務卡片的內容、寬窄排版、「前往」「派給角色」。
 * 全部是虛構資料（任務、NPC、地圖都是假的），不含任何原版內容。
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  PROTOCOL_VERSION, isPluginMessage, type CommandMessage, type GameEvent, type PluginMessage,
  type SceneSnapshot, type SnapshotQuestEntry, type SnapshotShopGood,
} from '../src/protocol/index';
import { applyMessage, initialState } from '../src/state';
import {
  QUEST_CARDS_NARROW_BELOW,
  UNKNOWN_TEXT,
  questCardModels,
  questCardsLayout,
  type QuestCardContext,
  type QuestCardModel,
} from '../src/panels/questCardModel';
import { createWorld } from './f2_world';
import { assert, done, suite } from './helpers';

// Radix 在載入時判斷有沒有 document（決定 useLayoutEffect），所以 DOM 要在載入元件前準備好。
const win = new Window({ url: 'http://localhost:5173/family/' });
Object.assign(globalThis, {
  window: win,
  document: win.document,
  getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: win.requestAnimationFrame.bind(win),
  cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  HTMLElement: win.HTMLElement,
  HTMLButtonElement: win.HTMLButtonElement,
  Element: win.Element,
  Node: win.Node,
  Event: win.Event,
  MouseEvent: win.MouseEvent,
  PointerEvent: win.PointerEvent ?? win.MouseEvent,
  KeyboardEvent: win.KeyboardEvent,
  CustomEvent: win.CustomEvent,
  FocusEvent: win.FocusEvent,
  NodeFilter: win.NodeFilter,
  ResizeObserver: win.ResizeObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { QuestCards } = await import('../src/panels/QuestCards');
const { ShopBuyList } = await import('../src/panels/ShopBuyList');

const snap = {
  mapId: 'm-town',
  mapName: '虛構小鎮',
  npcs: [{ id: 'npc-a', name: '虛構村長', x: 1, y: 1, gridX: 0, gridY: 0, role: 'VILLAGER', talkable: true, isAnimal: false, isShop: false }],
  nav: {
    status: 'AVAILABLE',
    reachableMaps: [{ mapId: 'm-field', name: '虛構草原', hops: 1 }],
    pixelWidth: null,
    pixelHeight: null,
  },
} as unknown as Pick<SceneSnapshot, 'mapId' | 'mapName' | 'npcs' | 'nav'>;

const quest = (over: Partial<SnapshotQuestEntry> & { questId: number }): SnapshotQuestEntry => ({
  title: `虛構委託${over.questId}`,
  npcId: 'npc-a',
  npcName: '虛構村長',
  minLevel: 1,
  status: 'AVAILABLE',
  objectives: [],
  rewardExp: 10,
  rewardCoins: 20,
  ...over,
});

const quests: SnapshotQuestEntry[] = [
  quest({ questId: 3, status: 'COMPLETED' }),
  quest({ questId: 1, status: 'AVAILABLE', objectives: [{ type: 'TALK', description: '和村長說話', current: 0, required: 1, met: false }] }),
  quest({
    questId: 2,
    status: 'IN_PROGRESS',
    objectives: [
      { type: 'TALK', description: '和村長說話', current: 1, required: 1, met: true },
      {
        type: 'KILL', description: '打倒虛構史萊姆', current: 1, required: 3, met: false,
        targetMaps: [{ mapId: 'm-field', mapName: null, reason: 'ENCOUNTER_AREA' }],
      },
    ],
  }),
  // 宿主沒給的值（佔位）：標題空字串、委託人缺、獎勵 null、目標數字缺。
  {
    questId: 4,
    title: '',
    npcId: 'npc-x',
    npcName: undefined as unknown as string,
    minLevel: null as unknown as number,
    status: 'READY',
    objectives: [{ type: 'GATHER', description: '', current: undefined as unknown as number, required: 2, met: true }],
    rewardExp: null as unknown as number,
    rewardCoins: Number.NaN,
  },
];

const names: Record<string, string> = { c1: '甲', c2: '乙' };
const ctx = (over: Partial<QuestCardContext> = {}): QuestCardContext => ({
  snapshot: snap,
  viewCharacterId: 'c1',
  nameOf: id => names[id] ?? null,
  activeQuestId: null,
  pendingAssign: null,
  ...over,
});
const byId = (cards: QuestCardModel[], id: number) => cards.find(c => c.questId === id)!;

suite('F9: 卡片內容只讀快照（目標、地點、進度、獎勵、誰在做）');
{
  const cards = questCardModels(quests, ctx({ activeQuestId: 2 }));
  assert(cards.map(c => c.questId).join(',') === '4,2,1,3', '排序：可回報 → 進行中 → 可接取 → 已完成');

  const avail = byId(cards, 1);
  assert(avail.goal === '向 虛構村長 接取', `可接取：目標是向委託人接取（${avail.goal}）`);
  assert(avail.location === '虛構村長｜虛構小鎮', `委託人在本圖：地點寫出 NPC 與地圖（${avail.location}）`);
  assert(avail.go?.kind === 'NPC' && avail.go.target === '虛構村長', '可接取：「前往」找委託人');
  assert(avail.rewardExp === '10 EXP' && avail.rewardCoins === '20 金', '獎勵照快照數字');
  assert(avail.owner.mode === 'NONE' && avail.owner.text === '尚無角色接取', '可接取：還沒有人在做');
  assert(avail.progress === '0/1 項目標', `進度（${avail.progress}）`);

  const prog = byId(cards, 2);
  assert(prog.goal === '打倒虛構史萊姆', `進行中：目標是第一個未完成的目標（${prog.goal}）`);
  assert(prog.location === '虛構草原', `地點名稱由導航可達清單補上（${prog.location}）`);
  assert(prog.go?.kind === 'MAP' && prog.go.target === 'm-field' && prog.go.name === '虛構草原', '進行中：「前往」交給跨圖移動到目標地圖');
  assert(prog.progress === '1/2 項目標', `進度（${prog.progress}）`);
  assert(prog.objectives[1].progress === '1/3' && !prog.objectives[1].met, '每個目標各自的數量');
  assert(prog.owner.mode === 'AUTO' && prog.owner.text === '甲（自動推進中）', '誰在做：自動推進中的角色');
  assert(!prog.hasUnknown, '資料完整的卡片沒有「未知」');

  const doneCard = byId(cards, 3);
  assert(doneCard.go === null && doneCard.owner.mode === 'DONE', '已完成：沒有「前往」');
}

suite('F9: 沒有出處的值顯示「未知」，不自補');
{
  const card = byId(questCardModels(quests, ctx()), 4);
  assert(card.title === UNKNOWN_TEXT, '標題空字串 → 未知');
  assert(card.giver === UNKNOWN_TEXT && card.location === UNKNOWN_TEXT, '委託人缺 → 未知，地點也未知');
  assert(card.go === null, '不知道去哪就不給「前往」');
  assert(card.minLevel === UNKNOWN_TEXT, '等級需求缺 → 未知');
  assert(card.rewardExp === UNKNOWN_TEXT && card.rewardCoins === UNKNOWN_TEXT, '獎勵 null／NaN → 未知（不補 0）');
  assert(card.objectives[0].text === UNKNOWN_TEXT && card.objectives[0].progress === UNKNOWN_TEXT, '目標文字與數量缺 → 未知');
  assert(card.hasUnknown, '卡片標記有未知欄位');
  assert(card.owner.mode === 'MANUAL' && card.owner.text === '甲', '可回報：快照的視角角色在做');
  const zero = questCardModels([quest({ questId: 9, rewardExp: 0, rewardCoins: 0, objectives: [{ type: 'TALK', description: '說話', current: 0, required: 1, met: false }] })], ctx())[0];
  assert(zero.rewardExp === '0 EXP' && zero.rewardCoins === '0 金' && !zero.hasUnknown, '宿主明確給 0 就顯示 0');
  const pending = byId(questCardModels(quests, ctx({ pendingAssign: { questId: 1, characterId: 'c2' } })), 1);
  assert(pending.owner.mode === 'PENDING' && pending.owner.text.includes('乙'), '派給別人時寫出等待背景快照');
  const bgActive = byId(questCardModels(quests, ctx({ lanes: [{ characterId: 'c2', active: true, questId: 1 }] })), 1);
  assert(bgActive.owner.mode === 'AUTO' && bgActive.owner.text.includes('乙') && bgActive.owner.text.includes('背景推進中'), '背景派工通道推進時顯示背景推進中');
}

suite('F9: 寬版多欄、窄版單欄');
{
  assert(questCardsLayout(1280).columns >= 3 && !questCardsLayout(1280).narrow, '1280px：多欄');
  assert(questCardsLayout(QUEST_CARDS_NARROW_BELOW).columns === 1 && !questCardsLayout(QUEST_CARDS_NARROW_BELOW).narrow, '480px：寬版但只放得下一欄');
  assert(questCardsLayout(750).columns === 3, '750px：三欄');
  assert(questCardsLayout(360).narrow && questCardsLayout(360).columns === 1, '360px：窄版單欄');
  assert(questCardsLayout(0).narrow && questCardsLayout(Number.NaN).columns === 1, '量不到寬度時當窄版');
}

suite('FX18: 窄版任務卡只隱藏宿主標示的佔位欄位');
{
  const objectives = [{ type: 'TALK', description: '說話', current: 0, required: 1, met: false }];
  const hidden = quest({
    questId: 91, minLevel: 9, rewardExp: 0, rewardCoins: 30, objectives,
    placeholderFields: ['minLevel', 'rewardExp'],
  });
  const zero = quest({
    questId: 92, minLevel: 0, rewardExp: 0, rewardCoins: 0, objectives,
    placeholderFields: ['rewardCoins'],
  });
  const known = quest({ questId: 93, minLevel: 0, rewardExp: 0, rewardCoins: 0, objectives });
  const snapshot: PluginMessage = {
    v: PROTOCOL_VERSION, kind: 'snapshot', characterId: 'char_1', ts: 100, seq: 1, reason: 'STARTED',
    snapshot: { ...createWorld({questCount: 0}).snapshotFor('char_1'), quests: [hidden, zero, known] },
  };
  assert(isPluginMessage(snapshot), '具旗標的 v6 任務快照通過共同協定');
  const state = applyMessage(initialState(), snapshot, 100);
  const models = questCardModels(state.snapshot?.quests ?? [], ctx());
  assert(byId(models, 91).hasUnknown && byId(models, 91).minLevel === UNKNOWN_TEXT
    && byId(models, 91).rewardExp === UNKNOWN_TEXT && byId(models, 91).rewardCoins === '30 金',
    '有旗標的非零門檻與零經驗都為未知，未標記金錢仍顯示');
  assert(byId(models, 92).minLevel === 'Lv.0' && byId(models, 92).rewardExp === '0 EXP'
    && byId(models, 92).rewardCoins === UNKNOWN_TEXT && !byId(models, 93).hasUnknown,
    '三欄旗標各自獨立；無旗標的三種 0 均保留');
  assert(state.snapshot?.quests?.[0]?.minLevel === 9 && state.snapshot?.quests?.[0]?.rewardExp === 0,
    '顯示模型不改自動化讀取的原始數字');
  const html = renderToStaticMarkup(
    <QuestCards cards={models} members={[]} viewCharacterId="char_1" running activeQuestId={null}
      initialWidth={360} onGo={() => {}} onAuto={() => {}} onAutoStop={() => {}} onAssign={() => {}} />,
  );
  assert(html.includes('data-layout="narrow"') && html.includes('需求 未知')
    && html.includes('未知／30 金') && html.includes('0 EXP／0 金'), '360px 任務卡保留旗標／實際數字差異');
}

suite('FX18: 商店快照與重開事件保留價格旗標，沒有污染實際 0');
{
  const npcId = 'npc-fx18-test';
  const npcName = '虛構商人';
  const goods: SnapshotShopGood[] = [
    { itemId: 1901, name: '虛構甲', price: 250, pricePlaceholder: true },
    { itemId: 1902, name: '虛構乙', price: 0, pricePlaceholder: true },
    { itemId: 1903, name: '虛構丙', price: 0, pricePlaceholder: false },
    { itemId: 1904, name: '虛構丁', price: 15 },
  ];
  const scene = createWorld({questCount: 0}).snapshotFor('char_1');
  const base = { v: PROTOCOL_VERSION, characterId: 'char_1', ts: 100 };
  const m: PluginMessage = {
    ...base, kind: 'snapshot', seq: 1, reason: 'STARTED',
    snapshot: {
      ...scene,
      shops: [{ npcId, npcName, goodsStatus: 'AVAILABLE', goods }],
      activity: { ...scene.activity, shop: { npcId, npcName } },
    },
  };
  assert(isPluginMessage(m), '共同協定接受含價格旗標的商店快照');
  let state = applyMessage(initialState(), m, 100);
  const shopHtml = () => state.shop && renderToStaticMarkup(
    <ShopBuyList goods={state.shop.goods} running onBuy={() => {}} />,
  );
  const correctPrices = (html: string | null) => !!html
    && (html.match(/<small>未知<\/small>/g) ?? []).length === 2
    && html.includes('<small>0 金</small>') && html.includes('<small>15 金</small>')
    && !html.includes('<small>250 金</small>');
  assert(correctPrices(shopHtml()), '先讀開店快照：旗標為真顯示未知，false 的零及缺旗標的數字照常顯示');
  const event = (seq: number, payload: GameEvent): PluginMessage => ({ ...base, kind: 'event', seq, event: payload });
  state = applyMessage(state, event(2, { type: 'SHOP_CLOSED', npcId }), 101);
  assert(shopHtml() === null, '關店清空列表');
  const reopen = event(3, { type: 'SHOP_OPENED', npcId, npcName, goods });
  assert(isPluginMessage(reopen), '共同協定接受含價格旗標的開店事件');
  state = applyMessage(state, reopen, 102);
  assert(correctPrices(shopHtml()) && state.shop?.goods[0].price === 250, '從開店事件重開後顯示一致，原始價格未被改寫');
}

const failDir = path.resolve('test-results/f9');
const render = (width: number) =>
  renderToStaticMarkup(
    <QuestCards
      cards={questCardModels(quests, ctx())}
      members={[{ characterId: 'c1', name: '甲' }, { characterId: 'c2', name: '乙' }]}
      viewCharacterId="c1"
      running
      activeQuestId={null}
      initialWidth={width}
      onGo={() => {}}
      onAuto={() => {}}
      onAutoStop={() => {}}
      onAssign={() => {}}
    />,
  );

suite('F9: 假快照排版（寬、窄）');
for (const [width, layout] of [[1280, 'wide'], [360, 'narrow']] as const) {
  const html = render(width);
  const ok = [
    html.includes(`data-layout="${layout}"`),
    html.includes(`data-columns="${questCardsLayout(width).columns}"`),
    (html.match(/data-testid="quest-entry"/g) ?? []).length === 4,
    (html.match(/data-testid="quest-nav-btn"/g) ?? []).length === 3,
    (html.match(/data-testid="quest-card-assign-btn"/g) ?? []).length === 3,
    html.includes(UNKNOWN_TEXT),
    html.includes('前往（地點未知）'),
  ];
  const pass = ok.every(Boolean);
  assert(pass, `${width}px：${layout} 版面、4 張卡片、未完成的 3 張有「前往」「派給角色」、佔位顯示未知`);
  if (!pass) {
    // 失敗時才留下版面（覆蓋同一個資料夾）；成功不存任何檔案。
    mkdirSync(failDir, { recursive: true });
    writeFileSync(path.join(failDir, `quest-cards-${width}.html`), html);
    console.error(`  已存失敗時的版面：${path.join(failDir, `quest-cards-${width}.html`)}`);
  }
}

suite('F9: 點「前往」與「派給角色」（React 實機 DOM）');
{
  const { createRoot } = await import('react-dom/client');
  const { act } = await import('react');
  const host = win.document.createElement('div');
  win.document.body.appendChild(host);
  const went: QuestCardModel[] = [];
  const assigned: Array<[number, string]> = [];
  const root = createRoot(host as unknown as HTMLElement);
  await act(async () => {
    root.render(
      <QuestCards
        cards={questCardModels(quests, ctx())}
        members={[{ characterId: 'c1', name: '甲' }, { characterId: 'c2', name: '乙' }]}
        viewCharacterId="c1"
        running
        activeQuestId={null}
        initialWidth={1280}
        onGo={card => went.push(card)}
        onAuto={() => {}}
        onAutoStop={() => {}}
        onAssign={(card, id) => assigned.push([card.questId, id])}
      />,
    );
  });
  const nav = host.querySelector('[data-testid="quest-entry"][data-quest-id="2"] [data-testid="quest-nav-btn"]') as unknown as HTMLElement;
  await act(async () => { nav.click(); });
  assert(went.length === 1 && went[0].go?.kind === 'MAP' && went[0].go.target === 'm-field', '「前往」把目標地圖交給跨圖移動');
  const unknownNav = host.querySelector('[data-testid="quest-entry"][data-quest-id="4"] [data-testid="quest-nav-btn"]') as unknown as HTMLButtonElement;
  assert(unknownNav.disabled, '地點未知時「前往」不能按');

  const trigger = host.querySelector('[data-testid="quest-entry"][data-quest-id="1"] [data-testid="quest-card-assign-btn"]') as unknown as HTMLElement;
  await act(async () => { trigger.click(); });
  const member = win.document.querySelector('[data-testid="quest-card-assign-member"][data-character-id="c2"]') as unknown as HTMLElement | null;
  const menuText = win.document.querySelector('[data-testid="quest-card-assign-menu"]')?.textContent ?? '';
  assert(member !== null && menuText.includes('背景派工通道') && !menuText.includes('先切換視角'), '「派給角色」打開成員清單（Radix Popover），提示背景派工不切視角');
  if (member) await act(async () => { member.click(); });
  assert(assigned.length === 1 && assigned[0][0] === 1 && assigned[0][1] === 'c2', '選成員後回報任務與角色');
  const stoppedCards: number[] = [];
  const bgCtx = ctx({
    pendingAssign: { questId: 1, characterId: 'c2' },
    lanes: [{ characterId: 'c2', active: true, questId: 2 }],
  });
  await act(async () => {
    root.render(
      <QuestCards
        cards={questCardModels(quests, bgCtx)}
        members={[{ characterId: 'c1', name: '甲' }, { characterId: 'c2', name: '乙' }]}
        viewCharacterId="c1"
        running
        activeQuestId={null}
        initialWidth={1280}
        onGo={card => went.push(card)}
        onAuto={() => {}}
        onAutoStop={card => stoppedCards.push(card.questId)}
        onAssign={(card, id) => assigned.push([card.questId, id])}
      />,
    );
  });
  const stopPending = host.querySelector('[data-testid="quest-entry"][data-quest-id="1"] [data-testid="quest-auto-stop-btn"]') as unknown as HTMLElement | null;
  const stopBgAuto = host.querySelector('[data-testid="quest-entry"][data-quest-id="2"] [data-testid="quest-auto-stop-btn"]') as unknown as HTMLElement | null;
  assert(stopPending !== null && stopBgAuto !== null, '背景等待快照（PENDING）與背景推進（AUTO）卡片都顯示「停止自動」');
  if (stopPending) await act(async () => { stopPending.click(); });
  if (stopBgAuto) await act(async () => { stopBgAuto.click(); });
  assert(stoppedCards.join(',') === '1,2', '點背景卡片「停止自動」會回報對應的任務');

  await act(async () => { root.unmount(); });
  win.close();
}

suite('F9c: 派給不在視角中的角色＝直接走 F8 背景派工通道，不切視角');
{
  const w = createWorld({ fx17: true, questCount: 3, questStepMs: 500 });
  w.boot();
  assert(w.viewed === 'char_1', '一開始視角是愛麗絲');
  const before = w.sent.length;
  const err = w.ctrl.perform({ kind: 'QUEST_ASSIGN', questId: 7000, characterId: 'char_2', label: '派任務「虛構委託1」給 小石' });
  assert(err === null, '派任務接受');
  assert(w.sent.slice(before).every(c => c.command.type !== 'SWITCH_VIEW_CHARACTER'), '完全不送 SWITCH_VIEW_CHARACTER');
  assert(w.sent.slice(before).some(c => c.command.type === 'REQUEST_SNAPSHOT' && c.characterId === 'char_2'), '向宿主索取小石自己的背景快照');
  assert(w.ctrl.pendingQuestAssign()?.characterId === 'char_2', '等待中的背景派任務記在控制器');
  const dupErr = w.ctrl.perform({ kind: 'QUEST_ASSIGN', questId: 7000, characterId: 'char_1', label: '重複派給愛麗絲' });
  assert(typeof dupErr === 'string' && dupErr.includes('小石'), `等待快照期間同一任務不重複派給別人（${dupErr}）`);
  const fg = new Set(['WALK_TO', 'TALK_TO_NPC', 'CHOOSE_DIALOG_OPTION', 'ACCEPT_QUEST']);
  assert(w.sent.slice(before).filter(c => fg.has(c.command.type)).length === 0, '背景快照到位前沒有送任務指令');

  w.advance(2_000);
  assert(w.viewed === 'char_1' && w.ctrl.state.characterId === 'char_1', '宿主與外掛視角都維持在愛麗絲');
  assert(w.ctrl.pendingQuestAssign() === null, '背景快照到位後清掉等待中紀錄');
  const laneSum = w.ctrl.laneSummaries().find(l => l.characterId === 'char_2');
  assert(Boolean(laneSum?.active) && laneSum?.questId === 7000, '小石的 F8 背景通道開始推進 7000');
  const after = w.sent.slice(before).filter(c => fg.has(c.command.type));
  assert(after.length > 0 && after.every(c => c.characterId === 'char_2'), '任務指令全部直接送給小石');
  assert(!w.ctrl.state.log.some(l => l.text.includes('WRONG_CHARACTER')), '宿主沒有回 WRONG_CHARACTER');

  for (let i = 0; i < 40 && w.questsOf('char_2').find(q => q.questId === 7000)?.status !== 'COMPLETED'; i++) {
    w.advance(250);
  }
  assert(w.questsOf('char_2').find(q => q.questId === 7000)?.status === 'COMPLETED', '小石在背景完成這個任務');
  assert(w.questsOf('char_1').find(q => q.questId === 7000)?.status === 'AVAILABLE', '視角角色愛麗絲的任務沒有被動到');
  assert(w.sent.slice(before).every(c => c.command.type !== 'SWITCH_VIEW_CHARACTER'), '全程零次 SWITCH_VIEW_CHARACTER');

  // 推進一拍讓背景更新快照送達，通道已有新鮮快照（5 秒內），直接再派 7001 不用再等快照也不切視角。
  w.advance(500);
  const beforeSecond = w.sent.length;
  const err2 = w.ctrl.perform({ kind: 'QUEST_ASSIGN', questId: 7001, characterId: 'char_2', label: '再派任務「虛構委託2」給 小石' });
  assert(err2 === null && w.ctrl.pendingQuestAssign() === null, '新鮮快照下直接啟動背景通道任務');
  w.advance(10_000);
  assert(w.questsOf('char_2').find(q => q.questId === 7001)?.status === 'COMPLETED', '小石在背景接續完成 7001');
  assert(w.sent.slice(beforeSecond).every(c => c.command.type !== 'SWITCH_VIEW_CHARACTER'), '第二次派任務一樣不切視角');
}

suite('F9c: 派給視角中的角色＝直接自動推進，不切視角；找不到的角色回錯誤');
{
  const w = createWorld({ fx17: true, questCount: 3, questStepMs: 500 });
  w.boot();
  const before = w.sent.length;
  const err = w.ctrl.perform({ kind: 'QUEST_ASSIGN', questId: 7001, characterId: 'char_1', label: '派任務給 愛麗絲' });
  assert(err === null && w.ctrl.activeQuest() === 7001, '視角中的角色直接開始自動推進');
  assert(w.sent.slice(before).every(c => c.command.type !== 'SWITCH_VIEW_CHARACTER'), '不用切換視角');
  w.advance(10_000);
  assert(w.questsOf('char_1').find(q => q.questId === 7001)?.status === 'COMPLETED', '視角角色完成任務');
  const bad = w.ctrl.perform({ kind: 'QUEST_ASSIGN', questId: 7001, characterId: 'char_nobody', label: '派任務給 不存在' });
  assert(typeof bad === 'string' && bad.length > 0, '不存在的角色回錯誤文字');
}

suite('F9c: 背景已有派工時改派單筆任務會停掉原派工；快照逾時則放棄且不切視角');
{
  const w = createWorld({ fx17: true, questCount: 10, questStepMs: 500 });
  w.boot();
  assert(w.ctrl.dispatcher.assign('char_2', {
    kind: 'QUEST_CHAIN',
    stop: { maxMinutes: null, stopOnBagFull: false, minSatiety: null },
  }) === null, '先讓小石跑任務鏈派工');
  w.advance(4_000);
  const before = w.sent.length;
  const err = w.ctrl.perform({ kind: 'QUEST_ASSIGN', questId: 7005, characterId: 'char_2', label: '改派單筆任務給小石' });
  assert(err === null, '改派單筆任務成功');
  const rec = w.ctrl.dispatches().find(r => r.characterId === 'char_2');
  assert(rec?.phase === 'STOPPED', `原本任務鏈派工已停下（${rec?.phase}）`);
  w.advance(10_000);
  assert(w.questsOf('char_2').find(q => q.questId === 7005)?.status === 'COMPLETED', '小石在背景完成指定的單筆任務 7005');
  assert(w.sent.slice(before).every(c => c.command.type !== 'SWITCH_VIEW_CHARACTER'), '改派與執行全程不切視角');

  // 快照逾時情境：攔截 REQUEST_SNAPSHOT 不回傳。
  const w2 = createWorld({ fx17: true, questCount: 3, questStepMs: 500 });
  w2.boot();
  const origSend = w2.transport.send.bind(w2.transport);
  w2.transport.send = m => {
    if (m.command.type === 'REQUEST_SNAPSHOT' && m.characterId === 'char_2') return;
    origSend(m);
  };
  assert(w2.ctrl.perform({ kind: 'QUEST_ASSIGN', questId: 7000, characterId: 'char_2', label: '逾時測試' }) === null, '派任務進入等待背景快照');
  assert(w2.ctrl.pendingQuestAssign()?.characterId === 'char_2', '紀錄等待中');
  w2.advance(16_000);
  assert(w2.ctrl.pendingQuestAssign() === null, '15 秒未收到快照後清除等待狀態');
  assert(w2.ctrl.laneSummaries().every(l => !l.active), '逾時後沒有啟動通道任務');
  assert(w2.sent.every(c => c.command.type !== 'SWITCH_VIEW_CHARACTER'), '逾時情境也不會送出切換視角');
}

suite('F9c: QUEST_AUTO_STOP 與 DISPATCH_ASSIGN / DISPATCH_STOP 正確中止背景待啟動與執行中的單筆任務');
{
  // 1. 背景 PENDING 時可用 QUEST_AUTO_STOP 單獨取消，不影響視角角色正在跑的任務。
  const w = createWorld({ fx17: true, questCount: 4, questStepMs: 500 });
  w.boot();
  assert(w.ctrl.perform({ kind: 'QUEST_ASSIGN', questId: 7001, characterId: 'char_1', label: '視角角色跑 7001' }) === null, '視角角色開始 7001');
  assert(w.ctrl.perform({ kind: 'QUEST_ASSIGN', questId: 7000, characterId: 'char_2', label: '背景角色派 7000' }) === null, '背景角色進入等待快照');
  assert(w.ctrl.pendingQuestAssign()?.characterId === 'char_2', '小石在 PENDING 中');
  assert(w.ctrl.perform({ kind: 'QUEST_AUTO_STOP', label: '取消小石背景任務', targetCharacterId: 'char_2' }) === null, '取消小石背景任務');
  assert(w.ctrl.pendingQuestAssign() === null, '小石的 PENDING 已清除');
  assert(w.ctrl.activeQuest() === 7001, '視角角色愛麗絲的 7001 沒有被停掉');
  w.advance(2_000);
  assert(!w.ctrl.laneSummaries().find(l => l.characterId === 'char_2')?.active, '即使快照隨後到達，小石也不會啟動已取消的 7000');

  // 2. 背景 AUTO 進行中時可用 QUEST_AUTO_STOP(targetCharacterId) 單獨停下，且不影響視角角色。
  assert(w.ctrl.perform({ kind: 'QUEST_ASSIGN', questId: 7002, characterId: 'char_2', label: '背景角色跑 7002' }) === null, '小石啟動 7002');
  assert(Boolean(w.ctrl.laneSummaries().find(l => l.characterId === 'char_2')?.active), '小石通道正在推進 7002');
  assert(w.ctrl.perform({ kind: 'QUEST_AUTO_STOP', label: '停止小石背景單筆任務', targetCharacterId: 'char_2' }) === null, '對小石送 QUEST_AUTO_STOP');
  assert(!w.ctrl.laneSummaries().find(l => l.characterId === 'char_2')?.active, '小石背景單筆任務已停止');
  w.advance(10_000);
  assert(w.questsOf('char_1').find(q => q.questId === 7001)?.status === 'COMPLETED', '愛麗絲照常完成 7001');
  assert(w.questsOf('char_2').find(q => q.questId === 7002)?.status !== 'COMPLETED', '小石停止後不再推進 7002');

  // 3. DISPATCH_ASSIGN 與 DISPATCH_STOP 都要清掉 pendingLaneQuests 並停掉 active 的單筆 lane.quest。
  const w2 = createWorld({ fx17: true, questCount: 5, questStepMs: 500 });
  w2.boot();
  assert(w2.ctrl.perform({ kind: 'QUEST_ASSIGN', questId: 7000, characterId: 'char_2', label: '派 7000' }) === null, '進入 PENDING');
  assert(w2.ctrl.perform({
    kind: 'DISPATCH_ASSIGN',
    characterId: 'char_2',
    label: '改派任務鏈',
    spec: { kind: 'QUEST_CHAIN', stop: { maxMinutes: null, stopOnBagFull: false, minSatiety: null } },
  }) === null, 'DISPATCH_ASSIGN 取代待啟動的背景單筆任務');
  assert(w2.ctrl.pendingQuestAssign() === null, 'DISPATCH_ASSIGN 清掉 pendingLaneQuests');
  w2.advance(1_000);
  assert(w2.ctrl.dispatches().find(r => r.characterId === 'char_2')?.kind === 'QUEST_CHAIN', '改為執行任務鏈派工');

  // DISPATCH_STOP 停掉進行中的單筆 lane.quest；也驗證對 PENDING 狀態下 DISPATCH_STOP 同樣清除。
  assert(w2.ctrl.perform({ kind: 'QUEST_ASSIGN', questId: 7003, characterId: 'char_2', label: '派單筆 7003' }) === null, '派單筆 7003');
  w2.advance(1_000);
  assert(Boolean(w2.ctrl.laneSummaries().find(l => l.characterId === 'char_2' && l.active && l.questId === 7003)), '小石通道正在跑單筆 7003');
  w2.ctrl.perform({ kind: 'DISPATCH_STOP', characterId: 'char_2', label: '停止小石派工' });
  assert(!w2.ctrl.laneSummaries().find(l => l.characterId === 'char_2')?.active, 'DISPATCH_STOP 停掉進行中的單筆 lane.quest');

  const w3 = createWorld({ fx17: true, questCount: 3, questStepMs: 500 });
  w3.boot();
  w3.ctrl.perform({ kind: 'QUEST_ASSIGN', questId: 7000, characterId: 'char_2', label: '派 7000' });
  assert(w3.ctrl.pendingQuestAssign()?.characterId === 'char_2', 'PENDING 中');
  w3.ctrl.perform({ kind: 'DISPATCH_STOP', characterId: 'char_2', label: '派工停止' });
  assert(w3.ctrl.pendingQuestAssign() === null, 'DISPATCH_STOP 清掉 pendingLaneQuests');
  w3.advance(2_000);
  assert(!w3.ctrl.laneSummaries().find(l => l.characterId === 'char_2')?.active, '清掉後不會在快照到達時啟動');
}

done();
