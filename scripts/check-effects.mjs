import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS_PATH = path.join(ROOT, 'src/render/effects/scripts/sp129_split_and_core.json');
const EXAMPLES_PATH = path.join(ROOT, 'src/protocol/examples.json');

const scripts = JSON.parse(fs.readFileSync(SCRIPTS_PATH, 'utf8'));
if (!Array.isArray(scripts) || scripts.length === 0) {
  console.error('[check-effects] 腳本檔必須是非空陣列');
  process.exit(1);
}

const seenIds = new Set();
const bySkill = new Map();

for (const s of scripts) {
  if (!s.id || !s.label || typeof s.durationMs !== 'number' || s.durationMs <= 0) {
    console.error('[check-effects] 腳本格式缺漏必要欄位:', s);
    process.exit(1);
  }
  if (!s.frames && !s.particles && !s.hitFlash) {
    console.error('[check-effects] 腳本至少需有 frames / particles / hitFlash:', s.id);
    process.exit(1);
  }
  if (JSON.stringify(s).includes('data:image/')) {
    console.error('[check-effects] 禁止在特效腳本內嵌像素資料:', s.id);
    process.exit(1);
  }
  if (seenIds.has(s.id)) {
    console.error('[check-effects] 重複的特效腳本 ID:', s.id);
    process.exit(1);
  }
  seenIds.add(s.id);
  for (const sid of s.skillIds ?? []) {
    if (bySkill.has(sid)) {
      console.error('[check-effects] 技能 ID 對應到多個重複腳本:', sid);
      process.exit(1);
    }
    bySkill.set(sid, s.id);
  }
}

// 驗證原先共用 sp129 的 6 個技能（2261, 2262, 2263, 2293, 1021, 1023）皆有各自獨立腳本 ID
const previouslySharedSp129 = [2261, 2262, 2263, 2293, 1021, 1023];
const resolvedIds = new Set();
for (const sid of previouslySharedSp129) {
  const fxId = bySkill.get(sid);
  if (!fxId) {
    console.error(`[check-effects] 缺少原共用 sp129 技能 ${sid} 的獨立腳本`);
    process.exit(1);
  }
  if (resolvedIds.has(fxId)) {
    console.error(`[check-effects] 技能 ${sid} 仍與其他技能共用腳本 ID: ${fxId}`);
    process.exit(1);
  }
  resolvedIds.add(fxId);
}

// 驗證 protocol examples 裡列出的技能都有對應腳本可解析
const examples = JSON.parse(fs.readFileSync(EXAMPLES_PATH, 'utf8'));
for (const sk of examples?.staticData?.staticData?.skills ?? []) {
  const hasExplicit = bySkill.has(sk.id) || (sk.animId && scripts.some(s => (s.effectIds ?? []).includes(sk.animId)));
  if (!hasExplicit && !sk.animId) {
    console.error('[check-effects] examples 技能缺少對應特效或 animId:', sk);
    process.exit(1);
  }
}

console.log(
  `[check-effects] OK：共驗證 ${scripts.length} 支特效腳本，6 個原 sp129 共用技能皆各有獨立腳本。`,
);
