/* 用假的 HTTP 回應驗證各 provider 的解析、退路與正規化邏輯
   執行：node --test test/ */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseYahooChart,
  parseStooqCsv,
  parseRSS,
  buildEqualWeightBenchmark,
  fetchLivePrices,
  guessRecords,
  stooqSymbol,
  federalRegisterUrl,
  ogeQueryUrl,
  normalizeOgeFiling,
  diffFilings,
  filingKey,
  candidateDocUrls,
  isRelevantPolicyDoc,
  quarterWindows,
} from '../providers.mjs';

import {
  buildPortfolio,
  importTrades,
  buildMarketData,
  analyze,
  analyzePolicy,
  rankPolicyExposure,
  midAmount,
  daysBetween,
  buildPriceSeries,
} from '../engine.mjs';

import {
  buildDataset,
  fitScaler,
  applyScaler,
  trainLogistic,
  predictOne,
  auc,
  evaluateModel,
  fitCalibration,
  applyCalibration,
  judgeModel,
  conditionalStats,
  runProbabilityModel,
  FEATURE_KEYS,
  signalScorecard,
} from '../model.mjs';

import { computeCapacity, buildEventClock, liquidityTier } from '../desk.mjs';
import {
  computeRegime,
  expandingPercentile,
  regimeScoreOn,
  regimeConditionalScorecard,
  REGIME_SYMBOLS,
  REGIME_DIMENSIONS,
} from '../regime.mjs';
import { normalizePositions, analyzePositions } from '../portfolio.mjs';
import { parseForm4, xmlBlocks, xmlText } from '../providers.mjs';
import { flattenForm4, summarizeInsiders, recentTransactions, roleOf } from '../insiders.mjs';
import { DEMO_TRADES, SECTORS } from '../demo-data.mjs';

/* --------------------------- 樣本資料 --------------------------- */

const YAHOO_SAMPLE = {
  chart: {
    result: [
      {
        meta: { symbol: 'NVDA' },
        timestamp: [1730419200, 1730505600, 1730592000, 1730688000],
        indicators: {
          quote: [{ close: [100.5, 101.25, null, 103.75] }],
          adjclose: [{ adjclose: [100.4, 101.1, null, 103.5] }],
        },
      },
    ],
    error: null,
  },
};

const STOOQ_SAMPLE = [
  'Date,Open,High,Low,Close,Volume',
  '2024-10-01,10,11,9,10.5,1000',
  '2024-10-02,10.5,12,10.4,11.75,1200',
  '2024-10-03,11.75,12.1,11.5,11.9,900',
  '',
].join('\n');

const RSS_SAMPLE = `<?xml version="1.0"?><rss version="2.0"><channel>
<title>Google News</title>
<item>
  <title><![CDATA[Trump disclosed buying Nvidia shares - Reuters]]></title>
  <link>https://news.google.com/rss/articles/abc123</link>
  <pubDate>Fri, 11 Sep 2026 13:05:00 GMT</pubDate>
  <source url="https://www.reuters.com">Reuters</source>
  <description><![CDATA[<a href="x">Trump</a> filed a periodic transaction report &amp; more]]></description>
</item>
<item>
  <title>Trump tariffs hit semiconductor imports</title>
  <link>https://news.google.com/rss/articles/def456</link>
  <pubDate>Thu, 10 Sep 2026 08:00:00 GMT</pubDate>
  <source url="https://www.bloomberg.com">Bloomberg</source>
  <description>policy &lt;b&gt;detail&lt;/b&gt;</description>
</item>
</channel></rss>`;

/* --------------------------- 價格解析 --------------------------- */

test('parseYahooChart：取 adjusted close 並跳過缺值', () => {
  const points = parseYahooChart(YAHOO_SAMPLE);
  assert.equal(points.length, 3);
  assert.equal(points[0].close, 100.4);
  assert.equal(points[1].close, 101.1);
  assert.equal(points[2].close, 103.5);
  assert.match(points[0].date, /^\d{4}-\d{2}-\d{2}$/);
});

test('parseYahooChart：非預期結構回傳空陣列而不丟錯', () => {
  assert.deepEqual(parseYahooChart({}), []);
  assert.deepEqual(parseYahooChart(null), []);
  assert.deepEqual(parseYahooChart({ chart: { result: [{}] } }), []);
});

test('parseStooqCsv：解析日期與收盤價、忽略結尾空行', () => {
  const points = parseStooqCsv(STOOQ_SAMPLE);
  assert.equal(points.length, 3);
  assert.equal(points[0].date, '2024-10-01');
  assert.equal(points[2].close, 11.9);
});

test('stooqSymbol：美股代號轉換', () => {
  assert.equal(stooqSymbol('NVDA'), 'nvda.us');
  assert.equal(stooqSymbol('BRK.B'), 'brk-b.us');
  assert.equal(stooqSymbol('^SPX'), 'spx');
});

test('buildEqualWeightBenchmark：首日為 100，上漲 10% 的標的權重相同', () => {
  const series = {
    A: [{ date: '2024-10-01', close: 100 }, { date: '2024-10-02', close: 110 }],
    B: [{ date: '2024-10-01', close: 10 }, { date: '2024-10-02', close: 10 }],
  };
  const bench = buildEqualWeightBenchmark(series);
  assert.equal(bench.length, 2);
  assert.equal(bench[0].close, 100);
  assert.equal(bench[1].close, 105);
});

/* --------------------------- 退路邏輯 --------------------------- */

test('fetchLivePrices：Yahoo 失敗時自動改用 Stooq', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    if (url.includes('query1.finance.yahoo.com')) {
      return { ok: false, status: 429, json: async () => ({}) };
    }
    return { ok: true, status: 200, text: async () => STOOQ_SAMPLE };
  };
  const result = await fetchLivePrices(['NVDA'], { fetchImpl: fakeFetch });
  assert.equal(result.provider, 'stooq');
  assert.equal(result.series.NVDA.length, 3);
  assert.equal(result.benchmark[0].close, 100);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].provider, 'yahoo');
  assert.ok(calls.some((u) => u.includes('stooq.com')));
});

test('fetchLivePrices：全部失敗時給出可行動的錯誤訊息', async () => {
  const fakeFetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(
    () => fetchLivePrices(['NVDA'], { fetchImpl: fakeFetch }),
    (err) => {
      assert.match(err.message, /所有價格來源都失敗/);
      assert.match(err.message, /模擬價格/);
      return true;
    }
  );
});

/* --------------------------- 新聞與政策 --------------------------- */

test('parseRSS：解析標題、連結、來源並解碼實體', () => {
  const items = parseRSS(RSS_SAMPLE);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Trump disclosed buying Nvidia shares - Reuters');
  assert.equal(items[0].source, 'Reuters');
  assert.equal(items[0].publishedAt, '2026-09-11T13:05:00.000Z');
  assert.match(items[0].summary, /& more/);
  assert.equal(items[1].source, 'Bloomberg');
  assert.match(items[1].summary, /policy detail/);
});

