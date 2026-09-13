/* ============================================================================
   特朗普交易雷達 / Trump Trade Radar
   共用分析引擎 — 純 ES Module、零外部依賴
   同一份檔案會被 Node 後端 (server.mjs) 與瀏覽器前端 (public/app.js) 載入，
   確保「畫面看到的數字」與「API 回傳的數字」永遠一致。
   ========================================================================== */

/* ---------------------------------------------------------------------------
   1. 基礎工具
   ------------------------------------------------------------------------- */

export const PRICE_START = '2024-10-01';
export const PRICE_END = '2026-09-11';
export const DISCLOSURE_LAG_WARNING_DAYS = 30;

export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* 可重現的偽隨機數：同樣的 ticker 永遠產生同樣的價格路徑 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const round2 = (x) => Math.round(x * 100) / 100;
const LN2 = Math.log(2);
const DAY_MS = 86400000;
const toDate = (iso) => new Date(iso + 'T00:00:00Z');
const toISO = (d) => d.toISOString().slice(0, 10);

export function daysBetween(aISO, bISO) {
  return Math.round((toDate(bISO) - toDate(aISO)) / DAY_MS);
}

export function addDays(iso, n) {
  return toISO(new Date(toDate(iso).getTime() + n * DAY_MS));
}

export function isWeekend(iso) {
  const d = toDate(iso).getUTCDay();
  return d === 0 || d === 6;
}

/* 交易日（扣除週末；示範資料不含美股假期，真實使用時請以交易所行事曆為準） */
export function businessDays(startISO, endISO) {
  const out = [];
  for (let iso = startISO; iso <= endISO; iso = addDays(iso, 1)) {
    if (!isWeekend(iso)) out.push(iso);
  }
  return out;
}

export function monthKey(iso) {
  return iso.slice(0, 7);
}

/* ---------------------------------------------------------------------------
   2. 示範價格序列（明確標示為模擬資料）
   幾何布朗運動 + 跳躍事件，seed 來自 ticker，因此每次載入完全一致。
   ------------------------------------------------------------------------- */

function gaussian(rnd) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function buildPriceSeries(ticker, opts = {}) {
  const startISO = opts.startISO || PRICE_START;
  const endISO = opts.endISO || PRICE_END;
  const rnd = mulberry32(hashStr(ticker) ^ 0x9e3779b9);
  const vol = 0.17 + rnd() * 0.28;
  const drift = (rnd() - 0.42) * 0.55;
  const days = businessDays(startISO, endISO);
  const dt = Math.sqrt(1 / 252);
  let price = 35 + rnd() * 240;
  const phase = rnd() * Math.PI * 2;
  const out = [];
  for (let i = 0; i < days.length; i++) {
    const cycle = Math.sin((i / 252) * Math.PI * 2 + phase) * 0.0007;
    const shock = rnd() < 0.012 ? (rnd() - 0.45) * 0.07 : 0;
    const r = drift / 252 + cycle + shock + vol * dt * gaussian(rnd);
    price = Math.max(3, price * Math.exp(r));
    /* 模擬成交量：與波動連動，讓以量為基礎的特徵在離線模式也能運作 */
    const baseVolume = 2_000_000 + rnd() * 9_000_000;
    const spike = rnd() < 0.05 ? 1.8 + rnd() * 1.6 : 1;
    out.push({ date: days[i], close: round2(price), volume: Math.round(baseVolume * spike) });
  }
  return out;
}

export function buildMarketData(tickers, opts = {}) {
  const series = {};
  for (const t of tickers) series[t] = buildPriceSeries(t, opts);
  const len = series[tickers[0]] ? series[tickers[0]].length : 0;
  const benchmark = [];
  /* 等權指數：對每檔先做基準化（首日 = 1）再取平均，避免高價股主導指數 */
  for (let i = 0; i < len; i++) {
    const base = series[tickers[0]][i];
    let sum = 0;
    for (const t of tickers) sum += series[t][i].close / series[t][0].close;
    benchmark.push({ date: base.date, close: round2((sum / tickers.length) * 100) });
  }
  return { series, benchmark };
}

/* 找到 <= iso 的最後一個索引；找不到回 -1 */
export function indexAtOrBefore(series, iso) {
  let lo = 0;
  let hi = series.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].date <= iso) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/* 找到 >= iso 的第一個索引；找不到回 -1 */
export function indexAtOrAfter(series, iso) {
  const before = indexAtOrBefore(series, addDays(iso, -1));
  const next = before + 1;
  return next < series.length ? next : -1;
}

export function priceOn(series, iso) {
  const i = indexAtOrBefore(series, iso);
  return i < 0 ? null : series[i].close;
}

export function trailingReturn(series, asOf, tradingDays) {
  const end = indexAtOrBefore(series, asOf);
  if (end < 0) return null;
  const start = Math.max(0, end - tradingDays);
  if (start === end) return null;
  return series[end].close / series[start].close - 1;
}

/* ---------------------------------------------------------------------------
   3. 交易紀錄正規化
   支援 OGE 278-T / 眾議院與參議院申報 / Capitol Trades 匯出等常見欄位名稱。
   ------------------------------------------------------------------------- */

