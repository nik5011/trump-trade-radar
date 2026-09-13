/* ============================================================================
   外部資料來源介接層（零依賴，只用原生 fetch）

   現實限制先講清楚：
   ・特朗普的「股票交易」本身沒有即時資料。美國總統依《政府倫理法》以
     OGE Form 278-T 申報，法定期限是交易後 30 天內，公開時間又再晚幾天。
     因此「成交 → 你看到」的實際落差通常是 1~6 週，任何 API 都無法突破。
   ・真正能做到接近即時的是三種替代訊號：
       1) 市價（延遲 15 分鐘 ~ 收盤）
       2) 新聞／政策文件（發布即取得）
       3) 政府採購與合約公告（公布即取得）
   本檔把這三條線都做成 provider，並提供通用端點介接給申報資料用。
   ========================================================================== */

const UA = 'TrumpTradeRadar/1.0 (local research tool; contact: local-user)';

export const PROVIDERS_INFO = {
  prices: [
    {
      id: 'yahoo',
      name: 'Yahoo Finance Chart API',
      kind: '即時/延遲市價',
      latency: '通常延遲 15 分鐘（盤中）或收盤價',
      needKey: false,
      note: '非官方端點、免費、無需金鑰；會擋部分來源 IP，失敗時自動改用 Stooq。',
    },
    {
      id: 'stooq',
      name: 'Stooq 歷史與收盤價 CSV',
      kind: '收盤價',
      latency: '收盤後（EOD）',
      needKey: false,
      note: '免費、穩定、無金鑰，適合日線回測；盤中即時性不如 Yahoo。',
    },
    {
      id: 'finnhub',
      name: 'Finnhub / Polygon / Twelve Data 等商用 API',
      kind: '即時報價',
      latency: '即時（依方案）',
      needKey: true,
      note: '需在 data/config.json 或環境變數填入金鑰；若你已有訂閱，這是最穩的即時來源。',
    },
    {
      id: 'synthetic',
      name: '內建模擬價格',
      kind: '無外部連線',
      latency: '—',
      needKey: false,
      note: '離線可用的可重現序列，僅供流程驗證。',
    },
  ],
  disclosures: [
    {
      id: 'oge-api',
      name: 'OGE 官方揭露資料庫 API（第一手，已實測可用）',
      latency: '交易後 30 天內申報；實測公開延遲約 6~20 天',
      needKey: false,
      note:
        'OGE 官網搜尋頁背後就是這個 JSON 介面（API.xsp/v2/rest）。可即時列出總統的每一筆 278-T 申報與 PDF 連結，' +
        '是目前「法規允許範圍內最快的」取得管道。限制：PDF 為掃描影像，交易明細需要 OCR 才能轉成表格。',
    },
    {
      id: 'endpoint',
      name: '通用 JSON 端點介接',
      latency: '依你的來源',
      needKey: false,
      note: '把 Quiver Quantitative、Unusual Whales、Capitol Trades 或你自建爬蟲的 JSON 端點貼進來，系統自動找欄位並正規化。',
    },
  ],
  context: [
    {
      id: 'news',
      name: 'Google News RSS 關鍵字快訊',
      latency: '發布後數分鐘',
      needKey: false,
      note: '最快的「特朗普買了什麼」風聲來源，但屬新聞層級，需要人工核對申報正本。',
    },
    {
      id: 'federalregister',
      name: 'Federal Register API（行政命令／關稅／法規）',
      latency: '公告即取得（公開預覽可提早一天）',
      needKey: false,
      note: '免費官方 API，適合追蹤會直接影響個股的政策事件。',
    },
    {
      id: 'usaspending',
      name: 'USAspending.gov API（政府採購合約）',
      latency: '公布即取得',
      needKey: false,
      note: '免費官方 API。對國防、工業類標的（LMT／RTX／GD）是真正的即時基本面訊號。',
    },
  ],
};

/* ---------------------------------------------------------------------------
   基礎 HTTP 工具
   ------------------------------------------------------------------------- */