test('federalRegisterUrl：欄位以陣列語法帶入', () => {
  const url = federalRegisterUrl('tariff exemption');
  assert.match(url, /conditions%5Bterm%5D=tariff%20exemption/);
  assert.match(url, /fields%5B%5D=title/);
});

/* --------------------------- 通用端點 --------------------------- */

test('guessRecords：從任意 JSON 結構中找出主要資料陣列', () => {
  const json = {
    status: 'ok',
    data: {
      trades: [
        { ticker: 'NVDA', transactionDate: '2026-07-01', amount: '$1,000,001 - $5,000,000', type: 'Buy' },
        { ticker: 'AMD', transactionDate: '2026-07-02', amount: '$250,001 - $500,000', type: 'Buy' },
      ],
    },
  };
  const records = guessRecords(json);
  assert.equal(records.length, 2);
  assert.equal(records[0].ticker, 'NVDA');
  assert.deepEqual(guessRecords({ a: 1 }), []);
});

/* --------------------------- 匯入正規化 --------------------------- */

test('importTrades：容忍欄位大小寫、金額字串與斜線日期', () => {
  const csv = [
    'Transaction Date,Filed Date,Symbol,Asset,Type,Amount,Owner',
    '8/18/2026,2026-09-08,AMZN,Amazon.com Inc,Buy,"$1,000,001 - $5,000,000",本人',
    '2026-08-25,2026-09-09,PLTR,Palantir Technologies,Sale,$250,001-$500,000,家族信託',
  ].join('\n');
  const { trades, errors } = importTrades(csv, 'csv');
  assert.equal(errors.length, 0);
  assert.equal(trades.length, 2);
  assert.equal(trades[0].tradeDate, '2026-08-18');
  assert.equal(trades[0].ticker, 'AMZN');
  assert.equal(trades[0].amountMin, 1000001);
  assert.equal(trades[0].amountMax, 5000000);
  assert.equal(trades[1].side, 'SELL');
});

test('importTrades：缺少必要欄位時回報列號而非丟錯', () => {
  const csv = ['ticker,date,amount', ',2026-01-01,1000'].join('\n');
  const { trades, errors } = importTrades(csv, 'csv');
  assert.equal(trades.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].rowNumber, 2);
  assert.match(errors[0].reason, /股票代號/);
});

/* --------------------------- 組合限制 --------------------------- */

test('buildPortfolio：持股與產業上限都必須成立', () => {
  const trades = DEMO_TRADES.map((t, i) => ({ ...t, id: `t${i}` }));
  const market = buildMarketData([...new Set(trades.map((t) => t.ticker))]);
  const result = analyze({ trades, sectors: SECTORS, market });

  for (const pos of result.portfolio.positions) {
    assert.ok(pos.weight <= result.portfolio.params.maxWeight + 1e-9, `${pos.ticker} 超過持股上限`);
  }
  for (const sec of result.portfolio.sectorBreakdown) {
    assert.ok(sec.weight <= result.portfolio.params.sectorCap + 1e-6, `${sec.sector} 超過產業上限`);
  }
  const gross = result.portfolio.positions.reduce((a, b) => a + b.weight, 0);
  assert.ok(Math.abs(gross + result.portfolio.cash - 1) < 1e-6, '權重與現金必須合計為 100%');

  const sectorMax = result.portfolio.sectorBreakdown[0];
  assert.ok(sectorMax, '必須產生產業分布');
  assert.ok(sectorMax.weight >= 0.0001);
});

test('buildPortfolio：候選不足時資金留在現金並說明原因', () => {
  const fakeScores = [
    {
      ticker: 'AAA', company: 'A', sector: 'S1', score: 90, lastClose: 10,
      components: { size: 1, freshness: 1, accumulation: 1, momentum: 0.5, heat: 0.5 },
      flags: [], stats: { buyAmount: 5e6, netAmount: 5e6 },
    },
    {
      ticker: 'BBB', company: 'B', sector: 'S1', score: 85, lastClose: 10,
      components: { size: 1, freshness: 1, accumulation: 1, momentum: 0.5, heat: 0.5 },
      flags: [], stats: { buyAmount: 4e6, netAmount: 4e6 },
    },
  ];
  const p = buildPortfolio(fakeScores, { topN: 8, maxWeight: 0.18, cashMin: 0.1 });
  assert.equal(p.positions.length, 2);
  assert.ok(p.positions.every((x) => x.weight <= 0.18 + 1e-9));
  assert.ok(p.cash > 0.6, `現金應明顯提高，實際 ${p.cash}`);
  assert.match(p.notes.join(' '), /實際現金比重/);
});

/* --------------------------- 引擎輸出穩定性 --------------------------- */

test('analyze：41 筆示範交易可完整產生評分、組合與回測', () => {
  const trades = DEMO_TRADES.map((t, i) => ({ ...t, id: `t${i}` }));
  const result = analyze({ trades, sectors: SECTORS });
  assert.equal(result.summary.tradeCount, 41);
  assert.equal(result.scores.length, new Set(trades.map((t) => t.ticker)).size);
  assert.ok(result.scores[0].score >= result.scores[result.scores.length - 1].score);
  assert.ok(result.backtest.stats.trades > 0);
  assert.equal(result.backtest.equity.length, result.backtest.equity.length);
  for (const s of result.scores) {
    for (const k of Object.keys(s.components)) {
      assert.ok(s.components[k] >= 0 && s.components[k] <= 1, `${s.ticker}.${k} 必須在 0~1`);
    }
  }
});

test('midAmount：金額區間取中位數', () => {
  assert.equal(midAmount({ amountMin: 1000, amountMax: 5000 }), 3000);
});

/* --------------------------- OGE 官方 API --------------------------- */

test('ogeQueryUrl：必須用欄位搜尋，且帶分頁參數', () => {
  const url = ogeQueryUrl({ nameSearch: 'Trump, Donald J' });
  /* 全域 search[value] 會被 OGE 忽略，真正生效的是 name 欄位（索引 3） */
  assert.match(url, /columns%5B3%5D%5Bsearch%5D%5Bvalue%5D=Trump%2C\+Donald\+J/);
  assert.match(url, /search%5Bvalue%5D=&/);
  assert.match(url, /start=0/);
  assert.match(url, /length=200/);
  assert.match(url, /API\.xsp\/v2\/rest/);
});

test('normalizeOgeFiling：解析申報類型與 PDF 連結', () => {
  const filing = normalizeOgeFiling({
    docDate: '2026-08-22T04:17:46',
    name: 'Trump, Donald J',
    agency: 'White House Office',
    title: '',
    level: '',
    amended: '',
    type:
      "<a href='https://extapps2.oge.gov/201/Presiden.nsf/PAS+Index/ABC/$FILE/Donald-J-Trump-08.12.2026-278T.pdf'>" +
      '278 Transaction</a>',
  });
  assert.equal(filing.docDate, '2026-08-22');
  assert.equal(filing.name, 'Trump, Donald J');
  assert.equal(filing.type, '278 Transaction');
  assert.equal(filing.isTransactionReport, true);
  assert.equal(filing.isPdf, true);
  assert.equal(filing.file, 'Donald-J-Trump-08.12.2026-278T.pdf');
});