const FIELD_ALIASES = {
  ticker: ['ticker', 'symbol', '股票代號', '代號'],
  company: ['company', 'asset', 'issuer', '公司', '標的'],
  side: ['side', 'type', 'transaction', '買賣別', '類型'],
  tradeDate: ['tradedate', 'transactiondate', 'date', '成交日', '交易日'],
  filedDate: ['fileddate', 'disclosuredate', 'filingdate', '申報日', '揭露日'],
  amountMin: ['amountmin', 'minamount', '低標', '金額下限'],
  amountMax: ['amountmax', 'maxamount', '高標', '金額上限'],
  amountRaw: ['amount', 'amountrange', '金額', '金額區間'],
  filer: ['filer', 'owner', 'person', '申報人', '持有人'],
  source: ['source', '來源'],
};

function pick(row, key) {
  for (const alias of FIELD_ALIASES[key]) {
    for (const k of Object.keys(row)) {
      if (k.toLowerCase().replace(/[\s_-]/g, '') === alias.toLowerCase()) {
        const v = row[k];
        if (v !== undefined && v !== null && String(v).trim() !== '') return v;
      }
    }
  }
  return undefined;
}

const AMOUNT_BRACKETS = [
  [1001, 15000], [15001, 50000], [50001, 100000], [100001, 250000],
  [250001, 500000], [500001, 1000000], [1000001, 5000000], [5000001, 25000000],
  [25000001, 50000000], [50000001, 100000000],
];

function parseMoney(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && String(v).match(/\d/) ? n : null;
}

function parseAmountRange(row) {
  let min = parseMoney(pick(row, 'amountMin'));
  let max = parseMoney(pick(row, 'amountMax'));
  if (min === null && max === null) {
    const raw = pick(row, 'amountRaw');
    if (raw !== undefined) {
      const nums = String(raw).match(/[0-9][0-9,]*/g);
      if (nums && nums.length >= 2) {
        min = parseMoney(nums[0]);
        max = parseMoney(nums[nums.length - 1]);
      } else if (nums && nums.length === 1) {
        min = parseMoney(nums[0]);
        max = min;
      }
    }
  }
  if (min === null && max !== null) min = max;
  if (max === null && min !== null) max = min;
  if (min === null) return null;
  if (max < min) [min, max] = [max, min];
  return { min, max };
}

function normalizeSide(v) {
  const s = String(v || '').trim().toLowerCase();
  if (/^(buy|purchase|p|b|買入|買|新購|加碼)/.test(s)) return 'BUY';
  if (/^(sell|sale|s|賣出|賣|減碼|處分)/.test(s)) return 'SELL';
  return 'BUY';
}

function normalizeDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  const m2 = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : toISO(d);
}

export function normalizeTrade(row, index = 0) {
  const ticker = String(pick(row, 'ticker') || '').trim().toUpperCase().replace(/\s+/g, '');
  const range = parseAmountRange(row);
  const tradeDate = normalizeDate(pick(row, 'tradeDate'));
  const filedDate = normalizeDate(pick(row, 'filedDate')) || tradeDate;
  if (!ticker || !range || !tradeDate) {
    return {
      ok: false,
      reason: !ticker ? '缺少股票代號' : !tradeDate ? '缺少成交日期' : '無法解析金額區間',
      row,
    };
  }
  return {
    ok: true,
    trade: {
      id: `${ticker}-${tradeDate}-${index}`,
      ticker,
      company: String(pick(row, 'company') || ticker).trim(),
      side: normalizeSide(pick(row, 'side')),
      tradeDate,
      filedDate,
      amountMin: range.min,
      amountMax: range.max,
      owner: String(pick(row, 'filer') || '本人').trim(),
      source: String(pick(row, 'source') || '使用者匯入').trim(),
    },
  };
}

/* 超寬鬆 CSV 解析：支援雙引號、逗號、分號與 tab 分隔 */
export function parseCSV(text) {
  const clean = text.replace(/^\uFEFF/, '');
  const firstLine = clean.split(/\r?\n/)[0] || '';
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length]);
  counts.sort((a, b) => b[1] - a[1]);
  const delim = counts[0][0];
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quoted) {
      if (c === '"') {
        if (clean[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c === '\r') { /* skip */ }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  if (!nonEmpty.length) return [];
  const header = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = r[i] !== undefined ? r[i].trim() : ''; });
    return obj;
  });
}

export function importTrades(text, format) {
  let rows;
  if (format === 'json') {
    const parsed = JSON.parse(text);
    rows = Array.isArray(parsed) ? parsed : parsed.trades;
    if (!Array.isArray(rows)) throw new Error('JSON 必須是陣列，或含 trades 陣列的物件');
  } else {
    rows = parseCSV(text);
  }
  const trades = [];
  const errors = [];
  rows.forEach((r, i) => {
    const res = normalizeTrade(r, i);
    if (res.ok) trades.push(res.trade);
    else errors.push({ rowNumber: i + 2, reason: res.reason, row: r });
  });
  return { trades, errors, total: rows.length };
}

/* ---------------------------------------------------------------------------
   4. 訊號評分引擎
   ------------------------------------------------------------------------- */

export const COMPONENTS = {
  size: {
    label: '部位規模',
    short: '規模',
    desc: '近 365 天申報買入金額的中位區間總和（對數壓縮）。金額越大，代表申報人的實質信念越強。',
  },
  freshness: {
    label: '訊號新穎度',
    short: '新穎度',
    desc: '距最近一次買入申報的天數，以 45 天半衰期指數衰減。越新的申報越有跟隨價值。',
  },
  accumulation: {
    label: '加碼節奏',
    short: '加碼',
    desc: '近 180 天的分批買入次數，並對「短期集中加碼」給予加成；連續多筆買入通常勝過單筆大額。',
  },
  momentum: {
    label: '價格動能',
    short: '動能',
    desc: '以 60 日與 120 日報酬加權後的 tanh 標準化。用來避免買在已經漲完的標的。',
  },
  heat: {
    label: '申報熱度',
    short: '熱度',
    desc: '近 90 天出現在申報中的買入筆數，以及跨申報人／帳戶的重複程度。',
  },
};

