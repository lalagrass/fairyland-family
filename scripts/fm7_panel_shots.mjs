// F1 工作台的瀏覽器驗收與 FM7 面板截圖。Playwright 不寫進 package.json，避免 npm ci 下載瀏覽器。
// 圖檔只寫到 /tmp，不進 repo。
//
//   node scripts/fm7_panel_shots.mjs
//
// 不要把 playwright 寫進本專案的 dependencies。ESM 的 import() 也不讀 NODE_PATH，
// 所以裝在別處時把套件入口指給 FM7_PLAYWRIGHT，例如：
//   mkdir -p /tmp/fm7-pw && cd /tmp/fm7-pw && npm --cache /tmp/npm-cache-fm7 init -y
//   npm --cache /tmp/npm-cache-fm7 install playwright
//   npx --cache /tmp/npm-cache-fm7 playwright install chromium
//   FM7_PLAYWRIGHT=/tmp/fm7-pw/node_modules/playwright node scripts/fm7_panel_shots.mjs

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = '/tmp/fm7-panels';
const port = 3100;
const base = `http://127.0.0.1:${port}/family/?replay=1`;

mkdirSync(outDir, { recursive: true });

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
  console.error('待實機確認：這次執行找不到 playwright，沒有截圖。');
  console.error('指令見 scripts/fm7_panel_shots.mjs 檔頭。不要把 playwright 加進 fairyland-family 的 dependencies。');
  process.exit(2);
}

const vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let viteLog = '';
vite.stdout.on('data', chunk => { viteLog += chunk; });
vite.stderr.on('data', chunk => { viteLog += chunk; });

function stopVite() {
  if (!vite.killed) vite.kill('SIGTERM');
}

async function waitForServer() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (vite.exitCode !== null) throw new Error(`vite 已結束 ${vite.exitCode}\n${viteLog}`);
    try {
      const res = await fetch(base);
      if (res.ok) return;
    } catch {
      // 伺服器還沒起來
    }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`vite 沒有在 20 秒內回應\n${viteLog}`);
}

try {
  await waitForServer();
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="character-stats"]', { timeout: 15000 });
  await page.evaluate(() => {
    const ctrl = window.__family?.controller;
    if (!ctrl?.receive || !ctrl.state?.characterId) return;
    ctrl.stop?.();
    const characterId = ctrl.state.characterId;
    const baseMsg = { v: 5, characterId, ts: Date.now() };
    ctrl.receive({
      ...baseMsg,
      kind: 'event',
      seq: 9001,
      event: { type: 'INVENTORY_CHANGED', changes: [{ itemId: 50001, delta: 2, count: 2 }] },
    });
    ctrl.receive({
      ...baseMsg,
      kind: 'event',
      seq: 9002,
      event: { type: 'WAREHOUSE_CHANGED', gold: 20, items: [{ itemId: 50001, name: '測試物品', count: 1 }] },
    });
  });
  const workbench = page.getByRole('tablist', { name: '目前角色工作台' });
  const tab = name => workbench.getByRole('tab', { name, exact: true });
  const activePane = name => page.getByRole('tabpanel', { name, exact: true });
  const assertNoOverflow = async width => {
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    if (scrollWidth > width) throw new Error(`${width}px 有水平溢出：${scrollWidth}px`);
  };

  await activePane('總覽').waitFor();
  await assertNoOverflow(1280);
  await page.locator('[data-testid="family-bar"]').waitFor();
  await page.locator('[data-testid="log"]').waitFor();
  await tab('總覽').focus();
  await page.keyboard.press('ArrowRight');
  await activePane('技能').waitFor();
  await assertNoOverflow(1280);
  await page.keyboard.press('ArrowRight');
  await activePane('物品欄').waitFor();
  await page.waitForSelector('[data-testid="wh-deposit-item"]', { timeout: 5000 });
  await assertNoOverflow(1280);
  const bagPanel = page.getByTestId('inventory-panel');
  const warehouse = page.getByTestId('warehouse-panel');
  const bagDesktop = await bagPanel.boundingBox();
  const warehouseDesktop = await warehouse.boundingBox();
  if (!bagDesktop || !warehouseDesktop || bagDesktop.x >= warehouseDesktop.x) {
    throw new Error('1280px 的背包／倉庫應左右排列');
  }
  await page.screenshot({ path: path.join(outDir, 'desktop-1280.png'), fullPage: true });

  await page.setViewportSize({ width: 360, height: 800 });
  await activePane('物品欄').waitFor();
  await assertNoOverflow(360);
  const bagMobile = await bagPanel.boundingBox();
  const warehouseMobile = await warehouse.boundingBox();
  if (!bagMobile || !warehouseMobile || bagMobile.y >= warehouseMobile.y) {
    throw new Error('360px 的背包／倉庫應上下排列');
  }
  await page.screenshot({ path: path.join(outDir, 'mobile-360-inventory.png'), fullPage: true });
  await tab('設定').click();
  await activePane('設定').waitFor();
  await assertNoOverflow(360);
  await page.screenshot({ path: path.join(outDir, 'mobile-360-settings.png'), fullPage: true });
  await page.getByRole('tab', { name: /名冊/ }).click();
  await workbench.waitFor({ state: 'hidden' });
  await page.locator('[data-testid="family-bar"]').waitFor();
  await assertNoOverflow(360);
  await page.getByRole('tab', { name: '目前角色', exact: true }).click();
  await activePane('設定').waitFor();
  await browser.close();
  console.log(`FM7 screenshots: ${outDir}/desktop-1280.png ${outDir}/mobile-360-inventory.png ${outDir}/mobile-360-settings.png`);
} catch (err) {
  console.error('待實機確認：截圖腳本沒有跑完。');
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 2;
} finally {
  stopVite();
}
