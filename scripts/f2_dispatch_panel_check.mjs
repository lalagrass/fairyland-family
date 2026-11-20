// F2 派工面板的瀏覽器驗收：360px／1280px 都能操作、沒有水平溢出。不存任何截圖。
//
//   FM7_PLAYWRIGHT=/opt/node-tools/node_modules/playwright node scripts/f2_dispatch_panel_check.mjs
//
// 找不到 playwright 時結束碼 2，並印出「待實機確認」。Playwright 不寫進 package.json。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 3101;
const base = `http://127.0.0.1:${port}/family/?replay=1&loop=1`;

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
  console.error('待實機確認：找不到 playwright，沒有跑面板驗收（設定 FM7_PLAYWRIGHT，見檔頭）。');
  process.exit(2);
}

const vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let viteLog = '';
vite.stdout.on('data', c => { viteLog += c; });
vite.stderr.on('data', c => { viteLog += c; });
const stopVite = () => { if (!vite.killed) vite.kill('SIGTERM'); };

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
const check = (ok, name) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failed++;
};

try {
  await waitForServer();
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="character-stats"]', { timeout: 15000 });

  // 把兩位成員塞進快照（回放檔只有一位角色）。
  await page.evaluate(() => {
    const ctrl = window.__family.controller;
    const cid = ctrl.state.characterId;
    const snap = JSON.parse(JSON.stringify(ctrl.state.snapshot));
    const member = (id, name) => ({
      characterId: id, name, level: 5, mapId: snap.mapId, mapName: snap.mapName, x: 100, y: 100, gold: 10, satiety: 90,
      inventoryCount: 0, inventoryCap: 40, inBattle: false, inventory: [], workSkills: {},
    });
    snap.family = { activeCharacterId: cid, maxSlots: 5, warehouse: { gold: 0, cap: 200, items: [] }, members: [member(cid, '甲'), member('char_f2_b', '乙')] };
    snap.gatherPoints = {
      status: 'AVAILABLE',
      points: [{ id: 'g1', name: '虛構點', mapId: snap.mapId, mapName: snap.mapName, x: 120, y: 100, skillId: 5, skillName: '挖礦', requiredToolItemId: null, materials: [{ itemId: 90001, name: '虛構礦石', reqLevel: 1 }] }],
    };
    ctrl.receive({ v: 4, characterId: cid, ts: Date.now(), kind: 'snapshot', seq: 99001, reason: 'REQUESTED', snapshot: snap });
  });

  const noOverflow = async (w, label) => {
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    check(sw <= w, `${label}：沒有水平溢出（scrollWidth ${sw} ≤ ${w}）`);
  };
  const inView = async (w, label) => {
    const boxes = await page.locator('[data-testid="dispatch-panel"] :is(select,input,button)').evaluateAll(els =>
      els.filter(e => e.offsetParent !== null).map(e => { const r = e.getBoundingClientRect(); return { right: r.right, left: r.left }; }));
    check(boxes.length > 0 && boxes.every(b => b.left >= -1 && b.right <= w + 1), `${label}：派工面板的控制項都在畫面內（${boxes.length} 個）`);
  };

  await page.locator('[data-testid="dispatch-panel"]').waitFor();
  check((await page.locator('[data-testid="dispatch-row"]').count()) === 2, '1280px：兩位成員各一列派工');
  await noOverflow(1280, '1280px');
  await inView(1280, '1280px');

  // 派工：乙 → 採集（背包滿即停預設勾選）
  const rowB = page.locator('[data-testid="dispatch-row"][data-character-id="char_f2_b"]');
  await rowB.locator('[data-testid="dispatch-assign"]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="dispatch-row"][data-character-id="char_f2_b"]')?.getAttribute('data-phase') === 'RUNNING', null, { timeout: 5000 });
  check(true, '1280px：按「派工」後乙進入進行中');
  const text = await rowB.locator('[data-testid="dispatch-status"]').innerText();
  check(text.includes('乙') && text.includes('採集'), `1280px：狀態列寫出角色與工作（${text}）`);
  await rowB.locator('[data-testid="dispatch-stop"]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="dispatch-row"][data-character-id="char_f2_b"] [data-testid="dispatch-status"]')?.textContent?.includes('玩家停止'), null, { timeout: 5000 });
  check(true, '1280px：停止後狀態列寫出停工原因');

  // 手機寬度：先切到名冊分頁
  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByRole('tab', { name: /名冊/ }).click();
  await page.locator('[data-testid="dispatch-panel"]').waitFor({ state: 'visible' });
  await noOverflow(360, '360px');
  await inView(360, '360px');
  await rowB.locator('[data-testid="dispatch-kind"]').selectOption('QUEST_CHAIN');
  await noOverflow(360, '360px（任務鏈欄位）');
  await inView(360, '360px（任務鏈欄位）');
  await rowB.locator('[data-testid="dispatch-kind"]').selectOption('GATHER');
  await rowB.locator('[data-testid="dispatch-assign"]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="dispatch-row"][data-character-id="char_f2_b"]')?.getAttribute('data-phase') === 'RUNNING', null, { timeout: 5000 });
  check(true, '360px：可以操作派工');
  await noOverflow(360, '360px（派工後）');
  check(pageErrors.length === 0, `沒有頁面錯誤（${pageErrors.join('；')}）`);
  await browser.close();
} finally {
  stopVite();
}
process.exit(failed ? 1 : 0);