export const DEFAULT_WEIGHTS = {
  size: 0.28,
  freshness: 0.22,
  accumulation: 0.2,
  momentum: 0.18,
  heat: 0.12,
};

export const DEFAULT_CONFIG = {
  freshnessHalfLifeDays: 45,
  sellPenalty: 0.35,
  minBuyAmount: 1001,
  amountForFullScore: 100000000,
  momentumScale: 0.18,
};

export function midAmount(t) {
  return (t.amountMin + t.amountMax) / 2;
}

/* ---------------------------------------------------------------------------
   價格分析用的標的池
   真實申報資料可能有上千檔標的，但價格查詢（外部 API）與前端傳輸都必須收斂，
   因此只對「申報金額最大」的前 N 檔抓價格；其餘標的動能分數以中性值處理。
   ------------------------------------------------------------------------- */

export const PRICE_UNIVERSE_LIMIT = 120;

export function selectPriceUniverse(trades, limit = PRICE_UNIVERSE_LIMIT) {
  const volume = new Map();
  for (const t of trades) {
    const v = Math.abs(midAmount(t));
    volume.set(t.ticker, (volume.get(t.ticker) || 0) + v);
  }
  const ranked = [...volume.entries()].sort((a, b) => b[1] - a[1]);
  const tickers = ranked.slice(0, limit).map(([ticker]) => ticker).sort();
  return {
    tickers,
    /* 依申報金額排序的版本（tickers 為了顯示方便已改成字母序，兩者不可混用） */
    rankedTickers: ranked.slice(0, limit).map(([ticker]) => ticker),
    total: ranked.length,
    omitted: Math.max(0, ranked.length - tickers.length),
    coveredVolume: ranked.slice(0, limit).reduce((a, [, v]) => a + v, 0),
    totalVolume: ranked.reduce((a, [, v]) => a + v, 0),
  };
}

export function tradeStats(ticker, trades, asOf, config = DEFAULT_CONFIG) {
  const mine = trades.filter((t) => t.ticker === ticker);
  const buys = mine.filter((t) => t.side === 'BUY');
  const sells = mine.filter((t) => t.side === 'SELL');
  const within = (arr, days) =>
    arr.filter((t) => {
      const age = daysBetween(t.tradeDate, asOf);
      return age >= 0 && age <= days;
    });

  const buys365 = within(buys, 365);
  const buys180 = within(buys, 180);
  const buys90 = within(buys, 90);
  const sells180 = within(sells, 180);

  const buyAmount = buys365.reduce((s, t) => s + midAmount(t), 0);
  const sellAmount = within(sells, 365).reduce((s, t) => s + midAmount(t), 0);

  const lastBuy = buys.slice().sort((a, b) => (a.tradeDate < b.tradeDate ? 1 : -1))[0];
  const daysSinceLastBuy = lastBuy ? daysBetween(lastBuy.tradeDate, asOf) : null;

  /* 近 180 天最密集的 30 天視窗內有幾筆買入 */
  const dates = buys180.map((t) => t.tradeDate).sort();
  let clusterMax = 0;
  for (let i = 0; i < dates.length; i++) {
    let n = 0;
    for (let j = i; j < dates.length; j++) {
      if (daysBetween(dates[i], dates[j]) <= 30) n++;
      else break;
    }
    clusterMax = Math.max(clusterMax, n);
  }

  const filers = new Set(buys365.map((t) => t.owner || '本人'));
  const lastFiled = mine.slice().sort((a, b) => (a.filedDate < b.filedDate ? 1 : -1))[0];
  const lags = mine.map((t) => daysBetween(t.tradeDate, t.filedDate)).filter((n) => n >= 0);
  const avgLag = lags.length ? Math.round(lags.reduce((a, b) => a + b, 0) / lags.length) : null;

  return {
    ticker,
    tradeCount: mine.length,
    buyCount: buys.length,
    sellCount: sells.length,
    buyCount90: buys90.length,
    buyCount180: buys180.length,
    sellCount180: sells180.length,
    buyAmount,
    sellAmount,
    netAmount: buyAmount - sellAmount,
    lastTradeDate: mine.length ? mine.map((t) => t.tradeDate).sort().slice(-1)[0] : null,
    lastBuyDate: lastBuy ? lastBuy.tradeDate : null,
    lastFiledDate: lastFiled ? lastFiled.filedDate : null,
    lastDisclosureLag: lastFiled ? daysBetween(lastFiled.tradeDate, lastFiled.filedDate) : null,
    avgDisclosureLag: avgLag,
    daysSinceLastBuy,
    clusterMax,
    filerCount: filers.size,
  };
}

