// F8 多角色派工的瀏覽器驗收（回放模式＋頁內的虛構 FX17 背景角色）：
// - 派工面板列出兩位成員，每列有家族總覽（目前、進度、預計完成）與「切換觀看」。
// - 把任務鏈派給背景角色：通道自己要該角色的快照（inReplyTo），在背景接任務、回報完成，視角角色的畫面狀態不變。
// - 1280px 與 360px 都沒有水平溢出。
// 截圖只在失敗時存（覆蓋 test-results/f8-shots/），成功不存任何檔案。
//
//   FM7_PLAYWRIGHT=/opt/node-tools/node_modules/playwright node scripts/f8_multi_dispatch_check.mjs
//   （沒有 Playwright 自帶的瀏覽器時再加 FM7_CHROMIUM=/usr/bin/google-chrome）
//
// 找不到 playwright 時結束碼 2，並印出「待實機確認」。Playwright 不寫進 package.json。
// 背景角色、任務、NPC 都是虛構資料，執行時塞進頁面；不含任何原版內容。這不是對真宿主的實機驗收。

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 3110;
const base = `http://127.0.0.1:${port}/family/?replay=1&loop=1`;
const shotDir = path.join(root, 'test-results', 'f8-shots');

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
  console.error('待實機確認：找不到 playwright，沒有跑多角色派工驗收（設定 FM7_PLAYWRIGHT，見檔頭）。');
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
  // 沒裝 Playwright 自帶的瀏覽器時，可用 FM7_CHROMIUM 指定系統的 Chrome／Chromium。
  browser = await playwright.chromium.launch(process.env.FM7_CHROMIUM ? { executablePath: process.env.FM7_CHROMIUM } : {});
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="character-stats"]', { timeout: 15000 });

  // 頁內的虛構 FX17 宿主：只替背景角色「乙」回指令；視角角色仍由回放驅動。
  await page.evaluate(async () => {
    const { PROTOCOL_VERSION } = await import('/family/src/protocol/index.ts');
    const ctrl = window.__family.controller;
    const B = 'char_f8_b';
    const viewed = ctrl.state.characterId;
    const base = JSON.parse(JSON.stringify(ctrl.state.snapshot));
    const npc = { id: 'npc_f8', name: '虛構嚮導F8', x: 200, y: 200, gridX: 6, gridY: 6, role: 'VILLAGER', talkable: true, isAnimal: false, isShop: false };
    const b = { x: 210, y: 210, quest: 'AVAILABLE', dialog: false };
    const member = (id, name, x, y) => ({
      characterId: id, name, level: 5, mapId: base.mapId, mapName: base.mapName, x, y, gold: 10, satiety: 90,
      inventoryCount: 0, inventoryCap: 40, inBattle: false, inventory: [], workSkills: {},
    });
    const family = () => ({ maxSlots: 5, warehouse: { gold: 0, cap: 200, items: [] }, members: [member(viewed, '甲', 100, 100), member(B, '乙', b.x, b.y)] });
    const quest = () => ({
      questId: 99801, title: '虛構委託F8', npcId: npc.id, npcName: npc.name, minLevel: 1, status: b.quest,
      objectives: [{ type: 'TALK', description: `與「${npc.name}」交談`, current: b.quest === 'AVAILABLE' ? 0 : 1, required: 1, met: b.quest !== 'AVAILABLE' }],
      rewardExp: 5, rewardCoins: 0,
    });
    const snapB = () => {
      const s = JSON.parse(JSON.stringify(base));
      s.character = { ...s.character, name: '乙', x: b.x, y: b.y, level: 5 };
      s.npcs = [npc]; s.exits = []; s.openingStage = 'DONE';
      s.quests = [quest()];
      s.activity = { dialog: null, shop: null, battle: null, battleResult: null, command: null };
      s.family = { ...family(), activeCharacterId: B };
      return s;
    };
    let seq = 1e6;
    const env = () => ({ v: PROTOCOL_VERSION, characterId: B, ts: Date.now() });
    const later = (ms, fn) => setTimeout(fn, ms);
    const ev = event => ctrl.receive({ ...env(), kind: 'event', seq: ++seq, event });
    const transport = ctrl.transport;
    const replaySend = transport.send.bind(transport);
    window.__f8 = { b, sentToB: [], viewed };
    transport.send = msg => {
      if (msg.characterId !== B) return replaySend(msg);
      window.__f8.sentToB.push(msg.command.type);
      const c = msg.command;
      later(0, () => ctrl.receive({ ...env(), kind: 'command-result', commandId: msg.commandId, status: 'ACCEPTED' }));
      const done = (code, fn = () => {}) => later(150, () => { fn(); ev({ type: 'COMMAND_COMPLETED', commandId: msg.commandId, outcome: 'DONE', code }); });
      if (c.type === 'REQUEST_SNAPSHOT') later(50, () => ctrl.receive({ ...env(), kind: 'snapshot', seq: ++seq, reason: 'REQUESTED', inReplyTo: msg.commandId, snapshot: snapB() }));
      else if (c.type === 'WALK_TO') done('ARRIVED', () => { b.x = c.x; b.y = c.y; ev({ type: 'MOVED', mapId: base.mapId, x: c.x, y: c.y, dir: 0 }); });
      else if (c.type === 'TALK_TO_NPC') done('DIALOG_OPENED', () => {
        b.dialog = true;
        const opt = b.quest === 'AVAILABLE' ? 'ACCEPT_QUEST:99801' : b.quest === 'READY' ? 'COMPLETE_QUEST:99801' : null;
        ev({ type: 'DIALOG_OPENED', npcId: npc.id, npcName: npc.name, role: null, lines: ['虛構對白'], optionsAvailable: true,
          options: [...(opt ? [{ id: opt, label: '好' }] : []), { id: 'CLOSE', label: '離開' }] });
      });
      else if (c.type === 'CHOOSE_DIALOG_OPTION' || c.type === 'ACCEPT_QUEST') done('DONE', () => {
        const id = c.type === 'ACCEPT_QUEST' ? 'ACCEPT_QUEST:99801' : c.optionId;
        if (id.startsWith('ACCEPT_QUEST')) b.quest = 'READY';
        else if (id.startsWith('COMPLETE_QUEST')) b.quest = 'COMPLETED';
        b.dialog = false;
        ev({ type: 'DIALOG_CLOSED', npcId: npc.id });
      });
      else done('DONE');
    };
    // 回放會一直送視角角色自己的快照；每 200ms 補回兩位成員的名冊。
    const apply = () => {
      const cur = ctrl.state.snapshot;
      if (!cur || cur.family?.members?.some(m => m.characterId === B)) return;
      const s = JSON.parse(JSON.stringify(cur));
      s.family = { ...family(), activeCharacterId: ctrl.state.characterId };
      ctrl.receive({ v: PROTOCOL_VERSION, characterId: ctrl.state.characterId, ts: Date.now(), kind: 'snapshot', seq: ++seq, reason: 'REQUESTED', snapshot: s });
    };
    apply();
    setInterval(apply, 200);
  });

  const rows = page.locator('[data-testid="dispatch-row"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="dispatch-row"]').length === 2, null, { timeout: 10000 }).catch(() => {});
  await check((await rows.count()) === 2, `1280px：派工面板列出兩位成員（${await rows.count()}）`, 'desktop-1280');
  const rowB = page.locator('[data-testid="dispatch-row"][data-character-id="char_f8_b"]');
  await check((await rowB.locator('[data-testid="dispatch-overview"] dd').count()) === 3, '1280px：每列有家族總覽（目前、進度、預計完成）', 'desktop-1280');
  const viewBtns = await rows.locator('[data-testid="dispatch-view"]').evaluateAll(els => els.map(e => e.disabled));
  await check(viewBtns.length === 2 && viewBtns.filter(Boolean).length === 1, `1280px：「切換觀看」視角中那位不能按、另一位可以（${viewBtns.join(',')}）`, 'desktop-1280');

  // 用面板把任務鏈派給背景的乙。
  await rowB.locator('[data-testid="dispatch-kind"]').selectOption('QUEST_CHAIN');
  await rowB.locator('[data-testid="dispatch-assign"]').click();
  await page.waitForFunction(() => window.__family.controller.dispatches().find(r => r.characterId === 'char_f8_b')?.phase === 'RUNNING', null, { timeout: 10000 }).catch(() => {});
  const phaseB = await rowB.getAttribute('data-phase');
  await check(phaseB === 'RUNNING', `乙要到自己的快照後開始跑（data-phase=${phaseB}）`, 'assign-b');
  await page.waitForFunction(() => window.__f8.b.quest === 'COMPLETED', null, { timeout: 20000 }).catch(() => {});
  const r = await page.evaluate(() => ({
    quest: window.__f8.b.quest,
    sent: [...new Set(window.__f8.sentToB)],
    viewed: window.__family.controller.state.characterId,
    viewedName: window.__family.controller.state.snapshot?.character?.name ?? null,
    switched: window.__family.controller.state.log.filter(l => l.tag === '送出' && l.text.includes('SWITCH_VIEW_CHARACTER')).length,
    wrong: window.__family.controller.state.log.filter(l => l.text.includes('WRONG_CHARACTER') && l.characterId === 'char_f8_b').length,
  }));
  await check(r.quest === 'COMPLETED', `乙在背景接任務並回報完成（${r.quest}；送給乙：${r.sent.join('、')}）`, 'quest-b');
  await check(r.viewed === (await page.evaluate(() => window.__f8.viewed)) && r.viewedName !== '乙', `視角角色的畫面狀態沒有被乙的快照蓋掉（${r.viewed}／${r.viewedName}）`, 'quest-b');
  await check(r.switched === 0 && r.wrong === 0, `沒有切換視角、沒有 WRONG_CHARACTER（切換 ${r.switched}、拒絕 ${r.wrong}）`, 'quest-b');
  const overflow1280 = await page.evaluate(() => document.documentElement.scrollWidth);
  await check(overflow1280 <= 1280, `1280px：沒有水平溢出（${overflow1280}）`, 'desktop-1280');

  await page.setViewportSize({ width: 360, height: 800 });
  const tabs = page.locator('[data-testid="mobile-tabs"] > *');
  let shown = false;
  for (let i = 0; i < (await tabs.count()) && !shown; i++) {
    await tabs.nth(i).click();
    await page.waitForTimeout(200);
    shown = await page.locator('[data-testid="dispatch-panel"]').isVisible();
  }
  await check(shown, '360px：有分頁能看到派工面板', 'mobile-360');
  const w360 = await page.evaluate(() => document.documentElement.scrollWidth);
  await check(w360 <= 360, `360px：沒有水平溢出（${w360}）`, 'mobile-360');
  const btns = await page.locator('[data-testid="dispatch-panel"] button').evaluateAll(els =>
    els.filter(e => e.offsetParent !== null).map(e => { const b = e.getBoundingClientRect(); return { left: b.left, right: b.right }; }));
  await check(btns.length > 0 && btns.every(b => b.left >= -1 && b.right <= 361), `360px：派工按鈕都在畫面內（${btns.length} 個）`, 'mobile-360');
  await check(pageErrors.length === 0, `沒有頁面錯誤（${pageErrors.join('；')}）`, 'page-error');
} finally {
  await browser?.close().catch(() => {});
  stopVite();
}
process.exit(failed ? 1 : 0);