test('normalizeOgeFiling：需向 OGE 申請的文件不算可下載 PDF', () => {
  const filing = normalizeOgeFiling({
    docDate: '2024-08-23T00:00:00',
    name: 'Trump, Donald J',
    agency: 'Candidates - F.E.C.',
    type:
      "<a href='https://extapps2.oge.gov/201/Presiden.nsf/201%20Request?OpenForm&Filer=Trump'>" +
      'Presidential Candidate (Request this Document)</a>',
  });
  assert.equal(filing.needsRequest, true);
  assert.equal(filing.isPdf, false);
  assert.equal(filing.link, null);
  assert.ok(filing.requestLink.includes('201%20Request'));
});

test('normalizeOgeFiling：修正版本會被標記', () => {
  const filing = normalizeOgeFiling({
    docDate: '2025-08-19',
    name: 'Trump, Donald J',
    type: "<a href='x/$FILE/amended.pdf'>278 Transaction (Amended 08/12/2025)</a>",
  });
  assert.equal(filing.isAmended, true);
  assert.equal(filing.isTransactionReport, true);
});

test('diffFilings：只有新出現的紀錄算新申報', () => {
  const a = normalizeOgeFiling({ docDate: '2026-01-01', name: 'Trump, Donald J', type: '278 Transaction' });
  const b = normalizeOgeFiling({ docDate: '2026-02-01', name: 'Trump, Donald J', type: '278 Transaction' });
  const c = normalizeOgeFiling({ docDate: '2026-03-01', name: 'Trump, Donald J', type: '278 Transaction' });

  const first = diffFilings([], [a, b]);
  assert.equal(first.fresh.length, 2, '首次執行全部視為新');

  const second = diffFilings([a, b], [b, c]);
  assert.equal(second.fresh.length, 1);
  assert.equal(second.fresh[0].docDate, '2026-03-01');
  assert.equal(second.removed.length, 1);
  assert.equal(second.removed[0].docDate, '2026-01-01');
});

test('filingKey：同樣的申報在不同次抓取會得到相同指紋', () => {
  const row = {
    docDate: '2026-08-22T04:17:46',
    name: 'Trump, Donald J',
    type: "<a href='u/$FILE/a.pdf'>278 Transaction</a>",
  };
  const again = { ...row, docDate: '2026-08-22T09:00:00' };
  assert.equal(filingKey(normalizeOgeFiling(row)), filingKey(normalizeOgeFiling(again)));
});

test('candidateDocUrls：針對 Domino 路徑提供多種寫法', () => {
  const urls = candidateDocUrls('https://x/201/Presiden.nsf/PAS+Index/AB/$FILE/f.pdf');
  assert.ok(urls.includes('https://x/201/Presiden.nsf/PAS+Index/AB/$FILE/f.pdf'));
  assert.ok(urls.some((u) => u.includes('PAS%20Index')));
  assert.ok(urls.some((u) => u.includes('%24FILE')));
});

/* --------------------------- 政策資料處理 --------------------------- */

test('federalRegisterUrl：可帶日期區間與文件類型', () => {
  const url = federalRegisterUrl('tariff', 25, {
    from: '2025-05-01',
    to: '2026-09-14',
    types: ['PRESDOCU', 'RULE'],
  });
  assert.match(url, /conditions%5Bpublication_date%5D%5Bgte%5D=2025-05-01/);
  assert.match(url, /conditions%5Bpublication_date%5D%5Blte%5D=2026-09-14/);
  assert.match(url, /conditions%5Btype%5D%5B%5D=PRESDOCU/);
  assert.match(url, /conditions%5Btype%5D%5B%5D=RULE/);
  assert.match(url, /per_page=25/);
});

test('isRelevantPolicyDoc：標題命中即採用', () => {
  assert.equal(
    isRelevantPolicyDoc({ title: 'Adjusting Imports of Semiconductors', abstract: '' }, ['semiconductor']),
    true
  );
});

test('isRelevantPolicyDoc：通用短詞只比對摘要時不算命中（避免 electric 誤中 electrical）', () => {
  assert.equal(
    isRelevantPolicyDoc(
      { title: 'General and Plastic Surgery Devices', abstract: 'requires electrical safety testing' },
      ['electric']
    ),
    false
  );
  assert.equal(
    isRelevantPolicyDoc({ title: 'National Agriculture Day, 2026', abstract: '' }, ['electric vehicle']),
    false
  );
});

test('isRelevantPolicyDoc：夠特定的詞可在摘要命中', () => {
  assert.equal(
    isRelevantPolicyDoc(
      { title: 'Agency Information Collection', abstract: 'rules regarding artificial intelligence systems' },
      ['artificial intelligence']
    ),
    true
  );
  assert.equal(
    isRelevantPolicyDoc({ title: 'Fee Schedule', abstract: 'cryptocurrency reporting duty' }, ['cryptocurrency']),
    true
  );
});

test('quarterWindows：切成連續且涵蓋整段期間的區間', () => {
  const windows = quarterWindows('2025-05-08', '2026-09-13');
  assert.ok(windows.length >= 5, `至少 5 個季度區間，實際 ${windows.length}`);
  assert.equal(windows[0].from, '2025-05-08');
  assert.equal(windows[windows.length - 1].to, '2026-09-13');
  for (let i = 1; i < windows.length; i++) {
    assert.ok(windows[i].from > windows[i - 1].to, '區間不可重疊');
  }
  for (const w of windows) assert.ok(w.from <= w.to);
});

/* --------------------------- 政策曝險分析 --------------------------- */

const POLICY_TRADES = [
  {
    id: 'a', ticker: 'AXON', company: 'Axon', side: 'BUY', tradeDate: '2026-03-20',
    filedDate: '2026-05-14', amountMin: 1000001, amountMax: 5000000, owner: '本人', source: 'test',
  },
  {
    id: 'b', ticker: 'AXON', company: 'Axon', side: 'BUY', tradeDate: '2025-09-01',
    filedDate: '2025-10-01', amountMin: 15001, amountMax: 50000, owner: '本人', source: 'test',
  },
  {
    id: 'c', ticker: 'GEO', company: 'GEO Group', side: 'SELL', tradeDate: '2026-03-25',
    filedDate: '2026-05-14', amountMin: 100001, amountMax: 250000, owner: '本人', source: 'test',
  },
];

const POLICY_THEMES_FIXTURE = [
  {
    id: 'immigration',
    name: '移民執法與邊境',
    axis: '執法',
    keywords: ['immigration'],
    exposed: {
      AXON: { dir: 1, reason: '執法裝備' },
      GEO: { dir: 1, reason: '拘留設施' },
      LMT: { dir: 1, reason: '邊境監控' },
    },
  },
  {
    id: 'crypto',
    name: '加密貨幣',
    axis: '金融科技',
    keywords: ['crypto'],
    exposed: { COIN: { dir: 1, reason: '交易所' } },
  },
];

const POLICY_DOCS = {
  immigration: {
    items: [
      { title: 'Border security enforcement rule', link: 'https://example.gov/1', publishedAt: '2026-03-18T00:00:00.000Z', agencies: 'DHS' },
    ],
  },
  crypto: { items: [] },
};