export function scoreComponents(stats, series, asOf, weights, config = DEFAULT_CONFIG) {
  const c = config;

  const size = clamp01(
    Math.log10(1 + stats.buyAmount / 250000) / Math.log10(1 + c.amountForFullScore / 250000)
  );

  const freshness =
    stats.daysSinceLastBuy === null
      ? 0
      : clamp01(Math.exp((-LN2 * stats.daysSinceLastBuy) / c.freshnessHalfLifeDays));

  const base = Math.min(1, stats.buyCount180 / 5);
  const cluster = stats.clusterMax >= 2 ? Math.min(0.25, (stats.clusterMax - 1) * 0.125) : 0;
  const accumulation = clamp01(base * 0.85 + cluster);

  let momentum = 0.5;
  if (series) {
    const r60 = trailingReturn(series, asOf, 60);
    const r120 = trailingReturn(series, asOf, 120);
    if (r60 !== null && r120 !== null) {
      const raw = 0.65 * r60 + 0.35 * r120;
      momentum = clamp01(0.5 + 0.5 * Math.tanh(raw / c.momentumScale));
    }
  }

  const heat = clamp01(
    Math.min(1, stats.buyCount90 / 4) * 0.7 + Math.min(1, Math.max(0, stats.filerCount - 1) / 2) * 0.3
  );

  const components = { size, freshness, accumulation, momentum, heat };

  const total = stats.buyAmount + stats.sellAmount;
  const sellRatio = total > 0 ? stats.sellAmount / total : 0;
  const sellPenalty = 1 - c.sellPenalty * sellRatio;

  const wSum = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  const weighted = Object.keys(components).reduce(
    (s, k) => s + (weights[k] || 0) * components[k],
    0
  );

  return {
    components,
    sellRatio,
    sellPenalty,
    score: Math.round(clamp01((weighted / wSum) * sellPenalty) * 1000) / 10,
  };
}

function buildNarrative(ticker, stats, scored, series, asOf) {
  const reasons = [];
  const flags = [];
  const r60 = series ? trailingReturn(series, asOf, 60) : null;
  const pct = (x) => `${(x * 100).toFixed(1)}%`;

  if (stats.buyAmount > 0) {
    reasons.push(
      `近 365 天申報買入 ${stats.buyCount} 筆、金額區間合計約 $${fmtMoney(stats.buyAmount)}，` +
        `淨買入約 $${fmtMoney(stats.netAmount)}。`
    );
  }
  if (stats.daysSinceLastBuy !== null) {
    reasons.push(`最近一次買入為 ${stats.lastBuyDate}（${stats.daysSinceLastBuy} 天前）。`);
  }
  if (stats.clusterMax >= 2) {
    reasons.push(`近 180 天出現 ${stats.clusterMax} 筆集中在 30 天內的加碼，屬於分批建立部位的節奏。`);
  }
  if (stats.sellCount180 > 0) {
    reasons.push(
      `同期有 ${stats.sellCount180} 筆減碼，金額區間約 $${fmtMoney(stats.sellAmount)}，` +
        `已就淨賣出比重下調分數 ${pct(1 - scored.sellPenalty)}。`
    );
    flags.push({ level: 'warn', text: '申報期間同時存在減碼紀錄' });
  }
  if (stats.lastDisclosureLag !== null && stats.lastDisclosureLag >= DISCLOSURE_LAG_WARNING_DAYS) {
    flags.push({
      level: 'warn',
      text: `最新申報延遲 ${stats.lastDisclosureLag} 天（區間申報制），跟單時價格已非申報價`,
    });
  }
  if (r60 !== null && r60 > 0.25) {
    flags.push({ level: 'warn', text: `近 60 日已上漲 ${pct(r60)}，追高風險偏高` });
  }
  if (scored.components.freshness < 0.3 && stats.daysSinceLastBuy !== null) {
    flags.push({
      level: 'info',
      text: `訊號已過期 ${stats.daysSinceLastBuy} 天，動能分數衰减至 ${Math.round(scored.components.freshness * 100)} 分`,
    });
  }
  if (stats.buyAmount > 0 && stats.buyAmount < 50000) {
    flags.push({ level: 'info', text: '申報金額區間偏低，可能屬被動再平衡而非主動選股' });
  }
  if (!flags.some((f) => f.level === 'warn') && scored.score >= 60) {
    flags.push({ level: 'good', text: '無明顯衝突訊號，規模、新穎度與節奏一致' });
  }

  return { reasons, flags };
}

export function fmtMoney(n) {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(Math.round(n));
}

export function scoreTickers(input) {
  const {
    trades,
    market,
    sectors = {},
    weights = DEFAULT_WEIGHTS,
    config = DEFAULT_CONFIG,
    asOf = PRICE_END,
  } = input;

  /* 先把交易依標的分組：否則每個標的都要掃過全部交易，
     在真實資料（上千檔標的 × 數千筆交易）會變成數百萬次比對。 */
  const byTicker = new Map();
  for (const t of trades) {
    const list = byTicker.get(t.ticker);
    if (list) list.push(t);
    else byTicker.set(t.ticker, [t]);
  }

  const tickers = [...new Set(trades.map((t) => t.ticker))];
  const results = tickers.map((ticker) => {
    const stats = tradeStats(ticker, byTicker.get(ticker) || [], asOf, config);
    const series = market && market.series ? market.series[ticker] : null;
    const scored = scoreComponents(stats, series, asOf, weights, config);
    const narrative = buildNarrative(ticker, stats, scored, series, asOf);
    const company = (trades.find((t) => t.ticker === ticker) || {}).company || ticker;
    return {
      ticker,
      company,
      sector: sectors[ticker] || '其他',
      score: scored.score,
      components: scored.components,
      sellRatio: scored.sellRatio,
      sellPenalty: scored.sellPenalty,
      stats,
      reasons: narrative.reasons,
      flags: narrative.flags,
      momentum: {
        r60: series ? trailingReturn(series, asOf, 60) : null,
        r120: series ? trailingReturn(series, asOf, 120) : null,
      },
      lastClose: series ? priceOn(series, asOf) : null,
    };
  });

  results.sort((a, b) => b.score - a.score);
  results.forEach((r, i) => { r.rank = i + 1; });
  return results;
}

