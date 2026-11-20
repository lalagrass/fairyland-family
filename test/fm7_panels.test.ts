import { Window } from 'happy-dom';
import ex from '../src/protocol/examples.json';
import { PROTOCOL_VERSION, type StaticDataPayload, type StaticSkillSummary } from '../src/protocol/index';
import { commandForItemDrag, commandFromDragData } from '../src/panels/itemMove';
import { applyMessage, initialState } from '../src/state';
import { assert, done, suite } from './helpers';

const potion = { itemId: 50001, name: '生命藥水', count: 3 };

suite('FM7: 拖曳只產生原子指令，不改本地數量');
{
  assert(commandForItemDrag('bag', 'bag', potion) === null, '同一個背包裡換位置沒有指令');
  assert(commandForItemDrag('warehouse', 'warehouse', potion) === null, '同一個倉庫裡換位置沒有指令');
  assert(commandFromDragData({ bin: 'bag', item: potion }, 'shelf') === null, '落點不是背包或倉庫時不送指令');

  const deposit = commandForItemDrag('bag', 'warehouse', potion);
  assert(
    deposit?.command.type === 'WAREHOUSE_DEPOSIT'
      && deposit.command.itemId === 50001
      && deposit.command.count === 1
      && deposit.label.includes('生命藥水'),
    '背包拖到倉庫是存倉 1 件',
  );
  const withdraw = commandFromDragData({ bin: 'warehouse', item: potion }, 'bag');
  assert(
    withdraw?.command.type === 'WAREHOUSE_WITHDRAW'
      && withdraw.command.itemId === 50001
      && withdraw.command.count === 1,
    '倉庫拖到背包是取倉 1 件',
  );
  assert(potion.count === 3, '組指令時不改動物件數量');
}

suite('FM7: 宿主事件套用後背包與倉庫才變');
{
  let s = initialState();
  const snapMsg = JSON.parse(JSON.stringify(ex.snapshot));
  snapMsg.characterId = 'char-demo-1';
  snapMsg.snapshot.family = {
    activeCharacterId: 'char-demo-1',
    maxSlots: 5,
    warehouse: { gold: 0, cap: 200, items: [] },
    members: [{
      characterId: 'char-demo-1',
      name: '阿草',
      level: 5,
      mapId: '10001',
      mapName: '吉恩村',
      x: 3880,
      y: 3740,
      gold: 1200,
      satiety: 95,
      inventoryCount: 8,
      inventoryCap: 40,
      inBattle: false,
      inventory: snapMsg.snapshot.inventory,
      workSkills: {},
    }],
  };
  s = applyMessage(s, {
    v: PROTOCOL_VERSION, characterId: 'char-demo-1', ts: 1, kind: 'heartbeat',
    sessionId: 'sess-fm7', seq: 1, mapId: '10001', phase: 'PLAYING', inBattle: false,
  }, 10);
  s = applyMessage(s, snapMsg, 20);
  assert(s.inventory.find(i => i.itemId === 50001)?.count === 3, '快照後背包仍是 3');
  assert(s.warehouse?.items.length === 0, '快照後倉庫沒有物品');

  const deposit = commandForItemDrag('bag', 'warehouse', potion);
  assert(deposit !== null && s.inventory.find(i => i.itemId === 50001)?.count === 3, '送出存倉指令當下外掛不改背包');
  s = applyMessage(s, {
    v: PROTOCOL_VERSION, characterId: 'char-demo-1', ts: 30, kind: 'event', seq: 2,
    event: { type: 'INVENTORY_CHANGED', changes: [{ itemId: 50001, delta: -1, count: 2 }] },
  }, 30);
  s = applyMessage(s, {
    v: PROTOCOL_VERSION, characterId: 'char-demo-1', ts: 31, kind: 'event', seq: 3,
    event: { type: 'WAREHOUSE_CHANGED', gold: 0, items: [{ itemId: 50001, name: '生命藥水', count: 1 }] },
  }, 31);
  assert(s.inventory.find(i => i.itemId === 50001)?.count === 2, '宿主 INVENTORY_CHANGED 後背包剩 2');
  assert(s.warehouse?.items.some(i => i.itemId === 50001 && i.count === 1) === true, '宿主 WAREHOUSE_CHANGED 後倉庫有 1 件');
  assert(s.warehouse?.cap === 200, '倉庫容量沿用快照，不被事件清掉');

  const back = commandForItemDrag('warehouse', 'bag', { itemId: 50001, name: '生命藥水', count: 1 });
  assert(back?.command.type === 'WAREHOUSE_WITHDRAW' && back.command.count === 1, '取回也是 1 件');
  s = applyMessage(s, {
    v: PROTOCOL_VERSION, characterId: 'char-demo-1', ts: 40, kind: 'event', seq: 4,
    event: { type: 'INVENTORY_CHANGED', changes: [{ itemId: 50001, delta: 1, count: 3 }] },
  }, 40);
  s = applyMessage(s, {
    v: PROTOCOL_VERSION, characterId: 'char-demo-1', ts: 41, kind: 'event', seq: 5,
    event: { type: 'WAREHOUSE_CHANGED', gold: 0, items: [] },
  }, 41);
  assert(s.inventory.find(i => i.itemId === 50001)?.count === 3, '取回後背包回到 3');
  assert(s.warehouse?.items.length === 0, '取回後倉庫物品清空');
}