test('analyzePolicy：只有落在時間窗內的政策文件才算交集', () => {
  const p = analyzePolicy({
    trades: POLICY_TRADES,
    themes: POLICY_THEMES_FIXTURE,
    docsByTheme: POLICY_DOCS,
    asOf: '2026-09-11',
    windowDays: 30,
  });
  assert.equal(p.summary.pairCount, 2, 'AXON 3/20 與 GEO 3/25 各一筆，2025-09 那筆超出時間窗');
  assert.equal(p.pairs[0].ticker, 'AXON');
  assert.equal(p.pairs[0].gapDays, 2);
  assert.equal(p.pairs[0].side, 'BUY');
  assert.equal(p.themes.find((t) => t.id === 'crypto').pairCount, 0, '沒有文件就不會有交集');
});

test('analyzePolicy：淨額、曝險分數與未交易標的都要正確', () => {
  const p = analyzePolicy({
    trades: POLICY_TRADES,
    themes: POLICY_THEMES_FIXTURE,
    docsByTheme: POLICY_DOCS,
    asOf: '2026-09-11',
    windowDays: 30,
  });
  const immigration = p.themes.find((t) => t.id === 'immigration');
  assert.equal(immigration.tradeCount, 3);
  /* AXON 買 3,000,000.5 + 32,500.5，GEO 賣 175,000.5 */
  assert.ok(immigration.netFlow > 2_800_000, `淨買入應超過 2.8M，實際 ${immigration.netFlow}`);
  assert.equal(immigration.exposureCount, 2, 'AXON 與 GEO 有交易，LMT 沒有');

  assert.equal(p.tickers.AXON.sensitivity, 1);
  assert.equal(p.tickers.AXON.themes.length, 1);
  assert.ok(p.tickers.AXON.net > 2_900_000);
  assert.equal(p.tickers.LMT.count, 0, '未交易的標的仍要出現在曝險表中');
});

test('analyzePolicy：放大時間窗會納入更多交集', () => {
  const narrow = analyzePolicy({ trades: POLICY_TRADES, themes: POLICY_THEMES_FIXTURE, docsByTheme: POLICY_DOCS, asOf: '2026-09-11', windowDays: 3 });
  const wide = analyzePolicy({ trades: POLICY_TRADES, themes: POLICY_THEMES_FIXTURE, docsByTheme: POLICY_DOCS, asOf: '2026-09-11', windowDays: 14 });
  assert.ok(wide.summary.pairCount >= narrow.summary.pairCount);
  assert.equal(narrow.windowDays, 3);
  assert.equal(wide.windowDays, 14);
});

test('rankPolicyExposure：依曝險強度排序且只取有交易的標的', () => {
  const p = analyzePolicy({
    trades: POLICY_TRADES,
    themes: POLICY_THEMES_FIXTURE,
    docsByTheme: POLICY_DOCS,
    asOf: '2026-09-11',
    windowDays: 30,
  });
  const ranked = rankPolicyExposure(p, { minTrades: 1, limit: 10 });
  assert.equal(ranked.length, 2);
  assert.ok(ranked.every((r) => r.count >= 1));
  assert.ok(ranked[0].strength >= ranked[1].strength);
});

/* --------------------------- AI 機率模型 --------------------------- */

/* 造一段上漲後持續下跌、再上漲的價格序列，用來檢查特徵與標籤 */
function makeSeries(len = 400, fn = () => 1) {
  const out = [];
  const start = new Date(Date.UTC(2025, 0, 1));
  let d = new Date(start);
  let close = 100;
  for (let i = 0; i < len; i++) {
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    close = close * fn(i, close);
    out.push({ date: d.toISOString().slice(0, 10), close: Math.round(close * 100) / 100, volume: 1_000_000 });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

test('auc：完全分開為 1、完全顛倒為 0、打平為 0.5', () => {
  assert.equal(auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]), 1);
  assert.equal(auc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1]), 0);
  assert.equal(auc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1]), 0.5);
  assert.equal(auc([0.5], [1]), null);
});

test('trainLogistic：在線性可分的資料上學到正確方向', () => {
  const X = [];
  const y = [];
  for (let i = 0; i < 200; i++) {
    const signal = i % 2 === 0 ? 1 : -1;
    X.push([signal * (1 + (i % 7) / 10), (i % 5) / 10]);
    y.push(signal > 0 ? 1 : 0);
  }
  const scaler = fitScaler(X);
  const Xs = X.map((r) => applyScaler(r, scaler));
  const model = trainLogistic(Xs, y, { epochs: 400 });
  assert.ok(model.weights[0] > 0, '第一個特徵應該為正權重');
  const metrics = evaluateModel(model, Xs, y);
  assert.ok(metrics.accuracy > 0.9, `準確率應 > 0.9，實際 ${metrics.accuracy}`);
  assert.ok(metrics.auc > 0.9);
});

test('fitCalibration：過度自信的分數會被拉回實際命中率', () => {
  /* 模型說 0.99，但實際只有一半命中 */
  const probs = Array.from({ length: 200 }, (_, i) => 0.95 + (i % 5) / 100);
  const y = probs.map((_, i) => (i % 2 === 0 ? 1 : 0));
  const cal = fitCalibration(probs, y);
  const calibrated = applyCalibration(cal, 0.99);
  assert.ok(calibrated < 0.9, `校正後應明顯低於 0.99，實際 ${calibrated}`);
  assert.ok(calibrated > 0.3 && calibrated < 0.8, `且應接近 0.5，實際 ${calibrated}`);
});

test('applyCalibration：輸出單調不減', () => {
  const probs = [0.05, 0.15, 0.35, 0.55, 0.75, 0.95];
  const y = [0, 1, 0, 1, 1, 1];
  const cal = fitCalibration(probs, y, 3);
  const mapped = [0.1, 0.3, 0.5, 0.7, 0.9].map((p) => applyCalibration(cal, p));
  for (let i = 1; i < mapped.length; i++) {
    assert.ok(mapped[i] >= mapped[i - 1] - 1e-9, `校正函式應單調，實際 ${JSON.stringify(mapped)}`);
  }
});

test('judgeModel：依樣本外表現給出誠實結論', () => {
  assert.equal(judgeModel({ n: 100, accuracy: 0.7, majorityAccuracy: 0.6, auc: 0.8 }).level, 'unknown');
  assert.equal(judgeModel({ n: 1000, accuracy: 0.6, majorityAccuracy: 0.6, auc: 0.51 }).level, 'none');
  assert.equal(judgeModel({ n: 1000, accuracy: 0.615, majorityAccuracy: 0.6, auc: 0.58 }).level, 'weak');
  assert.equal(judgeModel({ n: 1000, accuracy: 0.66, majorityAccuracy: 0.6, auc: 0.62 }).level, 'positive');
});

