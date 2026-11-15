import type { PluginCommand, SnapshotBattleStatus, SnapshotBattleUnitSummary } from './protocol/index';
import { STRATEGIES, type BattleStrategy } from './battler';
import type { DirNpc } from './directory';
import { buildMenu } from './menu';
import type { NavStatus } from './navigator';
import { INPUT_HELP, type UiAction } from './parse';
import { stopReasonLabel, type QueueStatus } from './queue';
import { initialState, type FamilyState } from './state';

type Perform = (action: UiAction) => string | null;
type SubmitText = (text: string) => string | null;

/** 畫面上除了鏡像狀態之外，還要顯示的外掛端資訊。 */
export interface UiAux { nav: NavStatus; strategy: BattleStrategy; known: DirNpc[]; queue?: QueueStatus; queues?: Record<string, QueueStatus> }
const NO_QUEUE: QueueStatus = { phase: 'IDLE', jobs: [], activeJobIndex: 0, stopReason: null, text: '工作佇列：閒置' };
const NO_AUX: UiAux = { nav: { phase: 'IDLE', goal: null, route: [], text: '導航：閒置' }, strategy: 'MANUAL', known: [], queue: NO_QUEUE, queues: {} };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) e.append(c);
  return e;
}

const fmtTime = (t: number) => {
  const d = new Date(t);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

/** 建好靜態骨架，之後只更新各區塊內容（輸入框不會被重建而失去焦點）。 */
export function mountUi(root: HTMLElement, modeLabel: string, perform: Perform, submit: SubmitText) {
  const status = el('span', { class: 'pill stop', 'data-testid': 'conn-status' }, '遊戲未執行');
  const header = el('header', {}, el('h1', {}, '童話家族'), status, el('span', { class: 'pill mode' }, modeLabel), el('span', { class: 'muted', 'data-testid': 'session' }));
  const charBox = el('section', { 'data-testid': 'character' });
  const familyBox = el('section', { 'data-testid': 'family-bar' });
  const warehouseBox = el('section', { 'data-testid': 'warehouse-panel' });
  const compareBox = el('section', { 'data-testid': 'compare-panel' });
  const navBox = el('section', { 'data-testid': 'nav-panel' });
  const queueBox = el('section', { 'data-testid': 'work-queue' });
  const questBox = el('section', { 'data-testid': 'quest-panel' });
  const sceneBox = el('section', { 'data-testid': 'scene' });
  const actBattleBox = el('div');
  const strategySel = el('select', { 'data-testid': 'strategy' });
  for (const st of STRATEGIES) strategySel.append(el('option', { value: st.id }, st.label));
  strategySel.addEventListener('change', () => perform({ kind: 'STRATEGY', strategy: strategySel.value as BattleStrategy, label: `戰鬥策略：${strategySel.value}` }));
  const strategyRow = el('div', { class: 'row' }, el('span', { class: 'k' }, '戰鬥策略'), strategySel, el('span', { class: 'muted' }, '（手動＝外掛不自動出手）'));
  const actBodyBox = el('div');
  const actBox = el('section', { 'data-testid': 'activity' }, actBattleBox, strategyRow, actBodyBox);
  const inputErr = el('div', { class: 'err', 'data-testid': 'input-error' });
  const input = el('input', { type: 'text', placeholder: '例如：前往 村長、採集 青銅礦 2、小石 採集 青銅礦 2', 'data-testid': 'cmd-input', autocomplete: 'off' });
  const form = el('form', {}, input, el('button', { class: 'item', type: 'submit' }, '送出'));
  const inputBox = el('section', {}, el('h2', {}, '文字輸入'), form, inputErr, el('div', { class: 'muted' }, INPUT_HELP));
  const logBox = el('div', { id: 'log', 'data-testid': 'log' });
  const logSection = el('section', {}, el('h2', {}, '事件日誌（時間／標籤／內容／commandId）'), logBox);
  root.replaceChildren(header, charBox, familyBox, warehouseBox, compareBox, navBox, queueBox, questBox, actBox, sceneBox, inputBox, logSection);

  form.addEventListener('submit', ev => {
    ev.preventDefault();
    const err = submit(input.value);
    inputErr.textContent = err ?? '';
    if (!err) input.value = '';
  });

  function menuRow(label: string, items: ReturnType<typeof buildMenu>[number]['items'], empty: string, enabled: boolean): HTMLElement {
    const box = el('div', { class: 'items' });
    if (!items.length) box.append(el('span', { class: 'muted' }, empty));
    for (const it of items) {
      const b = el('button', { class: 'item', type: 'button', 'data-testid': 'menu-item' }, it.label);
      if (it.hint) b.append(el('small', {}, it.hint));
      if (!enabled || !it.action) b.disabled = true;
      b.addEventListener('click', () => { if (it.action) { const err = perform(it.action); inputErr.textContent = err ?? ''; } });
      box.append(b);
    }
    return el('div', { class: 'row', 'data-testid': `menu-${label}` }, el('span', { class: 'k' }, label), box);
  }

  function act(label: string, action: UiAction, testid: string, enabled: boolean, attrs: Record<string, string> = {}): HTMLButtonElement {
    const b = el('button', { class: 'item', type: 'button', 'data-testid': testid, ...attrs }, label);
    if (!enabled) b.disabled = true;
    b.addEventListener('click', () => { const err = perform(action); inputErr.textContent = err ?? ''; });
    return b;
  }
  const cmdAction = (command: PluginCommand, label: string): UiAction => ({ kind: 'COMMAND', command, label });

  function renderNav(aux: UiAux, running: boolean) {
    navBox.replaceChildren(el('h2', {}, '自動導航'));
    navBox.append(el('div', { 'data-testid': 'nav-status', 'data-phase': aux.nav.phase }, aux.nav.text));
    if (aux.nav.route.length > 1) navBox.append(el('div', { class: 'muted', 'data-testid': 'nav-route' }, `路線：${aux.nav.route.join(' → ')}`));
    const active = ['WALKING', 'WAIT_MAP', 'PAUSED_BATTLE', 'TALKING'].includes(aux.nav.phase);
    if (active) navBox.append(act('停止導航', { kind: 'NAV_CANCEL', label: '取消導航' }, 'nav-cancel', running));
  }

  function renderFamilyBar(s: FamilyState, aux: UiAux, running: boolean) {
    const maxSlots = s.snapshot?.family?.maxSlots ?? 5;
    familyBox.replaceChildren(el('h2', {}, `家族成員（${s.members.length}/${maxSlots}）`));
    if (s.members.length === 0) {
      familyBox.append(el('div', { class: 'muted' }, '（尚未收到家族成員資料）'));
      return;
    }
    const activeId = s.activeCharacterId ?? s.snapshot?.family?.activeCharacterId ?? 'char_1';
    for (const m of s.members) {
      const isActive = m.characterId === activeId;
      const q = aux.queues?.[m.characterId] ?? (isActive ? aux.queue : undefined);
      const qText = q && (q.phase !== 'IDLE' || q.jobs.length > 0 || q.stopReason) ? q.text : '工作佇列：閒置';
      const row = el('div', { class: 'char', 'data-character-id': m.characterId },
        el('span', { class: `pill ${isActive ? 'ok' : ''}` }, isActive ? '視角中' : m.characterId),
        el('span', {}, `${m.name ?? m.characterId} Lv.${m.level}`),
        el('span', {}, `${m.mapName ?? m.mapId}`),
        el('span', {}, `金 ${m.gold}`),
        el('span', {}, `體 ${m.satiety}`),
        el('span', {}, `袋 ${m.inventoryCount}/${m.inventoryCap}`),
        el('span', { class: 'muted' }, qText),
      );
      if (!isActive) {
        row.append(act('切換視角', cmdAction({ type: 'SWITCH_VIEW_CHARACTER', characterId: m.characterId }, `切換視角 ${m.name ?? m.characterId}`), 'switch-char-btn', running, { 'data-character-id': m.characterId }));
      }
      familyBox.append(row);
    }
  }

  function renderWarehouse(s: FamilyState, running: boolean) {
    warehouseBox.replaceChildren(el('h2', {}, '家族共用倉庫'));
    const wh = s.warehouse;
    if (!wh) {
      warehouseBox.append(el('div', { class: 'muted' }, '（尚未收到倉庫資料）'));
      return;
    }
    const used = wh.items.reduce((sum, it) => sum + it.count, 0);
    warehouseBox.append(
      el('div', { class: 'char' },
        el('span', { 'data-testid': 'wh-gold' }, `倉庫金錢：${wh.gold}`),
        el('span', { 'data-testid': 'wh-cap' }, `倉庫容量：${used}/${wh.cap}`),
        act('存 500 金', cmdAction({ type: 'WAREHOUSE_DEPOSIT', gold: 500 }, '存倉 500 金'), 'wh-deposit-gold', running && (s.character?.gold ?? 0) >= 500),
        act('取 500 金', cmdAction({ type: 'WAREHOUSE_WITHDRAW', gold: 500 }, '取倉 500 金'), 'wh-withdraw-gold', running && wh.gold >= 500),
      ),
    );
    const whItemsBox = el('div', { class: 'items' });
    if (wh.items.length === 0) {
      whItemsBox.append(el('span', { class: 'muted' }, '倉庫物品：空'));
    } else {
      for (const it of wh.items) {
        const label = `取 ${it.name ?? `#${it.itemId}`} ×${it.count}`;
        whItemsBox.append(act(label, cmdAction({ type: 'WAREHOUSE_WITHDRAW', itemId: it.itemId, count: 1 }, `取倉 ${it.name ?? it.itemId} ×1`), 'wh-withdraw-item', running, { 'data-item-id': String(it.itemId) }));
      }
    }
    warehouseBox.append(whItemsBox);

    if (s.inventory.length > 0) {
      const invLabel = el('div', { class: 'muted' }, '目前角色背包（點一下存倉 ×1）：');
      const bagItemsBox = el('div', { class: 'items' });
      for (const it of s.inventory) {
        const label = `存 ${it.name ?? `#${it.itemId}`} ×${it.count}`;
        bagItemsBox.append(act(label, cmdAction({ type: 'WAREHOUSE_DEPOSIT', itemId: it.itemId, count: 1 }, `存倉 ${it.name ?? it.itemId} ×1`), 'wh-deposit-item', running, { 'data-item-id': String(it.itemId) }));
      }
      warehouseBox.append(invLabel, bagItemsBox);
    }
  }

  function renderQueue(aux: UiAux, running: boolean) {
    const q = aux.queue ?? NO_QUEUE;
    queueBox.replaceChildren(el('h2', {}, '工作佇列（FX11）'));
    queueBox.append(
      el('div', {
        'data-testid': 'queue-status',
        'data-phase': q.phase,
        ...(q.stopReason ? { 'data-stop-reason': q.stopReason } : {}),
      }, q.text)
    );
    if (q.stopReason) {
      queueBox.append(el('div', { class: 'muted', 'data-testid': 'queue-stop-reason' }, `停止原因：${stopReasonLabel(q.stopReason)}`));
    }
    if (q.jobs.length > 0) {
      const list = el('div', { class: 'muted', 'data-testid': 'queue-jobs' },
        q.jobs.map((j, idx) => {
          const mark = idx < q.activeJobIndex ? '✓' : idx === q.activeJobIndex && q.phase !== 'IDLE' ? '▶' : '…';
          const name = j.kind === 'GATHER' ? j.targetName : j.recipeName;
          const total = j.kind === 'GATHER' && j.targetCount === 'UNTIL_FULL' ? '到滿' : String(j.targetCount);
          return `${mark} ${name} (${j.doneCount}/${total})`;
        }).join(' ｜ ')
      );
      queueBox.append(list);
    }
    const qActive = ['RUNNING', 'PAUSED_BATTLE', 'WAITING_TOOL_BUY', 'WALKING_TO_POINT'].includes(q.phase);
    if (qActive) queueBox.append(act('停止工作', { kind: 'QUEUE_STOP', label: '停止工作佇列' }, 'queue-stop', running));
  }

  function renderCompare(s: FamilyState, running: boolean) {
    compareBox.replaceChildren(el('h2', {}, '雙向狀態對照（快照 vs 事件追蹤）'));
    const snap = s.snapshot;
    const ev = s.eventMirror;
    if (!snap || !s.character) {
      compareBox.append(el('div', { class: 'muted', 'data-testid': 'compare-status' }, '等待快照中'));
      return;
    }
    const snapInv = snap.character.inventoryCount ?? snap.inventory.reduce((sum, i) => sum + i.count, 0);
    const diffs: string[] = [];
    if (ev.mapId && ev.mapId !== snap.mapId) diffs.push(`地圖(${snap.mapId}≠${ev.mapId})`);
    if (ev.gold !== null && ev.gold !== snap.character.gold) diffs.push(`金錢(${snap.character.gold}≠${ev.gold})`);
    if (ev.inventoryCount !== null && ev.inventoryCount !== snapInv) diffs.push(`背包(${snapInv}≠${ev.inventoryCount})`);
    const statusText = diffs.length === 0 ? '一致 OK' : `事件較新：${diffs.join('、')}`;
    compareBox.append(
      el('div', { class: 'char' },
        el('span', { 'data-testid': 'compare-snapshot' }, `快照：${snap.mapId} (${snap.character.x},${snap.character.y}) 金${snap.character.gold} 袋${snapInv}/${snap.character.inventoryCap ?? 40} 體${snap.character.satiety ?? 100}`),
        el('span', { 'data-testid': 'compare-events' }, `事件：${ev.mapId ?? '?'} (${ev.x ?? '?'},${ev.y ?? '?'}) 金${ev.gold ?? '?'} 袋${ev.inventoryCount ?? '?'}`),
        el('span', { 'data-testid': 'compare-status', 'data-sync': diffs.length === 0 ? 'OK' : 'DIFF' }, statusText),
        act('重讀快照對照', cmdAction({ type: 'REQUEST_SNAPSHOT' }, '重讀快照對照'), 'compare-refresh', running),
      )
    );
  }

  const STATUS_LABELS: Record<string, string> = {
    PETRIFY: '石化', SLEEP: '睡眠', CONFUSE: '混亂', POISON: '中毒', SHIELD: '護盾',
    ATK_UP: '攻↑', DEF_DOWN: '防↓', GUARD_UP: '格擋↑', COUNTER: '反擊',
    EVADE_UP: '閃避↑', HASTE: '加速', PROTECT: '守護', FEIGN: '裝死',
  };
  const DEBUFF_SET = new Set(['PETRIFY', 'SLEEP', 'CONFUSE', 'POISON', 'DEF_DOWN']);

  function buildStatusBadges(unit?: { isDead?: boolean; isDefending?: boolean; isChanting?: boolean; statuses?: SnapshotBattleStatus[] } | null): HTMLElement[] {
    if (!unit) return [];
    const out: HTMLElement[] = [];
    if (unit.isDead) out.push(el('span', { class: 'status-tag debuff', 'data-testid': 'status-badge' }, '倒下'));
    if (unit.isDefending) out.push(el('span', { class: 'status-tag buff', 'data-testid': 'status-badge' }, '防禦中'));
    if (unit.isChanting) out.push(el('span', { class: 'status-tag', 'data-testid': 'status-badge' }, '詠唱中'));
    for (const st of unit.statuses ?? []) {
      const cls = DEBUFF_SET.has(st.type) ? 'status-tag debuff' : 'status-tag buff';
      const label = STATUS_LABELS[st.type] ?? st.type;
      const stacks = st.stacks && st.stacks > 1 ? `×${st.stacks}` : '';
      out.push(el('span', { class: cls, 'data-testid': 'status-badge', 'data-status-type': st.type }, `${label}${stacks}(${st.duration}T)`));
    }
    return out;
  }

  function renderUnitStatusRow(title: string, unit: SnapshotBattleUnitSummary, testid: string): HTMLElement {
    const badges = buildStatusBadges(unit);
    return el(
      'div',
      { class: 'status-row', 'data-testid': testid },
      el('span', { class: 'k' }, title),
      el('span', {}, `${unit.name} HP ${unit.hp}/${unit.maxHp}${unit.mp !== undefined ? ` MP ${unit.mp}/${unit.maxMp ?? unit.mp}` : ''}`),
      ...(badges.length > 0 ? badges : [el('span', { class: 'muted' }, '無異常/增益')]),
    );
  }

  function renderQuests(s: FamilyState, running: boolean) {
    questBox.replaceChildren(el('h2', {}, '任務摘要與自動排程'));
    const snap = s.snapshot;
    if (!snap) {
      questBox.append(el('div', { class: 'muted' }, '（尚未收到任務快照）'));
      return;
    }
    if (snap.openingStage && snap.openingStage !== 'DONE') {
      questBox.append(el('div', { class: 'row', 'data-testid': 'opening-stage-badge' },
        el('span', { class: 'pill warn' }, `主線階段：${snap.openingStage}`)));
    }
    const quests = snap.quests ?? [];
    if (quests.length === 0) {
      questBox.append(el('div', { class: 'muted' }, '（目前沒有可用委託清單）'));
      return;
    }
    const statusLabel: Record<string, { text: string; cls: string }> = {
      AVAILABLE: { text: '可接取', cls: 'pill mode' },
      IN_PROGRESS: { text: '進行中', cls: 'pill warn' },
      READY: { text: '可回報', cls: 'pill ok' },
      COMPLETED: { text: '已完成', cls: 'pill' },
    };
    const ordered = [...quests].sort((a, b) => {
      const rank = (x: string) => x === 'READY' ? 0 : x === 'IN_PROGRESS' ? 1 : x === 'AVAILABLE' ? 2 : 3;
      return rank(a.status) - rank(b.status) || a.questId - b.questId;
    });
    for (const q of ordered) {
      const st = statusLabel[q.status] ?? { text: q.status, cls: 'pill' };
      const item = el('div', { class: 'quest-item', 'data-testid': 'quest-entry', 'data-quest-id': String(q.questId), 'data-quest-status': q.status });
      const head = el('div', { class: 'row' },
        el('span', { class: st.cls }, st.text),
        el('b', {}, q.title),
        el('span', { class: 'muted' }, `Lv.${q.minLevel}｜${q.npcName}｜獎 ${q.rewardExp}EXP / ${q.rewardCoins}金`),
      );
      if (q.status !== 'COMPLETED') {
        head.append(
          act(`前往 ${q.npcName}`, { kind: 'NAV', goal: { kind: 'NPC', query: q.npcName, talk: true }, label: `前往並對話 ${q.npcName}` }, 'quest-nav-btn', running, { 'data-quest-id': String(q.questId) }),
          act(q.status === 'READY' ? '自動回報' : q.status === 'AVAILABLE' ? '自動接取' : '自動推進', { kind: 'QUEST_AUTO', questId: q.questId, label: `自動處理任務 ${q.title}` }, 'quest-auto-btn', running, { 'data-quest-id': String(q.questId) }),
        );
      }
      item.append(head);
      if (q.objectives.length > 0) {
        item.append(el('div', { class: 'muted' }, q.objectives.map(o => `${o.description} (${o.current}/${o.required}) ${o.met ? '✓' : '…'}`).join(' ｜ ')));
      }
      questBox.append(item);
    }
  }

  function renderActivity(s: FamilyState, aux: UiAux, running: boolean) {
    actBattleBox.replaceChildren();
    // 戰鬥
    if (s.battle || s.battleResult) {
      const box = el('div', { 'data-testid': 'battle-panel' }, el('h2', {}, '戰鬥'));
      if (s.battle) {
        const b = s.battle;
        box.append(el('div', { 'data-testid': 'battle-info' }, `#${b.battleId}${b.round ? ` 第 ${b.round} 回合` : ''}${b.ready ? '（等你出手）' : '（結算中）'}`));
        if (b.player) box.append(renderUnitStatusRow('主角', b.player, 'battle-player-status-row'));
        if (b.pet) box.append(renderUnitStatusRow('出戰寵', b.pet, 'battle-pet-status-row'));
        const en = el('div', { class: 'items' });
        for (const e of b.enemyStates) {
          en.append(act(`攻擊 ${e.name}`, cmdAction({ type: 'BATTLE_ACTION', battleId: b.battleId, action: { kind: 'ATTACK', targetSlot: e.slot } }, `攻擊 ${e.name}`), 'battle-attack', running && b.ready, { 'data-slot': String(e.slot) }));
          en.lastElementChild!.append(el('small', {}, `${e.hp}/${e.maxHp}`));
        }
        en.append(act('防禦', cmdAction({ type: 'BATTLE_ACTION', battleId: b.battleId, action: { kind: 'DEFEND' } }, '防禦'), 'battle-defend', running && b.ready));
        en.append(act('逃跑', cmdAction({ type: 'BATTLE_FLEE', battleId: b.battleId }, '戰鬥逃跑'), 'battle-flee', running && b.ready && b.canFlee));
        box.append(en);
        for (const e of b.enemyStates) {
          const eBadges = buildStatusBadges(e);
          if (eBadges.length > 0) {
            box.append(el('div', { class: 'status-row', 'data-testid': 'battle-enemy-status-row', 'data-slot': String(e.slot) }, el('span', { class: 'muted' }, `${e.name}：`), ...eBadges));
          }
        }
        if (!b.canFlee) box.append(el('div', { class: 'muted' }, '這場戰鬥不能逃跑'));
      }
      if (s.battleResult) {
        const win = s.battleResult === 'VICTORY';
        box.append(el('div', { 'data-testid': 'battle-result' }, win ? '勝利！結算視窗開著' : '敗北，結算視窗開著'),
          act(win ? '返回地圖' : '送回醫院', cmdAction({ type: 'CHOOSE_DIALOG_OPTION', optionId: win ? 'RETURN_TO_MAP' : 'DEFEAT_RESCUE' }, win ? '關閉勝利視窗' : '敗北：送回醫院'), 'battle-result-option', running));
      }
      actBattleBox.append(box);
    }
    // 戰鬥策略（靜態元素：快照重繪不重建 <select>，避免展開選單被關閉）
    const activeEl = root.ownerDocument?.activeElement ?? document.activeElement;
    if (activeEl !== strategySel && strategySel.value !== aux.strategy) strategySel.value = aux.strategy;

    actBodyBox.replaceChildren();
    // 對話
    if (s.dialog) {
      const box = el('div', { class: 'dialog', 'data-testid': 'dialog' }, el('b', {}, `${s.dialog.npcName}：`), ...s.dialog.lines.slice(0, 3).map(l => el('div', {}, l)));
      const opts = el('div', { class: 'items' });
      if (!s.dialog.options.length) opts.append(el('span', { class: 'muted' }, '（宿主沒有提供選項）'));
      for (const o of s.dialog.options) opts.append(act(o.label, cmdAction({ type: 'CHOOSE_DIALOG_OPTION', optionId: o.id }, `對話選項：${o.label}`), 'dialog-option', running, { 'data-option-id': o.id }));
      box.append(opts);
      actBodyBox.append(box);
    }
    // 商店
    if (s.shop) {
      const box = el('div', { 'data-testid': 'shop-panel' }, el('h2', {}, `商店：${s.shop.npcName}`));
      const buy = el('div', { class: 'items' });
      for (const g of s.shop.goods.slice(0, 60)) {
        const b = act(`買 ${g.name ?? `#${g.itemId}`}`, cmdAction({ type: 'BUY_ITEM', itemId: g.itemId, count: 1 }, `買 ${g.name ?? g.itemId} ×1`), 'shop-buy', running, { 'data-item-id': String(g.itemId) });
        b.append(el('small', {}, `${g.price} 金`));
        buy.append(b);
      }
      const sell = el('div', { class: 'items' });
      if (!s.inventory.length) sell.append(el('span', { class: 'muted' }, '（背包是空的）'));
      for (const i of s.inventory) sell.append(act(`賣 ${i.name ?? `#${i.itemId}`}`, cmdAction({ type: 'SELL_ITEM', itemId: i.itemId, count: 1 }, `賣 ${i.name ?? i.itemId} ×1`), 'shop-sell', running, { 'data-item-id': String(i.itemId) }));
      box.append(el('div', { class: 'row' }, el('span', { class: 'k' }, '購買'), buy), el('div', { class: 'row' }, el('span', { class: 'k' }, '賣出'), sell),
        act('離開商店', cmdAction({ type: 'CHOOSE_DIALOG_OPTION', optionId: 'CLOSE_SHOP' }, '離開商店'), 'shop-close', running));
      actBodyBox.append(box);
    }
    // 背包
    actBodyBox.append(el('div', { class: 'muted', 'data-testid': 'inventory' }, `背包：${s.inventory.length ? s.inventory.map(i => `${i.name ?? `#${i.itemId}`}×${i.count}`).join('、') : '（空）'}`));
  }

  function render(s: FamilyState, conn: 'RUNNING' | 'STOPPED', aux: UiAux = NO_AUX) {
    const running = conn === 'RUNNING';
    status.textContent = running ? '遊戲執行中' : '遊戲未執行';
    status.className = `pill ${running ? 'run' : 'stop'}`;
    header.querySelector<HTMLElement>('[data-testid=session]')!.textContent = s.sessionId ? `session ${s.sessionId.slice(0, 8)}` : '';

    const c = s.character;
    charBox.replaceChildren(el('h2', {}, '角色'));
    if (c) {
      const invUsed = c.inventoryCount ?? s.inventory.reduce((sum, i) => sum + i.count, 0);
      const invCap = c.inventoryCap ?? 40;
      const sat = c.satiety ?? 100;
      const maxSat = c.maxSatiety ?? 100;
      charBox.append(el('div', { class: 'char' },
        el('span', {}, el('b', {}, c.name ?? s.characterId ?? '？'), ` Lv.${c.level}`),
        el('span', {}, `HP ${c.hp ?? '?'}/${c.maxHp ?? '?'}`), el('span', {}, `MP ${c.mp ?? '?'}/${c.maxMp ?? '?'}`),
        el('span', { 'data-testid': 'gold' }, `金錢 ${c.gold}`), el('span', { 'data-testid': 'pos' }, `位置 (${c.x}, ${c.y})`),
        el('span', { 'data-testid': 'satiety' }, `飽食 ${sat}/${maxSat}`),
        el('span', { 'data-testid': 'bag-cap' }, `背包 ${invUsed}/${invCap}`),
        ...(c.weaponFamily ? [el('span', { 'data-testid': 'mastery' }, `武器 ${c.weaponFamily} Lv.${c.familyLevel ?? 1}｜連擊 Lv.${c.comboLevel ?? 1}`)] : []),
        el('span', {}, c.inBattle ? '戰鬥中' : '探索中')));
      const selfBadges = buildStatusBadges(c);
      if (selfBadges.length > 0) charBox.append(el('div', { class: 'status-row', 'data-testid': 'char-status-row' }, el('span', { class: 'muted' }, '狀態：'), ...selfBadges));
      const petUnit = c.activePet ?? s.battle?.pet;
      if (petUnit) charBox.append(renderUnitStatusRow('出戰寵', petUnit, 'pet-status-row'));
    } else {
      charBox.append(el('div', { class: 'muted' }, running ? '等待快照…' : '（沒有角色資料；請先開啟 fairyland 遊戲分頁）'));
    }
    if (s.battle) charBox.append(el('div', {}, `戰鬥 #${s.battle.battleId}${s.battle.round ? ` 第 ${s.battle.round} 回合` : ''}：${s.battle.enemies.join('、')}`));

    sceneBox.replaceChildren();
    const snap = s.snapshot;
    const title = s.location ? `${s.location.mapName ?? s.location.mapId}` : '（未知）';
    const stale = snap && s.location && snap.mapId !== s.location.mapId;
    sceneBox.append(el('h2', {}, `場景${stale ? '（換圖中，選單為上一張圖的快照）' : ''}`), el('div', { 'data-testid': 'scene-title' }, title));
    if (snap) {
      for (const sec of buildMenu(snap, aux.known)) {
        if ((sec.key === 'animals' || sec.key === 'known') && !sec.items.length) continue;
        sceneBox.append(menuRow(sec.label, sec.items, sec.emptyText, running));
      }
      if (snap.recipes && snap.recipes.length > 0) {
        const invMap = new Map(s.inventory.map(i => [i.itemId, i.count]));
        const hasAll = (r: (typeof snap.recipes)[number]) =>
          r.ingredients.every(i => i.itemId !== null && (invMap.get(i.itemId) ?? 0) >= i.count);
        const priority = snap.recipes.filter(r => r.recipeId === 20901 || r.recipeId === 40101 || hasAll(r));
        const picked = [...priority, ...snap.recipes.filter(r => !priority.includes(r))].slice(0, 12);
        const craftItems = picked.map(r => ({
          label: `製作：${r.name}`,
          hint: r.ingredients.map(i => `${i.name}×${i.count}`).join('+'),
          action: { kind: 'QUEUE_CRAFT', recipeId: r.recipeId, recipeName: r.name, count: 1, label: `製作：${r.name}` } as UiAction,
        }));
        sceneBox.append(menuRow('製作', craftItems, '（無）', running));
      }
      sceneBox.append(el('div', { class: 'muted', 'data-testid': 'nav-summary' },
        `可到達地圖：${snap.nav.reachableMaps.slice(0, 12).map(m => `${m.name ?? m.mapId}（${m.hops}）`).join('、') || '（無）'}${snap.nav.status === 'UNAVAILABLE' ? '　［僅直接出口：宿主沒有世界目錄］' : ''}`));
    } else {
      sceneBox.append(el('div', { class: 'muted' }, '（尚未收到場景快照）'));
    }
    renderFamilyBar(s, aux, running);
    renderWarehouse(s, running);
    renderCompare(s, running);
    renderNav(aux, running);
    renderQueue(aux, running);
    renderQuests(s, running);
    renderActivity(s, aux, running);

    logBox.replaceChildren(...[...s.log].reverse().map(e => {
      const row = el('div', { class: e.level });
      row.append(`${fmtTime(e.at)} `, el('span', { class: 'tag' }, e.tag), ` ${e.text}`);
      if (e.commandId) row.append(' ', el('span', { class: 'cid' }, `[${e.commandId}]`));
      return row;
    }));
  }

  render(initialState(), 'STOPPED');
  return { render };
}