function signalWithTimeout(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

async function request(url, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const res = await fetchImpl(url, {
    method: opts.method || 'GET',
    headers: {
      'User-Agent': UA,
      Accept: opts.accept || 'application/json,text/csv,text/xml,*/*',
      ...(opts.headers || {}),
    },
    body: opts.body,
    signal: signalWithTimeout(opts.timeoutMs || 15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return opts.raw ? res : opts.text ? res.text() : res.json();
}

export function decodeEntities(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/* ---------------------------------------------------------------------------
   1. 市價 provider
   ------------------------------------------------------------------------- */

export async function fetchPricesYahoo(tickers, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const range = opts.range || '2y';
  const series = {};
  const errors = [];
  const concurrency = opts.concurrency || 4;
  const queue = [...tickers];

  async function worker() {
    while (queue.length) {
      const ticker = queue.shift();
      try {
        const url =
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
          `?range=${range}&interval=1d&includePrePost=false`;
        const json = await request(url, { fetchImpl, timeoutMs: opts.timeoutMs });
        const points = parseYahooChart(json);
        if (!points.length) throw new Error('回傳沒有價格資料');
        series[ticker] = points;
      } catch (err) {
        errors.push({ ticker, error: err.message });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tickers.length) }, worker));

  if (!Object.keys(series).length) {
    throw new Error(`Yahoo 未取得任何價格：${errors[0] ? errors[0].error : '未知錯誤'}`);
  }
  return { provider: 'yahoo', granularity: '1d', series, errors };
}

export function parseYahooChart(json) {
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result || !result.timestamp) return [];
  const quote = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const adj = result.indicators && result.indicators.adjclose && result.indicators.adjclose[0];
  const closes = (adj && adj.adjclose) || quote.close || [];
  const volumes = quote.volume || [];
  const out = [];
  for (let i = 0; i < result.timestamp.length; i++) {
    const c = closes[i];
    if (c === null || c === undefined || Number.isNaN(c)) continue;
    const v = volumes[i];
    out.push({
      date: new Date(result.timestamp[i] * 1000).toISOString().slice(0, 10),
      close: Math.round(c * 100) / 100,
      ...(Number.isFinite(v) ? { volume: Math.round(v) } : {}),
    });
  }
  return out;
}

/* Stooq：免費收盤價 CSV，無需金鑰 */
export function stooqSymbol(ticker) {
  const t = ticker.toLowerCase();
  if (t.startsWith('^')) return t.slice(1);
  return `${t.replace(/\./g, '-')}.us`;
}

export async function fetchPricesStooq(tickers, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const series = {};
  const errors = [];
  for (const ticker of tickers) {
    try {
      const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSymbol(ticker))}&i=d`;
      const csv = await request(url, { fetchImpl, text: true, timeoutMs: opts.timeoutMs });
      const points = parseStooqCsv(csv);
      if (!points.length) throw new Error('CSV 沒有資料列');
      series[ticker] = points;
    } catch (err) {
      errors.push({ ticker, error: err.message });
    }
  }
  if (!Object.keys(series).length) {
    throw new Error(`Stooq 未取得任何價格：${errors[0] ? errors[0].error : '未知錯誤'}`);
  }
  return { provider: 'stooq', granularity: '1d', series, errors };
}

export function parseStooqCsv(csv) {
  const lines = String(csv).trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const di = header.indexOf('date');
  const ci = header.indexOf('close');
  const vi = header.indexOf('volume');
  if (di < 0 || ci < 0) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    const d = (cells[di] || '').trim();
    const c = Number(cells[ci]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(c)) continue;
    const v = vi >= 0 ? Number(cells[vi]) : NaN;
    out.push({ date: d, close: Math.round(c * 100) / 100, ...(Number.isFinite(v) ? { volume: Math.round(v) } : {}) });
  }
  return out;
}

/* 由 series 建立等權指數（首日 = 100） */
export function buildEqualWeightBenchmark(series) {
  const tickers = Object.keys(series).filter((t) => series[t] && series[t].length);
  if (!tickers.length) return [];
  const dates = series[tickers[0]].map((p) => p.date);
  const base = {};
  for (const t of tickers) base[t] = series[t][0].close;
  const out = [];
  for (let i = 0; i < dates.length; i++) {
    let sum = 0;
    let n = 0;
    for (const t of tickers) {
      const p = series[t][i];
      if (!p || !base[t]) continue;
      sum += p.close / base[t];
      n++;
    }
    if (n) out.push({ date: dates[i], close: Math.round((sum / n) * 10000) / 100 });
  }
  return out;
}

export async function fetchLivePrices(tickers, opts = {}) {
  const order = opts.provider ? [opts.provider] : ['yahoo', 'stooq'];
  const attempts = [];
  for (const provider of order) {
    try {
      const result =
        provider === 'yahoo'
          ? await fetchPricesYahoo(tickers, opts)
          : provider === 'stooq'
            ? await fetchPricesStooq(tickers, opts)
            : (() => { throw new Error(`不支援的 provider：${provider}`); })();
      return {
        ...result,
        benchmark: buildEqualWeightBenchmark(result.series),
        fetchedAt: new Date().toISOString(),
        attempts,
      };
    } catch (err) {
      attempts.push({ provider, error: err.message });
    }
  }
  const err = new Error(
    `所有價格來源都失敗（${attempts.map((a) => `${a.provider}: ${a.error}`).join('；')}）。` +
      '若你的環境無法連外，請使用內建模擬價格。'
  );
  err.attempts = attempts;
  throw err;
}

/* ---------------------------------------------------------------------------
   2. 新聞快訊（Google News RSS，免費、無需金鑰）
   ------------------------------------------------------------------------- */

export function googleNewsUrl(query, locale = 'en-US') {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${locale === 'zh-TW' ? 'zh-TW' : 'en-US'}&gl=US&ceid=US:en`;
}

export async function fetchNewsFeed(opts = {}) {
  const query = opts.query || 'Trump stock purchase disclosure';
  const fetchImpl = opts.fetchImpl || fetch;
  const xml = await request(googleNewsUrl(query, opts.locale), { fetchImpl, text: true, timeoutMs: opts.timeoutMs });
  const items = parseRSS(xml).slice(0, opts.limit || 40);
  if (!items.length) throw new Error('RSS 沒有回傳任何新聞項目');
  return { query, items, fetchedAt: new Date().toISOString(), provider: 'google-news-rss' };
}

export function parseRSS(xml) {
  const items = [];
  const blocks = String(xml).match(/<item[\s>][\s\S]*?<\/item>/g) || [];
  for (const block of blocks) {
    const pick = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      return m ? decodeEntities(m[1]) : '';
    };
    const link = (block.match(/<link>([\s\S]*?)<\/link>/i) || [, ''])[1].trim();
    const source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/i) || [, ''])[1];
    const title = pick('title');
    if (!title) continue;
    items.push({
      title,
      link: decodeEntities(link),
      publishedAt: pick('pubDate') ? new Date(pick('pubDate')).toISOString() : null,
      source: decodeEntities(source),
      summary: pick('description').slice(0, 300),
    });
  }
  return items;
}

