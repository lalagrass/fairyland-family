// F7 跨區的瀏覽器驗收（回放模式，不連宿主）：角色總覽與家族名冊顯示每個角色目前所在區域、
// 宿主沒給就是「未知」；任務鏈的區域選單來自宿主的區域清單，可以選；續跑鍵在沒有可續跑的停工時停用。
// 1280px 與 360px 都檢查，且沒有水平溢出。截圖只在失敗時存（覆蓋 test-results/f7-shots/）。
//
//   FM7_PLAYWRIGHT=/home/box/node-tools/node_modules/playwright node scripts/f7_cross_region_check.mjs
//   （沒有 Playwright 自帶瀏覽器時再加 FM7_CHROME=/usr/bin/google-chrome）
//
// 找不到 playwright 時結束碼 2，並印出「待實機確認」。Playwright 不寫進 package.json。
// 區域、成員都是虛構資料，執行時塞進回放快照；不含任何原版內容。真實跨區流程仍須在實機上跑。

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 3117;
const base = `http://127.0.0.1:${port}/family/?replay=1&loop=1`;
const shotDir = path.join(root, 'test-results', 'f7-shots');

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
  console.error('待實機確認：找不到 playwright，沒有跑 F7 跨區驗收（設定 FM7_PLAYWRIGHT，見檔頭）。');
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
  // 沒裝 Playwright 自帶的瀏覽器時，可用 FM7_CHROME 指到系統的 Chrome。
  browser = await playwright.chromium.launch(process.env.FM7_CHROME ? { executablePath: process.env.FM7_CHROME } : {});
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="character-stats"]', { timeout: 15000 });

  // 回放會一直送自己的快照與靜態資料，所以每 200ms 檢查一次，被蓋掉就再塞回虛構區域。
  await page.evaluate(async () => {
    const { PROTOCOL_VERSION } = await import('/family/src/protocol/index.ts');
    const ctrl = window.__family.controller;
    const regions = [
      { regionId: 'r-f7a', name: '虛構甲區', villageMapId: 'f7-a1', mapIds: ['f7-a1'] },
      { regionId: 'r-f7b', name: '虛構乙區', villageMapId: 'f7-b1', mapIds: ['f7-b1'] },
    ];
    const apply = () => {
      const cid = ctrl.state.characterId;
      if (!ctrl.state.staticData?.regions?.some(r => r.regionId === 'r-f7a') && ctrl.state.staticData) {
        const sd = JSON.parse(JSON.stringify(ctrl.state.staticData));
        sd.regions = regions;
        ctrl.receive({ v: PROTOCOL_VERSION, characterId: cid, ts: Date.now(), kind: 'static-data', seq: Date.now(), staticData: sd });
      }
      if (ctrl.state.snapshot?.region?.regionId === 'r-f7b') return;
      const snap = JSON.parse(JSON.stringify(ctrl.state.snapshot));
      snap.region = { regionId: 'r-f7b', name: '虛構乙區' };
      const member = (id, name, region) => ({
        characterId: id, name, level: 5, mapId: snap.mapId, mapName: snap.mapName, region, x: 100, y: 100, gold: 10, satiety: 90,
        inventoryCount: 0, inventoryCap: 40, inBattle: false, inventory: [], workSkills: {},
      });
      snap.family = { activeCharacterId: cid, maxSlots: 5, warehouse: { gold: 0, cap: 200, items: [] },
        members: [member(cid, '甲', { regionId: 'r-f7b', name: '虛構乙區' }), member('char_f7_b', '乙', null)] };
      snap.openingStage = 'DONE';
      ctrl.receive({ v: PROTOCOL_VERSION, characterId: cid, ts: Date.now(), kind: 'snapshot', seq: Date.now(), reason: 'REQUESTED', snapshot: snap });
    };
    apply();
    setInterval(apply, 200);
  });
  await page.locator('[data-testid="region"][data-region-id="r-f7b"]').waitFor({ timeout: 10000 });
  await page.waitForTimeout(500);

  const read = () => page.evaluate(() => {
    const visible = e => e && e.offsetParent !== null;
    const hero = document.querySelector('[data-testid="region"]');
    const members = [...document.querySelectorAll('[data-testid="member-region"]')];
    const sel = document.querySelector('[data-testid="chain-region"]');
    const resume = document.querySelector('[data-testid="quest-chain-resume"]');
    return {
      hero: hero?.textContent ?? null,
      heroVisible: visible(hero),
      members: members.map(e => e.textContent),
      options: sel ? [...sel.options].map(o => o.textContent) : [],
      selectVisible: visible(sel),
      resumeDisabled: resume ? resume.disabled : null,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });

  let r = await read();
  await check(r.hero === '區域 虛構乙區' && r.heroVisible, `1280px：角色總覽顯示目前區域（${r.hero}）`, 'desktop-1280');
  await check(r.members.includes('區域 虛構乙區') && r.members.includes('區域 未知'), `1280px：名冊每人顯示區域，沒給的是未知（${r.members.join('、')}）`, 'desktop-1280');
  await check(r.options.join('|') === '不限區域|虛構甲區|虛構乙區', `1280px：區域選單來自宿主（${r.options.join('|')}）`, 'desktop-1280');
  await check(r.resumeDisabled === true, '1280px：沒有可續跑的停工時續跑鍵停用', 'desktop-1280');
  await check(r.scrollWidth <= 1280, `1280px：沒有水平溢出（${r.scrollWidth}）`, 'desktop-1280');

  if (r.selectVisible) {
    await page.locator('[data-testid="chain-region"]').selectOption({ label: '虛構甲區' }, { timeout: 5000 });
    await page.waitForTimeout(200);
    const picked = await page.evaluate(() => window.__family.controller.chainStatus().config.regionId);
    await check(picked === 'r-f7a', `1280px：選區域寫進任務鏈設定（${picked}）`, 'desktop-1280-select');
  } else {
    await check(false, '1280px：區域選單看得到', 'desktop-1280-select');
  }

  await page.setViewportSize({ width: 360, height: 800 });
  await page.waitForTimeout(400);
  r = await read();
  await check(r.scrollWidth <= 360, `360px：沒有水平溢出（${r.scrollWidth}）`, 'mobile-360');
  await check(r.hero === '區域 虛構乙區', `360px：區域文字還在（${r.hero}）`, 'mobile-360');
  const boxes = await page.locator('[data-testid="region"], [data-testid="member-region"], [data-testid="chain-region"], [data-testid="quest-chain-resume"]').evaluateAll(els =>
    els.filter(e => e.offsetParent !== null).map(e => { const b = e.getBoundingClientRect(); return { left: b.left, right: b.right }; }));
  await check(boxes.every(b => b.left >= -1 && b.right <= 361), `360px：看得到的區域元件都在畫面內（${boxes.length} 個）`, 'mobile-360');
  await check(pageErrors.length === 0, `沒有頁面錯誤（${pageErrors.join('；')}）`, 'page-error');
} finally {
  await browser?.close().catch(() => {});
  stopVite();
}
process.exit(failed ? 1 : 0);
