import { Window } from 'happy-dom';
import { initialState } from '../src/state';
import {
  DEFAULT_WINE_CONFIG,
  WINE_SETTINGS_STORAGE_KEY,
  WineBridgeClient,
  bridgeWebSocketUrl,
  framePreviewUrl,
  isLoopbackBridgeUrl,
  loadSavedWineBridgeSettings,
  normalizeLoopbackBridgeUrl,
  saveWineBridgeSettings,
  type BridgeWebSocketLike,
  type WineBgConfig,
  type WineBridgeStatus,
} from '../src/wine/wineBridgeClient';
import { assert, done, suite } from './helpers';

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

const { flushSync } = await import('react-dom');
const { mountUi } = await import('../src/ui');

const flushUi = async () => {
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 15));
};

function setInputValue(el: HTMLInputElement, val: string) {
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')?.set;
  if (setter) {
    setter.call(el, val);
  } else {
    el.value = val;
  }
  el.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
  el.dispatchEvent(new win.Event('change', { bubbles: true }) as unknown as Event);
}

function makeFakeBridge() {
  const calls: Array<{ method: string; url: string; body: Record<string, unknown> | null }> = [];
  let cfg: WineBgConfig = {
    patrolA: [260, 300],
    patrolB: [540, 300],
    hotkey: 'F7',
    preferred: 'skill',
    healAtPct: 35,
    stopHpPct: 15,
    stopMpPct: 0,
    maxMinutes: 30,
    maxRoundTrips: null,
    windowTitle: '',
    wid: null,
  };
  let status: WineBridgeStatus = {
    ok: true,
    connected: true,
    running: false,
    phase: 'idle',
    scene: 'map',
    hpPct: 92,
    mpPct: 80,
    roundTrips: 0,
    encounters: 0,
    turns: 0,
    ticks: 0,
    actionsSent: 0,
    lastAction: null,
    stopReason: null,
    config: cfg,
    recentEvents: [],
  };
  const sockets: MockWs[] = [];
  let frameFailures = 0;

  class MockWs implements BridgeWebSocketLike {
    readyState = 1;
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    sent: string[] = [];
    constructor(public url: string) {
      sockets.push(this);
      setTimeout(() => this.onopen?.({}), 0);
    }
    send(data: string) {
      this.sent.push(data);
    }
    close() {
      this.readyState = 3;
    }
    push(payload: unknown) {
      this.onmessage?.({ data: JSON.stringify(payload) });
    }
    dropUnexpectedly() {
      this.readyState = 3;
      this.onclose?.({});
    }
  }

  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const rawBody = typeof init?.body === 'string' && init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method, url, body: rawBody });

    const u = new URL(url);
    if (u.pathname === '/frame') {
      if (frameFailures > 0) {
        frameFailures--;
        return new Response(null, { status: 503 });
      }
      return new Response(new Uint8Array([1]), {
        headers: {
          'Content-Type': 'image/png',
          'X-Frame-Scene': 'battle',
          'X-Frame-HP-Pct': '0',
          'X-Frame-MP-Pct': '75',
          'X-Frame-Position': '10,22',
        },
      });
    }
    if (u.pathname === '/status') {
      return new Response(JSON.stringify(status), { status: 200 });
    }
    if (u.pathname === '/windows') {
      return new Response(
        JSON.stringify({ ok: true, windows: [{ wid: 77, width: 800, height: 628, title: 'Sample-Window' }] }),
        { status: 200 },
      );
    }
    if (u.pathname === '/config') {
      cfg = { ...cfg, ...(rawBody as Partial<WineBgConfig>) };
      status = { ...status, config: cfg };
      return new Response(JSON.stringify(status), { status: 200 });
    }
    if (u.pathname === '/start') {
      if (rawBody) cfg = { ...cfg, ...(rawBody as Partial<WineBgConfig>) };
      status = { ...status, running: true, phase: 'running', stopReason: null, config: cfg };
      return new Response(JSON.stringify(status), { status: 200 });
    }
    if (u.pathname === '/stop') {
      status = { ...status, running: false, phase: 'stopped', stopReason: String(rawBody?.reason ?? 'manual_stop') };
      return new Response(JSON.stringify(status), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false, error: 'not found' }), { status: 404 });
  };

  return {
    calls,
    sockets,
    failNextFrame: () => { frameFailures++; },
    getStatus: () => status,
    setStatus: (next: WineBridgeStatus) => {
      status = next;
    },
    fetchFn,
    MockWs,
  };
}

