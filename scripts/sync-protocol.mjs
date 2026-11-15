#!/usr/bin/env node
/**
 * 把 fairyland 的外掛協定（packages/shared/src/protocol）原樣複製進 src/protocol/。
 *
 *   node scripts/sync-protocol.mjs           複製並在每個 .ts 檔頭寫入來源路徑與 fairyland commit
 *   node scripts/sync-protocol.mjs --check   只檢查是否同步；不同步就 exit 1。找不到 fairyland 時略過（exit 0）
 *
 * fairyland 的位置：環境變數 FL_FAIRYLAND_DIR，預設為與本 repo 並排的 ../fairyland。
 * 協定只有一份真相（fairyland 端）；這裡的副本不可手改。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fairyland = path.resolve(process.env.FL_FAIRYLAND_DIR || path.join(root, '..', 'fairyland'));
const srcRel = 'packages/shared/src/protocol';
const srcDir = path.join(fairyland, srcRel);
const dstDir = path.join(root, 'src', 'protocol');
const check = process.argv.includes('--check');
// P3：工作資料（材料、配方、採集點、工具、站點；每欄有來源標記）也由 fairyland 單一來源複製，附版本，外掛用來規劃佇列。
const dataSrc = path.join(fairyland, 'packages/shared/src/data/work_data.json');
const dataDst = path.join(root, 'src', 'data', 'work_data.json');
const MARK = '// [sync-protocol]';

if (!fs.existsSync(srcDir)) {
  console.log(`[sync-protocol] 找不到 ${srcDir}，略過${check ? '檢查' : '同步'}（沒有並排的 fairyland repo）。`);
  process.exit(0);
}

const git = (...a) => { try { return execFileSync('git', ['-C', fairyland, ...a], { encoding: 'utf8' }).trim(); } catch { return ''; } };
const commit = git('rev-parse', 'HEAD') || 'unknown';
const dirty = git('status', '--porcelain', '--', srcRel) ? '（來源有未提交修改）' : '';
const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.ts') || f === 'examples.json').sort();

const header = f => `${MARK} 自動產生，請勿手改；改協定請到 fairyland 修改後重新執行 npm run sync-protocol\n${MARK} 來源：fairyland/${srcRel}/${f} @ ${commit}${dirty}\n`;
const stripHeader = text => text.split('\n').filter(l => !l.startsWith(MARK)).join('\n');
const wanted = (f, text) => (f.endsWith('.ts') ? header(f) + text : text);

if (!check) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const f of fs.readdirSync(dstDir)) if (!files.includes(f) && (f.endsWith('.ts') || f === 'examples.json')) fs.rmSync(path.join(dstDir, f));
  for (const f of files) fs.writeFileSync(path.join(dstDir, f), wanted(f, fs.readFileSync(path.join(srcDir, f), 'utf8')));
  if (fs.existsSync(dataSrc)) { fs.mkdirSync(path.dirname(dataDst), { recursive: true }); fs.copyFileSync(dataSrc, dataDst); }
  console.log(`[sync-protocol] 已複製 ${files.length} 個檔案（含工作資料）@ ${commit.slice(0, 10)}${dirty}`);
  process.exit(0);
}

const problems = [];
for (const f of files) {
  const dst = path.join(dstDir, f);
  if (!fs.existsSync(dst)) { problems.push(`缺少 ${f}`); continue; }
  const have = fs.readFileSync(dst, 'utf8');
  const src = fs.readFileSync(path.join(srcDir, f), 'utf8');
  if (stripHeader(have) !== src) problems.push(`${f} 與 fairyland 不同`);
}
for (const f of fs.existsSync(dstDir) ? fs.readdirSync(dstDir) : []) {
  if ((f.endsWith('.ts') || f === 'examples.json') && !files.includes(f)) problems.push(`多出 ${f}（fairyland 已沒有）`);
}
if (fs.existsSync(dataSrc) && (!fs.existsSync(dataDst) || fs.readFileSync(dataDst, 'utf8') !== fs.readFileSync(dataSrc, 'utf8'))) problems.push('src/data/work_data.json 與 fairyland 不同');
if (problems.length) {
  console.error(`[sync-protocol] 協定副本已過期：\n  - ${problems.join('\n  - ')}\n請執行 npm run sync-protocol`);
  process.exit(1);
}
console.log(`[sync-protocol] 協定副本與 fairyland 一致（${files.length} 個檔案）。`);
