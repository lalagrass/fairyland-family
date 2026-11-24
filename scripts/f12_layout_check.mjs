// F12：390／768／1440 沒有水平溢出，窄版底部分頁，每個面板點得到，觸控目標至少 44px，
// 角色切換在每一頁都看得到。截圖只在失敗時寫進 test-results/f12-shots/。
//
//   FM7_PLAYWRIGHT=/tmp/pw/node_modules/playwright node scripts/f12_layout_check.mjs
//   node scripts/f12_layout_check.mjs --skip-hold
//
// 找不到 playwright 時結束碼 2。不要把 playwright 加進 dependencies。
// 用回放快照，不含原版素材。--skip-hold 略過最後 5 分鐘 pageerror 監看。

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 3112;
const base = `http://127.0.0.1:${port}/family/?replay=1&loop=1`;
const shotDir = path.join(root, 'test-results', 'f12-shots');
const skipHold = process.argv.includes('--skip-hold');
const widths = [390, 768, 1440];

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    // 本專案沒有這個依賴。
  }
  const candidates = [process.env.FM7_PLAYWRIGHT, '/tmp/pw/node_modules/playwright'].filter(Boolean);
  for (const hint of candidates) {
    try {
      const entry = hint.endsWith('.js') ? hint : path.join(hint, 'index.js');
      return await import(pathToFileURL(entry).href);
    } catch {
      // 下一個候選。
    }
  }
  return null;
}

const loaded = await loadPlaywright();
const playwright = loaded?.chromium ? loaded : loaded?.default;
if (!playwright?.chromium) {
  console.error('待實機確認：找不到 playwright，沒有跑 F12 版面驗收。');
  process.exit(2);
}

const vite = spawn(
  process.execPath,
  [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
);
let viteLog = '';
vite.stdout.on('data', c => { viteLog += c; });
vite.stderr.on('data', c => { viteLog += c; });
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
const pageErrors = [];
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

async function overflow() {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return { scrollWidth: doc.scrollWidth, innerWidth: window.innerWidth };
  });
}

async function assertNoOverflow(label) {
  const box = await overflow();
  await check(box.scrollWidth <= box.innerWidth + 1, `${label}：沒有水平溢出（${box.scrollWidth}/${box.innerWidth}）`, `overflow-${label}`);
}

async function visibleTargets() {
  return page.evaluate(() => {
    const nodes = [...document.querySelectorAll('button, [role="tab"], select, input:not([type="checkbox"]):not([type="radio"])')];
    const bad = [];
    for (const el of nodes) {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (r.bottom < 0 || r.top > window.innerHeight) continue;
      if (r.width < 44 || r.height < 44) {
        bad.push({
          tag: el.tagName,
          testid: el.getAttribute('data-testid') || '',
          text: (el.textContent || '').trim().slice(0, 24),
          w: Math.round(r.width),
          h: Math.round(r.height),
        });
      }
    }
    return bad;
  });
}

async function assertTargets(label) {
  const bad = await visibleTargets();
  const sample = bad.slice(0, 6).map(b => `${b.tag}#${b.testid || b.text} ${b.w}x${b.h}`).join('; ');
  await check(bad.length === 0, `${label}：可見控制項至少 44px${bad.length ? `（${bad.length}：${sample}）` : ''}`, `target-${label}`);
}

async function injectMembers() {
  await page.evaluate(async () => {
    const { PROTOCOL_VERSION } = await import('/family/src/protocol/index.ts');
    const ctrl = window.__family.controller;
    if ((ctrl.state.members ?? []).length >= 2) return;
    const cid = ctrl.state.characterId;
    const snap = JSON.parse(JSON.stringify(ctrl.state.snapshot));
    const member = (id, name) => ({
      characterId: id, name, level: 5, mapId: snap.mapId, mapName: snap.mapName, region: snap.region ?? null,
      x: 100, y: 100, gold: 10, satiety: 90, inventoryCount: 0, inventoryCap: 40, inBattle: false, inventory: [], workSkills: {},
    });
    snap.family = {
      activeCharacterId: cid,
      maxSlots: 5,
      warehouse: snap.family?.warehouse ?? { gold: 0, cap: 200, items: [] },
      members: [member(cid, '甲'), member('char_f12_b', '乙')],
    };
    ctrl.receive({
      v: PROTOCOL_VERSION, characterId: cid, ts: Date.now(), kind: 'snapshot', seq: Date.now(), reason: 'REQUESTED', snapshot: snap,
    });
  });
  await page.locator('[data-testid="f10-member-char_f12_b"]').waitFor({ state: 'visible', timeout: 8000 });
}

async function assertCharacterSwitch(label) {
  const result = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('[data-testid^="f10-member-"]')];
    if (!buttons.length) return { ok: false, count: 0 };
    const boxes = buttons.map(el => {
      const r = el.getBoundingClientRect();
      return { disabled: el.disabled, w: r.width, h: r.height, top: r.top, bottom: r.bottom };
    });
    const ok = boxes.length >= 2 && boxes.every(b =>
      !b.disabled && b.w >= 44 && b.h >= 44 && b.top >= -1 && b.bottom <= window.innerHeight + 1,
    );
    return { ok, count: boxes.length };
  });
  await check(result.ok, `${label}：角色切換在這一頁可見、可按、至少 44px（${result.count}）`, `switch-${label}`);
}

async function show(selector) {
  const loc = page.locator(selector).first();
  await loc.scrollIntoViewIfNeeded();
  await loc.waitFor({ state: 'visible', timeout: 8000 });
}

