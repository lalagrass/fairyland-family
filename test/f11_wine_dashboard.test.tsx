import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_WINE_SCHEDULE,
  loadSavedWineBridgeSettings,
  saveWineBridgeSettings,
  sanitizeSchedule,
  type WineBridgeStatus,
} from '../src/wine/wineBridgeClient';
import {
  clockReached,
  formatExpPerHour,
  scheduleStopDecision,
  shouldNotifyTrainingStop,
  trainingStats,
} from '../src/wine/trainingDashboard';
import { assert, done, suite } from './helpers';

const HOUR = 3_600_000;
const armed = Date.parse('2026-11-25T10:00:00');
const evening = Date.parse('2026-11-25T18:00:00');

function status(patch: Partial<WineBridgeStatus> = {}): WineBridgeStatus {
  return {
    ok: true,
    connected: true,
    running: true,
    phase: 'running',
    scene: 'battle',
    hpPct: 80,
    mpPct: 70,
    roundTrips: 1,
    encounters: 2,
    turns: 4,
    ticks: 10,
    actionsSent: 6,
    lastAction: null,
    stopReason: null,
    config: {
      patrolA: [260, 300], patrolB: [540, 300], hotkey: 'F7', preferred: 'skill',
      healAtPct: 35, stopHpPct: 15, stopMpPct: 0, maxMinutes: null, maxRoundTrips: null,
      windowTitle: '', wid: null,
    },
    recentEvents: [{ tsMs: armed, type: 'started' }],
    ...patch,
  };
}

suite('F11 統計只採用橋接欄位');
{
  const blank = trainingStats(null, evening);
  assert(blank.hours === null && blank.battles === null && blank.expPerHour === null, '未連線時時數、場數、經驗都留空');
  assert(blank.potionUses === null && blank.stopCount === null, '未連線時吃補與停機留空');

  const partial = trainingStats(status({ recentEvents: [], potionUses: undefined, expGained: undefined }), evening);
  assert(partial.battles === 2, '場數用橋接 encounters');
  assert(partial.hours === null, '沒有 started 事件時不拿本機連線時間充當時數');
  assert(partial.expPerHour === null, '橋接沒有經驗時不計算每小時經驗');
  assert(partial.potionUses === null, '沒有 potionUses 時不補 0');

  const full = trainingStats(status({
    potionUses: 3,
    expGained: 120,
    recentEvents: [
      { tsMs: armed, type: 'started' },
      { tsMs: armed + HOUR, type: 'stopped', reason: 'low_hp_critical' },
    ],
    running: false,
    stopReason: 'low_hp_critical',
  }), evening);
  assert(full.hours === 1, '時數用 started 到 stopped 的橋接時間');
  assert(full.expPerHour === 120, '每小時經驗用回報經驗除以回報時數');
  assert(full.potionUses === 3, '吃補次數用 potionUses');
  assert(full.stopCount === 1 && full.stopReasons[0] === 'low_hp_critical', '停機次數與原因來自 stopped 事件');
  assert(formatExpPerHour(null) === '—', '沒有經驗時顯示空值');

  const zero = trainingStats(status({ potionUses: 0, expGained: 0 }), armed + HOUR);
  assert(zero.potionUses === 0 && zero.expPerHour === 0, '橋接回報 0 時保留 0');
}

suite('F11 排程停止');
{
  const running = { running: true, encounters: 4 };
  assert(
    scheduleStopDecision({ stopAt: null, maxBattles: 4, armedAtMs: armed }, running, evening).reason === 'schedule_battles',
    '場數達到上限就該停',
  );
  assert(
    scheduleStopDecision({ stopAt: null, maxBattles: 4, armedAtMs: armed }, { running: true, encounters: null }, evening).stop === false,
    '場數沒回報時不停',
  );
  assert(
    scheduleStopDecision({ stopAt: '18:00', maxBattles: null, armedAtMs: armed }, running, evening).reason === 'schedule_clock',
    '已到設定時刻就該停',
  );
  assert(clockReached('18:00', evening, evening + 60_000) === false, '設定當下已過的時刻改等下一次');
  assert(
    scheduleStopDecision({ ...DEFAULT_WINE_SCHEDULE, stopAt: '18:00', maxBattles: 1 }, { running: false, encounters: 9 }, evening).stop === false,
    '沒在練功時不送停止',
  );
  assert(shouldNotifyTrainingStop({
    hidden: true, granted: true, enabled: true, previousSignature: null, nextSignature: '1:low_hp_critical',
  }), '背景分頁且已授權時，新的停機要通知');
  assert(!shouldNotifyTrainingStop({
    hidden: false, granted: true, enabled: true, previousSignature: null, nextSignature: '1:low_hp_critical',
  }), '分頁在前景時不通知');
  assert(!shouldNotifyTrainingStop({
    hidden: true, granted: true, enabled: true, previousSignature: '1:low_hp_critical', nextSignature: '1:low_hp_critical',
  }), '同一個停機不重複通知');
}

