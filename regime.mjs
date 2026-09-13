/* ============================================================================
   市場體制（market regime）

   為什麼要做這個：單一訊號脫離環境幾乎沒有意義。同一個「申報買入」訊號，
   在風險偏好與風險趨避的市場裡表現可能完全相反。

   作法：用 12 個跨資產維度，各自算出「相對自己歷史的水位」（0~100），
   再合成一個體制分數。所有百分位都用「擴張視窗」計算（只用當日之前的資料），
   避免用未來資料回頭美化歷史。

   資料全部來自 Yahoo Chart API（免費、無金鑰）。
   ========================================================================== */

export const REGIME_SYMBOLS = {
  spy: 'SPY',
  vix: '^VIX',
  tnx: '^TNX',
  irx: '^IRX',
  dxy: 'DX-Y.NYB',
  oil: 'CL=F',
  gold: 'GC=F',
  copper: 'HG=F',
  hyg: 'HYG',
  lqd: 'LQD',
  iwm: 'IWM',
  rsp: 'RSP',
  smh: 'SMH',
  eem: 'EEM',
};

/* riskOn = +1：數值越高越偏風險偏好；-1：數值越高越偏風險趨避 */
export const REGIME_DIMENSIONS = [
  { id: 'trend', label: '股市趨勢', riskOn: 1, desc: 'S&P 500 相對 200 日均線的距離' },
  { id: 'breadth', label: '市場寬度', riskOn: 1, desc: '等權重(RSP)相對市值加權(SPY)的 20 日強弱' },
  { id: 'smallcap', label: '小型股偏好', riskOn: 1, desc: 'IWM 相對 SPY 的 20 日強弱' },
  { id: 'volLevel', label: '波動水準', riskOn: -1, desc: 'VIX 絕對水位（越低越偏風險偏好）' },
  { id: 'volTrend', label: '波動變化', riskOn: -1, desc: 'VIX 20 日變化（上升代表壓力升高）' },
  { id: 'varianceRisk', label: '波動風險溢酬', riskOn: -1, desc: 'VIX ÷ SPY 20 日已實現波動（選擇權相對貴不貴）' },
  { id: 'rates', label: '利率水準', riskOn: -1, desc: '10 年期殖利率水位（越高越壓抑評價）' },
  { id: 'ratesTrend', label: '利率變化', riskOn: -1, desc: '10 年期殖利率 20 日變化' },
  { id: 'curve', label: '殖利率曲線', riskOn: 1, desc: '10 年期減 3 個月（倒掛＝景氣疑慮）' },
  { id: 'credit', label: '信用風險偏好', riskOn: 1, desc: '高收益(HYG)相對投資級(LQD)的 20 日強弱' },
  { id: 'dollar', label: '美元', riskOn: -1, desc: '美元指數 20 日變化（走強＝跨國企業逆風）' },
  { id: 'growth', label: '景氣循環', riskOn: 1, desc: '銅金比 20 日變化（景氣預期代理指標）' },
  { id: 'oil', label: '油價', riskOn: -1, desc: '油價 20 日變化（成本與通膨壓力）' },
  { id: 'tech', label: '科技領導', riskOn: 1, desc: '半導體(SMH)相對 SPY 的 20 日強弱' },
  { id: 'em', label: '新興市場', riskOn: 1, desc: 'EEM 相對 SPY 的 20 日強弱' },
];

const LN2 = Math.log(2);

function indexOnOrBefore(series, date) {
  if (!series || !series.length) return -1;
  let lo = 0;
  let hi = series.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].date <= date) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function trailingReturn(series, i, days) {
  if (i < days || i < 0 || !series[i]) return null;
  const past = series[i - days];
  if (!past || !past.close) return null;
  return series[i].close / past.close - 1;
}