test('buildDataset：標籤使用未來報酬，特徵不使用未來資料', () => {
  /* 前 300 天每日 +1%，之後每日 −1%：觀察日在 300 之前的都應該「未來下跌」 */
  const series = makeSeries(400, (i) => (i < 300 ? 1.01 : 0.99));
  const market = { series: { TST: series }, benchmark: series };
  const rows = buildDataset({
    trades: [],
    market,
    asOf: series[series.length - 1].date,
    horizonDays: 20,
    stepDays: 5,
    minHistoryDays: 260,
    daysBetweenFn: daysBetween,
    midAmountFn: midAmount,
  });
  assert.ok(rows.length > 5, `應該產生觀察值，實際 ${rows.length}`);
  const early = rows.filter((r) => r.date < series[290].date);
  assert.ok(early.length > 0);
  for (const r of early) {
    assert.equal(r.y, 1, `${r.date} 的未來 20 日應為上漲`);
    assert.ok(r.forwardReturn > 0);
  }
});

test('buildDataset：申報特徵以 filedDate 為準，不能用尚未公開的申報', () => {
  const series = makeSeries(400, () => 1.001);
  const market = { series: { TST: series }, benchmark: series };
  const obsDate = series[300].date;
  const laterFiled = {
    id: 'x', ticker: 'TST', company: 'Test', side: 'BUY',
    tradeDate: series[280].date,
    filedDate: series[350].date, /* 觀察日之後才公開 */
    amountMin: 1000001, amountMax: 5000000, owner: '本人', source: 'test',
  };
  const rows = buildDataset({
    trades: [laterFiled],
    market,
    asOf: series[series.length - 1].date,
    horizonDays: 10,
    stepDays: 5,
    minHistoryDays: 260,
    daysBetweenFn: daysBetween,
    midAmountFn: midAmount,
  });
  const atObs = rows.find((r) => r.date === obsDate);
  assert.ok(atObs, '觀察日應該存在');
  assert.equal(atObs.x.buyNet90, 0, '尚未公開的申報不能計入');
  assert.equal(atObs.x.freshness, 0);
});

test('conditionalStats：條件與命中率的對應正確', () => {
  const rows = [];
  for (let i = 0; i < 100; i++) {
    const strong = i < 60;
    rows.push({
      date: '2026-01-01',
      ticker: `T${i}`,
      x: { mom60: strong ? 0.5 : -0.5, buyNet90: 0, buyCount90: 0, freshness: 0, policySens: 0, policyEvents60: 0, mom20: 0, excess60: 0, vol20: 0.2, distHigh: -0.1, volRatio: 1 },
      forwardReturn: strong ? 0.05 : -0.02,
      y: strong ? 1 : 0,
    });
  }
  const stats = conditionalStats(rows, 20);
  const cond = stats.table.find((c) => c.key === 'strongMom');
  assert.ok(cond, '應有強動能條件');
  assert.equal(cond.n, 60);
  assert.equal(cond.hitRate, 1);
  assert.ok(cond.lift > 0.3);
  assert.equal(stats.all.n, 100);
  assert.equal(stats.all.hitRate, 0.6);
});

test('runProbabilityModel：完整流程可執行且機率在合理範圍', () => {
  const tickers = ['AAA', 'BBB', 'CCC', 'DDD'];
  const market = { series: {}, benchmark: null };
  tickers.forEach((t, k) => {
    market.series[t] = makeSeries(400, (i) => 1 + Math.sin((i + k * 7) / 20) * 0.004);
  });
  market.benchmark = market.series.AAA;
  const result = runProbabilityModel({
    trades: [],
    market,
    themes: [],
    docsByTheme: {},
    asOf: market.series.AAA[market.series.AAA.length - 1].date,
    horizonDays: 20,
    stepDays: 5,
    daysBetweenFn: daysBetween,
    midAmountFn: midAmount,
  });
  if (!result.ok) {
    assert.match(result.reason, /樣本不足/);
    return;
  }
  assert.equal(result.predictions.length, tickers.length);
  for (const p of result.predictions) {
    assert.ok(p.probUp > 0 && p.probUp < 1, `${p.ticker} 機率必須在 0~1，實際 ${p.probUp}`);
    assert.equal(p.contributions.length, 4);
  }
  assert.ok(result.verdict && result.verdict.level);
  assert.equal(result.features.length, FEATURE_KEYS.length);
  for (const f of result.features) assert.ok(Number.isFinite(f.weight));
});

/* --------------------------- 執行面：容量與事件 --------------------------- */

test('liquidityTier：依成交金額分級', () => {
  assert.equal(liquidityTier(2e9).id, 'very-high');
  assert.equal(liquidityTier(5e8).id, 'high');
  assert.equal(liquidityTier(1.5e8).id, 'medium');
  assert.equal(liquidityTier(5e7).id, 'low');
  assert.equal(liquidityTier(1e6).id, 'very-low');
});

test('computeCapacity：申報金額 ÷ 日成交量 的計算正確', () => {
  const series = makeSeries(120, () => 1); /* 收盤固定 100、量固定 1,000,000 */
  const market = { series: { TST: series }, benchmark: series };
  const trades = [
    {
      id: 'a', ticker: 'TST', company: 'Test', side: 'BUY',
      tradeDate: series[110].date, filedDate: series[115].date,
      amountMin: 1000000, amountMax: 3000000, owner: '本人', source: 'test',
    },
  ];
  const rows = computeCapacity({ market, trades, asOf: series[series.length - 1].date });
  assert.equal(rows.length, 1);
  const row = rows[0];
  /* 日成交金額 = 1,000,000 股 × $100 = $100M，申報中位數 $2M → 2% 的天量 */
  assert.ok(Math.abs(row.adv20Value - 100_000_000) < 1_000_000, `ADV 應約 1 億，實際 ${row.adv20Value}`);
  assert.ok(Math.abs(row.daysForAllDisclosed - 0.02) < 0.002, `應約 2%，實際 ${row.daysForAllDisclosed}`);
  assert.ok(Math.abs(row.suggestedMaxPosition - 10_000_000) < 200_000);
  assert.equal(row.tradeCount, 1);
  assert.equal(row.liquidity, '中');
});

test('buildEventClock：合併事件、過濾區間、依日期分組', () => {
  const clock = buildEventClock({
    asOf: '2026-09-11',
    days: 30,
    policyEvents: [
      { effectiveOn: '2026-09-20', title: 'Rule A', themeName: '關稅', link: 'u1', tickers: ['AAPL'] },
      { effectiveOn: '2026-12-01', title: 'Too far', themeName: '關稅', link: 'u2' },
      { commentsCloseOn: '2026-09-25', title: 'Comment B', themeName: '能源', link: 'u3' },
    ],
    earnings: [
      { date: '2026-09-18', ticker: 'COST', name: 'Costco', session: '盤後', epsForecast: '$6.4' },
      { date: '2026-11-01', ticker: 'FAR', name: 'Far away' },
    ],
    contracts: [{ publishedAt: '2026-09-15T00:00:00.000Z', title: 'Contract C', agency: 'DoD', amount: 5e6, link: 'u4' }],
    tickerSectors: { COST: 'Consumer Staples' },
  });
  assert.equal(clock.from, '2026-09-11');
  assert.equal(clock.to, '2026-10-11');
  assert.equal(clock.events.length, 4, '超出區間的事件要被濾掉');
  assert.equal(clock.counts.policyEffective, 1);
  assert.equal(clock.counts.commentDeadline, 1);
  assert.equal(clock.counts.earnings, 1);
  assert.equal(clock.counts.contract, 1);
  const dates = clock.events.map((e) => e.date);
  assert.deepEqual(dates, [...dates].sort(), '事件必須依日期排序');
  assert.equal(clock.byDate['2026-09-18'][0].ticker, 'COST');
  assert.equal(clock.byDate['2026-09-18'][0].sector, 'Consumer Staples');
});

