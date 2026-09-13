/* ============================================================================
   來源連通性探測工具
   用途：在你自己的網路環境確認「哪些即時資料來源真的抓得到」，
        並看回傳的資料形狀（而不是只相信文件寫的）。

   執行：node scripts/check-sources.mjs
        node scripts/check-sources.mjs --json   （輸出 JSON，便於接監控）
   ========================================================================== */

const UA = 'TrumpTradeRadar/1.0 (local research tool)';

const TARGETS = [
  {
    id: 'oge-presidential',
    name: 'OGE 總統財務揭露頁（第一手來源）',
    url: "https://www.oge.gov/web/oge.nsf/Officials%27%20Financial%20Disclosures",
    expect: 'html',
    note: '總統 278-T 定期交易申報的官方公布處；若這裡抓得到，理論上可寫爬蟲。',
  },
  {
    id: 'oge-root',
    name: 'OGE 首頁（檢查站台是否可達）',
    url: 'https://www.oge.gov/',
    expect: 'html',
  },
  {
    id: 'fr-278t',
    name: 'Federal Register API：搜尋 278-T',
    url: 'https://www.federalregister.gov/api/v1/documents.json?per_page=3&order=newest&conditions%5Bterm%5D=%22278-T%22&fields%5B%5D=title&fields%5B%5D=publication_date&fields%5B%5D=html_url',
    expect: 'json',
    note: '免費官方 API，無需金鑰。',
  },
  {
    id: 'fr-trump-disclosure',
    name: 'Federal Register API：搜尋 Trump financial disclosure',
    url: 'https://www.federalregister.gov/api/v1/documents.json?per_page=3&order=newest&conditions%5Bterm%5D=Trump%20financial%20disclosure&fields%5B%5D=title&fields%5B%5D=publication_date&fields%5B%5D=html_url',
    expect: 'json',
  },
  {
    id: 'capitol-trades-bff',
    name: 'Capitol Trades 內部 API（國會議員交易）',
    url: 'https://bff.capitoltrades.com/trades?page=1&pageSize=5',
    expect: 'json',
    note: '非官方端點。注意：Capitol Trades 追蹤的是國會議員，總統不在其中。',
  },
  {
    id: 'house-stock-watcher',
    name: 'House Stock Watcher 公開資料集（S3，免費）',
    url: 'https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json',
    expect: 'json',
    note: '眾議員交易全量 JSON；可作為「其他人怎麼買」的交叉驗證來源。',
  },
  {
    id: 'senate-efd',
    name: '參議院 eFD 電子申報',
    url: 'https://efdsearch.senate.gov/search/',
    expect: 'html',
    note: '需要表單查詢與驗證碼流程，自動化難度高。',
  },
  {
    id: 'quiver-home',
    name: 'Quiver Quantitative（政治人物交易整理站）',
    url: 'https://www.quiverquant.com/',
    expect: 'html',
    note: '有 API 但需訂閱金鑰；網頁本身可作為人工核對來源。',
  },
  {
    id: 'yahoo-chart',
    name: 'Yahoo Finance Chart API（即時/延遲價格）',
    url: 'https://query1.finance.yahoo.com/v8/finance/chart/NVDA?range=5d&interval=1d',
    expect: 'json',
  },
  {
    id: 'stooq',
    name: 'Stooq 收盤價 CSV',
    url: 'https://stooq.com/q/d/l/?s=nvda.us&i=d',
    expect: 'csv',
  },
  {
    id: 'google-news',
    name: 'Google News RSS（即時新聞快訊）',
    url: 'https://news.google.com/rss/search?q=Trump%20stock%20purchase&hl=en-US&gl=US&ceid=US:en',
    expect: 'xml',
  },
  {
    id: 'usaspending',
    name: 'USAspending.gov API（政府採購）',
    url: 'https://api.usaspending.gov/api/v2/references/toptier_agencies/',
    expect: 'json',
  },
];

async function probe(target) {
  const started = Date.now();
  try {
    const res = await fetch(target.url, {
      headers: { 'User-Agent': UA, Accept: '*/*' },
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    const contentType = res.headers.get('content-type') || '';
    return {
      id: target.id,
      name: target.name,
      url: target.url,
      status: res.status,
      ok: res.ok,
      contentType,
      bytes: text.length,
      ms: Date.now() - started,
      note: target.note || '',
      preview: text.replace(/\s+/g, ' ').slice(0, 160),
    };
  } catch (err) {
    return {
      id: target.id,
      name: target.name,
      url: target.url,
      status: 0,
      ok: false,
      error: err.message,
      ms: Date.now() - started,
      note: target.note || '',
    };
  }
}

const results = [];
for (const target of TARGETS) {
  results.push(await probe(target));
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log('\n來源連通性探測結果\n' + '='.repeat(78));
  for (const r of results) {
    const flag = r.ok ? '可  ' : '不可';
    console.log(`${flag} ${String(r.status).padEnd(4)} ${String(r.ms).padStart(6)}ms  ${r.name}`);
    console.log(`      ${r.url}`);
    if (r.ok) {
      console.log(`      type=${r.contentType} bytes=${r.bytes}`);
      console.log(`      preview: ${r.preview}`);
    } else {
      console.log(`      error: ${r.error || 'HTTP ' + r.status}`);
    }
    if (r.note) console.log(`      備註: ${r.note}`);
    console.log('');
  }
  const okCount = results.filter((r) => r.ok).length;
  console.log(`${okCount}/${results.length} 個來源可連線`);
}