function realizedVol(series, i, days = 20) {
  if (i < days) return null;
  const rets = [];
  for (let k = i - days + 1; k <= i; k++) {
    rets.push(Math.log(series[k].close / series[k - 1].close));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  return sd * Math.sqrt(252);
}

function mean(arr) {
  const v = arr.filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/* 擴張視窗百分位：只用當日之前的資料，避免前視偏誤 */
export function expandingPercentile(values, i, minObs = 60) {
  const v = values[i];
  if (!Number.isFinite(v)) return null;
  let count = 0;
  let below = 0;
  for (let k = 0; k <= i; k++) {
    if (!Number.isFinite(values[k])) continue;
    count++;
    if (values[k] <= v) below++;
  }
  if (count < minObs) return null;
  return (below / count) * 100;
}

/* 計算每日的維度原始值 */
export function computeDimensionValues(series, dates) {
  const s = series;
  const spy = s[REGIME_SYMBOLS.spy] || [];
  const vix = s[REGIME_SYMBOLS.vix] || [];
  const tnx = s[REGIME_SYMBOLS.tnx] || [];
  const irx = s[REGIME_SYMBOLS.irx] || [];
  const dxy = s[REGIME_SYMBOLS.dxy] || [];
  const oil = s[REGIME_SYMBOLS.oil] || [];
  const gold = s[REGIME_SYMBOLS.gold] || [];
  const copper = s[REGIME_SYMBOLS.copper] || [];
  const hyg = s[REGIME_SYMBOLS.hyg] || [];
  const lqd = s[REGIME_SYMBOLS.lqd] || [];
  const iwm = s[REGIME_SYMBOLS.iwm] || [];
  const rsp = s[REGIME_SYMBOLS.rsp] || [];
  const smh = s[REGIME_SYMBOLS.smh] || [];
  const eem = s[REGIME_SYMBOLS.eem] || [];

  const ratio = (a, b, i) => {
    if (i < 0 || !a[i] || !b[i] || !b[i].close) return null;
    return a[i].close / b[i].close;
  };
  const ratioChange = (a, b, i, days = 20) => {
    if (i < days) return null;
    const now = ratio(a, b, i);
    const then = ratio(a, b, i - days);
    if (now === null || then === null) return null;
    return now / then - 1;
  };

  const values = {};
  for (const dim of REGIME_DIMENSIONS) values[dim.id] = [];

  dates.forEach((date, k) => {
    const si = indexOnOrBefore(spy, date);
    const vi = indexOnOrBefore(vix, date);
    const ti = indexOnOrBefore(tnx, date);
    const ii = indexOnOrBefore(irx, date);
    const di = indexOnOrBefore(dxy, date);
    const oi = indexOnOrBefore(oil, date);
    const gi = indexOnOrBefore(gold, date);
    const ci = indexOnOrBefore(copper, date);
    const hi = indexOnOrBefore(hyg, date);
    const li = indexOnOrBefore(lqd, date);
    const wi = indexOnOrBefore(iwm, date);
    const ri = indexOnOrBefore(rsp, date);
    const mi = indexOnOrBefore(smh, date);
    const ei = indexOnOrBefore(eem, date);

    /* 趨勢：現價相對 200 日均線 */
    let trend = null;
    if (si >= 200) {
      const slice = [];
      for (let x = si - 199; x <= si; x++) slice.push(spy[x].close);
      const ma = mean(slice);
      if (ma) trend = spy[si].close / ma - 1;
    }

    const rv = si >= 21 ? realizedVol(spy, si, 20) : null;
    const vixNow = vi >= 0 ? vix[vi].close : null;
    const vixPast = vi >= 20 ? vix[vi - 20].close : null;

    values.trend[k] = trend;
    values.breadth[k] = ratioChange(rsp, spy, ri, 20);
    values.smallcap[k] = ratioChange(iwm, spy, wi, 20);
    values.volLevel[k] = vixNow;
    values.volTrend[k] = vixNow !== null && vixPast ? vixNow / vixPast - 1 : null;
    values.varianceRisk[k] = vixNow !== null && rv ? vixNow / 100 / rv : null;
    values.rates[k] = ti >= 0 ? tnx[ti].close : null;
    values.ratesTrend[k] = ti >= 20 ? tnx[ti].close - tnx[ti - 20].close : null;
    values.curve[k] = ti >= 0 && ii >= 0 ? tnx[ti].close - irx[ii].close : null;
    values.credit[k] = ratioChange(hyg, lqd, hi, 20);
    values.dollar[k] = di >= 20 ? dxy[di].close / dxy[di - 20].close - 1 : null;
    values.growth[k] = ratioChange(copper, gold, ci, 20);
    values.oil[k] = trailingReturn(oil, oi, 20);
    values.tech[k] = ratioChange(smh, spy, mi, 20);
    values.em[k] = ratioChange(eem, spy, ei, 20);
  });

  return values;
}

export function computeRegime(input) {
  const { series, asOf } = input;
  const spy = series[REGIME_SYMBOLS.spy] || [];
  if (!spy.length) return { ok: false, reason: '缺少 SPY 價格序列' };
  const dates = spy.map((p) => p.date).filter((d) => !asOf || d <= asOf);
  const values = computeDimensionValues(series, dates);

  const timeline = dates.map((date, k) => {
    const dims = REGIME_DIMENSIONS.map((dim) => {
      const raw = values[dim.id][k];
      const pct = expandingPercentile(values[dim.id], k);
      const score = pct === null ? null : dim.riskOn > 0 ? pct : 100 - pct;
      return { id: dim.id, label: dim.label, raw, percentile: pct, score };
    });
    const usable = dims.filter((d) => d.score !== null);
    const overall = usable.length ? mean(usable.map((d) => d.score)) : null;
    return { date, overall, dimensions: dims };
  });

  const latest = timeline[timeline.length - 1];
  const state = (score) =>
    score === null ? '資料不足' : score >= 65 ? '風險偏好' : score <= 35 ? '風險趨避' : '中性';

  return {
    ok: true,
    asOf: latest ? latest.date : null,
    score: latest ? latest.overall : null,
    state: latest ? state(latest.overall) : '資料不足',
    dimensions: latest
      ? latest.dimensions.map((d) => {
          const def = REGIME_DIMENSIONS.find((x) => x.id === d.id);
          return { ...d, desc: def.desc, riskOn: def.riskOn };
        })
      : [],
    timeline,
    symbols: REGIME_SYMBOLS,
  };
}

/* 取某一天（含）之前的體制狀態 */
export function regimeScoreOn(timeline, date) {
  let lo = 0;
  let hi = timeline.length - 1;
  let ans = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timeline[mid].date <= date) {
      ans = timeline[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export const REGIME_BUCKETS = [
  { id: 'riskOn', label: '風險偏好', test: (s) => s >= 60 },
  { id: 'neutral', label: '中性', test: (s) => s > 40 && s < 60 },
  { id: 'riskOff', label: '風險趨避', test: (s) => s <= 40 },
];

/* 同一個訊號在不同體制下的表現：這才是體制面板的用途 */
export function regimeConditionalScorecard(rows, timeline, conditions, horizons) {
  const enriched = rows
    .map((r) => {
      const snap = regimeScoreOn(timeline, r.date);
      return snap && snap.overall !== null ? { ...r, regimeScore: snap.overall } : null;
    })
    .filter(Boolean);

  const overall = REGIME_BUCKETS.map((bucket) => {
    const subset = enriched.filter((r) => bucket.test(r.regimeScore));
    return {
      id: bucket.id,
      label: bucket.label,
      n: subset.length,
      byHorizon: horizons.map((h) => {
        const vals = subset.map((r) => r.forward[h]).filter(Number.isFinite);
        return {
          horizon: h,
          hitRate: vals.length ? vals.filter((v) => v > 0).length / vals.length : null,
          avgReturn: vals.length ? mean(vals) : null,
        };
      }),
    };
  });

  const signals = conditions
    .map((c) => {
      const subset = enriched.filter((r) => {
        try {
          return c.test(r);
        } catch {
          return false;
        }
      });
      if (subset.length < 20) return null;
      return {
        key: c.key,
        label: c.label,
        byBucket: REGIME_BUCKETS.map((bucket) => {
          const b = subset.filter((r) => bucket.test(r.regimeScore));
          return {
            id: bucket.id,
            label: bucket.label,
            n: b.length,
            byHorizon: horizons.map((h) => {
              const vals = b.map((r) => r.forward[h]).filter(Number.isFinite);
              const all = overall.find((o) => o.id === bucket.id).byHorizon.find((x) => x.horizon === h);
              const hitRate = vals.length ? vals.filter((v) => v > 0).length / vals.length : null;
              return {
                horizon: h,
                hitRate,
                lift: hitRate !== null && all.hitRate !== null ? hitRate - all.hitRate : null,
              };
            }),
          };
        }),
      };
    })
    .filter(Boolean);

  return { horizons, overall, signals, sampleCount: enriched.length };
}
