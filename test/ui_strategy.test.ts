import { initialState } from '../src/state';
import { mountUi, type UiAux } from '../src/ui';
import { assert, done, suite } from './helpers';

class FakeElement {
  tagName: string;
  attrs: Record<string, string> = {};
  children: (FakeElement | string)[] = [];
  className = '';
  textContent = '';
  value = 'MANUAL';
  disabled = false;
  lastElementChild: FakeElement | null = null;
  ownerDocument: FakeDocument;
  listeners: Record<string, Array<() => void>> = {};

  constructor(tag: string, doc: FakeDocument) {
    this.tagName = tag.toLowerCase();
    this.ownerDocument = doc;
  }

  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }

  append(...nodes: (FakeElement | string)[]) {
    for (const n of nodes) {
      this.children.push(n);
      if (n instanceof FakeElement) this.lastElementChild = n;
    }
  }

  replaceChildren(...nodes: (FakeElement | string)[]) {
    this.children = [];
    this.lastElementChild = null;
    this.append(...nodes);
  }

  addEventListener(ev: string, fn: () => void) {
    (this.listeners[ev] ??= []).push(fn);
  }

  findByTestId(id: string): FakeElement | null {
    if (this.attrs['data-testid'] === id) return this;
    for (const c of this.children) {
      if (c instanceof FakeElement) {
        const hit = c.findByTestId(id);
        if (hit) return hit;
      }
    }
    return null;
  }

  querySelector(sel: string): FakeElement | null {
    const m = /^\[data-testid=([^\]]+)\]$/.exec(sel);
    return m ? this.findByTestId(m[1]) : null;
  }
}

class FakeDocument {
  activeElement: FakeElement | null = null;
  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }
}

suite('UI 戰鬥策略選單穩定性');

const doc = new FakeDocument();
(globalThis as unknown as { document: FakeDocument }).document = doc;
const root = new FakeElement('div', doc);

const actions: string[] = [];
const ui = mountUi(
  root as unknown as HTMLElement,
  'TEST',
  a => { actions.push(a.kind); return null; },
  () => null,
);

const firstSel = root.findByTestId('strategy');
assert(firstSel !== null && firstSel.tagName === 'select', '初次掛載有 strategy select');

const auxManual: UiAux = { nav: { phase: 'IDLE', goal: null, route: [], text: '閒置' }, strategy: 'MANUAL', known: [] };
const auxAttack: UiAux = { ...auxManual, strategy: 'ATTACK' };

ui.render(initialState(), 'RUNNING', auxManual);
ui.render(initialState(), 'RUNNING', auxManual);
const afterRendersSel = root.findByTestId('strategy');
assert(afterRendersSel === firstSel, '連續快照 render() 不得重建或替換 <select> DOM 節點');

// 模擬使用者展開並操作下拉選單（focus 中）
doc.activeElement = firstSel;
firstSel!.value = 'ATTACK';
ui.render(initialState(), 'RUNNING', auxManual);
assert(firstSel!.value === 'ATTACK', 'focus 期間快照重繪不得把已選值洗回 MANUAL');

// 觸發 change -> 通知 controller，之後非 focus 狀態下同步
for (const fn of firstSel!.listeners.change ?? []) fn();
assert(actions.includes('STRATEGY'), 'change 事件正確送出 STRATEGY action');

doc.activeElement = null;
ui.render(initialState(), 'RUNNING', auxAttack);
assert(firstSel!.value === 'ATTACK', '非 focus 狀態會同步 aux.strategy');

done();
