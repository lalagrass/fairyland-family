#!/usr/bin/env node
/**
 * FL4: 缺漏檢查腳本（可放進公開 repo family）。
 * 依無圖規格 martial_artist_spec.json 檢查一套新外觀資源包缺少哪些圖層、動作、方向、幀數、特效、立繪、圖示或音效。
 *
 * 用法：
 *   node tools/wuxia_spec/check_appearance_spec.mjs <bundleDir> [--spec <path>] [--json] [--strict]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SPEC_PATH = path.join(__dirname, 'martial_artist_spec.json');

export function checkAppearanceBundle(bundleDir, spec, opts = {}) {
  const strict = Boolean(opts.strict);
  const missing = {
    manifest: [],
    layers: [],
    actions: [],
    effects: [],
    portraits: [],
    icons: [],
    sfx: [],
  };

  const manifestPath = path.join(bundleDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    missing.manifest.push('manifest.json');
    return { ok: false, bundleDir, totalMissing: 1, missing };
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const declaredLayers = new Set(
    Array.isArray(manifest.layers)
      ? manifest.layers.map(l => (typeof l === 'string' ? l : l.slot)).filter(Boolean)
      : Object.keys(manifest.frames || {}).map(k => k.toLowerCase()),
  );

  for (const layer of spec.equipmentLayerSlots || []) {
    if ((layer.required || strict) && !declaredLayers.has(layer.slot)) {
      missing.layers.push({ slot: layer.slot, required: Boolean(layer.required) });
    }
  }

  const actionsMap = manifest.actions || {};
  for (const act of spec.actions || []) {
    if (!act.required && !strict) continue;
    const actData = actionsMap[String(act.actionId)] ?? actionsMap[act.key];
    if (!actData || typeof actData !== 'object') {
      missing.actions.push({
        actionId: act.actionId,
        key: act.key,
        reason: 'MISSING_ACTION',
        expectedFrames: act.minFramesPerDirection,
      });
      continue;
    }
    const minFrames = Math.max(1, act.minFramesPerDirection || 1);
    for (let d = 0; d < (act.directions || 8); d++) {
      const dirEntry = actData[String(d)] ?? actData[spec.directions?.[d] || ''];
      const frames = Array.isArray(dirEntry?.frames) ? dirEntry.frames : [];
      if (frames.length < minFrames) {
        missing.actions.push({
          actionId: act.actionId,
          key: act.key,
          direction: d,
          reason: 'INSUFFICIENT_FRAMES',
          expected: minFrames,
          actual: frames.length,
        });
      }
    }
  }

  const effectsSet = new Set(Array.isArray(manifest.effects) ? manifest.effects : Object.keys(manifest.effectDefs || {}));
  for (const sk of spec.skills || []) {
    if (sk.effectKey && !effectsSet.has(sk.effectKey) && !missing.effects.includes(sk.effectKey)) {
      missing.effects.push(sk.effectKey);
    }
  }

  const portraitsSet = new Set(Object.keys(manifest.portraits || {}));
  for (const p of spec.portraitSlots || []) {
    if (!portraitsSet.has(p)) missing.portraits.push(p);
  }

  const iconsSet = new Set(Object.keys(manifest.icons || {}));
  for (const ic of spec.iconSlots || []) {
    if (!iconsSet.has(ic)) missing.icons.push(ic);
  }

  const sfxSet = new Set(Object.keys(manifest.sfx || {}));
  for (const s of spec.sfxSlots || []) {
    if (!sfxSet.has(s)) missing.sfx.push(s);
  }

  const totalMissing =
    missing.manifest.length +
    missing.layers.length +
    missing.actions.length +
    missing.effects.length +
    missing.portraits.length +
    missing.icons.length +
    missing.sfx.length;

  return { ok: totalMissing === 0, bundleDir, totalMissing, missing };
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.error('用法：node check_appearance_spec.mjs <bundleDir> [--spec <spec.json>] [--json] [--strict]');
    return 2;
  }
  const bundleDir = path.resolve(args[0]);
  const specIdx = args.indexOf('--spec');
  const specPath = specIdx >= 0 && args[specIdx + 1] ? path.resolve(args[specIdx + 1]) : DEFAULT_SPEC_PATH;
  const asJson = args.includes('--json');
  const strict = args.includes('--strict');

  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const report = checkAppearanceBundle(bundleDir, spec, { strict });

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.ok) {
    console.log(`✓ 外觀資源包完整（${bundleDir}）：無任何缺漏`);
  } else {
    console.log(`✗ 外觀資源包缺少 ${report.totalMissing} 項（${bundleDir}）：`);
    if (report.missing.manifest.length) console.log('  - manifest:', report.missing.manifest.join(', '));
    if (report.missing.layers.length) console.log('  - 圖層槽位:', report.missing.layers.map(l => l.slot).join(', '));
    if (report.missing.actions.length) console.log('  - 動作／幀數:', report.missing.actions.length, '項');
    if (report.missing.effects.length) console.log('  - 特效:', report.missing.effects.join(', '));
    if (report.missing.portraits.length) console.log('  - 立繪／頭像:', report.missing.portraits.join(', '));
    if (report.missing.icons.length) console.log('  - 圖示:', report.missing.icons.join(', '));
    if (report.missing.sfx.length) console.log('  - 音效:', report.missing.sfx.join(', '));
  }
  return report.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv));
}