/* ---------------------------------------------------------------------------
   5. 投資組合建議
   ------------------------------------------------------------------------- */

export const DEFAULT_PORTFOLIO = {
  topN: 8,
  maxWeight: 0.18,
  sectorCap: 0.4,
  cashMin: 0.1,
  minScore: 40,
  gamma: 1.5,
};

const sum = (a) => a.reduce((x, y) => x + y, 0);

/* 單一持股上限：超額部分只分配給「還有空間」的標的，沒有空間就留成現金 */
function capStockWeight(weights, maxWeight) {
  let w = weights.slice();
  for (let it = 0; it < 100; it++) {
    const capped = w.map((x) => Math.min(x, maxWeight));
    const excess = sum(w) - sum(capped);
    if (excess <= 1e-9) return capped;
    const room = capped.map((x, i) => (x < maxWeight - 1e-9 ? i : -1)).filter((i) => i >= 0);
    if (!room.length) return capped;
    const roomTotal = sum(room.map((i) => capped[i]));
    w = capped.map((x, i) =>
      room.includes(i) ? x + excess * (roomTotal > 0 ? x / roomTotal : 1 / room.length) : x
    );
  }
  return w;
}

/* 單一產業上限：超出上限的產業按比例縮回上限，超額轉給其他產業 */
function capSectorWeight(weights, picked, cap) {
  let w = weights.slice();
  for (let it = 0; it < 100; it++) {
    const by = {};
    picked.forEach((s, i) => { by[s.sector] = (by[s.sector] || 0) + w[i]; });
    const over = Object.entries(by).filter(([, v]) => v > cap + 1e-9);
    if (!over.length) return w;
    const sector = over[0][0];
    const excess = over[0][1] - cap;
    const idxs = picked.map((s, i) => (s.sector === sector ? i : -1)).filter((i) => i >= 0);
    const others = picked.map((s, i) => (s.sector === sector ? -1 : i)).filter((i) => i >= 0);
    const sectorTotal = sum(idxs.map((i) => w[i]));
    if (sectorTotal <= 0) return w;
    const otherTotal = sum(others.map((i) => w[i]));
    const scale = (sectorTotal - excess) / sectorTotal;
    idxs.forEach((i) => { w[i] *= scale; });
    if (otherTotal > 0) others.forEach((i) => { w[i] += excess * (w[i] / otherTotal); });
    else return w;
  }
  return w;
}

export function buildPortfolio(scores, params = {}) {
  const p = { ...DEFAULT_PORTFOLIO, ...params };
  const investable = scores.filter((s) => s.score >= p.minScore && s.stats.buyAmount > 0);
  const picked = investable.slice(0, p.topN);
  const notes = [];

  if (!picked.length) {
    return {
      positions: [],
      cash: 1,
      sectorBreakdown: [],
      notes: [`沒有任何標的達到最低分數門檻 ${p.minScore} 分，建議 100% 持有現金。`],
      params: p,
    };
  }

  let weights = picked.map((s) => Math.pow(s.score, p.gamma));
  const budget = 1 - p.cashMin;
  const wSum = weights.reduce((a, b) => a + b, 0);
  weights = weights.map((w) => (w / wSum) * budget);

  /* 反覆套用「個股上限 + 產業上限」直到收斂（兩個限制會互相影響） */
  for (let round = 0; round < 12; round++) {
    const before = weights.slice();
    weights = capStockWeight(weights, p.maxWeight);
    weights = capSectorWeight(weights, picked, p.sectorCap);
    if (Math.max(...weights.map((w, i) => Math.abs(w - before[i]))) < 1e-9) break;
  }

  let positions = picked.map((s, i) => ({
    ticker: s.ticker,
    company: s.company,
    sector: s.sector,
    score: s.score,
    weight: weights[i],
    lastClose: s.lastClose,
    reason: portfolioReason(s),
    risks: s.flags.filter((f) => f.level === 'warn').map((f) => f.text),
  }));

  /* 重新正規化（避免浮點誤差）並把多餘的放回現金 */
  const gross = positions.reduce((a, b) => a + b.weight, 0);
  if (gross > budget) {
    positions = positions.map((pos) => ({ ...pos, weight: (pos.weight / gross) * budget }));
  }
  const invested = positions.reduce((a, b) => a + b.weight, 0);
  const cash = Math.max(0, 1 - invested);

  const sectorBreakdown = Object.entries(
    positions.reduce((acc, pos) => {
      acc[pos.sector] = (acc[pos.sector] || 0) + pos.weight;
      return acc;
    }, {})
  )
    .map(([sector, weight]) => ({ sector, weight }))
    .sort((a, b) => b.weight - a.weight);

  if (investable.length > p.topN) {
    notes.push(
      `候選池共 ${investable.length} 檔，僅取分數最高前 ${p.topN} 檔，其餘列為觀察名單。`
    );
  }
  if (positions.some((pos) => pos.weight >= p.maxWeight - 1e-6)) {
    notes.push(`已套用單一持股上限 ${(p.maxWeight * 100).toFixed(0)}%。`);
  }
  if (sectorBreakdown.length && sectorBreakdown[0].weight >= p.sectorCap - 1e-6) {
    notes.push(`已套用單一產業上限 ${(p.sectorCap * 100).toFixed(0)}%（最重為 ${sectorBreakdown[0].sector}）。`);
  }
  if (cash > p.cashMin + 0.02) {
    notes.push(
      `實際現金比重 ${(cash * 100).toFixed(0)}%：達到分數門檻的標的不足，` +
        `在持股上限內無法把資金全部投入（可下調最低分數或放寬上限）。`
    );
  } else {
    notes.push(`保留 ${(cash * 100).toFixed(0)}% 現金，用於吸收申報延遲期間的價格落差。`);
  }

  return { positions, cash, sectorBreakdown, notes, params: p };
}

