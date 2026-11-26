/**
 * F15：視窗尋路面板。
 * 連本機 `wine_bridge.py --demo`，在宿主回放地圖上點一次目的地、看進度與停下原因，
 * 390px 無水平溢出，並守約 5 分鐘、0 pageerror。
 *
 *   FAIRYLAND_ROOT=... node scripts/f15_wine_path_check.mjs
 *
 * 地圖代號與座標只從畫面上的宿主快照來，這個腳本不寫死原版地圖。
 * 失敗截圖放 /tmp/fl-f15-shots，不進 git。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgePort = Number(process.env.F15_BRIDGE_PORT || 4182);
const vitePort = Number(process.env.F15_VITE_PORT || 3118);
const totalMs = Number(process.env.F15_TOTAL_MS || 300000);
const base = `http://127.0.0.1:${vitePort}/family/?replay=1&loop=1`;
const shotDir = '/tmp/fl-f15-shots';

function fairylandRoot() {
  const fromEnv = process.env.FAIRYLAND_ROOT;
  const candidates = [
    fromEnv,
    path.resolve(root, '../fairyland-wt-180'),
    path.resolve(root, '../fairyland'),
  ].filter(Boolean);
  for (const cand of candidates) {
    if (fs.existsSync(path.join(cand, 'tools/observe/wine_bridge.py'))) return cand;
  }
  return null;
}

async function loadPlaywright() {
  const candidates = [process.env.FM7_PLAYWRIGHT, '/tmp/pw/node_modules/playwright'].filter(Boolean);
  for (const hint of candidates) {
    try {
      const entry = hint.endsWith('.js') ? hint : path.join(hint, 'index.js');
      const loaded = await import(pathToFileURL(entry).href);
      const pw = loaded.chromium ? loaded : loaded.default;
      if (pw?.chromium) return pw;
    } catch {
      // 下一個候選。
    }
  }
  return null;
}

function waitForHttp(url, child, logRef, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (child.exitCode !== null) {
        reject(new Error(`process exited ${child.exitCode}\n${logRef.value.slice(-800)}`));
        return;
      }
      fetch(url).then(res => (res.status < 500 ? resolve() : retry())).catch(() => retry());
      function retry() {
        if (Date.now() - start > timeoutMs) reject(new Error(`timeout ${url}\n${logRef.value.slice(-800)}`));
        else setTimeout(tick, 400);
      }
    };
    tick();
  });
}

const hostRoot = fairylandRoot();
const pw = await loadPlaywright();
if (!hostRoot || !pw) {
  console.error(`待實機確認：${!hostRoot ? '找不到 fairyland 的 wine_bridge.py' : '找不到 playwright'}`);
  process.exit(2);
}

const bridgeLog = { value: '' };
const bridge = spawn('python3', ['-m', 'tools.observe.wine_bridge', '--demo', '--port', String(bridgePort)], {
  cwd: hostRoot,
  stdio: ['ignore', 'pipe', 'pipe'],
});
bridge.stdout.on('data', chunk => { bridgeLog.value += chunk; });
bridge.stderr.on('data', chunk => { bridgeLog.value += chunk; });

const viteLog = { value: '' };
const vite = spawn(process.execPath, [
  path.join(root, 'node_modules/vite/bin/vite.js'),
  '--host', '127.0.0.1',
  '--port', String(vitePort),
  '--strictPort',
], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
vite.stdout.on('data', chunk => { viteLog.value += chunk; });
vite.stderr.on('data', chunk => { viteLog.value += chunk; });

let browser;
let exitCode = 1;
const started = Date.now();
const pageErrors = [];

try {
  await waitForHttp(`http://127.0.0.1:${bridgePort}/health`, bridge, bridgeLog, 20000);
  await waitForHttp(base, vite, viteLog, 20000);
  browser = await pw.chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 1 });
  page.on('pageerror', err => {
    pageErrors.push(err.message);
    console.log(`PAGEERROR ${err.message}`);
  });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="tab-wine-path"]').click();
  await page.locator('[data-testid="wine-path-panel"]').waitFor({ state: 'visible' });
  const narrowOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  if (narrowOverflow) throw new Error(`390px horizontal overflow scrollWidth=${await page.evaluate(() => document.documentElement.scrollWidth)}`);
  console.log('PASS 390 no horizontal overflow');

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('[data-testid="tab-wine"]').click();
  const urlBox = page.locator('[data-testid="wine-bridge-url"]');
  await urlBox.fill(`http://127.0.0.1:${bridgePort}`);
  await page.locator('[data-testid="wine-connect-btn"]').click();
  await page.locator('[data-testid="wine-conn-pill"]').filter({ hasText: '已連線' }).waitFor({ timeout: 15000 });
  console.log('PASS bridge connected');

  await page.locator('[data-testid="tab-wine-path"]').click();
  const map = page.locator('[data-testid="wine-nav-map"]');
  await map.waitFor({ state: 'visible', timeout: 15000 });
  const box = await map.boundingBox();
  if (!box) throw new Error('map has no box');
  await map.click({ position: { x: Math.max(8, box.width / 2), y: Math.max(8, box.height / 2) } });
  await page.waitForFunction(() => {
    const progress = document.querySelector('[data-testid="wine-nav-progress"]')?.textContent ?? '';
    const notice = document.querySelector('[data-testid="wine-nav-notice"]');
    const err = document.querySelector('[data-testid="wine-nav-error"]');
    return (progress && progress !== '尚未開始') || notice || err;
  }, null, { timeout: 20000 });
  const shown = await page.locator('[data-testid="wine-nav-progress"]').innerText();
  const notice = await page.locator('[data-testid="wine-nav-notice"]').allInnerTexts().catch(() => []);
  console.log(`PASS walk status: ${shown} ${notice.join(' ')}`);
  const stop = page.locator('[data-testid="wine-nav-stop"]');
  if (await stop.isEnabled()) {
    await stop.click();
    console.log('PASS stop clicked');
  }

  if (pageErrors.length) throw new Error(`pageerror count=${pageErrors.length}: ${pageErrors.slice(0, 4).join(' | ')}`);
  const remain = Math.max(0, totalMs - (Date.now() - started));
  console.log(`holding remaining ${Math.round(remain / 1000)}s`);
  while (Date.now() - started < totalMs) {
    if (pageErrors.length) throw new Error(`pageerror during hold: ${pageErrors.slice(0, 4).join(' | ')}`);
    const left = totalMs - (Date.now() - started);
    await page.waitForTimeout(Math.min(15000, Math.max(0, left)));
  }
  console.log(`PASS 5min headless 0 pageerror (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  console.log('F15_PATH_OK');
  exitCode = 0;
} catch (err) {
  console.error(err instanceof Error ? err.stack || err.message : err);
  console.error(bridgeLog.value.slice(-1000));
  fs.mkdirSync(shotDir, { recursive: true });
  const pages = browser ? browser.contexts().flatMap(ctx => ctx.pages()) : [];
  if (pages[0]) await pages[0].screenshot({ path: path.join(shotDir, 'f15_failure.png') }).catch(() => {});
  console.error('F15_PATH_FAIL');
} finally {
  if (browser) await browser.close().catch(() => {});
  bridge.kill('SIGTERM');
  vite.kill('SIGTERM');
  setTimeout(() => process.exit(exitCode), 800);
}
