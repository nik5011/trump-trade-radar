/* ============================================================================
   把整個網站輸出成「純靜態」版本，可放到免費空間（GitHub Pages / Netlify /
   Cloudflare Pages…），手機開瀏覽器就能看。

   原理：這個 App 的畫面資料都來自 /api/*，只要把每個端點的回應先抓下來存成
   JSON，前端就完全不需要後端。資料新鮮度＝最後一次執行本腳本的時間。

   用法：
     1) 先啟動本機伺服器：node server.mjs
     2) node scripts/build-static.mjs            # 輸出到 dist/
        node scripts/build-static.mjs --out docs # 指定輸出目錄
   ========================================================================== */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const OUT = path.resolve(ROOT, outArg >= 0 ? args[outArg + 1] : 'dist');
const BASE = (() => {
  const i = args.indexOf('--base');
  return i >= 0 ? args[i + 1] : '';
})();
const PORT = (() => {
  const i = args.indexOf('--port');
  return i >= 0 ? args[i + 1] : '8787';
})();

const ENDPOINTS = [
  ['state', '/api/state'],
  ['market', '/api/market'],
  ['providers', '/api/providers'],
  ['news', '/api/news'],
  ['policy', '/api/policy'],
  ['contracts', '/api/contracts'],
  ['oge', '/api/oge'],
  ['policy-map', '/api/policy-map'],
  ['events', '/api/events?days=30'],
  ['insiders', '/api/insiders?days=120'],
  ['regime', '/api/regime'],
  ['desk', '/api/desk'],
  ['probability', '/api/probability?horizon=20'],
  ['positions', '/api/positions'],
  ['analysis', '/api/analysis?topN=8'],
];

async function main() {
  await fs.mkdir(path.join(OUT, 'data'), { recursive: true });

  /* 1. 複製前端靜態檔（app.js 會 import 引擎，所以引擎也要一起帶）
        引擎在靜態版改名成 engine.js：部分免費空間對 .mjs 會回錯的 MIME 類型，
        瀏覽器就會拒載 ES module。 */
  await fs.copyFile(path.join(ROOT, 'public', 'styles.css'), path.join(OUT, 'styles.css'));
  const appSource = await fs.readFile(path.join(ROOT, 'public', 'app.js'), 'utf8');
  await fs.writeFile(
    path.join(OUT, 'app.js'),
    appSource.replace("from './engine.mjs'", "from './engine.js'"),
    'utf8'
  );
  await fs.copyFile(path.join(ROOT, 'engine.mjs'), path.join(OUT, 'engine.js'));
  /* 版本雜湊：GitHub Pages 等空間會快取靜態檔，沒有這個會看到舊版程式 */
  const assetHash = crypto
    .createHash('sha1')
    .update(await fs.readFile(path.join(OUT, 'app.js')))
    .update(await fs.readFile(path.join(OUT, 'engine.js')))
    .update(await fs.readFile(path.join(OUT, 'styles.css')))
    .digest('hex')
    .slice(0, 8);

  /* 2. 抓取所有 API 回應 */
  const manifest = { builtAt: new Date().toISOString(), endpoints: [], failed: [] };
  for (const [name, url] of ENDPOINTS) {
    try {
      const res = await fetch(`http://localhost:${PORT}${url}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      await fs.writeFile(path.join(OUT, 'data', `${name}.json`), JSON.stringify(json), 'utf8');
      manifest.endpoints.push({ name, url, bytes: JSON.stringify(json).length });
      process.stdout.write(`  ✓ ${name.padEnd(12)} ${url}\n`);
    } catch (err) {
      manifest.failed.push({ name, url, error: err.message });
      /* 失敗的端點仍寫一個空物件，避免前端 fetch 失敗整個頁面掛掉 */
      await fs.writeFile(path.join(OUT, 'data', `${name}.json`), JSON.stringify({ ok: false, reason: `靜態建置時取得失敗：${err.message}` }), 'utf8');
      process.stdout.write(`  ✗ ${name.padEnd(12)} ${url} — ${err.message}\n`);
    }
  }

  /* 3. 產生靜態版 index.html：注入 fetch 攔截器 + 快照提示 */
  const html = await fs.readFile(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const builtAt = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Shanghai' });
  /* app.js 透過 window.__TTR_STATIC__ 判斷要走靜態資料檔，不需要攔截 fetch */
  const shim = `
    <script>
      window.__TTR_STATIC__ = {
        builtAt: ${JSON.stringify(builtAt)},
        dataBase: ${JSON.stringify(`${BASE}data/`)},
        apiBase: ${JSON.stringify(`${BASE}api/`)}
      };
    </script>`;
  const injection = `<div class="static-banner">靜態快照版本 · 資料時間 ${builtAt} · 同步與匯入功能請在本機執行</div>\n${shim}\n`;
  const outHtml = html
    .replace('<link rel="stylesheet" href="/styles.css" />', `<link rel="stylesheet" href="${BASE}styles.css?v=${assetHash}" />`)
    .replace('<script type="module" src="/app.js"></script>', `${injection}<script type="module" src="${BASE}app.js?v=${assetHash}"></script>`)
    .replace('<body>', '<body class="static-mode">');
  await fs.writeFile(path.join(OUT, 'index.html'), outHtml, 'utf8');

  /* 4. GitHub Pages 需要 .nojekyll，否則底線開頭的檔案會被忽略 */
  await fs.writeFile(path.join(OUT, '.nojekyll'), '', 'utf8');
  await fs.writeFile(path.join(OUT, 'build-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const total = manifest.endpoints.reduce((a, e) => a + e.bytes, 0);
  console.log('');
  console.log(`靜態版已輸出到 ${path.relative(ROOT, OUT)}/`);
  console.log(`  端點 ${manifest.endpoints.length} 個成功、${manifest.failed.length} 個失敗，資料量約 ${(total / 1048576).toFixed(1)} MB`);
  console.log('  本機預覽：node scripts/serve-static.mjs --dir ' + path.relative(ROOT, OUT));
  if (manifest.failed.length) {
    console.log('  失敗清單：');
    for (const f of manifest.failed) console.log(`    - ${f.name}: ${f.error}`);
  }
}

await main();