suite('W-FamilyUI (#149): loopback bridge client & Wine 視窗背景練功介面');

// 1. Loopback URL checks
assert(isLoopbackBridgeUrl('http://127.0.0.1:4182'), '接受 127.0.0.1');
assert(isLoopbackBridgeUrl('http://localhost:4189/'), '接受 localhost');
assert(isLoopbackBridgeUrl('http://[::1]:4182'), '接受 [::1]');
assert(!isLoopbackBridgeUrl('https://evil.example:4182'), '拒絕非 loopback 網域');
assert(!isLoopbackBridgeUrl('http://192.168.1.5:4182'), '拒絕區域網路 IP');
assert(!isLoopbackBridgeUrl('http://user@127.0.0.1:4182'), '拒絕含帳密的 URL');
assert(normalizeLoopbackBridgeUrl('http://127.0.0.1:4182/') === 'http://127.0.0.1:4182', '移除尾端斜線');
assert(bridgeWebSocketUrl('http://127.0.0.1:4182') === 'ws://127.0.0.1:4182/events', '正確轉換 WebSocket URL');

// 2. WineBridgeClient pure unit verification
{
  const fake = makeFakeBridge();
  const client = new WineBridgeClient({ fetchFn: fake.fetchFn, webSocketCtor: fake.MockWs });

  const badOk = await client.connect('https://evil.example:4182');
  assert(!badOk, '拒絕連線非 loopback 位址');
  assert(fake.calls.length === 0, '非 loopback URL 不應發出任何 fetch');

  const ok = await client.connect('http://127.0.0.1:4189');
  assert(ok, '成功連線 loopback bridge');
  assert(client.getSnapshot().connState === 'CONNECTED', '狀態為 CONNECTED');
  assert(fake.sockets.length === 1 && fake.sockets[0].url === 'ws://127.0.0.1:4189/events', '開啟 WS /events');

  await client.updateConfig({ hotkey: 'F8', healAtPct: 45, maxRoundTrips: 2 });
  assert(client.getSnapshot().status?.config.hotkey === 'F8', 'updateConfig 更新熱鍵設定');

  await client.start();
  assert(client.getSnapshot().status?.running === true, 'start 啟動背景練功');

  const pushedEvent = { tsMs: 1700000000000, type: 'action', action: { kind: 'hotkey', hotkey: 'F8', role: 'main' } };
  fake.sockets[0].push({
    kind: 'event',
    event: pushedEvent,
    status: {
      ...fake.getStatus(),
      scene: 'battle',
      roundTrips: 1,
      encounters: 1,
      turns: 1,
      actionsSent: 2,
      recentEvents: [pushedEvent],
    },
  });
  assert(client.getSnapshot().status?.turns === 1, 'WS 推送即時更新戰鬥回合數');
  assert(client.getSnapshot().events.length === 1, 'WS 推送寫入事件列表');

  await client.stop('user_clicked_stop');
  assert(client.getSnapshot().status?.running === false, 'stop 停止練功');

  fake.sockets[0].dropUnexpectedly();
  assert(client.getSnapshot().connState === 'DISCONNECTED', 'WebSocket 異常斷線應切換為 DISCONNECTED');
  assert(Boolean(client.getSnapshot().error), '斷線時記錄清楚錯誤訊息');
}