suite('FM7: 四個面板只顯示快照已有的欄位，長清單會虛擬化');
{
  const win = new Window({ url: 'http://localhost:3100/family/' });
  for (const [key, value] of [['clientHeight', 240], ['clientWidth', 280]] as const) {
    Object.defineProperty(win.HTMLElement.prototype, key, { configurable: true, get() { return value; } });
  }
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
    PointerEvent: win.PointerEvent,
    localStorage: win.localStorage,
  });
  const { mountUi } = await import('../src/ui');
  const root = win.document.createElement('div');
  win.document.body.appendChild(root);
  const actions: string[] = [];
  const ui = mountUi(root as unknown as HTMLElement, 'TEST', action => {
    actions.push(action.kind);
    return null;
  }, () => null);
  const selectPage = async (label: string) => {
    const tab = [...root.querySelectorAll('[data-testid="character-workbench"] [role="tab"]')].find(t => t.textContent === label);
    if (!tab) throw new Error(`工作台缺少頁籤：${label}`);
    tab.dispatchEvent(new win.MouseEvent('mousedown', { button: 0, bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    const panel = win.document.getElementById(tab.getAttribute('aria-controls') ?? '');
    assert(tab.getAttribute('aria-selected') === 'true' && panel?.getAttribute('data-state') === 'active', `${label}連到目前顯示的面板`);
    return panel;
  };

  const skills: StaticSkillSummary[] = [
    { id: 1, name: 'bbbb', kind: 'SKILL', mpCost: 0, targetScope: 'SINGLE' },
    { id: 2, name: 'aaaa', kind: 'SPELL', mpCost: 4, targetScope: 'SELF', reqLevel: 3 },
  ];
  for (let i = 3; i <= 40; i++) {
    skills.push({ id: i, name: `zzzz-${String(i).padStart(2, '0')}`, kind: 'SKILL', mpCost: 1, targetScope: 'SINGLE' });
  }
  let s = applyMessage(initialState(), {
    v: PROTOCOL_VERSION, characterId: 'char-demo-1', ts: 1, kind: 'heartbeat',
    sessionId: 'sess-fm7-ui', seq: 1, mapId: '10001', phase: 'PLAYING', inBattle: false,
  }, 10);
  const snapMsg = JSON.parse(JSON.stringify(ex.snapshot));
  snapMsg.snapshot.character.className = '測試職業';
  snapMsg.snapshot.character.ruleset = 'classic';
  snapMsg.snapshot.family = {
    activeCharacterId: 'char-demo-1',
    maxSlots: 5,
    warehouse: { gold: 10, cap: 200, items: [{ itemId: 100000, name: null, count: 1 }] },
    members: [],
  };
  s = applyMessage(s, snapMsg, 20);
  s = {
    ...s,
    staticData: {
      schema: 'static-data',
      version: 'fm7-test',
      recipes: [],
      portalGraph: [],
      skills,
    } as unknown as StaticDataPayload,
  };
  const aux = { nav: { phase: 'IDLE' as const, goal: null, route: [], text: '閒置' }, strategy: 'MANUAL' as const, known: [] };
  ui.render(s, 'RUNNING', aux);

  await selectPage('總覽');
  const stats = root.querySelector('[data-testid="character-stats"]')?.textContent ?? '';
  assert(stats.includes('測試職業'), '角色面板顯示快照裡的職業');
  assert(stats.includes('屬性') && stats.includes('快照沒有這欄'), '沒有屬性欄時不補數字');
  assert(stats.includes('經驗') && stats.split('快照沒有這欄').length >= 3, '經驗也標快照沒有這欄');
  assert(stats.includes('快照沒有裝備欄'), '沒有裝備欄時不補裝備');
  assert(!/\b(力量|敏捷|智慧|魅力|體質|幸運)\b/.test(stats), '角色面板不出現六圍名稱');

  assert(root.querySelector('[data-testid="skill-panel"]') !== null, '有技能面板');
  assert(root.querySelector('[data-testid="inventory-panel"]') !== null, '有物品欄');
  assert(root.querySelector('[data-testid="warehouse-panel"]') !== null, '有倉庫面板');
  const skillPane = await selectPage('技能');
  assert(skillPane?.textContent?.includes('不代表目前角色已習得') === true, '區分宿主技能表和角色已習得的技能');
  const skillRows = () => root.querySelectorAll('[data-testid="skill-row"]').length;
  assert(skillRows() > 0 && skillRows() < 40, `長技能表只畫視窗內的列（實際 ${skillRows()}）`);
  assert(root.querySelector('[data-testid="skill-row"]')?.textContent?.includes('說明：快照沒有這欄') === true, '技能說明不補文案');

  const sort = root.querySelector('[data-testid="skill-sort-name"]') as HTMLButtonElement | null;
  sort?.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  const firstSkill = root.querySelector('[data-testid="skill-row"]')?.getAttribute('data-skill-id');
  assert(firstSkill === '2', `名稱排序後第一列是 aaaa（實際 ${firstSkill}）`);

  await selectPage('物品欄');
  const bagRows = () => [...root.querySelectorAll('[data-testid="wh-deposit-item"]')].map(el => el.getAttribute('data-item-id'));
  assert(bagRows().includes('50001'), '背包列出快照物品');
  const filter = root.querySelector('[data-testid="bag-filter"]') as HTMLInputElement | null;
  assert(filter !== null, '背包有篩選框');
  if (filter) {
    // 直接寫 value 會先更新 React 的值追蹤，接著的 input 事件會被當成沒有變更。
    const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')?.set;
    setValue?.call(filter, '生命');
    filter.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
    await new Promise(resolve => setTimeout(resolve, 0));
    const after = bagRows();
    assert(after.length === 1 && after[0] === '50001', `篩選後只留生命藥水（實際 ${after.join(',') || '無'}）`);
  }



  assert(root.querySelector('[data-testid="wh-gold"]')?.textContent?.includes('10') === true, '倉庫金錢仍從快照顯示');
  assert(root.querySelector('[data-testid="wh-deposit-gold"]') !== null, '存金按鈕還在');
  assert(root.querySelector('[data-testid="gold"]') !== null, '角色金錢測試點還在');
  assert(root.querySelector('[data-testid="inventory"]') !== null, '右側物品摘要還在');

  suite('F1: 切換工作台頁籤不發送動作，更新快照不重置所選頁籤');
  const settings = await selectPage('設定');
  assert(settings?.textContent?.includes(snapMsg.snapshot.character.name) === true, '設定屬於目前快照的角色');
  assert(actions.length === 0, '切換四個工作台頁籤與清單排序、篩選都不送出動作');
  const updated = JSON.parse(JSON.stringify(snapMsg));
  updated.snapshot.character.name = '另一份角色快照';
  ui.render(applyMessage(s, updated, 30), 'RUNNING', aux);
  assert(settings?.getAttribute('data-state') === 'active' && settings.textContent?.includes('另一份角色快照') === true,
    '刷新快照後維持設定頁並顯示目前角色');
  await selectPage('物品欄');
  assert(filter?.value === '生命', '返回物品欄時保留篩選');
  win.close();
}

done();