suite('F11 策略持久化');
{
  const storage = new Map<string, string>();
  const memory = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  };
  const schedule = sanitizeSchedule({ stopAt: '18:00', maxBattles: 12, armedAtMs: armed, extra: 'nope' });
  saveWineBridgeSettings(memory, {
    baseUrl: 'http://127.0.0.1:4182',
    config: null,
    previewEnabled: true,
    previewOverlay: true,
    previewIntervalMs: 1000,
    microDistance: 25,
    schedule,
  });
  const loaded = loadSavedWineBridgeSettings(memory).settings.schedule;
  assert(loaded?.stopAt === '18:00' && loaded.maxBattles === 12 && loaded.armedAtMs === armed, '排程寫入後可以讀回');
  assert(sanitizeSchedule({ stopAt: '25:99', maxBattles: 0 }).stopAt === null, '不合法的時刻與場數不會存下來');
  assert(loadSavedWineBridgeSettings({ getItem: () => '{"baseUrl":"http://127.0.0.1:4182"}', setItem: () => undefined }).settings.schedule?.maxBattles === null, '舊存檔沒有排程時用關閉');
}

suite('F11 窄畫面儀表');
{
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  assert(css.includes('container-name: wine-panel') && css.includes('@container wine-panel (max-width: 420px)'), '儀表使用 container query');
  assert(css.includes('minmax(0, 1fr)') && css.includes('minmax(min(100%, 140px), 1fr)'), '窄寬用可收縮的 grid');

  const win = new Window({ url: 'http://localhost:5173/family/' });
  Object.assign(globalThis, {
    window: win,
    document: win.document,
    HTMLElement: win.HTMLElement,
    HTMLInputElement: win.HTMLInputElement,
    Element: win.Element,
    Node: win.Node,
    Event: win.Event,
  });
  const host = win.document.createElement('div');
  host.style.width = '390px';
  win.document.body.appendChild(host);
  const { createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { WineTrainingPanel } = await import('../src/panels/WineTrainingPanel');
  const { WineBridgeClient } = await import('../src/wine/wineBridgeClient');
  const root = createRoot(host as unknown as HTMLElement);
  const client = new WineBridgeClient();
  root.render(createElement(WineTrainingPanel, { client, active: true }));
  await new Promise(resolve => setTimeout(resolve, 20));
  const panel = host.querySelector('[data-testid="wine-training-panel"]') as unknown as HTMLElement;
  assert(panel !== null, '渲染練功面板');
  assert(host.querySelector('[data-testid="wine-stat-exp-hour"]')?.textContent === '—', '尚未連線時每小時經驗是空值');
  assert(host.querySelector('[data-testid="wine-stat-potions"]')?.textContent === '—', '尚未連線時吃補是空值');
  assert(host.querySelector('[data-testid="wine-stop-at"]') !== null, '可以設定練到幾點');
  assert(host.querySelector('[data-testid="wine-max-battles"]') !== null, '可以設定練幾場');
  const overflow = [...host.querySelectorAll('input, button, section, div')].filter(el => {
    const width = (el as unknown as HTMLElement).style?.width ?? '';
    const px = Number(width.replace('px', ''));
    return Number.isFinite(px) && px > 390;
  });
  assert(overflow.length === 0, '390px 容器裡沒有寫死超過 390px 的寬度');
  root.unmount();
}

done();