test('signalScorecard：命中率、提升與 IC 的計算方向正確', () => {
  const rows = [];
  const horizons = [1, 5, 20];
  for (let i = 0; i < 120; i++) {
    const good = i % 2 === 0;
    const forward = {};
    for (const h of horizons) forward[h] = good ? 0.01 * h : -0.005 * h;
    rows.push({
      date: '2026-01-01',
      ticker: `T${i}`,
      x: {
        freshness: good ? 0.9 : 0.1,
        buyCount90: good ? 1 : 0,
        buyNet90: good ? 1 : 0,
        mom60: 0, mom20: 0, excess60: 0, vol20: 0.2, distHigh: -0.1, volRatio: 1,
        policySens: 0, policyEvents60: 0,
      },
      forwardReturn: forward[20],
      y: good ? 1 : 0,
      forward,
    });
  }
  const sc = signalScorecard(rows, horizons);
  assert.equal(sc.sampleCount, 120);
  assert.equal(sc.overall.length, 3);
  for (const o of sc.overall) assert.equal(o.hitRate, 0.5);
  const fresh = sc.signals.find((s) => s.key === 'freshBuy');
  assert.ok(fresh, '應有「近 30 天內有買入申報」條件');
  for (const b of fresh.byHorizon) {
    assert.equal(b.hitRate, 1, '符合條件的全部上漲');
    assert.ok(b.lift > 0.4);
  }
  const icFresh = sc.ic.find((f) => f.key === 'freshness');
  const at20 = icFresh.byHorizon.find((b) => b.horizon === 20);
  assert.ok(at20.ic > 0.9, `freshness 與未來報酬應高度正相關，實際 ${at20.ic}`);
});

/* --------------------------- 市場體制 --------------------------- */

function makeRegimeSeries(overrides = {}) {
  const symbols = Object.values(REGIME_SYMBOLS);
  const base = {};
  symbols.forEach((sym, k) => {
    base[sym] = makeSeries(420, (i) => 1 + Math.sin((i + k * 11) / 40) * 0.003 + (k % 3 === 0 ? 0.0004 : -0.0002));
  });
  /* 讓 SPY 明顯向上、VIX 明顯向下，方便驗證方向 */
  base[REGIME_SYMBOLS.spy] = makeSeries(420, () => 1.0015);
  base[REGIME_SYMBOLS.vix] = makeSeries(420, () => 0.998);
  return { ...base, ...overrides };
}

test('expandingPercentile：只用當日之前的資料，樣本不足回 null', () => {
  const rising = Array.from({ length: 100 }, (_, i) => i);
  assert.equal(expandingPercentile(rising, 10, 60), null, '樣本不足應回 null');
  assert.equal(expandingPercentile(rising, 99, 60), 100, '創新高時百分位為 100');
  const falling = rising.slice().reverse();
  /* 百分位 = 「歷史上有多少比例的值 ≤ 今日值」。創新低時只有自己，所以約為 1%；
     配合 riskOn = -1 的維度（例如 VIX），分數 = 100 - 1 = 99，代表極度風險偏好。 */
  assert.equal(expandingPercentile(falling, 99, 60), 1, '持續破底時百分位約 1%');
});

test('computeRegime：15 個維度、分數落在 0~100、且不使用未來資料', () => {
  const series = makeRegimeSeries();
  const regime = computeRegime({ series });
  assert.equal(regime.ok, true);
  assert.equal(regime.dimensions.length, REGIME_DIMENSIONS.length);
  assert.ok(regime.score >= 0 && regime.score <= 100, `分數應在 0~100，實際 ${regime.score}`);
  for (const d of regime.dimensions) {
    if (d.score === null) continue;
    assert.ok(d.score >= 0 && d.score <= 100);
  }

  /* 只用前面 300 天計算一次，再把剩下 120 天接上重算：早期時間軸不應改變 */
  const shortSpy = series[REGIME_SYMBOLS.spy].slice(0, 300);
  const shortSeries = {};
  for (const k of Object.keys(series)) shortSeries[k] = series[k].slice(0, 300);
  const shortRegime = computeRegime({ series: shortSeries });
  const fullRegime = computeRegime({ series });
  const shortLast = shortRegime.timeline[shortRegime.timeline.length - 1];
  const sameDateInFull = fullRegime.timeline.find((t) => t.date === shortLast.date);
  assert.ok(sameDateInFull, '日期應該對得上');
  assert.equal(sameDateInFull.overall, shortLast.overall, '擴張視窗下，加入未來資料不應改變歷史分數');
  assert.equal(shortSpy.length, 300);
});

test('computeRegime：多頭股市＋下滑波動應偏向風險偏好', () => {
  /* 等速上漲會讓「距 200 日均線」收斂成常數，百分位約 50%；
     這裡用「加速上漲」才會讓距離持續擴大，趨勢維度才會給高分。 */
  const series = makeRegimeSeries({
    [REGIME_SYMBOLS.spy]: makeSeries(420, (i) => 1 + 0.0002 + (i / 420) * 0.0022),
  });
  const regime = computeRegime({ series });
  const trend = regime.dimensions.find((d) => d.id === 'trend');
  const vol = regime.dimensions.find((d) => d.id === 'volLevel');
  assert.ok(trend.score > 50, `加速上漲應偏風險偏好，實際 ${trend.score}`);
  assert.ok(vol.score > 50, `波動下滑應偏風險偏好，實際 ${vol.score}`);
  assert.ok(regime.score > 45, `整體應偏風險偏好或中性，實際 ${regime.score}`);
});

test('regimeScoreOn：取當日或之前最近的一筆', () => {
  const timeline = [
    { date: '2026-01-01', overall: 30 },
    { date: '2026-02-01', overall: 70 },
    { date: '2026-03-01', overall: 55 },
  ];
  assert.equal(regimeScoreOn(timeline, '2025-12-31'), null);
  assert.equal(regimeScoreOn(timeline, '2026-01-15').overall, 30);
  assert.equal(regimeScoreOn(timeline, '2026-02-01').overall, 70);
  assert.equal(regimeScoreOn(timeline, '2026-04-01').overall, 55);
});

