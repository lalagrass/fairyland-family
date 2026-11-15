import type { PluginCommand } from './protocol/index';
import { buildMenu } from './menu';
import { INPUT_HELP } from './parse';
import type { FamilyState } from './state';

type Send = (command: PluginCommand, label: string) => unknown;
type SubmitText = (text: string) => string | null;

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
export function mountUi(root: HTMLElement, modeLabel: string, send: Send, submit: SubmitText) {
  const status = el('span', { class: 'pill stop', 'data-testid': 'conn-status' }, '遊戲未執行');
  const header = el('header', {}, el('h1', {}, '童話家族'), status, el('span', { class: 'pill mode' }, modeLabel), el('span', { class: 'muted', 'data-testid': 'session' }));
  const charBox = el('section', { 'data-testid': 'character' });
  const sceneBox = el('section', { 'data-testid': 'scene' });
  const inputErr = el('div', { class: 'err', 'data-testid': 'input-error' });
  const input = el('input', { type: 'text', placeholder: '例如：前往 村長', 'data-testid': 'cmd-input', autocomplete: 'off' });
  const form = el('form', {}, input, el('button', { class: 'item', type: 'submit' }, '送出'));
  const inputBox = el('section', {}, el('h2', {}, '文字輸入'), form, inputErr, el('div', { class: 'muted' }, INPUT_HELP));
  const logBox = el('div', { id: 'log', 'data-testid': 'log' });
  const logSection = el('section', {}, el('h2', {}, '事件日誌（時間／標籤／內容／commandId）'), logBox);
  root.replaceChildren(header, charBox, sceneBox, inputBox, logSection);

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
      if (!enabled || !it.command) b.disabled = true;
      b.addEventListener('click', () => it.command && send(it.command, `${label}：${it.label}`));
      box.append(b);
    }
    return el('div', { class: 'row', 'data-testid': `menu-${label}` }, el('span', { class: 'k' }, label), box);
  }

  function render(s: FamilyState, conn: 'RUNNING' | 'STOPPED') {
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
      for (const sec of buildMenu(snap)) {
        if ((sec.key === 'animals' || sec.key === 'shop') && !sec.items.length) continue;
        sceneBox.append(menuRow(sec.label, sec.items, sec.emptyText, running));
      }
      sceneBox.append(el('div', { class: 'muted', 'data-testid': 'nav-summary' },
        `可到達地圖：${snap.nav.reachableMaps.slice(0, 12).map(m => `${m.name ?? m.mapId}（${m.hops}）`).join('、') || '（無）'}${snap.nav.status === 'UNAVAILABLE' ? '　［僅直接出口：宿主沒有世界目錄］' : ''}`));
    } else {
      sceneBox.append(el('div', { class: 'muted' }, '（尚未收到場景快照）'));
    }
    if (s.dialog) {
      sceneBox.append(el('div', { class: 'dialog', 'data-testid': 'dialog' }, el('b', {}, `${s.dialog.npcName}：`), ...s.dialog.lines.slice(0, 3).map(l => el('div', {}, l))));
    }

    logBox.replaceChildren(...[...s.log].reverse().map(e => {
      const row = el('div', { class: e.level });
      row.append(`${fmtTime(e.at)} `, el('span', { class: 'tag' }, e.tag), ` ${e.text}`);
      if (e.commandId) row.append(' ', el('span', { class: 'cid' }, `[${e.commandId}]`));
      return row;
    }));
  }

  render({ lastHeartbeatAt: null, sessionId: null, stoppedSessionId: null, phase: null, characterId: null, location: null, snapshot: null, snapshotAt: null, character: null, dialog: null, battle: null, pending: {}, log: [], logSeq: 0 }, 'STOPPED');
  return { render };
}
