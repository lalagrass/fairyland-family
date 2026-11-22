/**
 * F9（fairyland-family#50）：任務卡片的內容、寬窄排版、「前往」「派給角色」。
 * 全部是虛構資料（任務、NPC、地圖都是假的），不含任何原版內容。
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SceneSnapshot, SnapshotQuestEntry } from '../src/protocol/index';
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
  assert(pending.owner.mode === 'PENDING' && pending.owner.text.includes('乙'), '派給別人時寫出等待切換視角');
}

suite('F9: 寬版多欄、窄版單欄');
{
  assert(questCardsLayout(1280).columns >= 3 && !questCardsLayout(1280).narrow, '1280px：多欄');
  assert(questCardsLayout(QUEST_CARDS_NARROW_BELOW).columns === 1 && !questCardsLayout(QUEST_CARDS_NARROW_BELOW).narrow, '480px：寬版但只放得下一欄');
  assert(questCardsLayout(750).columns === 3, '750px：三欄');
  assert(questCardsLayout(360).narrow && questCardsLayout(360).columns === 1, '360px：窄版單欄');
  assert(questCardsLayout(0).narrow && questCardsLayout(Number.NaN).columns === 1, '量不到寬度時當窄版');
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
  assert(member !== null, '「派給角色」打開成員清單（Radix Popover）');
  if (member) await act(async () => { member.click(); });
  assert(assigned.length === 1 && assigned[0][0] === 1 && assigned[0][1] === 'c2', '選成員後回報任務與角色');
  await act(async () => { root.unmount(); });
  win.close();
}

suite('F9: 派給不在視角中的角色＝先切換視角，等快照到了才自動推進');
{
  const w = createWorld({ questCount: 3, questStepMs: 500 });
  w.boot();
  assert(w.viewed === 'char_1', '一開始視角是愛麗絲');
  const before = w.sent.length;
  const err = w.ctrl.perform({ kind: 'QUEST_ASSIGN', questId: 7000, characterId: 'char_2', label: '派任務「虛構委託1」給 小石' });
  assert(err === null, '派任務接受');
  const switched = w.sent.slice(before).filter(c => c.command.type === 'SWITCH_VIEW_CHARACTER');
  assert(switched.length === 1 && switched[0].characterId === 'char_2', '先送切換視角給小石');
  assert(w.ctrl.pendingQuestAssign()?.characterId === 'char_2', '等待中的派任務記在控制器');
  assert(w.ctrl.activeQuest() === null, '視角還沒切過去前不開始自動推進');
  const fg = new Set(['WALK_TO', 'TALK_TO_NPC', 'CHOOSE_DIALOG_OPTION', 'ACCEPT_QUEST']);
  assert(w.sent.slice(before).filter(c => fg.has(c.command.type)).length === 0, '切換前沒有送任何任務指令');
  w.advance(2_000);
  assert(w.viewed === 'char_2', '宿主視角切到小石');
  assert(w.ctrl.pendingQuestAssign() === null, '切過去後清掉等待中的派任務');
  const after = w.sent.slice(before).filter(c => fg.has(c.command.type));
  assert(after.length > 0 && after.every(c => c.characterId === 'char_2'), '任務指令都送給小石');
  assert(!w.ctrl.state.log.some(l => l.text.includes('WRONG_CHARACTER')), '宿主沒有回 WRONG_CHARACTER');
  w.advance(10_000);
  assert(w.quests[0].status === 'COMPLETED', '小石完成這個任務');
}

suite('F9: 派給視角中的角色＝直接自動推進；找不到的角色回錯誤');
{
  const w = createWorld({ questCount: 3, questStepMs: 500 });
  w.boot();
  const before = w.sent.length;
  const err = w.ctrl.perform({ kind: 'QUEST_ASSIGN', questId: 7001, characterId: 'char_1', label: '派任務給 愛麗絲' });
  assert(err === null && w.ctrl.activeQuest() === 7001, '視角中的角色直接開始自動推進');
  assert(w.sent.slice(before).every(c => c.command.type !== 'SWITCH_VIEW_CHARACTER'), '不用切換視角');
  const bad = w.ctrl.perform({ kind: 'QUEST_ASSIGN', questId: 7001, characterId: 'char_nobody', label: '派任務給 不存在' });
  assert(typeof bad === 'string' && bad.length > 0, '不存在的角色回錯誤文字');
}

done();