test('regimeConditionalScorecard：分組與提升的計算正確', () => {
  /* 造 200 筆觀察值：風險偏好期間全部上漲、風險趨避期間全部下跌 */
  const timeline = [
    { date: '2026-01-01', overall: 80 },
    { date: '2026-02-01', overall: 20 },
  ];
  const rows = [];
  for (let i = 0; i < 200; i++) {
    const date = i < 100 ? '2026-01-15' : '2026-02-15';
    const up = i < 100;
    rows.push({
      date,
      ticker: `T${i}`,
      x: { freshness: 1, buyCount90: 1, buyNet90: 1, mom60: 0, mom20: 0, excess60: 0, vol20: 0.2, distHigh: -0.1, volRatio: 1, policySens: 0, policyEvents60: 0 },
      forward: { 1: up ? 0.01 : -0.01, 5: up ? 0.02 : -0.02, 20: up ? 0.05 : -0.05, 60: up ? 0.08 : -0.08 },
      forwardReturn: up ? 0.05 : -0.05,
      y: up ? 1 : 0,
    });
  }
  const conditions = [
    { key: 'freshBuy', label: '近 30 天內有買入申報', test: (r) => r.x.freshness > 0.5 },
  ];
  const sc = regimeConditionalScorecard(rows, timeline, conditions, [1, 5, 20, 60]);
  assert.equal(sc.sampleCount, 200);
  const riskOn = sc.overall.find((b) => b.id === 'riskOn');
  const riskOff = sc.overall.find((b) => b.id === 'riskOff');
  assert.equal(riskOn.n, 100);
  assert.equal(riskOff.n, 100);
  assert.equal(riskOn.byHorizon.find((x) => x.horizon === 20).hitRate, 1);
  assert.equal(riskOff.byHorizon.find((x) => x.horizon === 20).hitRate, 0);
  const sig = sc.signals[0];
  assert.equal(sig.byBucket.find((b) => b.id === 'riskOn').n, 100);
  /* 同體制基準：風險偏好期間全體命中率也是 100%，所以提升為 0 */
  assert.equal(sig.byBucket.find((b) => b.id === 'riskOn').byHorizon.find((x) => x.horizon === 20).lift, 0);
  assert.ok(sc.overall.find((b) => b.id === 'neutral').n === 0);
});

/* --------------------------- 我的部位 --------------------------- */

test('normalizePositions：容忍欄位大小寫與金額格式，並回報無效列', () => {
  const { positions, errors } = normalizePositions([
    { Ticker: 'nvda', Shares: '120', 'Avg Cost': '$180.50' },
    { ticker: 'AMZN', shares: '80' },
    { ticker: '', shares: '10' },
    { ticker: 'MSFT', shares: 'abc' },
  ]);
  assert.equal(positions.length, 2);
  assert.equal(positions[0].ticker, 'NVDA');
  assert.equal(positions[0].shares, 120);
  assert.equal(positions[0].avgCost, 180.5);
  assert.equal(positions[1].avgCost, null, '沒有成本時應為 null 而不是 0');
  assert.equal(errors.length, 2);
  assert.match(errors[0].reason, /股票代號/);
  assert.match(errors[1].reason, /股數/);
});

test('analyzePositions：權重、集中度警示與流動性計算正確', () => {
  const series = makeSeries(120, () => 1); /* 收盤 100、量 1,000,000 → 日成交金額 $100M */
  const market = { series: { AAA: series, BBB: series }, benchmark: series };
  const capacity = [
    { ticker: 'AAA', close: 100, adv20Value: 100_000_000, adv20Shares: 1_000_000, tailRisk95: 0.02, liquidity: '中', tradeCount: 1 },
    { ticker: 'BBB', close: 100, adv20Value: 100_000_000, adv20Shares: 1_000_000, tailRisk95: 0.04, liquidity: '中', tradeCount: 0 },
  ];
  const analysis = analyzePositions({
    positions: [
      { ticker: 'AAA', shares: 900, avgCost: 90 }, /* 市值 90,000 */
      { ticker: 'BBB', shares: 100, avgCost: 110 }, /* 市值 10,000 */
    ],
    market,
    capacity,
    policy: null,
    sectors: { AAA: 'Technology', BBB: 'Healthcare' },
    asOf: series[series.length - 1].date,
  });

  assert.equal(analysis.summary.positionCount, 2);
  assert.equal(analysis.summary.totalValue, 100000);
  const aaa = analysis.rows.find((r) => r.ticker === 'AAA');
  const bbb = analysis.rows.find((r) => r.ticker === 'BBB');
  assert.ok(Math.abs(aaa.weight - 0.9) < 1e-9);
  assert.ok(Math.abs(bbb.weight - 0.1) < 1e-9);
  assert.equal(analysis.summary.totalPnl, 10000 - 11000 + (90000 - 81000)); /* +8,000 */
  assert.ok(Math.abs(aaa.pnlPct - (90000 / 81000 - 1)) < 1e-9);
  /* 900 股 ÷ 1,000,000 股均量 = 0.09% */
  assert.ok(Math.abs(aaa.advShare - 0.0009) < 1e-6);
  /* 90% 權重應觸發集中度警示 */
  assert.ok(analysis.warnings.some((w) => w.ticker === 'AAA' && /單一部位/.test(w.text)));
  assert.ok(analysis.warnings.some((w) => w.ticker === '組合' && /產業集中/.test(w.text)));
  /* 組合單日風險 = 0.9×0.02 + 0.1×0.04 = 0.022 */
  assert.ok(Math.abs(analysis.summary.portfolioTailRisk - 0.022) < 1e-9);
});

test('analyzePositions：財報與下跌機率警示會帶進部位表', () => {
  const series = makeSeries(120, () => 1);
  const market = { series: { AAA: series }, benchmark: series };
  const analysis = analyzePositions({
    positions: [{ ticker: 'AAA', shares: 10, avgCost: null }],
    market,
    capacity: [{ ticker: 'AAA', close: 100, adv20Value: 5e9, adv20Shares: 5e7, tailRisk95: 0.01, liquidity: '極高', tradeCount: 0 }],
    probability: { predictions: [{ ticker: 'AAA', probUp: 0.3, probDown: 0.7 }] },
    events: { events: [{ type: 'earnings', ticker: 'AAA', date: '2026-09-20', detail: '盤後' }] },
    sectors: {},
    asOf: series[series.length - 1].date,
  });
  assert.equal(analysis.rows[0].prob.down, 0.7);
  assert.equal(analysis.rows[0].earnings.date, '2026-09-20');
  assert.ok(analysis.warnings.some((w) => /財報將至/.test(w.text)));
  assert.ok(analysis.warnings.some((w) => /下跌機率排行/.test(w.text)));
  assert.equal(analysis.rows[0].cost, null);
  assert.equal(analysis.rows[0].pnl, null);
});

/* --------------------------- SEC Form 4 內部人交易 --------------------------- */

