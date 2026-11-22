// F9 任務卡片的瀏覽器驗收：1280px 多欄、360px 單欄、都沒有水平溢出；「派給角色」能打開成員清單。
// 截圖只在失敗時存（覆蓋 test-results/f9-shots/），成功不存任何檔案。
//
//   FM7_PLAYWRIGHT=/opt/node-tools/node_modules/playwright node scripts/f9_quest_cards_check.mjs
//
// 找不到 playwright 時結束碼 2，並印出「待實機確認」。Playwright 不寫進 package.json。
// 任務、NPC、地圖都是虛構資料，執行時塞進回放快照；不含任何原版內容。

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 3109;
const base = `http://127.0.0.1:${port}/family/?replay=1&loop=1`;
const shotDir = path.join(root, 'test-results', 'f9-shots');

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    // 本專案沒有這個依賴。
  }
  const hint = process.env.FM7_PLAYWRIGHT;
  if (!hint) return null;
  const entry = hint.endsWith('.js') ? hint : path.join(hint, 'index.js');
  return import(pathToFileURL(entry).href);
}

const loaded = await loadPlaywright();
const playwright = loaded?.chromium ? loaded : loaded?.default;
if (!playwright?.chromium) {
  console.error('待實機確認：找不到 playwright，沒有跑任務卡片驗收（設定 FM7_PLAYWRIGHT，見檔頭）。');
  process.exit(2);
}

const vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
let viteLog = '';
vite.stdout.on('data', c => { viteLog += c; });
vite.stderr.on('data', c => { viteLog += c; });
// 連同 vite 底下的 esbuild 一起關掉（整個 process group）。
const stopVite = () => {
  if (vite.exitCode !== null) return;
  try { process.kill(-vite.pid, 'SIGTERM'); } catch { vite.kill('SIGTERM'); }
};

async function waitForServer() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (vite.exitCode !== null) throw new Error(`vite 已結束 ${vite.exitCode}\n${viteLog}`);
    try {
      const res = await fetch(base);
      if (res.ok) return;
    } catch {
      // 還沒起來
    }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`vite 沒有在 20 秒內回應\n${viteLog}`);
}

let failed = 0;
let page = null;
const check = async (ok, name, shot) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (ok) return;
  failed++;
  if (page && shot) {
    mkdirSync(shotDir, { recursive: true });
    await page.screenshot({ path: path.join(shotDir, `${shot}.png`), fullPage: true }).catch(() => {});
    console.log(`  失敗截圖：${path.join(shotDir, `${shot}.png`)}`);
  }
};

