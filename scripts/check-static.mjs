/* 檢查靜態版 index.html 的注入是否正確（開發用診斷） */

import fs from 'node:fs/promises';

const html = await fs.readFile(process.argv[2] || 'dist/index.html', 'utf8');
const idx = html.indexOf('__TTR_STATIC__');
console.log(idx < 0 ? '（找不到 __TTR_STATIC__ 注入）' : html.slice(Math.max(0, idx - 160), idx + 340));
console.log('');
const body = html.match(/<body[^>]*>/);
console.log('body：', body ? body[0] : '（找不到）');
const css = html.match(/<link rel="stylesheet"[^>]*>/);
console.log('css ：', css ? css[0] : '（找不到）');
const js = html.match(/<script type="module"[^>]*><\/script>/);
console.log('js  ：', js ? js[0] : '（找不到）');
const banner = html.match(/<div class="static-banner">[^<]*<\/div>/);
console.log('橫幅：', banner ? banner[0] : '（找不到）');
