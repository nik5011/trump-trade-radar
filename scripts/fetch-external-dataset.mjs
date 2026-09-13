/* ============================================================================
   下載第三方已解析的 OGE 278-T 資料集（特朗普 2026 年申報）

   來源：GitHub HerringtonDarkholme/trump-portfolio-tracker
         README 說明為「3,642 disclosed transactions across 1,024 holdings」
         由 OGE Form 278-T 申報 PDF 解析而成。
   ⚠️ 這是第三方解析結果，不是 OGE 官方結構化資料；匯入後請以 OGE 正本核對。

   執行：node scripts/fetch-external-dataset.mjs
   ========================================================================== */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'data', 'external');
const REPO = 'HerringtonDarkholme/trump-portfolio-tracker';
const BRANCH = 'main';

const FILES = [
  { path: 'trump_278T.csv', out: 'trump_278T.csv' },
  { path: 'src/data/dataset.json', out: 'dataset.json' },
];

const UA = 'TrumpTradeRadar/1.0 (local research tool)';

await fs.mkdir(OUT_DIR, { recursive: true });

for (const f of FILES) {
  const url = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${f.path}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) {
    console.log(`✗ ${f.path} — HTTP ${res.status}`);
    continue;
  }
  const text = await res.text();
  await fs.writeFile(path.join(OUT_DIR, f.out), text, 'utf8');
  console.log(`✓ ${f.out}  ${(text.length / 1024).toFixed(0)} KB`);
}

/* --------------------------- 檢查 CSV 結構 --------------------------- */

const csvPath = path.join(OUT_DIR, 'trump_278T.csv');
let csv = '';
try {
  csv = await fs.readFile(csvPath, 'utf8');
} catch {
  console.log('沒有 CSV 可檢查');
  process.exit(0);
}

const lines = csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
console.log('\n=== trump_278T.csv ===');
console.log(`總行數：${lines.length}`);
console.log('\n欄位：');
console.log('  ' + lines[0]);
console.log('\n前 3 列：');
for (const l of lines.slice(1, 4)) console.log('  ' + l.slice(0, 240));

/* 簡易 CSV 解析（處理雙引號） */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const header = rows[0];
  return rows.slice(1).filter((r) => r.some((x) => x !== '')).map((r) => {
    const o = {};
    header.forEach((h, i) => { o[h] = (r[i] || '').trim(); });
    return o;
  });
}

const records = parseCsv(csv);
console.log(`\n解析後資料列：${records.length}`);
const cols = Object.keys(records[0] || {});
const uniq = (key) => new Set(records.map((r) => r[key])).size;
for (const key of cols) {
  const values = records.map((r) => r[key]).filter(Boolean);
  if (!values.length) continue;
  const distinct = uniq(key);
  const sample = [...new Set(values)].slice(0, 4).join(' | ').slice(0, 100);
  console.log(`  ${key.padEnd(22)} 相異值 ${String(distinct).padStart(6)}   範例：${sample}`);
}

const dates = records.map((r) => r.trade_date || r.date || r.transaction_date).filter(Boolean).sort();
if (dates.length) console.log(`\n日期範圍：${dates[0]} ~ ${dates[dates.length - 1]}`);

/* --------------------------- 檢查 JSON 結構 --------------------------- */

try {
  const json = JSON.parse(await fs.readFile(path.join(OUT_DIR, 'dataset.json'), 'utf8'));
  console.log('\n=== dataset.json ===');
  const topKeys = Object.keys(json);
  console.log(`最上層鍵：${topKeys.join(', ')}`);
  for (const k of topKeys) {
    if (Array.isArray(json[k])) {
      console.log(`  ${k}: 陣列，${json[k].length} 筆`);
      if (json[k][0]) {
        console.log(`    第一筆鍵：${Object.keys(json[k][0]).join(', ')}`);
        console.log(`    範例：${JSON.stringify(json[k][0]).slice(0, 300)}`);
      }
    } else if (typeof json[k] === 'object' && json[k]) {
      const keys = Object.keys(json[k]);
      console.log(`  ${k}: 物件，${keys.length} 個鍵（${keys.slice(0, 8).join(', ')}…）`);
    } else {
      console.log(`  ${k}: ${JSON.stringify(json[k]).slice(0, 80)}`);
    }
  }
} catch (err) {
  console.log(`\nJSON 檢查失敗：${err.message}`);
}
