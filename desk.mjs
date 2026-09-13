/* ============================================================================
   交易台用的衍生資訊
   1. 容量與流動性：這個訊號「吃得下多少錢」、「要幾天才能進出」
   2. 事件時鐘：未來 N 天有哪些會影響價格的事件（政策生效、財報、合約、評論截止）
   這兩塊是交易決策真正會用到的執行面資訊。
   ========================================================================== */

import { indexAtOrBefore, addDays } from './engine.mjs';

export const LIQUIDITY_TIERS = [
  { id: 'very-high', label: '極高', min: 1e9 },
  { id: 'high', label: '高', min: 3e8 },
  { id: 'medium', label: '中', min: 1e8 },
  { id: 'low', label: '低', min: 3e7 },
  { id: 'very-low', label: '極低', min: 0 },
];

export function liquidityTier(advValue) {
  return LIQUIDITY_TIERS.find((t) => advValue >= t.min) || LIQUIDITY_TIERS[LIQUIDITY_TIERS.length - 1];
}

/* 日報酬的第 95 百分位絕對值：用來衡量「單日跳空風險」 */
function tailRisk(series, endIdx, lookback = 60) {
  const rets = [];
  for (let k = Math.max(1, endIdx - lookback + 1); k <= endIdx; k++) {
    rets.push(Math.abs(series[k].close / series[k - 1].close - 1));
  }
  if (rets.length < 10) return null;
  rets.sort((a, b) => a - b);
  return rets[Math.min(rets.length - 1, Math.floor(rets.length * 0.95))];
}

export function computeCapacity(input) {
  const { market, trades = [], asOf, minAdvValue = 0 } = input;
  const byTicker = new Map();
  for (const t of trades) {
    const list = byTicker.get(t.ticker);
    if (list) list.push(t);
    else byTicker.set(t.ticker, [t]);
  }

  const rows = [];
  for (const [ticker, series] of Object.entries(market.series || {})) {
    if (!series || series.length < 30) continue;
    const endIdx = asOf ? indexAtOrBefore(series, asOf) : series.length - 1;
    if (endIdx < 25) continue;
    const last = series[endIdx];
    const start = Math.max(0, endIdx - 19);
    let volSum = 0;
    let volCount = 0;
    for (let k = start; k <= endIdx; k++) {
      if (Number.isFinite(series[k].volume)) {
        volSum += series[k].volume;
        volCount++;
      }
    }
    if (!volCount) continue;
    const adv20 = volSum / volCount;
    const advValue = adv20 * last.close;
    if (advValue < minAdvValue) continue;

    const own = byTicker.get(ticker) || [];
    let buy = 0;
    let sell = 0;
    let maxTrade = 0;
    for (const t of own) {
      const mid = (t.amountMin + t.amountMax) / 2;
      maxTrade = Math.max(maxTrade, mid);
      if (t.side === 'BUY') buy += mid;
      else sell += mid;
    }
    const totalDisclosed = buy + sell;
    const tier = liquidityTier(advValue);
    rows.push({
      ticker,
      close: last.close,
      adv20Shares: adv20,
      adv20Value: advValue,
      liquidity: tier.label,
      liquidityId: tier.id,
      /* 把他的申報金額全部吃下來需要幾個交易日的成交量 */
      daysForAllDisclosed: advValue > 0 ? totalDisclosed / advValue : null,
      /* 最大單筆申報要幾天 */
      daysForLargestTrade: advValue > 0 ? maxTrade / advValue : null,
      /* 實務上單日不宜超過 10% ADV，換算成「建議單筆上限」 */
      suggestedMaxPosition: advValue * 0.1,
      tailRisk95: tailRisk(series, endIdx),
      disclosedBuy: buy,
      disclosedSell: sell,
      tradeCount: own.length,
    });
  }
  rows.sort((a, b) => b.adv20Value - a.adv20Value);
  return rows;
}

/* ---------------------------------------------------------------------------
   事件時鐘：把各種未來事件合併成一條時間軸
   ------------------------------------------------------------------------- */

export const EVENT_TYPES = {
  policyEffective: { label: '政策生效', color: '#f0b429', weight: 3 },
  commentDeadline: { label: '評論截止', color: '#64a8ff', weight: 2 },
  earnings: { label: '財報', color: '#2dd4bf', weight: 4 },
  contract: { label: '合約公告', color: '#a78bfa', weight: 2 },
  filing: { label: '申報到期', color: '#94a3b8', weight: 1 },
};

export function buildEventClock(input) {
  const {
    asOf,
    days = 30,
    policyEvents = [],
    earnings = [],
    contracts = [],
    tickerSectors = {},
  } = input;
  const from = asOf;
  const to = addDays(asOf, days);

  const events = [];
  for (const e of policyEvents) {
    if (e.effectiveOn && e.effectiveOn >= from && e.effectiveOn <= to) {
      events.push({
        date: e.effectiveOn,
        type: 'policyEffective',
        title: e.title,
        detail: `${e.themeName}｜${e.agencies || ''}`,
        link: e.link,
        themeId: e.themeId,
        tickers: e.tickers || [],
        source: 'Federal Register',
      });
    }
    if (e.commentsCloseOn && e.commentsCloseOn >= from && e.commentsCloseOn <= to) {
      events.push({
        date: e.commentsCloseOn,
        type: 'commentDeadline',
        title: e.title,
        detail: `${e.themeName}｜公眾評論截止`,
        link: e.link,
        themeId: e.themeId,
        tickers: e.tickers || [],
        source: 'Federal Register',
      });
    }
  }
  for (const e of earnings) {
    if (e.date >= from && e.date <= to) {
      events.push({
        date: e.date,
        type: 'earnings',
        title: `${e.ticker} 財報（${e.session}）`,
        detail: `${e.name}${e.epsForecast ? `｜EPS 預估 ${e.epsForecast}` : ''}`,
        link: null,
        ticker: e.ticker,
        sector: tickerSectors[e.ticker] || '',
        source: 'Nasdaq 日曆',
      });
    }
  }
  for (const c of contracts) {
    const date = (c.publishedAt || '').slice(0, 10);
    if (date >= from && date <= to) {
      events.push({
        date,
        type: 'contract',
        title: c.title.slice(0, 120),
        detail: `${c.agency || ''}${c.amount ? `｜$${(c.amount / 1e6).toFixed(1)}M` : ''}`,
        link: c.link,
        source: 'USAspending',
      });
    }
  }

  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (EVENT_TYPES[b.type]?.weight || 0) - (EVENT_TYPES[a.type]?.weight || 0)));

  const byDate = {};
  for (const e of events) {
    (byDate[e.date] = byDate[e.date] || []).push(e);
  }

  return {
    asOf,
    days,
    from,
    to,
    events,
    byDate,
    counts: Object.keys(EVENT_TYPES).reduce((acc, k) => {
      acc[k] = events.filter((e) => e.type === k).length;
      return acc;
    }, {}),
  };
}