/* ---------------------------------------------------------------------------
   3. 政策文件（Federal Register 官方 API，免費）
   ------------------------------------------------------------------------- */

export function federalRegisterUrl(term, perPage = 20, opts = {}) {
  const fields = ['title', 'publication_date', 'html_url', 'type', 'agencies', 'abstract', 'effective_on', 'comments_close_on']
    .map((f) => `fields%5B%5D=${f}`)
    .join('&');
  const range = [
    opts.from ? `&conditions%5Bpublication_date%5D%5Bgte%5D=${opts.from}` : '',
    opts.to ? `&conditions%5Bpublication_date%5D%5Blte%5D=${opts.to}` : '',
  ].join('');
  const types = (opts.types || []).map((t) => `&conditions%5Btype%5D%5B%5D=${t}`).join('');
  const effRange = [
    opts.effectiveFrom ? `&conditions%5Beffective_date%5D%5Bgte%5D=${opts.effectiveFrom}` : '',
    opts.effectiveTo ? `&conditions%5Beffective_date%5D%5Blte%5D=${opts.effectiveTo}` : '',
  ].join('');
  return (
    `https://www.federalregister.gov/api/v1/documents.json?per_page=${perPage}` +
    `&order=${opts.order || 'newest'}&conditions%5Bterm%5D=${encodeURIComponent(term)}${range}${effRange}${types}&${fields}`
  );
}

export async function fetchPolicyDocs(opts = {}) {
  const term = opts.term || 'tariff';
  const fetchImpl = opts.fetchImpl || fetch;
  const json = await request(
    federalRegisterUrl(term, opts.limit || 20, {
      from: opts.from,
      to: opts.to,
      order: opts.order,
      types: opts.types,
      effectiveFrom: opts.effectiveFrom,
      effectiveTo: opts.effectiveTo,
    }),
    { fetchImpl, timeoutMs: opts.timeoutMs }
  );
  const results = (json && json.results) || [];
  const items = results.map((r) => ({
    title: r.title,
    link: r.html_url,
    publishedAt: r.publication_date ? new Date(`${r.publication_date}T00:00:00Z`).toISOString() : null,
    effectiveOn: r.effective_on || null,
    commentsCloseOn: r.comments_close_on || null,
    type: r.type,
    agencies: (r.agencies || []).map((a) => a.name).join('、'),
    abstract: r.abstract || '',
  }));
  if (!items.length) throw new Error('Federal Register 沒有回傳文件');
  return { term, items, fetchedAt: new Date().toISOString(), provider: 'federal-register' };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* Federal Register 的全文搜尋只保證「文件提到關鍵字」，常撈到不相關的公告
   （例如「國家農業日」公告被算成電動車政策）。
   規則：
   1. 關鍵字出現在「標題」→ 直接採用（標題命中通常就是該政策本身）。
   2. 只出現在「摘要」→ 僅接受夠特定的關鍵字（含空白或長度 ≥ 9），
      避免 drug／oil／bank／electric 這類通用詞誤中（"electric" 會中 "electrical"）。 */
export function isRelevantPolicyDoc(doc, keywords) {
  const title = String(doc.title || '').toLowerCase();
  const abstract = String(doc.abstract || '').toLowerCase();
  /* 允許複數形（tariff → tariffs、semiconductor → semiconductors），
     但不用前綴比對，否則 electric 會誤中 electrical。 */
  const hit = (text, key) => new RegExp(`\\b${escapeRe(key)}(?:s|es)?\\b`).test(text);

  if (keywords.some((k) => hit(title, k.toLowerCase()))) return true;
  return keywords.some((k) => {
    const key = k.toLowerCase();
    return (key.includes(' ') || key.length >= 9) && hit(abstract, key);
  });
}

/* 依時間區間分批抓取，讓文件涵蓋整段交易期間（只取最新幾筆會漏掉較早的月份） */
export function quarterWindows(fromISO, toISO) {
  const windows = [];
  const start = new Date(`${fromISO}T00:00:00Z`);
  const end = new Date(`${toISO}T00:00:00Z`);
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), Math.floor(start.getUTCMonth() / 3) * 3, 1));
  const iso = (d) => d.toISOString().slice(0, 10);
  while (cursor <= end) {
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 3, 0));
    windows.push({
      from: iso(cursor < start ? start : cursor),
      to: iso(next > end ? end : next),
    });
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 3, 1));
  }
  return windows;
}

