/* ============================================================================
   內建「示範資料集」
   ⚠️ 這份資料是為了讓 App 可以完整運作而建立的模擬申報紀錄，
      不是特朗普本人的真實交易。請以 CSV/JSON 匯入真實申報資料後再依賴分析結果。
   ========================================================================== */

export const SECTORS = {
  NVDA: '半導體',
  AVGO: '半導體',
  AMD: '半導體',
  MSFT: '軟體與雲端',
  GOOGL: '軟體與雲端',
  META: '軟體與雲端',
  PLTR: '軟體與雲端',
  AAPL: '消費電子',
  AMZN: '消費與零售',
  TSLA: '電動車',
  LMT: '航太與國防',
  RTX: '航太與國防',
  GD: '航太與國防',
  JPM: '金融',
  GS: '金融',
  V: '金融',
  COIN: '金融',
  XOM: '能源',
  CVX: '能源',
  UNH: '醫療',
  DE: '工業',
};

export const DEMO_META = {
  demo: true,
  datasetName: '示範資料集（模擬申報紀錄）',
  filer: '美國總統特朗普（模擬）',
  asOf: '2026-09-11',
  note:
    '此資料集為模擬內容，用於驗證 App 的評分、組合建議與回測流程。' +
    '真實分析請匯入 OGE 278-T 或國會交易申報匯出檔。',
  priceNote: '價格序列為可重現的模擬資料（幾何布朗運動 + 跳躍事件），不是真實市價。',
};

/* 真實資料來源（請自行核對可用性與最新狀態） */
export const DATA_SOURCES = [
  {
    name: 'OGE 美國政府倫理署 — 總統財務揭露',
    url: 'https://www.oge.gov/web/oge.nsf/Officials%27%20Financial%20Disclosures',
    note: '總統的 278-T 定期交易申報正本，含成交日、申報日與金額區間。',
  },
  {
    name: '美國聯邦公報 Federal Register',
    url: 'https://www.federalregister.gov',
    note: '總統與高階官員財務揭露文件的公告與下載。',
  },
  {
    name: 'Capitol Trades',
    url: 'https://www.capitoltrades.com',
    note: '把國會與行政部門申報整理成可下載表格，方便轉成 App 匯入格式。',
  },
  {
    name: 'Quiver Quantitative — 政治人物交易',
    url: 'https://www.quiverquant.com',
    note: '提供 API 與 CSV 匯出，可接成自動同步來源。',
  },
  {
    name: '美國參議院 eFD 電子申報系統',
    url: 'https://efdsearch.senate.gov',
    note: '參議員與高階官員的電子財務申報。',
  },
  {
    name: '美國眾議院書記官辦公室 — 財務揭露',
    url: 'https://disclosures-clerk.house.gov',
    note: '眾議員交易申報 PDF 與索引檔。',
  },
];

export const IMPORT_TEMPLATE_CSV = [
  'tradeDate,filedDate,ticker,company,side,amountMin,amountMax,owner,source',
  '2026-08-18,2026-09-08,AMZN,Amazon.com Inc,BUY,1000001,5000000,本人,OGE 278-T',
  '2026-08-25,2026-09-09,PLTR,Palantir Technologies,BUY,1000001,5000000,家族信託,OGE 278-T',
].join('\n');

/* 金額以 OGE 法定申報區間（美元）表示 */
const T = (tradeDate, filedDate, ticker, company, side, amountMin, amountMax, owner, extra = '') => ({
  tradeDate,
  filedDate,
  ticker,
  company,
  side,
  amountMin,
  amountMax,
  owner: owner || '本人',
  source: 'OGE 278-T（示範）',
  note: extra,
});

