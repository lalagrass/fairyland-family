import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.vite']);
// 公開領域美術參考圖明確放於 art/references/public_domain/；其餘任何位置禁止放圖片／音訊／原版封裝檔。
const ALLOWED_PUBLIC_DOMAIN_PREFIX = 'art/references/public_domain/';
const FORBIDDEN_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico', '.tga',
  '.lpq', '.adf', '.wav', '.mp3', '.ogg', '.flac', '.aac',
]);
const DATA_URI_RE = /data:(image|audio|application\/octet-stream)\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]{128,}/;

const violations = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    const rel = path.relative(ROOT, full).replace(/\\/g, '/');
    const ext = path.extname(entry.name).toLowerCase();
    if (FORBIDDEN_EXTS.has(ext)) {
      if (!rel.startsWith(ALLOWED_PUBLIC_DOMAIN_PREFIX)) {
        violations.push(`禁止的原版或二進位素材檔：${rel}`);
      }
      continue;
    }
    if (/\.(ts|tsx|js|mjs|json|css|html)$/i.test(entry.name)) {
      const text = fs.readFileSync(full, 'utf8');
      if (DATA_URI_RE.test(text)) {
        violations.push(`禁止內嵌大型二進位 data URI：${rel}`);
      }
    }
  }
}

walk(ROOT);

if (violations.length > 0) {
  console.error('[check-no-original-assets] 檢查失敗：');
  for (const v of violations) console.error('  -', v);
  process.exit(1);
}

console.log('[check-no-original-assets] OK：repo 內無原版圖檔或二進位素材。');