let browser = null;
try {
  await waitForServer();
  browser = await playwright.chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="character-stats"]', { timeout: 15000 });

  // 回放會一直送自己的快照，所以每 200ms 檢查一次，被蓋掉就再塞回虛構任務。
  const inject = () => page.evaluate(async () => {
    const { PROTOCOL_VERSION } = await import('/family/src/protocol/index.ts');
    const ctrl = window.__family.controller;
    const apply = () => {
    if (ctrl.state.snapshot?.quests?.some(x => x.questId === 99101)) return;
    const cid = ctrl.state.characterId;
    const snap = JSON.parse(JSON.stringify(ctrl.state.snapshot));
    const member = (id, name) => ({
      characterId: id, name, level: 5, mapId: snap.mapId, mapName: snap.mapName, x: 100, y: 100, gold: 10, satiety: 90,
      inventoryCount: 0, inventoryCap: 40, inBattle: false, inventory: [], workSkills: {},
    });
    snap.family = { activeCharacterId: cid, maxSlots: 5, warehouse: { gold: 0, cap: 200, items: [] }, members: [member(cid, '甲'), member('char_f9_b', '乙')] };
    snap.openingStage = 'DONE';
    const q = (questId, status, extra = {}) => ({
      questId, title: `虛構委託${questId}`, npcId: 'npc_f9', npcName: '虛構村長', minLevel: 1, status,
      objectives: [{ type: 'TALK', description: '和虛構村長說話', current: status === 'AVAILABLE' ? 0 : 1, required: 1, met: status !== 'AVAILABLE' }],
      rewardExp: 10, rewardCoins: 20, ...extra,
    });
    snap.quests = [
      q(99101, 'READY'),
      q(99102, 'IN_PROGRESS', { objectives: [{ type: 'KILL', description: '打倒很長很長名字的虛構魔物一隻又一隻', current: 1, required: 3, met: false }] }),
      q(99103, 'AVAILABLE'),
      q(99104, 'AVAILABLE', { title: '', npcName: '' }),
      q(99105, 'COMPLETED'),
    ];
    ctrl.receive({ v: PROTOCOL_VERSION, characterId: cid, ts: Date.now(), kind: 'snapshot', seq: Date.now(), reason: 'REQUESTED', snapshot: snap });
    };
    apply();
    setInterval(apply, 200);
  });
  await inject();
  await page.locator('[data-testid="quest-entry"][data-quest-id="99101"]').waitFor({ timeout: 10000 });
  await page.waitForTimeout(500);

  const layout = () => page.evaluate(() => {
    const root = document.querySelector('[data-testid="quest-cards"]');
    const cards = [...document.querySelectorAll('[data-testid="quest-cards"] [data-testid="quest-entry"]')].map(e => e.getBoundingClientRect());
    const firstRowTop = cards.length ? cards[0].top : 0;
    return {
      dataLayout: root?.getAttribute('data-layout'),
      count: cards.length,
      firstRow: cards.filter(r => Math.abs(r.top - firstRowTop) < 2).length,
      scrollWidth: document.documentElement.scrollWidth,
      unknown: root?.textContent?.includes('未知') ?? false,
    };
  });

  let l = await layout();
  await check(l.count === 5, `1280px：5 張卡片（${l.count}）`, 'desktop-1280');
  await check(l.firstRow >= 2 && l.dataLayout === 'wide', `1280px：多欄（第一列 ${l.firstRow} 張，data-layout=${l.dataLayout}）`, 'desktop-1280');
  await check(l.scrollWidth <= 1280, `1280px：沒有水平溢出（${l.scrollWidth}）`, 'desktop-1280');
  await check(l.unknown, '1280px：宿主沒給的值顯示「未知」', 'desktop-1280');

  await page.locator('[data-testid="quest-entry"][data-quest-id="99103"] [data-testid="quest-card-assign-btn"]').click();
  const menu = page.locator('[data-testid="quest-card-assign-menu"]');
  await menu.waitFor({ timeout: 3000 }).catch(() => {});
  await check((await menu.locator('[data-testid="quest-card-assign-member"]').count()) === 2, '1280px：「派給角色」列出兩位成員', 'desktop-1280-assign');
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 360, height: 800 });
  await page.locator('[data-testid="mobile-tabs"] > *').nth(2).click();
  await page.locator('[data-testid="quest-cards"]').waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(300);
  l = await layout();
  await check(l.dataLayout === 'narrow' && l.firstRow === 1, `360px：單欄（第一列 ${l.firstRow} 張，data-layout=${l.dataLayout}）`, 'mobile-360');
  await check(l.scrollWidth <= 360, `360px：沒有水平溢出（${l.scrollWidth}）`, 'mobile-360');
  const btns = await page.locator('[data-testid="quest-cards"] button').evaluateAll(els =>
    els.filter(e => e.offsetParent !== null).map(e => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right }; }));
  await check(btns.length > 0 && btns.every(b => b.left >= -1 && b.right <= 361), `360px：卡片按鈕都在畫面內（${btns.length} 個）`, 'mobile-360');
  await check(pageErrors.length === 0, `沒有頁面錯誤（${pageErrors.join('；')}）`, 'page-error');
} finally {
  await browser?.close().catch(() => {});
  stopVite();
}
process.exit(failed ? 1 : 0);
