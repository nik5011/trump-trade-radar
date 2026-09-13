/* ============================================================================
   我的部位：把「我的帳」跟網站上所有訊號交叉比對

   輸入只需要 ticker、股數，成本（選填）。輸出：
     1. 部位明細（市值、權重、未實現損益、流動性、跳空風險）
     2. 風險彙總（產業集中度、政策曝險、組合單日風險、最大部位）
     3. 訊號交叉比對（監控名單、申報訊號、AI 機率、財報日、事件）
     4. 警示（集中度、流動性、事件將至、政策逆風、位於下跌機率排行）
   ========================================================================== */

export const POSITION_FIELDS = [
  { key: 'ticker', label: '股票代號', required: true },
  { key: 'shares', label: '股數', required: true },
  { key: 'avgCost', label: '平均成本（選填）', required: false },
];

export const POSITION_TEMPLATE_CSV = [
  'ticker,shares,avgCost',
  'NVDA,120,180.50',
  'AMZN,80,230.00',
  'COST,25,900.00',
].join('\n');

export function normalizePositions(rows) {
  const out = [];
  const errors = [];
  rows.forEach((row, i) => {
    const get = (key) => {
      for (const k of Object.keys(row)) {
        if (k.toLowerCase().replace(/[\s_-]/g, '') === key.toLowerCase()) {
          const v = row[k];
          if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
        }
      }
      return '';
    };
    const ticker = get('ticker').toUpperCase().replace(/\s+/g, '');
    const shares = Number(get('shares').replace(/[^0-9.\-]/g, ''));
    const avgCostRaw = get('avgcost') || get('cost') || get('avgprice');
    const avgCost = avgCostRaw ? Number(avgCostRaw.replace(/[^0-9.\-]/g, '')) : null;
    if (!ticker || !Number.isFinite(shares) || shares === 0) {
      errors.push({ rowNumber: i + 2, reason: !ticker ? '缺少股票代號' : '股數無法解析', row });
      return;
    }
    out.push({
      ticker,
      shares,
      avgCost: Number.isFinite(avgCost) && avgCost > 0 ? avgCost : null,
    });
  });
  return { positions: out, errors };
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

export function analyzePositions(input) {
  const {
    positions = [],
    market,
    capacity = [],
    policy = null,
    probability = null,
    events = null,
    regime = null,
    sectors = {},
    asOf,
    concentrationWarn = 0.25,
    positionWarnVsAdv = 0.05,
  } = input;

  const capByTicker = new Map(capacity.map((c) => [c.ticker, c]));
  const probByTicker = new Map(
    probability && probability.predictions ? probability.predictions.map((p) => [p.ticker, p]) : []
  );
  const earningsByTicker = new Map();
  if (events && events.events) {
    for (const e of events.events) {
      if (e.type === 'earnings' && e.ticker && !earningsByTicker.has(e.ticker)) {
        earningsByTicker.set(e.ticker, e);
      }
    }
  }

  const rows = [];
  for (const p of positions) {
    const series = market.series ? market.series[p.ticker] : null;
    const cap = capByTicker.get(p.ticker) || null;
    const close = series && series.length ? series[series.length - 1].close : cap ? cap.close : null;
    const value = close !== null ? close * p.shares : null;
    const cost = p.avgCost !== null && p.avgCost !== undefined ? p.avgCost * p.shares : null;
    const prob = probByTicker.get(p.ticker) || null;
    const pol = policy && policy.tickers ? policy.tickers[p.ticker] : null;
    const earnings = earningsByTicker.get(p.ticker) || null;
    rows.push({
      ...p,
      name: (series && null) || null,
      sector: sectors[p.ticker] || (cap && cap.sector) || '',
      close,
      value,
      cost,
      pnl: value !== null && cost !== null ? value - cost : null,
      pnlPct: value !== null && cost ? value / cost - 1 : null,
      weight: null,
      advShare: cap && cap.adv20Shares && close ? p.shares / (cap.adv20Value / close) : null,
      tailRisk95: cap ? cap.tailRisk95 : null,
      liquidity: cap ? cap.liquidity : null,
      hasPriceData: Boolean(series),
      prob: prob ? { up: prob.probUp, down: prob.probDown } : null,
      policy: pol ? { sensitivity: pol.sensitivity, themes: pol.themes.map((t) => t.name) } : null,
      earnings: earnings ? { date: earnings.date, session: earnings.detail || '' } : null,
    });
  }

  const totalValue = rows.reduce((a, r) => a + (r.value || 0), 0);
  for (const r of rows) r.weight = totalValue > 0 && r.value !== null ? r.value / totalValue : null;
  rows.sort((a, b) => (b.value || 0) - (a.value || 0));

  /* 產業集中度 */
  const bySector = {};
  for (const r of rows) {
    const key = r.sector || '未分類';
    bySector[key] = (bySector[key] || 0) + (r.weight || 0);
  }
  const sectorBreakdown = Object.entries(bySector)
    .map(([sector, weight]) => ({ sector, weight }))
    .sort((a, b) => b.weight - a.weight);

  /* 政策曝險分布 */
  const policyBuckets = { bullish: 0, bearish: 0, neutral: 0 };
  for (const r of rows) {
    if (!r.policy) continue;
    if (r.policy.sensitivity > 0) policyBuckets.bullish += r.weight || 0;
    else if (r.policy.sensitivity < 0) policyBuckets.bearish += r.weight || 0;
    else policyBuckets.neutral += r.weight || 0;
  }

  /* 組合層級的單日風險：各部位權重 × 個別 95 分位單日波動（保守上限，未考慮相關性） */
  const portfolioTailRisk = rows.reduce((a, r) => a + (r.weight || 0) * (r.tailRisk95 || 0), 0);

  const warnings = [];
  for (const r of rows) {
    if (r.weight !== null && r.weight >= concentrationWarn) {
      warnings.push({
        level: 'warn',
        ticker: r.ticker,
        text: `單一部位占 ${(r.weight * 100).toFixed(1)}%（超過 ${(concentrationWarn * 100).toFixed(0)}% 門檻）`,
      });
    }
    if (r.advShare !== null && r.advShare > positionWarnVsAdv) {
      warnings.push({
        level: 'warn',
        ticker: r.ticker,
        text: `持股市數相當於 ${(r.advShare * 100).toFixed(1)}% 的日成交量，出場可能滑價`,
      });
    }
    if (!r.hasPriceData) {
      warnings.push({ level: 'info', ticker: r.ticker, text: '不在價格分析池內（申報金額前 120 名之外），無法計算風險指標' });
    }
    if (r.earnings) {
      warnings.push({ level: 'warn', ticker: r.ticker, text: `財報將至：${r.earnings.date}（盤後跳空風險）` });
    }
    if (r.prob && r.prob.down >= 0.6) {
      warnings.push({ level: 'warn', ticker: r.ticker, text: `在 AI 機率的下跌機率排行前段（${(r.prob.down * 100).toFixed(1)}%）` });
    }
    if (r.policy && r.policy.sensitivity < 0) {
      warnings.push({ level: 'info', ticker: r.ticker, text: `政策對照為受損型：${r.policy.themes.join('、')}` });
    }
  }
  if (sectorBreakdown.length && sectorBreakdown[0].weight >= 0.4) {
    warnings.unshift({
      level: 'warn',
      ticker: '組合',
      text: `產業集中：${sectorBreakdown[0].sector} 占 ${(sectorBreakdown[0].weight * 100).toFixed(1)}%`,
    });
  }
  if (portfolioTailRisk > 0.03) {
    warnings.unshift({
      level: 'warn',
      ticker: '組合',
      text: `單日 95% 分位風險約 ${(portfolioTailRisk * 100).toFixed(2)}%（未考慮相關性，實際可能更高）`,
    });
  }

  return {
    asOf,
    rows,
    summary: {
      positionCount: rows.length,
      totalValue,
      totalCost: rows.reduce((a, r) => a + (r.cost || 0), 0) || null,
      totalPnl: rows.some((r) => r.pnl !== null) ? rows.reduce((a, r) => a + (r.pnl || 0), 0) : null,
      largestWeight: rows.length ? rows[0].weight : null,
      largestTicker: rows.length ? rows[0].ticker : null,
      sectorBreakdown,
      policyBuckets,
      portfolioTailRisk,
      withPriceData: rows.filter((r) => r.hasPriceData).length,
    },
    warnings,
    regime: regime ? { state: regime.state, score: regime.score } : null,
  };
}
