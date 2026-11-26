/**
 * F13b：六張宿主地圖的標記座標要與場景世界座標一致，並產出兩張程式圖形供目視。
 * 接著用回放開現代檢視，守約 5 分鐘、0 pageerror。
 *
 *   FAIRYLAND_ROOT=... npx tsx scripts/f13b_overlay_check.mts
 *   npx tsx scripts/f13b_overlay_check.mts --skip-hold
 *
 * 地圖代號、名稱與座標只在比對當下從宿主檔案讀取，不寫進這個 repo，成功時也不印出來。
 * 截圖只寫到 /tmp/fl-f13b-shots。失敗明細寫到 /tmp/fl-f13b-marker-fail.txt。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { overlayMarkers, routePolylines, worldToStagePoint } from '../src/render/viewMode';
import { rasterTerrain } from '../src/render/terrainRaster';
import { resolveModernTheme, themePixel } from '../src/render/modernTheme';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skipHold = process.argv.includes('--skip-hold');
const shotDir = '/tmp/fl-f13b-shots';
const failLog = '/tmp/fl-f13b-marker-fail.txt';
const port = Number(process.env.F13B_PORT || 3124);

function fairylandRoot(): string | null {
  const candidates = [process.env.FAIRYLAND_ROOT, path.resolve(root, '../fairyland'), path.resolve(root, '../fairyland-wt-180')].filter(Boolean) as string[];
  for (const cand of candidates) {
    if (fs.existsSync(path.join(cand, 'packages/shared/src/data/region_index.json'))) return cand;
  }
  return null;
}

function readAlias(hostRoot: string): { from: string; to: string } | null {
  const src = path.join(hostRoot, 'packages/shared/src/engine/map_runtime.ts');
  if (!fs.existsSync(src)) return null;
  const text = fs.readFileSync(src, 'utf8');
  const match = text.match(/mapId === '([^']+)'\) return '([^']+)'/);
  return match ? { from: match[1], to: match[2] } : null;
}

function canonical(id: string, alias: { from: string; to: string } | null): string {
  if (!id) return id;
  if (alias && id === alias.from) return alias.to;
  return id;
}

function activeBundle(hostRoot: string): string | null {
  const pointer = path.join(hostRoot, 'extracted/importer/bundles/active.json');
  if (!fs.existsSync(pointer)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(pointer, 'utf8')) as { bundle_path?: string };
    if (!data.bundle_path) return null;
    const cand = path.isAbsolute(data.bundle_path) ? data.bundle_path : path.join(hostRoot, data.bundle_path);
    return fs.existsSync(cand) ? cand : null;
  } catch {
    return null;
  }
}

function mapFile(hostRoot: string, mapId: string): string | null {
  const bundle = activeBundle(hostRoot);
  const candidates = [
    bundle ? path.join(bundle, 'assets/maps', mapId, `map_${mapId}.json`) : '',
    path.join(hostRoot, 'packages/client/public/assets/maps', mapId, `map_${mapId}.json`),
    path.join(hostRoot, 'packages/shared/src/data/maps', `${mapId}.json`),
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p)) ?? null;
}

function pointsOf(rows: Array<{ x: number; y: number }>): string[] {
  return rows.map(p => `${p.x},${p.y}`).sort();
}

function samePoints(actual: Array<{ x: number; y: number }>, expected: Array<{ x: number; y: number }>): boolean {
  const a = pointsOf(actual);
  const b = pointsOf(expected);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function checkHostMarkers(hostRoot: string): { maps: number; omittedSameMap: number } {
  const alias = readAlias(hostRoot);
  const index = JSON.parse(fs.readFileSync(path.join(hostRoot, 'packages/shared/src/data/region_index.json'), 'utf8')) as {
    regions: Array<{ maps: string[]; villageMapId: string }>;
  };
  const regions = [...index.regions].sort((a, b) => b.maps.length - a.maps.length).slice(0, 3);
  const gatherDoc = JSON.parse(fs.readFileSync(path.join(hostRoot, 'packages/shared/src/data/gather_zones.json'), 'utf8')) as {
    points: Array<{ mapId: string; x: number; y: number; source?: string }>;
  };
  const chosen: string[] = [];
  for (const region of regions) {
    const order = [region.villageMapId, ...region.maps.filter(id => id !== region.villageMapId)];
    const found = order.filter(id => mapFile(hostRoot, id)).slice(0, 2);
    chosen.push(...found);
  }
  if (chosen.length < 6) throw new Error(`宿主只找到 ${chosen.length} 張可讀地圖，需要 6 張`);
  const problems: string[] = [];
  let omittedSameMap = 0;
  chosen.forEach((mapId, indexNo) => {
    const file = mapFile(hostRoot, mapId);
    if (!file) {
      problems.push(`map#${indexNo} missing file`);
      return;
    }
    const scene = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      map_id?: string;
      portals?: Array<{ id: string; name?: string; world_x?: number; world_y?: number; target_map?: string }>;
      npcs?: Array<{ id?: string; name?: string; world_x?: number; world_y?: number }>;
    };
    const here = canonical(String(scene.map_id || mapId), alias);
    const exits = [];
    for (const portal of scene.portals ?? []) {
      if (typeof portal.world_x !== 'number' || typeof portal.world_y !== 'number' || !portal.target_map) continue;
      if (canonical(String(portal.target_map), alias) === here) {
        omittedSameMap += 1;
        continue;
      }
      exits.push({ id: String(portal.id), name: portal.name ?? portal.id, x: portal.world_x, y: portal.world_y });
    }
    const npcs = (scene.npcs ?? []).flatMap((npc, i) => {
      if (typeof npc.world_x !== 'number' || typeof npc.world_y !== 'number') return [];
      return [{ id: String(npc.id ?? npc.name ?? `npc_${i}`), name: npc.name ?? '', x: npc.world_x, y: npc.world_y }];
    });
    const gather = gatherDoc.points.filter(p => canonical(p.mapId, alias) === here && p.source !== 'CUSTOM_STARTER_LOOP' && Number.isFinite(p.x) && Number.isFinite(p.y))
      .map((p, i) => ({ id: `g${i}`, name: '採集', mapId: here, x: p.x, y: p.y }));
    const markers = overlayMarkers({ mapId: here, exits, npcs, gatherPoints: gather });
    const exitMarks = markers.filter(m => m.kind === 'exit');
    const npcMarks = markers.filter(m => m.kind === 'npc' || m.kind === 'shop');
    const gatherMarks = markers.filter(m => m.kind === 'gather');
    if (!samePoints(exitMarks, exits)) problems.push(`map#${indexNo} portals differ (${exitMarks.length} vs ${exits.length})`);
    if (!samePoints(npcMarks, npcs)) problems.push(`map#${indexNo} npcs differ (${npcMarks.length} vs ${npcs.length})`);
    if (!samePoints(gatherMarks, gather)) problems.push(`map#${indexNo} gather differ (${gatherMarks.length} vs ${gather.length})`);
  });
  if (problems.length) {
    fs.writeFileSync(failLog, problems.join('\n'));
    throw new Error(`標記座標不一致：${problems.join('; ')}（明細 ${failLog}）`);
  }
  return { maps: chosen.length, omittedSameMap };
}

function png(width: number, height: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const dest = y * (width * 4 + 1);
    raw[dest] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, dest + 1);
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function crc(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function fill(rgba: Uint8Array, width: number, x: number, y: number, color: readonly [number, number, number, number]): void {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= width || iy >= rgba.length / 4 / width) return;
  const o = (iy * width + ix) * 4;
  rgba[o] = color[0];
  rgba[o + 1] = color[1];
  rgba[o + 2] = color[2];
  rgba[o + 3] = color[3];
}

function disc(rgba: Uint8Array, width: number, height: number, x: number, y: number, radius: number, color: readonly [number, number, number, number]): void {
  const r = Math.ceil(radius);
  for (let dy = -r; dy <= r; dy += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      if (dx * dx + dy * dy > radius * radius) continue;
      const px = Math.round(x + dx);
      const py = Math.round(y + dy);
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      fill(rgba, width, px, py, color);
    }
  }
}

function writeThemeShots(): string[] {
  fs.mkdirSync(shotDir, { recursive: true });
  const viewW = 640;
  const viewH = 360;
  const mapW = 320;
  const mapH = 180;
  const cells = new Uint8Array(8 * 4);
  cells[1] = 1;
  cells[8] = 1;
  const markers = overlayMarkers({
    mapId: 'synthetic',
    exits: [{ id: 'out', name: '出口', x: 210, y: 70 }],
    npcs: [{ id: 'n', name: 'NPC', x: 120, y: 90 }],
    gatherPoints: [{ id: 'g', name: '採集', mapId: 'synthetic', x: 160, y: 130 }],
    portals: [{ id: 'out', name: '出口', x: 210, y: 70, targetStatus: 'IMPORTED' }],
  });
  const route = routePolylines([{ x: 80, y: 140 }, { x: 150, y: 100 }, { x: 210, y: 70 }])[0];
  const camera = { x: mapW / 2, y: mapH / 2 };
  const files: string[] = [];
  for (const preset of ['default', 'high-contrast'] as const) {
    const theme = resolveModernTheme({
      getAttribute: () => preset,
      closest: () => null,
      style: { getPropertyValue: () => '' },
    } as unknown as HTMLElement);
    const zoom = 1.4;
    const raster = rasterTerrain(cells, 8, 4, mapW, mapH, 320, { walk: themePixel(theme.walk), block: themePixel(theme.block) });
    const rgba = new Uint8Array(viewW * viewH * 4);
    const bg = themePixel(theme.bg);
    for (let py = 0; py < viewH; py += 1) {
      for (let px = 0; px < viewW; px += 1) {
        const worldX = camera.x + (px + 0.5 - viewW / 2) / zoom;
        const worldY = camera.y + (py + 0.5 - viewH / 2) / zoom;
        const dest = (py * viewW + px) * 4;
        if (worldX < 0 || worldY < 0 || worldX >= mapW || worldY >= mapH) {
          rgba[dest] = bg[0]; rgba[dest + 1] = bg[1]; rgba[dest + 2] = bg[2]; rgba[dest + 3] = 255;
          continue;
        }
        const sx = Math.min(raster.width - 1, Math.floor((worldX / mapW) * raster.width));
        const sy = Math.min(raster.height - 1, Math.floor((worldY / mapH) * raster.height));
        const o = (sy * raster.width + sx) * 4;
        rgba[dest] = raster.rgba[o];
        rgba[dest + 1] = raster.rgba[o + 1];
        rgba[dest + 2] = raster.rgba[o + 2];
        rgba[dest + 3] = 255;
      }
    }
    let prev: { x: number; y: number } | null = null;
    for (const point of route.points) {
      const stage = worldToStagePoint(point, camera, zoom, viewW, viewH);
      if (prev) {
        const steps = Math.ceil(Math.hypot(stage.x - prev.x, stage.y - prev.y));
        for (let s = 0; s <= steps; s += 1) {
          const t = steps === 0 ? 0 : s / steps;
          disc(rgba, viewW, viewH, prev.x + (stage.x - prev.x) * t, prev.y + (stage.y - prev.y) * t, 2, themePixel(theme.routeWalk));
        }
      }
      prev = stage;
    }
    for (const marker of markers) {
      const stage = worldToStagePoint(marker, camera, zoom, viewW, viewH);
      const color = marker.kind === 'npc' ? theme.npc : marker.kind === 'gather' ? theme.gather : theme.exit;
      disc(rgba, viewW, viewH, stage.x, stage.y, marker.kind === 'exit' ? 8 : 6, themePixel(color));
    }
    const file = path.join(shotDir, preset === 'default' ? 'f13b-theme-default.png' : 'f13b-theme-contrast.png');
    fs.writeFileSync(file, png(viewW, viewH, rgba));
    files.push(file);
  }
  return files;
}

async function loadPlaywright() {
  const candidates = [process.env.FM7_PLAYWRIGHT, '/tmp/pw/node_modules/playwright'].filter(Boolean) as string[];
  for (const hint of candidates) {
    try {
      const entry = hint.endsWith('.js') ? hint : path.join(hint, 'index.js');
      const loaded = await import(pathToFileURL(entry).href);
      const pw = loaded.chromium ? loaded : loaded.default;
      if (pw?.chromium) return pw;
    } catch { /* 下一個候選 */ }
  }
  return null;
}