const FORM4_FIXTURE = `<?xml version="1.0"?>
<ownershipDocument>
  <documentType>4</documentType>
  <periodOfReport>2026-09-09</periodOfReport>
  <issuer>
    <issuerCik>0001543151</issuerCik>
    <issuerName>Uber Technologies, Inc</issuerName>
    <issuerTradingSymbol>UBER</issuerTradingSymbol>
  </issuer>
  <reportingOwner>
    <reportingOwnerId>
      <rptOwnerCik>0001234567</rptOwnerCik>
      <rptOwnerName>KHOSROWSHAHI DARA</rptOwnerName>
    </reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>0</isDirector>
      <isOfficer>1</isOfficer>
      <isTenPercentOwner>0</isTenPercentOwner>
      <officerTitle>Chief Executive Officer</officerTitle>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-09-09</value></transactionDate>
      <transactionCoding>
        <transactionFormType>4</transactionFormType>
        <transactionCode>P</transactionCode>
        <aff10b5One>0</aff10b5One>
      </transactionCoding>
      <transactionAmounts>
        <transactionShares><value>141000</value></transactionShares>
        <transactionPricePerShare><value>70.9642</value></transactionPricePerShare>
      </transactionAmounts>
      <postTransactionAmounts>
        <sharesOwnedFollowingTransaction><value>1000000</value></sharesOwnedFollowingTransaction>
      </postTransactionAmounts>
      <ownershipNature>
        <directOrIndirectOwnership><value>D</value></directOrIndirectOwnership>
      </ownershipNature>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-09-08</value></transactionDate>
      <transactionCoding>
        <transactionFormType>4</transactionFormType>
        <transactionCode>S</transactionCode>
      </transactionCoding>
      <transactionAmounts>
        <transactionShares><value>1000</value></transactionShares>
        <transactionPricePerShare><value>75.5</value></transactionPricePerShare>
      </transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>`;

test('xmlBlocks / xmlText：可處理同名巢狀標籤與實體解碼', () => {
  const xml = '<a><b><value>1</value></b><b><value>2</value></b><c>Chairman &amp; CEO</c></a>';
  const blocks = xmlBlocks(xml, 'b');
  assert.equal(blocks.length, 2);
  assert.equal(xmlText(blocks[1], 'value'), '2');
  assert.equal(xmlText(xml, 'c'), 'Chairman & CEO', '應解碼 &amp;');
});

test('parseForm4：解析發行人、申報人角色與逐筆交易', () => {
  const parsed = parseForm4(FORM4_FIXTURE);
  assert.equal(parsed.ticker, 'UBER');
  assert.equal(parsed.issuerCik, '0001543151');
  assert.equal(parsed.issuerName, 'Uber Technologies, Inc');
  assert.equal(parsed.ownerName, 'KHOSROWSHAHI DARA');
  assert.equal(parsed.isOfficer, true);
  assert.equal(parsed.isDirector, false);
  assert.equal(parsed.officerTitle, 'Chief Executive Officer');
  assert.equal(parsed.transactions.length, 2);
  const buy = parsed.transactions[0];
  assert.equal(buy.code, 'P');
  assert.equal(buy.date, '2026-09-09');
  assert.equal(buy.shares, 141000);
  assert.equal(buy.price, 70.9642);
  assert.ok(Math.abs(buy.value - 141000 * 70.9642) < 0.01);
  assert.equal(buy.plan, false);
  assert.equal(buy.sharesAfter, 1000000);
  /* 沒勾 10b5-1 且標籤不存在時應為 null（未知），不是 false */
  assert.equal(parsed.transactions[1].plan, null);
});

test('roleOf：依職位給不同權重', () => {
  assert.equal(roleOf({ isOfficer: true, officerTitle: 'Chief Executive Officer' }).id, 'executive');
  assert.equal(roleOf({ isOfficer: true, officerTitle: 'Chief Executive Officer' }).weight, 1);
  assert.equal(roleOf({ isDirector: true }).id, 'director');
  assert.equal(roleOf({ isTenPercentOwner: true }).id, 'tenPercent');
  assert.equal(roleOf({}).id, 'other');
});

test('flattenForm4：攤平後保留角色與代碼標籤', () => {
  const parsed = parseForm4(FORM4_FIXTURE);
  const rows = flattenForm4(parsed, { filedDate: '2026-09-10', accession: '0001-26-000001' });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ticker, 'UBER');
  assert.equal(rows[0].filedDate, '2026-09-10');
  assert.equal(rows[0].codeLabel, '公開市場買進');
  assert.equal(rows[0].kind, 'buy');
  assert.equal(rows[1].codeLabel, '公開市場賣出');
  assert.equal(rows[0].ownerRoleLabel, 'Chief Executive Officer');
});

test('summarizeInsiders：集群買進、金額與分數計算', () => {
  const parsed = parseForm4(FORM4_FIXTURE);
  const base = flattenForm4(parsed, { filedDate: '2026-09-10' });
  /* 加上第二位內部人在同一週買進 → 集群 2 人 */
  const second = base[0] && {
    ...base[0],
    ownerName: 'MACDONALD ANDREW',
    officerTitle: 'Chief Operating Officer',
    code: 'P',
    date: '2026-09-11',
    value: 5_000_000,
    shares: 70000,
  };
  const rows = summarizeInsiders([...base, second], { asOf: '2026-09-12', windowDays: 90 });
  const uber = rows.find((r) => r.ticker === 'UBER');
  assert.ok(uber);
  assert.equal(uber.buyCount, 2);
  assert.equal(uber.buyerCount, 2);
  assert.equal(uber.cluster, 2, '同一週兩位內部人買進應判定為集群 2');
  assert.ok(Math.abs(uber.buyValue - (141000 * 70.9642 + 5_000_000)) < 1);
  assert.equal(uber.sellCount, 1);
  assert.ok(uber.score > 0);
  assert.ok(uber.flags.some((f) => /集群/.test(f.text)));
});

test('summarizeInsiders：只有薪酬紀錄時沒有分數，且標記無實質買賣', () => {
  const base = flattenForm4(parseForm4(FORM4_FIXTURE), { filedDate: '2026-09-10' });
  const grants = base.map((t) => ({ ...t, code: 'F', value: 0 }));
  const rows = summarizeInsiders(grants, { asOf: '2026-09-12', windowDays: 90 });
  const uber = rows.find((r) => r.ticker === 'UBER');
  assert.equal(uber.score, 0);
  assert.equal(uber.buyCount, 0);
  assert.ok(uber.flags.some((f) => /薪酬/.test(f.text)));
});

test('recentTransactions：先過濾代碼再取前 N 筆（買進不會被賣出洗掉）', () => {
  const trades = [];
  /* 一筆很久以前的買進，後面接 300 筆新賣出 */
  trades.push({
    ticker: 'XXX', date: '2026-06-01', code: 'P', value: 1_000_000, ownerName: 'A',
    officerTitle: '', isDirector: true, shares: 100, price: 10, sharesAfter: 100, kind: 'buy',
  });
  for (let i = 0; i < 300; i++) {
    trades.push({
      ticker: 'XXX', date: '2026-08-01', code: 'S', value: 1000, ownerName: 'B',
      officerTitle: '', isDirector: false, shares: 10, price: 10, sharesAfter: 10, kind: 'sell',
    });
  }
  const buys = recentTransactions(trades, { asOf: '2026-09-01', windowDays: 200, limit: 10, codes: ['P'] });
  assert.equal(buys.length, 1, '買進應該保留，不能被賣出擠掉');
  assert.equal(buys[0].code, 'P');
});