function portfolioReason(s) {
  const top = Object.entries(s.components).sort((a, b) => b[1] - a[1])[0];
  const label = (COMPONENTS[top[0]] || {}).label || top[0];
  return `總分 ${s.score}，主要貢獻來自「${label}」（${Math.round(top[1] * 100)} 分）；` +
    `申報淨買入約 $${fmtMoney(s.stats.netAmount)}。`;
}

/* ---------------------------------------------------------------------------
   6. 事件式回測
   規則：申報日（public 日）+ N 個交易日進場，持有 M 個交易日後出場。
   刻意使用 filedDate 而非 tradeDate，避免使用當時尚未公開的資訊（look-ahead bias）。
   ------------------------------------------------------------------------- */

export const DEFAULT_BACKTEST = {
  lagDays: 1,
  holdDays: 60,
  capital: 100000,
  positionSize: 0.2,
  minAmount: 15001,
  maxConcurrent: 5,
  includeSells: false,
  feeBps: 5,
};

export function runBacktest(input) {
  const {
    trades,
    market,
    params = {},
    startISO = PRICE_START,
    endISO = PRICE_END,
  } = input;
  const p = { ...DEFAULT_BACKTEST, ...params };
  const days = businessDays(startISO, endISO);
  const events = [];

  const sideFilter = trades.filter((t) => (p.includeSells ? true : t.side === 'BUY'));
  let skippedNoPrice = 0;
  let skippedAmount = 0;
  for (const t of sideFilter) {
    const series = market.series[t.ticker];
    if (!series) {
      skippedNoPrice++;
      continue;
    }
    if (midAmount(t) < p.minAmount) {
      skippedAmount++;
      continue;
    }
    const entryIdx = indexAtOrAfter(series, addDays(t.filedDate, 0));
    if (entryIdx < 0) continue;
    const entryIdxLag = Math.min(series.length - 1, entryIdx + Math.max(0, p.lagDays - 1));
    const exitIdx = Math.min(series.length - 1, entryIdxLag + p.holdDays);
    const entryPrice = series[entryIdxLag].close;
    const exitPrice = series[exitIdx].close;
    const gross = exitPrice / entryPrice - 1;
    const fee = (p.feeBps / 10000) * 2;
    events.push({
      ticker: t.ticker,
      tradeDate: t.tradeDate,
      signalDate: t.filedDate,
      entryDate: series[entryIdxLag].date,
      exitDate: series[exitIdx].date,
      holdDaysActual: exitIdx - entryIdxLag,
      entryPrice,
      exitPrice,
      grossReturn: gross,
      netReturn: gross - fee,
      amount: midAmount(t),
    });
  }
  events.sort((a, b) => (a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : 0));

  /* 逐日模擬：現金 + 未平倉部位市值 */
  let cash = p.capital;
  const open = [];
  const equity = [];
  const perDayEvents = {};
  for (const e of events) {
    (perDayEvents[e.entryDate] = perDayEvents[e.entryDate] || []).push({ kind: 'entry', e });
    (perDayEvents[e.exitDate] = perDayEvents[e.exitDate] || []).push({ kind: 'exit', e });
  }
  /* 申報制會讓同一份申報的訊號全部擠在同一天（例如一次申報上千筆）。
     當天訊號超過持倉上限時：先處理出場以釋放名額，再依「申報金額」由大到小進場，
     避免用檔案順序決定誰被選中。 */
  for (const day of Object.keys(perDayEvents)) {
    perDayEvents[day].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'exit' ? -1 : 1;
      if (a.kind === 'entry') return (b.e.amount || 0) - (a.e.amount || 0);
      return 0;
    });
  }

  const benchStart = market.benchmark.length ? market.benchmark[indexAtOrBefore(market.benchmark, days[0])] : null;

  for (const day of days) {
    for (const item of perDayEvents[day] || []) {
      if (item.kind === 'entry') {
        if (open.length >= p.maxConcurrent) continue;
        const notional = Math.min(p.capital * p.positionSize, cash);
        if (notional < 1) continue;
        const shares = notional / item.e.entryPrice;
        cash -= notional;
        open.push({ ...item.e, shares, notional, exitOn: item.e.exitDate, counted: true });
        item.e.traded = true;
      } else {
        const idx = open.findIndex((o) => o.ticker === item.e.ticker && o.entryDate === item.e.entryDate);
        if (idx >= 0) {
          const o = open[idx];
          cash += o.shares * item.e.exitPrice * (1 - p.feeBps / 10000);
          open.splice(idx, 1);
        }
      }
    }
    let mtm = 0;
    for (const o of open) {
      const series = market.series[o.ticker];
      const i = indexAtOrBefore(series, day);
      mtm += o.shares * (i >= 0 ? series[i].close : o.entryPrice);
    }
    const bench = market.benchmark.length
      ? market.benchmark[Math.min(market.benchmark.length - 1, indexAtOrBefore(market.benchmark, day))]
      : null;
    equity.push({
      date: day,
      value: cash + mtm,
      bench: benchStart && bench ? (p.capital * bench.close) / benchStart.close : p.capital,
    });
  }

  const final = equity[equity.length - 1] || { value: p.capital, bench: p.capital };
  const returns = [];
  for (let i = 1; i < equity.length; i++) {
    returns.push(equity[i].value / equity[i - 1].value - 1);
  }
  let peak = -Infinity;
  let maxDD = 0;
  for (const pt of equity) {
    peak = Math.max(peak, pt.value);
    maxDD = Math.min(maxDD, pt.value / peak - 1);
  }
  const mean = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length
    ? returns.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, returns.length - 1)
    : 0;
  const sd = Math.sqrt(variance);
  const years = Math.max(1 / 365, days.length / 252);

  const traded = events.filter((e) => e.traded);
  const wins = traded.filter((e) => e.netReturn > 0);
  const grossWin = wins.reduce((a, b) => a + b.netReturn, 0);
  const losses = traded.filter((e) => e.netReturn <= 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b.netReturn, 0));

  return {
    params: p,
    events: traded,
    skipped: events.length - traded.length,
    skippedNoPrice,
    skippedAmount,
    signalCount: sideFilter.length,
    equity,
    stats: {
      finalValue: final.value,
      totalReturn: final.value / p.capital - 1,
      benchReturn: final.bench / p.capital - 1,
      cagr: (final.value / p.capital) ** (1 / years) - 1,
      maxDrawdown: maxDD,
      volatility: sd * Math.sqrt(252),
      sharpe: sd > 0 ? (mean / sd) * Math.sqrt(252) : 0,
      trades: traded.length,
      winRate: traded.length ? wins.length / traded.length : 0,
      avgReturn: traded.length ? traded.reduce((a, b) => a + b.netReturn, 0) / traded.length : 0,
      avgWin: wins.length ? grossWin / wins.length : 0,
      avgLoss: losses.length ? -grossLoss / losses.length : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
      exposure: equity.length
        ? equity.reduce((a, pt) => a + (pt.value > 0 ? 1 : 0), 0) / equity.length
        : 0,
    },
  };
}