// 3. UI 整合測試（mountUi + happy-dom）
{
  const fake = makeFakeBridge();
  const client = new WineBridgeClient({ fetchFn: fake.fetchFn, webSocketCtor: fake.MockWs });
  const root = win.document.createElement('div');
  win.document.body.appendChild(root);

  const ui = mountUi(root as unknown as HTMLElement, 'TEST', () => null, () => null);
  ui.render(initialState(), 'STOPPED', {
    nav: { phase: 'IDLE', goal: null, route: [], text: '導航：閒置', skipped: [] },
    strategy: 'MANUAL',
    known: [],
    wineClient: client,
  });

  assert(fake.calls.length === 0, '掛載 UI 時不應自動發起橋接連線');
  const workbenchTabs = root.querySelectorAll('[data-testid="character-workbench"] [role="tab"]');
  assert(workbenchTabs.length === 5, `工作台應保留原本 4 頁籤並新增第 5 頁籤（實際：${workbenchTabs.length}）`);
  const mobileTabs = root.querySelectorAll('[data-testid="mobile-tabs"] [role="tab"]');
  assert(mobileTabs.length === 4, '手機版主分頁列維持 4 個分頁');

  // Switch via header quick-jump button
  const headerWineBtn = root.querySelector('[data-testid="header-wine-btn"]') as unknown as HTMLButtonElement;
  assert(headerWineBtn !== null, '存在頂部「視窗練功」捷徑按鈕');
  flushSync(() => headerWineBtn.click());
  await flushUi();

  const panel = root.querySelector('[data-testid="wine-training-panel"]');
  assert(panel !== null, '渲染 WineTrainingPanel');
  assert(win.localStorage.getItem(WINE_SETTINGS_STORAGE_KEY) === null, '首次開啟面板保留橋接端策略');
  assert(root.querySelector('[data-testid="wine-conn-pill"]')?.textContent === '已斷線', '初始狀態顯示已斷線');

  // Verify remote URL warning in input
  const urlInput = root.querySelector('[data-testid="wine-bridge-url"]') as unknown as HTMLInputElement;
  setInputValue(urlInput, 'https://evil.example:4182');
  await flushUi();
  assert(root.querySelector('[data-testid="wine-url-warn"]') !== null, '輸入非 loopback URL 時顯示安全警告');
  const blockedBtn = root.querySelector('[data-testid="wine-connect-btn"]') as unknown as HTMLButtonElement;
  assert(blockedBtn.disabled, '非 loopback URL 時停用連線按鈕');

  // Restore loopback URL & connect
  setInputValue(urlInput, 'http://127.0.0.1:4189');
  await flushUi();

  assert(loadSavedWineBridgeSettings(win.localStorage).settings.config === null, '只改連線網址不會儲存預設策略');
  const connectBtn = root.querySelector('[data-testid="wine-connect-btn"]') as unknown as HTMLButtonElement;
  assert(!connectBtn.disabled, '合法 loopback URL 可點擊連線');
  connectBtn.click();
  await flushUi();

  assert(root.querySelector('[data-testid="wine-conn-pill"]')?.textContent === '已連線', '連線後顯示已連線');
  assert(
    fake.calls.some(c => c.url === 'http://127.0.0.1:4189/status'),
    '使用畫面輸入的 4189 埠連線本機橋接',
  );

  // Preset "原地微移" & start training
  const microBtn = root.querySelector('[data-testid="wine-preset-micro"]') as unknown as HTMLButtonElement;
  microBtn.click();
  await flushUi();

  const startBtn = root.querySelector('[data-testid="wine-start-btn"]') as unknown as HTMLButtonElement;
  assert(!startBtn.disabled, '已連線時可一鍵開始背景練功');
  startBtn.click();
  await flushUi();

  const startCall = fake.calls.find(c => c.url.endsWith('/start'));
  assert(Boolean(startCall), '點擊一鍵開始送出 POST /start');
  assert(
    JSON.stringify(startCall?.body?.patrolA) === JSON.stringify([390, 300]),
    '一鍵開始會把畫面剛調整的「原地微移」座標一併送給橋接',
  );

  // Push WS live combat event & inspect UI update
  fake.sockets[0].push({
    kind: 'event',
    event: { tsMs: 1700000001000, type: 'action', action: { kind: 'move', point: [415, 300] } },
    status: {
      ...fake.getStatus(),
      roundTrips: 2,
      encounters: 1,
      turns: 3,
      actionsSent: 5,
      launch: {
        scaleMode: 'fit',
        windowWidth: 1512,
        windowHeight: 982,
        bridgePort: 4189,
        windowSizeSource: 'actual',
      },
      recentEvents: [
        { tsMs: 1700000001000, type: 'action', action: { kind: 'move', point: [415, 300] } },
      ],
    },
  });
  await flushUi();

  const metricsText = root.querySelector('[data-testid="wine-metrics"]')?.textContent ?? '';
  assert(metricsText.includes('往返 2 趟') && metricsText.includes('回合 3 次'), `即時戰報計數更新（實際：${metricsText}）`);
  const launchText = root.querySelector('[data-testid="wine-launch"]')?.textContent ?? '';
  assert(
    launchText.includes('縮放 fit') && launchText.includes('1512×982') && launchText.includes('實際') && launchText.includes('4189'),
    `視窗練功面板顯示橋接啟動設定（實際：${launchText}）`,
  );
  const logText = root.querySelector('[data-testid="wine-log"]')?.textContent ?? '';
  assert(logText.includes('巡邏移動 (415, 300)'), `動作日誌顯示推播事件（實際：${logText}）`);

  // Scan windows button populates window chip
  const scanBtn = root.querySelector('[data-testid="wine-scan-windows"]') as unknown as HTMLButtonElement;
  scanBtn.click();
  await flushUi();
  const winListText = root.querySelector('[data-testid="wine-window-list"]')?.textContent ?? '';
  assert(winListText.includes('Sample-Window'), '掃描視窗顯示本機橋接回傳視窗');

  // Stop & disconnect
  const stopBtn = root.querySelector('[data-testid="wine-stop-btn"]') as unknown as HTMLButtonElement;
  stopBtn.click();
  await flushUi();
  assert(fake.calls.some(c => c.url.endsWith('/stop')), '點擊停止送出 POST /stop');

  fake.sockets[0].dropUnexpectedly();
  await flushUi();
  assert(root.querySelector('[data-testid="wine-conn-pill"]')?.textContent === '已斷線', '橋接斷線時 UI 即時切回已斷線');
  assert(root.querySelector('[data-testid="wine-error"]') !== null, '橋接斷線時 UI 顯示斷線提示');
}

