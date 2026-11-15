import type { PluginCommand } from './protocol/index';
import { STRATEGIES, type BattleStrategy } from './battler';
import type { DirNpc } from './directory';
import { buildMenu } from './menu';
import type { NavStatus } from './navigator';
import { INPUT_HELP, type UiAction } from './parse';
import { initialState, type FamilyState } from './state';

type Perform = (action: UiAction) => string | null;
type SubmitText = (text: string) => string | null;

/** 畫面上除了鏡像狀態之外，還要顯示的外掛端資訊。 */
export interface UiAux { nav: NavStatus; strategy: BattleStrategy; known: DirNpc[] }
const NO_AUX: UiAux = { nav: { phase: 'IDLE', goal: null, route: [], text: '導航：閒置' }, strategy: 'MANUAL', known: [] };

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
  const navBox = el('section', { 'data-testid': 'nav-panel' });
  const sceneBox = el('section', { 'data-testid': 'scene' });
  const actBox = el('section', { 'data-testid': 'activity' });
  const inputErr = el('div', { class: 'err', 'data-testid': 'input-error' });
  const input = el('input', { type: 'text', placeholder: '例如：前往 村長', 'data-testid': 'cmd-input', autocomplete: 'off' });
  const form = el('form', {}, input, el('button', { class: 'item', type: 'submit' }, '送出'));
  const inputBox = el('section', {}, el('h2', {}, '文字輸入'), form, inputErr, el('div', { class: 'muted' }, INPUT_HELP));
  const logBox = el('div', { id: 'log', 'data-testid': 'log' });
  const logSection = el('section', {}, el('h2', {}, '事件日誌（時間／標籤／內容／commandId）'), logBox);
  root.replaceChildren(header, charBox, navBox, actBox, sceneBox, inputBox, logSection);

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

  function renderActivity(s: FamilyState, aux: UiAux, running: boolean) {
    actBox.replaceChildren();
    // 戰鬥
    if (s.battle || s.battleResult) {
      const box = el('div', { 'data-testid': 'battle-panel' }, el('h2', {}, '戰鬥'));
      if (s.battle) {
        const b = s.battle;
        box.append(el('div', { 'data-testid': 'battle-info' }, `#${b.battleId}${b.round ? ` 第 ${b.round} 回合` : ''}${b.ready ? '（等你出手）' : '（結算中）'}`));
        const en = el('div', { class: 'items' });
        for (const e of b.enemyStates) {
          en.append(act(`攻擊 ${e.name}`, cmdAction({ type: 'BATTLE_ACTION', battleId: b.battleId, action: { kind: 'ATTACK', targetSlot: e.slot } }, `攻擊 ${e.name}`), 'battle-attack', running && b.ready, { 'data-slot': String(e.slot) }));
          en.lastElementChild!.append(el('small', {}, `${e.hp}/${e.maxHp}`));
        }
        en.append(act('防禦', cmdAction({ type: 'BATTLE_ACTION', battleId: b.battleId, action: { kind: 'DEFEND' } }, '防禦'), 'battle-defend', running && b.ready));
        en.append(act('逃跑', cmdAction({ type: 'BATTLE_FLEE', battleId: b.battleId }, '戰鬥逃跑'), 'battle-flee', running && b.ready && b.canFlee));
        box.append(en);
        if (!b.canFlee) box.append(el('div', { class: 'muted' }, '這場戰鬥不能逃跑'));
      }
      if (s.battleResult) {
        const win = s.battleResult === 'VICTORY';
        box.append(el('div', { 'data-testid': 'battle-result' }, win ? '勝利！結算視窗開著' : '敗北，結算視窗開著'),
          act(win ? '返回地圖' : '送回醫院', cmdAction({ type: 'CHOOSE_DIALOG_OPTION', optionId: win ? 'RETURN_TO_MAP' : 'DEFEAT_RESCUE' }, win ? '關閉勝利視窗' : '敗北：送回醫院'), 'battle-result-option', running));
      }
      actBox.append(box);
    }
    // 戰鬥策略（永遠可見）
    const sel = el('select', { 'data-testid': 'strategy' });
    for (const st of STRATEGIES) { const o = el('option', { value: st.id }, st.label); if (st.id === aux.strategy) o.selected = true; sel.append(o); }
    sel.addEventListener('change', () => perform({ kind: 'STRATEGY', strategy: sel.value as BattleStrategy, label: `戰鬥策略：${sel.value}` }));
    actBox.append(el('div', { class: 'row' }, el('span', { class: 'k' }, '戰鬥策略'), sel, el('span', { class: 'muted' }, '（手動＝外掛不自動出手）')));

    // 對話
    if (s.dialog) {
      const box = el('div', { class: 'dialog', 'data-testid': 'dialog' }, el('b', {}, `${s.dialog.npcName}：`), ...s.dialog.lines.slice(0, 3).map(l => el('div', {}, l)));
      const opts = el('div', { class: 'items' });
      if (!s.dialog.options.length) opts.append(el('span', { class: 'muted' }, '（宿主沒有提供選項）'));
      for (const o of s.dialog.options) opts.append(act(o.label, cmdAction({ type: 'CHOOSE_DIALOG_OPTION', optionId: o.id }, `對話選項：${o.label}`), 'dialog-option', running, { 'data-option-id': o.id }));
      box.append(opts);
      actBox.append(box);
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
      actBox.append(box);
    }
    // 背包
    actBox.append(el('div', { class: 'muted', 'data-testid': 'inventory' }, `背包：${s.inventory.length ? s.inventory.map(i => `${i.name ?? `#${i.itemId}`}×${i.count}`).join('、') : '（空）'}`));
  }

  function render(s: FamilyState, conn: 'RUNNING' | 'STOPPED', aux: UiAux = NO_AUX) {
    const running = conn === 'RUNNING';
    status.textContent = running ? '遊戲執行中' : '遊戲未執行';
    status.className = `pill ${running ? 'run' : 'stop'}`;
    header.querySelector<HTMLElement>('[data-testid=session]')!.textContent = s.sessionId ? `session ${s.sessionId.slice(0, 8)}` : '';

    const c = s.character;
    charBox.replaceChildren(el('h2', {}, '角色'));
    if (c) {
      charBox.append(el('div', { class: 'char' },
        el('span', {}, el('b', {}, c.name ?? s.characterId ?? '？'), ` Lv.${c.level}`),
        el('span', {}, `HP ${c.hp ?? '?'}/${c.maxHp ?? '?'}`), el('span', {}, `MP ${c.mp ?? '?'}/${c.maxMp ?? '?'}`),
        el('span', { 'data-testid': 'gold' }, `金錢 ${c.gold}`), el('span', { 'data-testid': 'pos' }, `位置 (${c.x}, ${c.y})`),
        el('span', {}, c.inBattle ? '戰鬥中' : '探索中')));
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
      sceneBox.append(el('div', { class: 'muted', 'data-testid': 'nav-summary' },
        `可到達地圖：${snap.nav.reachableMaps.slice(0, 12).map(m => `${m.name ?? m.mapId}（${m.hops}）`).join('、') || '（無）'}${snap.nav.status === 'UNAVAILABLE' ? '　［僅直接出口：宿主沒有世界目錄］' : ''}`));
    } else {
      sceneBox.append(el('div', { class: 'muted' }, '（尚未收到場景快照）'));
    }
    renderNav(aux, running);
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