/* ---------------------------------------------------------------------------
   未來事件：政策生效日（Federal Register）＋ 財報日（Nasdaq 日曆）
   ------------------------------------------------------------------------- */

export async function fetchUpcomingPolicyEvents(opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const from = opts.from;
  const to = opts.to;
  const themes = opts.themes || [];
  const items = [];
  const seen = new Set();
  for (const theme of themes) {
    try {
      const docs = await fetchPolicyDocs({
        term: theme.keywords[0],
        limit: opts.limit || 20,
        from: opts.publishedFrom,
        to: opts.publishedTo,
        effectiveFrom: from,
        effectiveTo: to,
        types: ['PRESDOCU', 'RULE', 'PRORULE'],
        fetchImpl,
      });
      for (const d of docs.items) {
        /* 只保留與該主題真正相關的文件（標題命中，或夠特定的摘要字詞） */
        if (!isRelevantPolicyDoc(d, theme.keywords)) continue;
        const eff = d.effectiveOn || d.commentsCloseOn;
        if (!eff) continue;
        if (eff < from || eff > to) continue;
        const key = `${d.link}|${d.effectiveOn || ''}|${d.commentsCloseOn || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
          themeId: theme.id,
          themeName: theme.name,
          axis: theme.axis,
          tickers: Object.keys(theme.exposed || {}).slice(0, 14),
          title: d.title,
          link: d.link,
          type: d.type,
          agencies: d.agencies,
          publishedAt: d.publishedAt ? d.publishedAt.slice(0, 10) : null,
          effectiveOn: d.effectiveOn,
          commentsCloseOn: d.commentsCloseOn,
        });
      }
    } catch {
      /* 單一主題失敗不影響其他主題 */
    }
  }
  return { items, fetchedAt: new Date().toISOString(), from, to };
}

export function nextBusinessDays(fromISO, count) {
  const out = [];
  const d = new Date(`${fromISO}T00:00:00Z`);
  while (out.length < count) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/* Nasdaq 財報日曆（公開端點，無需金鑰） */
export async function fetchEarningsCalendar(opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const url = `https://api.nasdaq.com/api/calendar/earnings?date=${opts.date}`;
  const res = await fetchImpl(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: signalWithTimeout(opts.timeoutMs || 20000),
  });
  if (!res.ok) throw new Error(`Nasdaq HTTP ${res.status}`);
  const json = await res.json();
  const rows = (json && json.data && json.data.rows) || [];
  return rows.map((r) => ({
    date: opts.date,
    ticker: String(r.symbol || '').toUpperCase(),
    name: r.name || '',
    session: /pre/i.test(r.time || '') ? '盤前' : /after/i.test(r.time || '') ? '盤後' : '未提供',
    epsForecast: r.epsForecast || '',
    marketCap: r.marketCap || '',
  }));
}

export async function fetchEarningsRange(opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const days = opts.days || nextBusinessDays(opts.from, opts.count || 30);
  const wanted = opts.tickers ? new Set(opts.tickers) : null;
  const out = [];
  const queue = [...days];
  const errors = [];
  const worker = async () => {
    while (queue.length) {
      const date = queue.shift();
      try {
        const rows = await fetchEarningsCalendar({ date, fetchImpl });
        for (const r of rows) {
          if (wanted && !wanted.has(r.ticker)) continue;
          out.push(r);
        }
      } catch (err) {
        errors.push({ date, error: err.message });
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { items: out, fetchedAt: new Date().toISOString(), errors };
}

/* ---------------------------------------------------------------------------
   SEC EDGAR：Form 4 內部人交易（免費，無需金鑰）

   SEC 的公平使用政策要求：① 帶可識別的 User-Agent（含聯絡方式）
   ② 每秒不要超過 10 次請求。這裡用全域節流確保不超過 8 次/秒。
   ------------------------------------------------------------------------- */

const SEC_UA =
  process.env.TTR_SEC_UA || 'TrumpTradeRadar/1.0 (personal research tool; contact: set-your-email@example.com)';

let secLastRequest = 0;
const SEC_MIN_INTERVAL_MS = 125; /* 8 次/秒 */

async function secFetch(url, opts = {}) {
  const wait = SEC_MIN_INTERVAL_MS - (Date.now() - secLastRequest);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  secLastRequest = Date.now();
  const res = await fetch(url, {
    headers: {
      'User-Agent': SEC_UA,
      'Accept-Encoding': 'gzip, deflate',
      Accept: opts.accept || 'application/json',
      ...(opts.headers || {}),
    },
    signal: signalWithTimeout(opts.timeoutMs || 25000),
  });
  if (!res.ok) throw new Error(`SEC HTTP ${res.status} — ${url}`);
  return res;
}

export async function fetchCikMap(opts = {}) {
  const res = await secFetch('https://www.sec.gov/files/company_tickers.json', opts);
  const json = await res.json();
  const map = {};
  for (const key of Object.keys(json)) {
    const row = json[key];
    if (row && row.ticker) map[String(row.ticker).toUpperCase()] = String(row.cik_str).padStart(10, '0');
  }
  return map;
}

export async function fetchCompanyForm4Filings(cik, opts = {}) {
  const res = await secFetch(`https://data.sec.gov/submissions/CIK${cik}.json`, opts);
  const json = await res.json();
  const recent = (json.filings && json.filings.recent) || {};
  const forms = recent.form || [];
  const out = [];
  for (let i = 0; i < forms.length; i++) {
    if (forms[i] !== '4') continue;
    out.push({
      cik,
      company: json.name || '',
      filedDate: recent.filingDate[i],
      accession: recent.accessionNumber[i],
      primaryDocument: (recent.primaryDocument[i] || '').replace(/^xslF345X[0-9]+\//, ''),
      reportDate: recent.reportDate ? recent.reportDate[i] : null,
    });
    if (out.length >= (opts.limit || 10)) break;
  }
  return { company: json.name || '', filings: out };
}

export function form4XmlUrl(cik, accession, primaryDocument) {
  const acc = String(accession).replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc}/${primaryDocument}`;
}

export async function fetchForm4Xml(cik, filing, opts = {}) {
  const doc = filing.primaryDocument && filing.primaryDocument.endsWith('.xml')
    ? filing.primaryDocument
    : `${(filing.primaryDocument || '').replace(/\.(html?|txt)$/i, '')}.xml`;
  const res = await secFetch(form4XmlUrl(cik, filing.accession, doc), { ...opts, accept: 'application/xml,text/xml,*/*' });
  return res.text();
}

/* --- 極簡 XML 取值工具（Form 4 結構固定，不需要完整解析器） --- */

export function xmlBlocks(xml, tag) {
  const out = [];
  const openRe = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'g');
  let m;
  while ((m = openRe.exec(xml))) {
    const start = m.index + m[0].length;
    const scan = new RegExp(`</${tag}>|<${tag}(?:\\s[^>]*)?>`, 'g');
    scan.lastIndex = start;
    let depth = 1;
    let cm;
    let found = false;
    while ((cm = scan.exec(xml))) {
      if (cm[0].startsWith('</')) {
        depth--;
        if (depth === 0) {
          out.push(xml.slice(start, cm.index));
          openRe.lastIndex = cm.index;
          found = true;
          break;
        }
      } else depth++;
    }
    if (!found) break;
  }
  return out;
}

export function xmlText(xml, tag) {
  const m = String(xml).match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  /* Form 4 的名稱常含 &amp;（例如 "Chairman &amp; CEO"），要解碼才不會顯示成亂碼 */
  return m ? decodeEntities(m[1]) : null;
}

export function parseForm4(xml) {
  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  const issuerBlock = xmlBlocks(xml, 'issuer')[0] || '';
  const ownerBlock = xmlBlocks(xml, 'reportingOwner')[0] || '';
  const relBlock = xmlBlocks(ownerBlock, 'reportingOwnerRelationship')[0] || '';

  const transactions = [];
  for (const block of xmlBlocks(xml, 'nonDerivativeTransaction')) {
    const coding = xmlBlocks(block, 'transactionCoding')[0] || '';
    const amounts = xmlBlocks(block, 'transactionAmounts')[0] || '';
    const post = xmlBlocks(block, 'postTransactionAmounts')[0] || '';
    const nature = xmlBlocks(block, 'ownershipNature')[0] || '';
    const shares = num(xmlText(xmlBlocks(amounts, 'transactionShares')[0] || '', 'value'));
    const price = num(xmlText(xmlBlocks(amounts, 'transactionPricePerShare')[0] || '', 'value'));
    const code = xmlText(coding, 'transactionCode');
    const planRaw = xmlText(coding, 'aff10b5One');
    transactions.push({
      securityTitle: xmlText(block, 'securityTitle'),
      date: xmlText(xmlBlocks(block, 'transactionDate')[0] || '', 'value'),
      code,
      formType: xmlText(coding, 'transactionFormType'),
      /* 表單沒勾選時標籤可能整個不存在，此時回 null（「未知」）而不是 false */
      plan: planRaw === null ? null : planRaw === '1' || planRaw === 'true',
      shares,
      price,
      value: shares !== null && price !== null ? shares * price : null,
      sharesAfter: num(xmlText(xmlBlocks(post, 'sharesOwnedFollowingTransaction')[0] || '', 'value')),
      direct: xmlText(xmlBlocks(nature, 'directOrIndirectOwnership')[0] || '', 'value'),
    });
  }

  return {
    documentType: xmlText(xml, 'documentType'),
    periodOfReport: xmlText(xml, 'periodOfReport'),
    issuerCik: xmlText(issuerBlock, 'issuerCik'),
    issuerName: xmlText(issuerBlock, 'issuerName'),
    ticker: (xmlText(issuerBlock, 'issuerTradingSymbol') || '').toUpperCase(),
    ownerName: xmlText(ownerBlock, 'rptOwnerName'),
    isDirector: xmlText(relBlock, 'isDirector') === '1',
    isOfficer: xmlText(relBlock, 'isOfficer') === '1',
    isTenPercentOwner: xmlText(relBlock, 'isTenPercentOwner') === '1',
    officerTitle: (xmlText(relBlock, 'officerTitle') || '').trim(),
    transactions,
  };
}

/* ---------------------------------------------------------------------------
   4. 政府採購合約（USAspending 官方 API，免費）
   ------------------------------------------------------------------------- */

export async function fetchContracts(opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const days = opts.days || 30;
  const keywords = opts.keywords || ['LOCKHEED MARTIN', 'RAYTHEON', 'GENERAL DYNAMICS'];
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  const body = {
    filters: {
      keywords,
      time_period: [
        {
          /* date_type 一定要給，否則 USAspending 會忽略時間區間，
             回傳歷史上金額最大的合約（例如 1984 年的案子） */
          date_type: 'new_awards_only',
          start_date: iso(startDate),
          end_date: iso(endDate),
        },
      ],
      award_type_codes: ['A', 'B', 'C', 'D'],
    },
    fields: ['Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency', 'Start Date', 'Description'],
    page: 1,
    limit: opts.limit || 25,
    sort: 'Start Date',
    order: 'desc',
  };
  const json = await request('https://api.usaspending.gov/api/v2/search/spending_by_award/', {
    fetchImpl,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: opts.timeoutMs,
  });
  const items = ((json && json.results) || []).map((r) => ({
    title: `${r['Recipient Name'] || '—'}：${r.Description || '合約'}`,
    link: r['Award ID'] ? `https://www.usaspending.gov/award/${encodeURIComponent(r['Award ID'])}` : 'https://www.usaspending.gov',
    publishedAt: r['Start Date'] ? new Date(`${r['Start Date']}T00:00:00Z`).toISOString() : null,
    agency: r['Awarding Agency'] || '',
    amount: r['Award Amount'] || 0,
  }));
  if (!items.length) throw new Error(`USAspending 在最近 ${days} 天內沒有回傳符合關鍵字的合約`);
  return { items, days, fetchedAt: new Date().toISOString(), provider: 'usaspending' };
}

/* ---------------------------------------------------------------------------
   5. 通用申報端點介接（Quiver / Unusual Whales / 自建爬蟲）
   把任何回傳「陣列物件」的 JSON 端點丟進來，系統自動尋找欄位並正規化。
   ------------------------------------------------------------------------- */

export function guessRecords(json) {
  const candidates = [];
  const visit = (node, depth = 0) => {
    if (depth > 4 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      const objs = node.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
      if (objs.length >= 2) candidates.push(objs);
      node.slice(0, 3).forEach((x) => visit(x, depth + 1));
      return;
    }
    for (const key of Object.keys(node)) visit(node[key], depth + 1);
  };
  visit(json);
  if (!candidates.length) return [];
  /* 取欄位數最多的那一組，通常是主要資料列 */
  candidates.sort((a, b) => Object.keys(b[0]).length * b.length - Object.keys(a[0]).length * a.length);
  return candidates[0];
}

export async function fetchDisclosureEndpoint(opts = {}) {
  const { url, apiKey, headerName = 'Authorization', fetchImpl = fetch } = opts;
  if (!url) throw new Error('請提供端點 URL');
  const headers = {};
  if (apiKey) headers[headerName] = headerName.toLowerCase() === 'authorization' ? `Bearer ${apiKey}` : apiKey;
  const json = await request(url, { fetchImpl, headers, timeoutMs: opts.timeoutMs || 20000 });
  const records = guessRecords(json);
  if (!records.length) throw new Error('在這個端點的回應中找不到可用的紀錄陣列');
  return { records, fetchedAt: new Date().toISOString(), provider: 'endpoint', url };
}

/* ---------------------------------------------------------------------------
   6. OGE 官方揭露資料庫 API（第一手來源，實測可用）

   這個端點就是 OGE 官網「Officials Individual Disclosures Search」頁面背後
   的 DataTables 伺服器端介面。實測要點：
     ！全域 search[value] 會被忽略，必須用「欄位搜尋」columns[3][search][value]
     ！GET 可用；POST 會回 400
     ！不加 start/length 會一次回傳全部 1.6 萬筆（約 7MB），務必帶分頁參數
   姓名欄位格式為「Last, First」（例如 Trump, Donald J）。
   ------------------------------------------------------------------------- */

export const OGE_API = 'https://extapps2.oge.gov/201/Presiden.nsf/API.xsp/v2/rest';
export const OGE_COLUMNS = ['docDate', 'title', 'type', 'name', 'agency', 'level'];
export const OGE_NAME_COLUMN_INDEX = 3;

export function ogeQueryUrl({ nameSearch = '', start = 0, length = 200, draw = 1 } = {}) {
  const p = new URLSearchParams();
  p.set('draw', String(draw));
  OGE_COLUMNS.forEach((c, i) => {
    p.set(`columns[${i}][data]`, c);
    p.set(`columns[${i}][name]`, '');
    p.set(`columns[${i}][searchable]`, 'true');
    p.set(`columns[${i}][orderable]`, 'true');
    p.set(`columns[${i}][search][value]`, i === OGE_NAME_COLUMN_INDEX ? nameSearch : '');
    p.set(`columns[${i}][search][regex]`, 'false');
  });
  p.set('order[0][column]', '0');
  p.set('order[0][dir]', 'desc');
  p.set('start', String(start));
  p.set('length', String(length));
  p.set('search[value]', '');
  p.set('search[regex]', 'false');
  return `${OGE_API}?${p.toString()}`;
}

export function normalizeOgeFiling(row) {
  const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const type = strip(row.type);
  const href = String(row.type || '').match(/href='([^']+)'/);
  const link = href ? href[1].replace(/&amp;/g, '&') : null;
  const isRequest = /Request this Document/i.test(type) || (link ? link.includes('201%20Request') : false);
  const isPdf = Boolean(link && !isRequest && /\.pdf$/i.test(decodeURIComponent(link.split('?')[0])));
  return {
    docDate: strip(row.docDate).slice(0, 10),
    name: strip(row.name),
    agency: strip(row.agency),
    title: strip(row.title),
    level: strip(row.level),
    rawType: type,
    type: type.replace(/\s*\(Request this Document\)\s*/gi, ' ').replace(/\s+/g, ' ').trim(),
    isTransactionReport: /278\s*Transaction/i.test(type),
    isAnnual: /Annual/i.test(type),
    isAmended: /Amended/i.test(type),
    isPdf,
    needsRequest: isRequest,
    link: link && !isRequest ? link : null,
    requestLink: isRequest ? link : null,
    file: link && isPdf ? decodeURIComponent(link.split('/$FILE/')[1] || '') : null,
  };
}

export async function fetchOgeFilings(opts = {}) {
  const { name = 'Trump, Donald J', length = 200, fetchImpl = fetch, timeoutMs = 60000 } = opts;
  const json = await request(ogeQueryUrl({ nameSearch: name, length }), {
    fetchImpl,
    timeoutMs,
    headers: { Accept: 'application/json' },
  });
  const filings = ((json && json.data) || []).map(normalizeOgeFiling);
  if (!filings.length && !(json && json.recordsTotal)) {
    throw new Error('OGE API 沒有回傳任何紀錄');
  }
  return {
    name,
    filings,
    recordsTotal: json.recordsTotal,
    recordsFiltered: json.recordsFiltered,
    fetchedAt: new Date().toISOString(),
    provider: 'oge-api',
  };
}

/* 檔案指紋：用來比對「這次抓到的是不是新申報」 */
export function filingKey(f) {
  return [f.docDate, f.name, f.type, f.file || ''].join('|');
}

export function diffFilings(previous = [], current = []) {
  const known = new Set(previous.map(filingKey));
  const fresh = current.filter((f) => !known.has(filingKey(f)));
  const currentKeys = new Set(current.map(filingKey));
  const removed = previous.filter((f) => !currentKeys.has(filingKey(f)));
  return { fresh, removed };
}

/* Domino 對路徑中的空白與 "$FILE" 很挑，逐一嘗試候選寫法 */
export function candidateDocUrls(link) {
  return [
    ...new Set([
      link,
      link.replace('/PAS+Index/', '/PAS%20Index/'),
      link.replace('/PAS+Index/', '/PAS%20Index/').replace('/$FILE/', '/%24FILE/'),
      link.replace('/$FILE/', '/%24FILE/'),
    ]),
  ];
}

export async function downloadFilingPdf(link, destPath, opts = {}) {
  const fs = opts.fs;
  const path = opts.path;
  const fetchImpl = opts.fetchImpl || fetch;
  let lastError = '';
  for (const url of candidateDocUrls(link)) {
    try {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*' },
        signal: signalWithTimeout(opts.timeoutMs || 90000),
      });
      const buf = Buffer.from(await res.arrayBuffer());
      if (res.ok && buf.toString('latin1', 0, 5) === '%PDF-') {
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.writeFile(destPath, buf);
        return { ok: true, bytes: buf.length, url };
      }
      lastError = `HTTP ${res.status}（回傳不是 PDF）`;
    } catch (err) {
      lastError = err.message;
    }
  }
  return { ok: false, error: lastError };
}