// 4. W-Live3 (#155): /frame URL, preview toggle, and localStorage persistence across reloads
{
  win.localStorage.clear();
  assert(
    framePreviewUrl('http://127.0.0.1:4189', true) ===
      'http://127.0.0.1:4189/frame?overlay=1&w=480',
    '產生合法本機 /frame 預覽網址',
  );
  assert(framePreviewUrl('https://evil.example:4189', true) === null, '拒絕非 loopback 預覽網址');

  saveWineBridgeSettings(win.localStorage, {
    baseUrl: 'http://127.0.0.1:4190',
    config: { ...DEFAULT_WINE_CONFIG, hotkey: 'F8', patrolA: [390, 300], patrolB: [415, 300], healAtPct: 55, wid: 77, windowTitle: 'Test' },
    previewEnabled: true,
    previewOverlay: false,
    previewIntervalMs: 500,
    microDistance: 35,
  });
  const loaded = loadSavedWineBridgeSettings(win.localStorage);
  assert(loaded.hasSaved && loaded.settings.baseUrl === 'http://127.0.0.1:4190', '從 localStorage 還原橋接網址');
  assert(loaded.settings.config?.hotkey === 'F8' && loaded.settings.config.healAtPct === 55, '從 localStorage 還原熱鍵與補血門檻');
  assert(loaded.settings.previewOverlay === false && loaded.settings.previewIntervalMs === 500, '從 localStorage 還原預覽選項');

  assert(loaded.settings.config?.wid === null && loaded.settings.config.windowTitle === 'Test', '保留視窗標題且不記憶暫時視窗編號');
  const stale = JSON.parse(win.localStorage.getItem(WINE_SETTINGS_STORAGE_KEY)!);
  stale.config.wid = 78;
  win.localStorage.setItem(WINE_SETTINGS_STORAGE_KEY, JSON.stringify(stale));
  assert(loadSavedWineBridgeSettings(win.localStorage).settings.config?.wid === null, '讀取舊存檔時移除視窗編號');

  // Corrupt JSON in localStorage safely falls back without throwing
  win.localStorage.setItem(WINE_SETTINGS_STORAGE_KEY, '{broken_json');
  assert(!loadSavedWineBridgeSettings(win.localStorage).hasSaved, '損毀 localStorage 資料安全回退預設');

  // Persist real UI edits, then mount fresh root simulating tab reload
  win.localStorage.clear();
  const fake = makeFakeBridge();
  const client1 = new WineBridgeClient({ fetchFn: fake.fetchFn, webSocketCtor: fake.MockWs });
  const root1 = win.document.createElement('div');
  win.document.body.appendChild(root1);
  const ui1 = mountUi(root1 as unknown as HTMLElement, 'TEST', () => null, () => null);
  ui1.render(initialState(), 'STOPPED', {
    nav: { phase: 'IDLE', goal: null, route: [], text: '導航：閒置', skipped: [] },
    strategy: 'MANUAL',
    known: [],
    wineClient: client1,
  });
  flushSync(() => (root1.querySelector('[data-testid="header-wine-btn"]') as unknown as HTMLButtonElement).click());
  await flushUi();

  setInputValue(root1.querySelector('[data-testid="wine-bridge-url"]') as unknown as HTMLInputElement, 'http://127.0.0.1:4195');
  setInputValue(root1.querySelector('[data-testid="wine-micro-distance"]') as unknown as HTMLInputElement, '32');
  await flushUi();
  (root1.querySelector('[data-testid="wine-preset-micro"]') as unknown as HTMLButtonElement).click();
  const interval = root1.querySelector('select[data-testid="wine-preview-interval"]') as unknown as HTMLSelectElement;
  interval.value = '500';
  interval.dispatchEvent(new win.Event('change', { bubbles: true }) as unknown as Event);
  fake.failNextFrame();
  await flushUi();
  (root1.querySelector('[data-testid="wine-connect-btn"]') as unknown as HTMLButtonElement).click();
  await flushUi();

  assert(root1.querySelector('[data-testid="wine-preview-empty"]')?.textContent?.includes('尚未取得') ?? false, '暫時擷取失敗顯示狀態');
  await new Promise(resolve => setTimeout(resolve, 550));
  const img = root1.querySelector('[data-testid="wine-preview-img"]') as unknown as HTMLImageElement | null;
  assert(img !== null && img.src.startsWith('blob:'), '自動重試成功後顯示本機影格');
  assert(fake.calls.some(c => c.url === 'http://127.0.0.1:4195/frame?overlay=1&w=480'), '從使用者輸入的橋接取得影格');
  const hud = root1.querySelector('[data-testid="wine-preview-hud"]')?.textContent ?? '';
  assert(hud.includes('戰鬥中') && hud.includes('HP 0%') && hud.includes('MP 75%') && hud.includes('(10,22)'), '顯示待機影格的即時辨識結果與座標');

  const toggleBtn = root1.querySelector('[data-testid="wine-preview-toggle"]') as unknown as HTMLButtonElement;
  toggleBtn.click();
  await flushUi();
  assert(root1.querySelector('[data-testid="wine-preview-img"]') === null, '暫停預覽後隱藏圖片');
  toggleBtn.click();
  await flushUi();
  assert(root1.querySelector('[data-testid="wine-preview-img"]') !== null, '重新開啟預覽後恢復圖片');

  (root1.querySelector('[data-testid="wine-disconnect-btn"]') as unknown as HTMLButtonElement).click();
  await flushUi();
  assert(root1.querySelector('[data-testid="wine-preview-img"]') === null, '中斷連線時移除預覽');

  // Fresh mount simulates reload
  const client2 = new WineBridgeClient({ fetchFn: fake.fetchFn, webSocketCtor: fake.MockWs });
  const root2 = win.document.createElement('div');
  win.document.body.appendChild(root2);
  const ui2 = mountUi(root2 as unknown as HTMLElement, 'TEST', () => null, () => null);
  ui2.render(initialState(), 'STOPPED', {
    nav: { phase: 'IDLE', goal: null, route: [], text: '導航：閒置', skipped: [] },
    strategy: 'MANUAL',
    known: [],
    wineClient: client2,
  });
  flushSync(() => (root2.querySelector('[data-testid="header-wine-btn"]') as unknown as HTMLButtonElement).click());
  await flushUi();

  assert(
    (root2.querySelector('[data-testid="wine-bridge-url"]') as unknown as HTMLInputElement).value === 'http://127.0.0.1:4195',
    '重開分頁自動還原橋接位址',
  );
  assert(
    (root2.querySelector('[data-testid="wine-patrol-ax"]') as unknown as HTMLInputElement).value === '390',
    '重開分頁自動還原巡邏點 A X=390',
  );
  assert(
    (root2.querySelector('[data-testid="wine-micro-distance"]') as unknown as HTMLInputElement).value === '32' &&
      (root2.querySelector('[data-testid="wine-patrol-bx"]') as unknown as HTMLInputElement).value === '422',
    '重開分頁還原微移距離及套用後的巡邏點 B',
  );
}

done();
