/* ============================================================================
   從 OGE 官方 API 取得特朗普本人的 278-T 申報清單，並下載 PDF 正本

   執行：
     node scripts/fetch-oge-filings.mjs             # 列出清單（不下載）
     node scripts/fetch-oge-filings.mjs --download  # 下載 278-T PDF 到 data/oge/
     node scripts/fetch-oge-filings.mjs --json      # 以 JSON 輸出清單
     node scripts/fetch-oge-filings.mjs --name=Trump, Ivanka
   ========================================================================== */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchOgeFilings, downloadFilingPdf, safeFileName } from '../providers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'data', 'oge');

const args = process.argv.slice(2);
const name = (args.find((a) => a.startsWith('--name=')) || '').split('=')[1] || 'Trump, Donald J';
const wantDownload = args.includes('--download');
const asJson = args.includes('--json');

const result = await fetchOgeFilings({ name });
const tx = result.filings.filter((f) => f.isTransactionReport);
const downloadable = tx.filter((f) => f.isPdf);

if (asJson) {
  console.log(JSON.stringify({ ...result, transactionReports: tx }, null, 2));
} else {
  console.log(`\nOGE 官方資料庫：${name}`);
  console.log('='.repeat(96));
  console.log(
    `資料庫共 ${result.recordsTotal} 筆；此人 ${result.filings.length} 筆，` +
      `其中 278-T 定期交易申報 ${tx.length} 筆（PDF 可直接下載 ${downloadable.length} 筆）\n`
  );
  for (const f of result.filings) {
    const tag = f.isTransactionReport ? '[278-T]' : '       ';
    const status = f.isPdf ? 'PDF 可下載' : f.needsRequest ? '需向 OGE 申請' : '—';
    console.log(`${tag} ${f.docDate}  ${f.type.slice(0, 44).padEnd(46)} ${status}`);
  }
}

if (wantDownload) {
  console.log(`\n下載 ${downloadable.length} 份 PDF 到 data/oge/`);
  console.log('='.repeat(96));
  const index = [];
  for (const f of downloadable) {
    const fileName = safeFileName(f.file);
    const dest = path.join(OUT_DIR, fileName);
    let cached = false;
    try {
      cached = (await fs.stat(dest)).size > 1000;
    } catch {
      cached = false;
    }
    const res = cached
      ? { ok: true, bytes: (await fs.stat(dest)).size }
      : await downloadFilingPdf(f.link, dest, { fs, path, timeoutMs: 180000 });
    console.log(
      `  ${res.ok ? '✓' : '✗'} ${f.docDate}  ${fileName}  ` +
        (res.ok ? `${(res.bytes / 1048576).toFixed(1)} MB${cached ? '（已存在）' : ''}` : res.error)
    );
    if (res.ok) {
      index.push({ ...f, localPath: path.relative(ROOT, dest).replace(/\\/g, '/'), bytes: res.bytes });
    }
  }
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, 'index.json'),
    JSON.stringify({ fetchedAt: new Date().toISOString(), name, files: index }, null, 2),
    'utf8'
  );
  console.log(`\n索引已寫入 data/oge/index.json（${index.length} 份）`);
} else if (!asJson) {
  console.log('\n加上 --download 即可下載 PDF 正本。');
  console.log('提示：這些 PDF 是掃描影像，交易明細需要 OCR 才能轉成表格（見 README）。');
}
console.log('');