export function safeFileName(name) {
  return String(name).replace(/[^\w.\-]+/g, '_').replace(/_+/g, '_');
}

/* ---------------------------------------------------------------------------
   7. 第三方已解析資料集（特朗普 2026 Q1 申報，3,642 筆交易）

   來源：GitHub HerringtonDarkholme/trump-portfolio-tracker
   他們的 README 說明：3,642 disclosed transactions across 1,024 holdings，
   由 OGE Form 278-T PDF 解析並全部對應到股票代號。

   ⚠️ 這是第三方的解析結果。它讓 App 立刻有足量資料可以分析，
      但正式使用前應以 OGE 正本核對（App 內每筆都會標示來源）。
   ------------------------------------------------------------------------- */

export const EXTERNAL_DATASETS = [
  {
    id: 'trump-278t-q1-2026',
    name: '特朗普 2026 Q1 申報交易（第三方解析）',
    repo: 'HerringtonDarkholme/trump-portfolio-tracker',
    files: [
      { path: 'src/data/dataset.json', out: 'dataset.json' },
      { path: 'trump_278T.csv', out: 'trump_278T.csv' },
      { path: 'data/ticker-seed.json', out: 'ticker-seed.json' },
    ],
    filedDate: '2026-05-14',
    note:
      '原始檔為 OGE Form 278-T（2026-05-08 申報、2026-05-14 公開），涵蓋 2026-01-06～2026-03-30 的交易。' +
      '本資料集由第三方自申報 PDF 解析並對應股票代號，非 OGE 官方結構化資料。',
    license: '請自行確認原倉庫授權條款',
  },
];