/* ---------------------------------------------------------------------------
   7. 總入口：一次算出整個儀表板需要的資料
   ------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
   6.5 政策曝險與「政策事件 ↔ 交易」交集

   themes：政策主題對照表（policy-map.mjs）
   docsByTheme：每個主題已抓到的政策文件（Federal Register 官方 API）
   交集只代表時間接近，不代表因果關係。
   ------------------------------------------------------------------------- */

export const DEFAULT_POLICY_WINDOW_DAYS = 30;

export function analyzePolicy(input) {
  const {
    trades,
    themes = [],
    docsByTheme = {},
    asOf = PRICE_END,
    windowDays = DEFAULT_POLICY_WINDOW_DAYS,
  } = input;

  const byTicker = new Map();
  for (const t of trades) {
    const list = byTicker.get(t.ticker);
    if (list) list.push(t);
    else byTicker.set(t.ticker, [t]);
  }
  const days = (d) => (d ? Math.round((toDate(asOf) - toDate(d)) / DAY_MS) : null);

  const tickerExposure = {};
  const allPairs = [];
  const themeResults = [];

  for (const theme of themes) {
    const docs = (docsByTheme[theme.id] && docsByTheme[theme.id].items) || [];
    const docDates = docs
      .map((d) => ({ ...d, date: (d.publishedAt || '').slice(0, 10) }))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    const rows = [];
    const pairs = [];
    let netFlow = 0;
    let buyTotal = 0;
    let sellTotal = 0;
    let tradeCount = 0;
    let latestTrade = null;

    for (const [ticker, meta] of Object.entries(theme.exposed || {})) {
      const list = byTicker.get(ticker) || [];
      let buy = 0;
      let sell = 0;
      for (const t of list) {
        const mid = midAmount(t);
        if (t.side === 'BUY') buy += mid;
        else sell += mid;
      }
      const net = buy - sell;
      netFlow += net;
      buyTotal += buy;
      sellTotal += sell;
      tradeCount += list.length;
      for (const t of list) {
        if (!latestTrade || t.tradeDate > latestTrade) latestTrade = t.tradeDate;
      }

      /* 找出每筆交易最接近的政策文件（雙向皆算：事件前後都可能是線索） */
      for (const t of list) {
        let best = null;
        for (const d of docDates) {
          const gap = Math.round((toDate(t.tradeDate) - toDate(d.date)) / DAY_MS);
          if (Math.abs(gap) <= windowDays && (!best || Math.abs(gap) < Math.abs(best.gapDays))) {
            best = { doc: d, gapDays: gap };
          }
        }
        if (best) {
          const pair = {
            themeId: theme.id,
            themeName: theme.name,
            axis: theme.axis,
            ticker,
            direction: meta.dir,
            reason: meta.reason,
            side: t.side,
            tradeDate: t.tradeDate,
            filedDate: t.filedDate,
            amount: midAmount(t),
            docTitle: best.doc.title,
            docUrl: best.doc.link,
            docDate: best.doc.date,
            docAgency: best.doc.agencies || best.doc.agency || '',
            gapDays: best.gapDays,
            source: t.source || '',
          };
          pairs.push(pair);
          allPairs.push(pair);
        }
      }

      if (list.length) {
        rows.push({
          ticker,
          dir: meta.dir,
          reason: meta.reason,
          buy,
          sell,
          net,
          count: list.length,
          lastTradeDate: list.map((t) => t.tradeDate).sort().slice(-1)[0],
          company: list[0].company,
          sector: null,
        });
      } else {
        rows.push({
          ticker, dir: meta.dir, reason: meta.reason, buy: 0, sell: 0, net: 0, count: 0,
          lastTradeDate: null, company: null, sector: null,
        });
      }

      const exp = (tickerExposure[ticker] = tickerExposure[ticker] || {
        ticker,
        score: 0,
        themes: [],
        buy: 0,
        sell: 0,
        net: 0,
        count: 0,
      });
      exp.score += meta.dir;
      exp.themes.push({ id: theme.id, name: theme.name, dir: meta.dir, reason: meta.reason });
      exp.buy += buy;
      exp.sell += sell;
      exp.net += net;
      exp.count += list.length;
    }

    rows.sort((a, b) => b.net - a.net || b.count - a.count);
    pairs.sort(
      (a, b) => Math.abs(a.gapDays) - Math.abs(b.gapDays) || b.amount - a.amount
    );

    themeResults.push({
      id: theme.id,
      name: theme.name,
      axis: theme.axis,
      description: theme.description,
      keywords: theme.keywords,
      sources: theme.sources || [],
      docs: docDates.slice(-6).reverse(),
      docCount: docDates.length,
      bullish: rows.filter((r) => r.dir > 0).slice(0, 10),
      bearish: rows.filter((r) => r.dir < 0).slice(0, 10),
      neutral: rows.filter((r) => r.dir === 0).slice(0, 8),
      netFlow,
      buyTotal,
      sellTotal,
      tradeCount,
      lastTradeDate: latestTrade,
      exposureCount: rows.filter((r) => r.count > 0).length,
      pairs: pairs.slice(0, 12),
      pairCount: pairs.length,
    });
  }

  for (const exp of Object.values(tickerExposure)) {
    exp.daysSinceLast = null;
  }

  const maxScore = Math.max(1, ...Object.values(tickerExposure).map((e) => Math.abs(e.score)));
  for (const exp of Object.values(tickerExposure)) {
    exp.sensitivity = Math.round((exp.score / maxScore) * 100) / 100;
  }

  allPairs.sort((a, b) => Math.abs(a.gapDays) - Math.abs(b.gapDays) || b.amount - a.amount);

  return {
    asOf,
    windowDays,
    themes: themeResults,
    tickers: tickerExposure,
    pairs: allPairs,
    summary: {
      themeCount: themeResults.length,
      exposedTickers: Object.keys(tickerExposure).length,
      tradedExposedTickers: Object.values(tickerExposure).filter((e) => e.count > 0).length,
      pairCount: allPairs.length,
      docCount: themeResults.reduce((a, t) => a + t.docCount, 0),
      themeNet: themeResults.reduce((a, t) => a + t.netFlow, 0),
      windowDays,
    },
  };
}