const panelsWide = [
  ['遊戲畫面', '[data-testid="game-stage-panel"]'],
  ['世界地圖', '[data-testid="world-map-panel"]'],
  ['派工', '[data-testid="dispatch-panel"]'],
  ['角色', '[data-testid="character-stats"]'],
  ['任務卡', '[data-testid="quest-cards"]'],
  ['事件流', '[data-testid="log"]'],
];

let browser = null;
try {
  await waitForServer();
  browser = await playwright.chromium.launch();
  page = await browser.newPage();
  page.on('pageerror', e => pageErrors.push(e.message));

  for (const width of widths) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="character-stats"]', { timeout: 15000 });
    await injectMembers();
    const narrow = width <= 768;
    const tabs = page.locator('[data-testid="mobile-tabs"]');
    const tabDisplay = await tabs.evaluate(el => getComputedStyle(el).display);
    if (narrow) {
      const box = await tabs.boundingBox();
      const fixed = await tabs.evaluate(el => getComputedStyle(el).position === 'fixed');
      await check(tabDisplay === 'flex' && fixed && box && box.y > 700, `${width}：底部分頁導覽`, `tabs-${width}`);
    } else {
      await check(tabDisplay === 'none', `${width}：寬螢幕不顯示底部分頁`, `tabs-${width}`);
    }
    await assertNoOverflow(String(width));
    await assertCharacterSwitch(`${width}-start`);

    if (narrow) {
      const steps = [
        ['畫面', '遊戲畫面', '[data-testid="game-stage-panel"]'],
        ['畫面', '世界地圖', '[data-testid="world-map-panel"]'],
        ['名冊', '派工', '[data-testid="dispatch-panel"]'],
        ['目前角色', '角色', '[data-testid="character-stats"]'],
        ['目前角色', '技能', '[data-testid="skill-panel"]', '[data-testid="character-workbench"] [role="tab"]:has-text("技能")'],
        ['目前角色', '物品欄', '[data-testid="inventory-panel"]', '[data-testid="character-workbench"] [role="tab"]:has-text("物品欄")'],
        ['目前角色', '系統設定', '[data-testid="f10-view-mode"]', '[data-testid="character-workbench"] [role="tab"]:has-text("設定")'],
        ['目前角色', '任務卡', '[data-testid="quest-cards"]'],
        ['目前角色', '視窗練功', '[data-testid="wine-training-panel"]', '[data-testid="tab-wine"]'],
        ['事件流', '事件流', '[data-testid="log"]'],
      ];
      for (const [tab, name, selector, sub] of steps) {
        await page.locator('[data-testid="mobile-tabs"] [role="tab"]', { hasText: tab }).click();
        if (sub) await page.locator(sub).click();
        await show(selector);
        await check(await page.locator(selector).isVisible(), `${width}：${name} 點得到`, `panel-${width}-${name}`);
        await assertCharacterSwitch(`${width}-${name}`);
        await assertNoOverflow(`${width}-${name}`);
        await assertTargets(`${width}-${name}`);
      }
    } else {
      for (const [name, selector] of panelsWide) {
        await show(selector);
        await check(await page.locator(selector).isVisible(), `${width}：${name} 點得到`, `panel-${width}-${name}`);
        await assertCharacterSwitch(`${width}-${name}`);
        await assertNoOverflow(`${width}-${name}`);
      }
      await page.locator('[data-testid="character-workbench"] [role="tab"]:has-text("技能")').click();
      await show('[data-testid="skill-panel"]');
      await check(await page.locator('[data-testid="skill-panel"]').isVisible(), `${width}：技能 點得到`, `panel-${width}-技能`);
      await page.locator('[data-testid="character-workbench"] [role="tab"]:has-text("物品欄")').click();
      await show('[data-testid="inventory-panel"]');
      await check(await page.locator('[data-testid="inventory-panel"]').isVisible(), `${width}：物品欄 點得到`, `panel-${width}-物品欄`);
      await page.locator('[data-testid="character-workbench"] [role="tab"]:has-text("設定")').click();
      await show('[data-testid="f10-view-mode"]');
      await check(await page.locator('[data-testid="f10-view-mode"]').isVisible(), `${width}：系統設定 點得到`, `panel-${width}-設定`);
      await page.locator('[data-testid="tab-wine"]').click();
      await show('[data-testid="wine-training-panel"]');
      await check(await page.locator('[data-testid="wine-training-panel"]').isVisible(), `${width}：視窗練功 點得到`, `panel-${width}-視窗練功`);
      await assertTargets(`${width}-panels`);
      await assertNoOverflow(`${width}-panels`);
    }

    const second = page.locator('[data-testid="f10-member-char_f12_b"]');
    const enabled = await second.isEnabled();
    await second.click();
    await assertCharacterSwitch(`${width}-click`);
    await check(enabled, `${width}：第二個角色的切換按鈕可按`, `switch-click-${width}`);
  }

  if (!skipHold) {
    const before = pageErrors.length;
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) await page.waitForTimeout(15000);
    await check(pageErrors.length === before, `5 分鐘回放 0 個新 pageerror（共 ${pageErrors.length}）`, 'hold');
    if (pageErrors.length) console.log(pageErrors.slice(0, 5).join('\n'));
  } else {
    console.log('SKIP 5 分鐘回放（--skip-hold）');
  }
} catch (err) {
  failed++;
  console.error(`FAIL 腳本中斷：${err instanceof Error ? err.message : err}`);
  if (page) {
    mkdirSync(shotDir, { recursive: true });
    await page.screenshot({ path: path.join(shotDir, 'crash.png'), fullPage: true }).catch(() => {});
  }
} finally {
  await browser?.close().catch(() => {});
  stopVite();
}

if (failed) process.exit(1);
console.log('F12 layout check passed');