export async function fetchExternalDatasetFiles(dataset, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const out = {};
  for (const file of dataset.files) {
    const url = `https://raw.githubusercontent.com/${dataset.repo}/${opts.branch || 'main'}/${file.path}`;
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': UA },
      signal: signalWithTimeout(opts.timeoutMs || 60000),
    });
    if (!res.ok) throw new Error(`下載 ${file.path} 失敗：HTTP ${res.status}`);
    out[file.out] = await res.text();
  }
  return out;
}

/* 把第三方資料集的結構轉成 App 的交易格式 */
export function convertExternalDataset(dataset, opts = {}) {
  const filedDate = opts.filedDate || '2026-05-14';
  const sourceLabel = opts.sourceLabel || 'OGE 278-T（第三方解析）';
  const trades = [];
  const sectors = {};

  for (const ticker of Object.keys(dataset.stocks || {})) {
    const stock = dataset.stocks[ticker];
    if (stock && stock.sector) sectors[ticker] = stock.sector;
    for (const tx of stock.transactions || []) {
      const date = String(tx.date || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const low = Number(tx.low);
      const high = Number(tx.high);
      if (!Number.isFinite(low) || !Number.isFinite(high)) continue;
      trades.push({
        id: `ext-${ticker}-${date}-${tx.n ?? trades.length}`,
        ticker,
        company: stock.name || ticker,
        side: String(tx.type).toLowerCase().startsWith('sale') ? 'SELL' : 'BUY',
        tradeDate: date,
        filedDate,
        amountMin: low,
        amountMax: high,
        owner: '本人（申報）',
        source: sourceLabel,
        rawDescription: tx.rawDescription || '',
        filingRow: tx.n ?? null,
      });
    }
  }
  trades.sort((a, b) => (a.tradeDate < b.tradeDate ? -1 : a.tradeDate > b.tradeDate ? 1 : 0));
  return {
    trades,
    sectors,
    meta: {
      datasetId: 'trump-278t-q1-2026',
      filedDate,
      generatedAt: dataset.generatedAt || null,
      totals: dataset.totals || null,
      sourceLabel,
    },
  };
}