export const DEMO_TRADES = [
  /* --- 半導體 --- */
  T('2025-11-04', '2025-12-02', 'NVDA', 'NVIDIA Corp', 'BUY', 100001, 250000, '第三方管理帳戶'),
  T('2026-01-13', '2026-02-10', 'NVDA', 'NVIDIA Corp', 'BUY', 500001, 1000000, '本人'),
  T('2026-06-09', '2026-07-07', 'NVDA', 'NVIDIA Corp', 'BUY', 1000001, 5000000, '本人', '申報延遲 28 天'),
  T('2026-07-21', '2026-08-14', 'NVDA', 'NVIDIA Corp', 'BUY', 250001, 500000, '家族信託'),
  T('2026-02-24', '2026-03-20', 'AVGO', 'Broadcom Inc', 'BUY', 250001, 500000, '本人'),
  T('2026-07-28', '2026-08-25', 'AVGO', 'Broadcom Inc', 'BUY', 500001, 1000000, '本人'),
  T('2026-05-12', '2026-06-09', 'AMD', 'Advanced Micro Devices', 'BUY', 250001, 500000, '家族信託'),
  T('2026-08-12', '2026-09-04', 'AMD', 'Advanced Micro Devices', 'BUY', 500001, 1000000, '家族信託'),

  /* --- 軟體與雲端 --- */
  T('2025-10-21', '2025-11-18', 'MSFT', 'Microsoft Corp', 'BUY', 100001, 250000, '第三方管理帳戶'),
  T('2026-04-14', '2026-05-12', 'MSFT', 'Microsoft Corp', 'BUY', 250001, 500000, '本人'),
  T('2026-08-04', '2026-08-28', 'MSFT', 'Microsoft Corp', 'SELL', 100001, 250000, '本人', '獲利了結'),
  T('2026-03-03', '2026-04-01', 'GOOGL', 'Alphabet Inc', 'BUY', 250001, 500000, '本人'),
  T('2026-06-16', '2026-07-14', 'GOOGL', 'Alphabet Inc', 'BUY', 500001, 1000000, '本人'),
  T('2026-08-11', '2026-09-03', 'GOOGL', 'Alphabet Inc', 'BUY', 250001, 500000, '家族信託'),
  T('2026-02-10', '2026-03-10', 'META', 'Meta Platforms Inc', 'BUY', 100001, 250000, '本人'),
  T('2026-07-07', '2026-08-04', 'META', 'Meta Platforms Inc', 'SELL', 250001, 500000, '本人', '減碼'),
  T('2026-04-28', '2026-05-26', 'PLTR', 'Palantir Technologies', 'BUY', 500001, 1000000, '本人'),
  T('2026-06-02', '2026-06-30', 'PLTR', 'Palantir Technologies', 'BUY', 250001, 500000, '本人'),
  T('2026-08-25', '2026-09-09', 'PLTR', 'Palantir Technologies', 'BUY', 1000001, 5000000, '家族信託'),

  /* --- 消費與電動車 --- */
  T('2025-12-09', '2026-01-06', 'AAPL', 'Apple Inc', 'BUY', 100001, 250000, '第三方管理帳戶'),
  T('2026-05-19', '2026-06-16', 'AAPL', 'Apple Inc', 'BUY', 250001, 500000, '本人'),
  T('2026-01-27', '2026-02-24', 'AMZN', 'Amazon.com Inc', 'BUY', 250001, 500000, '本人'),
  T('2026-06-23', '2026-07-21', 'AMZN', 'Amazon.com Inc', 'BUY', 500001, 1000000, '本人'),
  T('2026-08-18', '2026-09-08', 'AMZN', 'Amazon.com Inc', 'BUY', 1000001, 5000000, '本人'),
  T('2025-10-14', '2025-11-12', 'TSLA', 'Tesla Inc', 'SELL', 100001, 250000, '本人', '減碼'),
  T('2026-03-17', '2026-04-14', 'TSLA', 'Tesla Inc', 'BUY', 100001, 250000, '本人'),

  /* --- 航太與國防 --- */
  T('2026-01-06', '2026-02-03', 'LMT', 'Lockheed Martin Corp', 'BUY', 250001, 500000, '本人'),
  T('2026-05-05', '2026-06-02', 'LMT', 'Lockheed Martin Corp', 'BUY', 500001, 1000000, '家族信託'),
  T('2026-02-17', '2026-03-17', 'RTX', 'RTX Corp', 'BUY', 100001, 250000, '本人'),
  T('2026-06-30', '2026-07-28', 'RTX', 'RTX Corp', 'BUY', 250001, 500000, '本人'),
  T('2026-04-07', '2026-05-05', 'GD', 'General Dynamics Corp', 'BUY', 100001, 250000, '第三方管理帳戶'),

  /* --- 金融 --- */
  T('2025-11-18', '2025-12-16', 'JPM', 'JPMorgan Chase & Co', 'BUY', 250001, 500000, '本人'),
  T('2026-07-14', '2026-08-11', 'JPM', 'JPMorgan Chase & Co', 'BUY', 500001, 1000000, '本人'),
  T('2026-05-26', '2026-06-23', 'GS', 'Goldman Sachs Group Inc', 'BUY', 250001, 500000, '本人'),
  T('2026-03-24', '2026-04-21', 'V', 'Visa Inc', 'BUY', 100001, 250000, '第三方管理帳戶'),
  T('2026-07-01', '2026-07-29', 'COIN', 'Coinbase Global Inc', 'BUY', 100001, 250000, '家族信託'),

  /* --- 能源 --- */
  T('2025-10-28', '2025-11-25', 'XOM', 'Exxon Mobil Corp', 'BUY', 500001, 1000000, '本人'),
  T('2026-04-21', '2026-05-19', 'XOM', 'Exxon Mobil Corp', 'BUY', 250001, 500000, '本人'),
  T('2026-08-06', '2026-09-01', 'CVX', 'Chevron Corp', 'BUY', 100001, 250000, '本人'),

  /* --- 醫療與工業 --- */
  T('2026-06-10', '2026-07-08', 'UNH', 'UnitedHealth Group Inc', 'SELL', 250001, 500000, '本人', '減碼'),
  T('2026-01-20', '2026-02-17', 'DE', 'Deere & Co', 'BUY', 100001, 250000, '第三方管理帳戶'),
];

export function demoStore() {
  return {
    meta: { ...DEMO_META, importedAt: null, source: 'builtin' },
    sectors: { ...SECTORS },
    trades: DEMO_TRADES.map((t, i) => ({ ...t, id: `${t.ticker}-${t.tradeDate}-${i}` })),
  };
}