/* 政策曝險排行：把「有交易的政策敏感標的」依曝險與金額排序 */
export function rankPolicyExposure(policy, { minTrades = 1, limit = 30 } = {}) {
  return Object.values(policy.tickers)
    .filter((t) => t.count >= minTrades)
    .map((t) => ({
      ...t,
      strength: Math.round(Math.abs(t.sensitivity) * 100 + Math.min(60, t.count * 3)),
    }))
    .sort((a, b) => b.strength - a.strength || Math.abs(b.net) - Math.abs(a.net))
    .slice(0, limit);
}

export function analyze(input) {
  const { trades, sectors = {}, weights = DEFAULT_WEIGHTS, asOf = PRICE_END } = input;
  const tickers = [...new Set(trades.map((t) => t.ticker))].sort();
  const market = input.market || buildMarketData(tickers);
  const scores = scoreTickers({ trades, market, sectors, weights, asOf });
  const portfolio = buildPortfolio(scores, input.portfolioParams);
  const backtest = runBacktest({ trades, market, params: input.backtestParams, endISO: asOf });

  const totalBuy = trades.filter((t) => t.side === 'BUY').reduce((s, t) => s + midAmount(t), 0);
  const totalSell = trades.filter((t) => t.side === 'SELL').reduce((s, t) => s + midAmount(t), 0);
  const lags = trades.map((t) => daysBetween(t.tradeDate, t.filedDate)).filter((n) => n >= 0);

  return {
    asOf,
    summary: {
      tradeCount: trades.length,
      tickerCount: tickers.length,
      totalBuy,
      totalSell,
      netAmount: totalBuy - totalSell,
      lastTradeDate: trades.map((t) => t.tradeDate).sort().slice(-1)[0] || null,
      lastFiledDate: trades.map((t) => t.filedDate).sort().slice(-1)[0] || null,
      avgDisclosureLag: lags.length ? Math.round(lags.reduce((a, b) => a + b, 0) / lags.length) : null,
      avgScore: scores.length ? Math.round((scores.reduce((a, b) => a + b.score, 0) / scores.length) * 10) / 10 : 0,
    },
    scores,
    portfolio,
    backtest,
  };
}