function waitForHttp(url: string, child: { exitCode: number | null }, logRef: { value: string }, timeoutMs: number) {
  const start = Date.now();
  return new Promise<void>((resolve, reject) => {
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

async function holdReplay(): Promise<void> {
  const pw = await loadPlaywright();
  if (!pw) throw new Error('找不到 playwright，5 分鐘回放沒跑');
  const viteLog = { value: '' };
  const vite = spawn(process.execPath, [
    path.join(root, 'node_modules/vite/bin/vite.js'),
    '--host', '127.0.0.1', '--port', String(port), '--strictPort',
  ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  vite.stdout.on('data', chunk => { viteLog.value += chunk; });
  vite.stderr.on('data', chunk => { viteLog.value += chunk; });
  let browser: { close(): Promise<void> } | null = null;
  const started = Date.now();
  const totalMs = 300000;
  try {
    const base = `http://127.0.0.1:${port}/family/?replay=1&loop=1`;
    await waitForHttp(base, vite, viteLog, 20000);
    browser = await pw.chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const pageErrors: string[] = [];
    page.on('pageerror', (err: Error) => pageErrors.push(err.message));
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="stage-view-mode-select"]').selectOption('modern');
    await page.locator('[data-testid="modern-host"]').waitFor({ state: 'visible' });
    await page.locator('[data-testid="modern-map-theme"]').selectOption('high-contrast');
    await page.locator('[data-testid="modern-map-theme"]').selectOption('default');
    await page.setViewportSize({ width: 390, height: 800 });
    const stageTab = page.locator('[data-testid="mobile-tabs"] [role="tab"]', { hasText: '畫面' });
    if (await stageTab.count()) await stageTab.click();
    await page.locator('[data-testid="modern-host"]').waitFor({ state: 'visible' });
    const narrowOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    if (narrowOverflow) throw new Error('390px horizontal overflow');
    console.log('PASS 390 modern view no horizontal overflow');
    await page.setViewportSize({ width: 1280, height: 800 });
    if (pageErrors.length) throw new Error(`pageerror ${pageErrors.slice(0, 3).join(' | ')}`);
    if (skipHold) {
      console.log('SKIP 5 分鐘回放（--skip-hold）');
      return;
    }
    const remain = Math.max(0, totalMs - (Date.now() - started));
    console.log(`holding remaining ${Math.round(remain / 1000)}s`);
    while (Date.now() - started < totalMs) {
      if (pageErrors.length) throw new Error(`pageerror during hold: ${pageErrors.slice(0, 3).join(' | ')}`);
      await page.waitForTimeout(Math.min(15000, Math.max(0, totalMs - (Date.now() - started))));
    }
    console.log(`PASS 5min headless 0 pageerror (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    vite.kill('SIGTERM');
  }
}

const host = fairylandRoot();
if (!host) {
  console.error('找不到 fairyland 的區域清單，六張地圖的座標比對沒跑');
  process.exit(2);
}
const checked = checkHostMarkers(host);
console.log(`PASS host markers ${checked.maps} maps, omitted same-map portals ${checked.omittedSameMap}`);
const shots = writeThemeShots();
console.log(`PASS theme shots ${shots.map(f => path.basename(f)).join(' ')}`);
await holdReplay();
console.log('F13B_OVERLAY_OK');
