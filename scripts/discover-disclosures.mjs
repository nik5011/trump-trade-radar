/* ============================================================================
   申報資料來源探索工具
   用途：從第一手來源找出「總統交易申報」真正可抓取的入口，
        並用即時新聞確認目前有哪些實際的申報事件。
   執行：node scripts/discover-disclosures.mjs
   ========================================================================== */

const UA = 'TrumpTradeRadar/1.0 (local research tool)';

async function text(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, ...(opts.headers || {}) },
    signal: AbortSignal.timeout(25000),
  });
  return { status: res.status, ok: res.ok, body: await res.text() };
}

async function json(url, opts) {
  const { ok, status, body } = await text(url, opts);
  if (!ok) throw new Error(`HTTP ${status}`);
  return JSON.parse(body);
}

/* ---------- 1. 從 OGE 首頁找出所有跟揭露／278 有關的連結 ---------- */

async function findOgeLinks() {
  console.log('\n[1] OGE 官方網站可用入口');
  console.log('-'.repeat(78));
  const { ok, body } = await text('https://www.oge.gov/');
  if (!ok) {
    console.log('OGE 首頁無法取得');
    return [];
  }
  const hrefs = [...body.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  const uniq = [...new Set(hrefs)];
  const hit = uniq.filter((h) => /278|disclos|presiden|financial|report/i.test(h));
  for (const h of hit.slice(0, 40)) {
    const abs = h.startsWith('http') ? h : `https://www.oge.gov${h.startsWith('/') ? '' : '/'}${h}`;
    console.log(`  ${abs}`);
  }
  if (!hit.length) console.log('  （沒有找到明顯連結，網站可能以 JavaScript 載入）');
  return hit;
}

/* ---------- 2. Federal Register：官方 API 裡的 278-T 文件 ---------- */

async function federalRegister278T() {
  console.log('\n[2] Federal Register API 中的 278-T 文件');
  console.log('-'.repeat(78));
  const url =
    'https://www.federalregister.gov/api/v1/documents.json?per_page=20&order=newest' +
    '&conditions%5Bterm%5D=%22278-T%22' +
    '&fields%5B%5D=title&fields%5B%5D=publication_date&fields%5B%5D=html_url&fields%5B%5D=type&fields%5B%5D=agencies';
  const data = await json(url);
  console.log(`  符合文件數：${data.count}`);
  for (const r of data.results) {
    const agency = (r.agencies || []).map((a) => a.name).join(', ');
    console.log(`  ${r.publication_date}  [${r.type}] ${r.title}`);
    if (agency) console.log(`               機關：${agency}`);
    console.log(`               ${r.html_url}`);
  }
  return data;
}

/* ---------- 3. 即時新聞：目前有哪些「特朗普交易」的實際事件 ---------- */

async function newsFor(queries) {
  console.log('\n[3] 即時新聞快訊（Google News RSS）');
  console.log('-'.repeat(78));
  for (const q of queries) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
    try {
      const { body } = await text(url);
      const blocks = body.match(/<item[\s\S]*?<\/item>/g) || [];
      console.log(`\n  關鍵字：${q}（${blocks.length} 則）`);
      for (const b of blocks.slice(0, 6)) {
        const title = (b.match(/<title>([\s\S]*?)<\/title>/) || [, ''])[1].replace(/<!\[CDATA\[|\]\]>/g, '');
        const date = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [, ''])[1];
        const src = (b.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [, ''])[1];
        console.log(`   • ${title}`);
        console.log(`     ${src} · ${date}`);
      }
    } catch (err) {
      console.log(`  ${q}：失敗（${err.message}）`);
    }
  }
}

/* ---------- 4. 檢查其他可能的總統交易追蹤端點 ---------- */

async function probePortfolioTrackers() {
  console.log('\n[4] 其他總統／政治人物交易追蹤端點');
  console.log('-'.repeat(78));
  const candidates = [
    ['Quiver 政治人物交易頁', 'https://www.quiverquant.com/politicstrading/'],
    ['Quiver Trump 專頁', 'https://www.quiverquant.com/politician/Trump'],
    ['Unusual Whales 政治交易', 'https://unusualwhales.com/politics'],
    ['Capitol Trades 總統頁', 'https://www.capitoltrades.com/politicians'],
    ['OGE 搜尋（278-T）', 'https://www.oge.gov/web/oge.nsf/search?searchview&query=278-T'],
  ];
  for (const [name, url] of candidates) {
    try {
      const { status, ok, body } = await text(url);
      const mention = /trump/i.test(body) ? '頁面含 Trump 字樣' : '未見 Trump 字樣';
      console.log(`  ${ok ? '可  ' : '不可'} ${String(status).padEnd(4)} ${name} — ${ok ? `${body.length} bytes，${mention}` : ''}`);
    } catch (err) {
      console.log(`  不可      ${name} — ${err.message}`);
    }
  }
}

await findOgeLinks();
await federalRegister278T();
await newsFor([
  'Trump 278-T periodic transaction report',
  'Trump stock purchase disclosure',
  'Trump bought shares disclosed',
]);
await probePortfolioTrackers();
console.log('');
