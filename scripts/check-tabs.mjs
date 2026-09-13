/* 檢查 index.html 的頁籤結構與 CSS 順序（開發用） */

import fs from 'node:fs/promises';

const html = await fs.readFile('public/index.html', 'utf8');
const css = await fs.readFile('public/styles.css', 'utf8');

const navStart = html.indexOf('<nav class="tabs"');
const navEnd = html.indexOf('</nav>', navStart);
console.log('--- nav 開頭 ---');
console.log(html.slice(navStart, navStart + 200));
console.log('--- nav 結尾 ---');
console.log(html.slice(navEnd - 120, navEnd + 6));
console.log('tab-row 包裹:', /<div class="tab-row">[\s\S]*<\/div>\s*<\/nav>/.test(html));
console.log('頁籤按鈕數:', (html.match(/class="tab[ "]/g) || []).length);

const baseSelect = css.indexOf('.tab-select {');
const media = css.indexOf('@media (max-width: 720px)');
const mobileSelect = css.indexOf('.tab-select { display: block');
console.log('\nCSS 順序：base .tab-select @', baseSelect, '／media @', media, '／手機 display:block @', mobileSelect);
console.log('順序正確（base 在 media 之前）:', baseSelect < media && media < mobileSelect);
console.log('base 是 display:none:', /\.tab-select \{\s*display: none/.test(css));
console.log('有 .tab-row 可橫向滑動:', /\.tab-row \{[^}]*overflow-x: auto/.test(css));
