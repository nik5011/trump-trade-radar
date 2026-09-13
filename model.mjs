/* ============================================================================
   機率模型：用歷史規律估計「未來 N 個交易日上漲的機率」

   這不是預言機，而是一個可以檢驗的統計模型：
     ˙特徵只用「觀察日當天已經公開」的資訊（申報用 filedDate，不是成交日）
     ˙用時間切分做樣本外檢驗（前面期間訓練、後面期間測試）
     ˙把樣本外準確率、AUC、基準率一起顯示出來，讓使用者自己判斷有沒有用
   若市場接近效率，樣本外準確率通常會在 50% 上下——我們照實呈現，不做美化。
   ========================================================================== */

import { mulberry32, addDays, indexAtOrBefore } from './engine.mjs';

export const FEATURES = [
  { key: 'mom20', label: '20 日動能', desc: '近 20 個交易日報酬率' },
  { key: 'mom60', label: '60 日動能', desc: '近 60 個交易日報酬率' },
  { key: 'excess60', label: '相對大盤強度', desc: '60 日報酬減去等權大盤報酬' },
  { key: 'vol20', label: '波動度', desc: '近 20 日年化波動率' },
  { key: 'distHigh', label: '距 52 週高點', desc: '現價相對近一年最高價的距離' },
  { key: 'volRatio', label: '成交量變化', desc: '近 5 日均量 ÷ 近 60 日均量' },
  { key: 'buyNet90', label: '申報淨買入', desc: '近 90 天已公開申報的淨買入金額（對數）' },
  { key: 'buyCount90', label: '申報買入筆數', desc: '近 90 天已公開的買入筆數' },
  { key: 'freshness', label: '申報新穎度', desc: '距最近一次已公開買入申報的天數（45 天半衰期）' },
  { key: 'policySens', label: '政策曝險', desc: '政策主題對照下的敏感度（正＝受惠型、負＝受損型）' },
  { key: 'policyEvents60', label: '政策事件密度', desc: '近 60 天與該標的相關的政策文件數' },
];

export const FEATURE_KEYS = FEATURES.map((f) => f.key);

const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const stdev = (a) => {
  if (a.length < 2) return 1;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)) || 1;
};

/* ---------------------------------------------------------------------------
   特徵工程
   ------------------------------------------------------------------------- */

function priceFeatures(series, i, benchmark, bi) {
  const close = series[i].close;
  const ret = (n) => (i - n >= 0 && series[i - n] ? close / series[i - n].close - 1 : null);
  const mom20 = ret(20);
  const mom60 = ret(60);

  const rets = [];
  for (let k = Math.max(1, i - 19); k <= i; k++) rets.push(Math.log(series[k].close / series[k - 1].close));
  const vol20 = rets.length >= 10 ? stdev(rets) * Math.sqrt(252) : null;

  let high = -Infinity;
  for (let k = Math.max(0, i - 251); k <= i; k++) high = Math.max(high, series[k].close);
  const distHigh = Number.isFinite(high) && high > 0 ? close / high - 1 : null;

  let excess60 = null;
  if (mom60 !== null && benchmark && bi - 60 >= 0 && benchmark[bi - 60] && benchmark[bi]) {
    excess60 = mom60 - (benchmark[bi].close / benchmark[bi - 60].close - 1);
  }

  let volRatio = null;
  const vols = series.map((p) => p.volume).filter((v) => Number.isFinite(v) && v > 0);
  if (vols.length === series.length) {
    const avg = (from, to) => {
      const slice = [];
      for (let k = Math.max(0, from); k <= to; k++) slice.push(series[k].volume);
      return slice.length ? mean(slice) : null;
    };
    const v5 = avg(i - 4, i);
    const v60 = avg(i - 59, i);
    if (v5 && v60) volRatio = v5 / v60;
  }

  return { mom20, mom60, excess60, vol20, distHigh, volRatio };
}

/* 申報特徵：只用 filedDate ≤ 觀察日的資料（避免使用當時還沒公開的申報） */
function buildDisclosureIndex(trades) {
  const byTicker = new Map();
  for (const t of trades) {
    const list = byTicker.get(t.ticker);
    if (list) list.push(t);
    else byTicker.set(t.ticker, [t]);
  }
  for (const list of byTicker.values()) {
    list.sort((a, b) => (a.filedDate < b.filedDate ? -1 : a.filedDate > b.filedDate ? 1 : 0));
  }
  return byTicker;
}

function disclosureFeatures(list, dateISO, daysBetweenFn, midAmountFn) {
  if (!list || !list.length) return { buyNet90: 0, buyCount90: 0, freshness: 0 };
  let buyNet = 0;
  let buyCount = 0;
  let lastBuy = null;
  for (let k = list.length - 1; k >= 0; k--) {
    const t = list[k];
    if (t.filedDate > dateISO) continue;
    const age = daysBetweenFn(t.filedDate, dateISO);
    if (age < 0) continue;
    if (age <= 90) {
      if (t.side === 'BUY') {
        buyNet += midAmountFn(t);
        buyCount++;
      } else {
        buyNet -= midAmountFn(t);
      }
    }
    if (t.side === 'BUY' && !lastBuy) lastBuy = t.filedDate;
    if (age > 180 && lastBuy) break;
  }
  const daysSince = lastBuy ? daysBetweenFn(lastBuy, dateISO) : null;
  const freshness = daysSince === null ? 0 : Math.exp((-Math.LN2 * daysSince) / 45);
  return {
    buyNet90: Math.sign(buyNet) * Math.log1p(Math.abs(buyNet) / 1e6),
    buyCount90: Math.log1p(buyCount),
    freshness,
  };
}

/* 政策事件密度：近 N 天內與該標的相關的政策文件數 */
function buildPolicyIndex(policy, docsByTheme, themes) {
  const events = [];
  for (const theme of themes) {
    const docs = (docsByTheme[theme.id] && docsByTheme[theme.id].items) || [];
    for (const d of docs) {
      const date = (d.publishedAt || '').slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) events.push({ themeId: theme.id, date });
    }
  }
  events.sort((a, b) => (a.date < b.date ? -1 : 1));
  const tickerThemes = {};
  if (policy && policy.tickers) {
    for (const [ticker, info] of Object.entries(policy.tickers)) {
      tickerThemes[ticker] = { sensitivity: info.sensitivity, themes: new Set(info.themes.map((t) => t.id)) };
    }
  }
  return { events, tickerThemes };
}

/* ---------------------------------------------------------------------------
   建立資料集
   ------------------------------------------------------------------------- */

export function buildDataset(input) {
  const {
    trades = [],
    market,
    policy = null,
    docsByTheme = {},
    themes = [],
    asOf,
    horizonDays = 20,
    stepDays = 5,
    minHistoryDays = 260,
    indexAtOrBeforeFn = indexAtOrBefore,
    daysBetweenFn,
    midAmountFn,
    horizons = null,
  } = input;

  const disclosure = buildDisclosureIndex(trades);
  const policyIndex = buildPolicyIndex(policy, docsByTheme, themes);
  const benchmark = market.benchmark || [];
  const rows = [];
  const maxHorizon = horizons && horizons.length ? Math.max(...horizons) : horizonDays;

  for (const [ticker, series] of Object.entries(market.series || {})) {
    if (!series || series.length < minHistoryDays + maxHorizon + 1) continue;
    const list = disclosure.get(ticker) || [];
    for (let i = minHistoryDays; i + maxHorizon < series.length; i += stepDays) {
      const date = series[i].date;
      if (asOf && date > asOf) break;
      const bi = indexAtOrBeforeFn(benchmark, date);
      const pf = priceFeatures(series, i, benchmark, bi);
      const df = disclosureFeatures(list, date, daysBetweenFn, midAmountFn);
      const pt = policyIndex.tickerThemes[ticker] || { sensitivity: 0, themes: new Set() };
      let policyEvents60 = 0;
      for (const ev of policyIndex.events) {
        if (ev.date > date) break;
        if (ev.date < addDays(date, -60)) continue;
        if (pt.themes.has(ev.themeId)) policyEvents60++;
      }
      const x = {
        mom20: pf.mom20, mom60: pf.mom60, excess60: pf.excess60, vol20: pf.vol20,
        distHigh: pf.distHigh, volRatio: pf.volRatio,
        buyNet90: df.buyNet90, buyCount90: df.buyCount90, freshness: df.freshness,
        policySens: pt.sensitivity || 0, policyEvents60: Math.log1p(policyEvents60),
      };
      /* 任一特徵缺漏就跳過這一筆，避免用 0 假造資料 */
      if (FEATURE_KEYS.some((k) => x[k] === null || x[k] === undefined || !Number.isFinite(x[k]))) continue;
      const forward = series[i + horizonDays].close / series[i].close - 1;
      const forwardMap = {};
      if (horizons) {
        for (const h of horizons) forwardMap[h] = series[i + h].close / series[i].close - 1;
      }
      rows.push({
        date,
        ticker,
        x,
        forwardReturn: forward,
        y: forward > 0 ? 1 : 0,
        ...(horizons ? { forward: forwardMap } : {}),
      });
    }
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rows;
}

/* ---------------------------------------------------------------------------
   標準化與羅吉斯迴歸
   ------------------------------------------------------------------------- */

export function fitScaler(X) {
  const d = X[0].length;
  const mu = new Array(d).fill(0);
  const sd = new Array(d).fill(1);
  for (let j = 0; j < d; j++) {
    const col = X.map((row) => row[j]);
    mu[j] = mean(col);
    sd[j] = stdev(col) || 1;
  }
  return { mu, sd };
}

export const applyScaler = (row, scaler) => row.map((v, j) => (v - scaler.mu[j]) / scaler.sd[j]);

export function trainLogistic(X, y, opts = {}) {
  const { epochs = 700, lr = 0.6, l2 = 0.02, seed = 42 } = opts;
  const rnd = mulberry32(seed);
  const n = X.length;
  const d = X[0].length;
  const weights = new Array(d).fill(0).map(() => (rnd() - 0.5) * 0.01);
  let bias = 0;
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = bias;
      for (let j = 0; j < d; j++) z += weights[j] * X[i][j];
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < d; j++) gw[j] += err * X[i][j];
      gb += err;
    }
    for (let j = 0; j < d; j++) weights[j] -= lr * (gw[j] / n + l2 * weights[j]);
    bias -= lr * (gb / n);
  }
  return { weights, bias };
}

export function predictOne(model, xStd) {
  let z = model.bias;
  for (let j = 0; j < xStd.length; j++) z += model.weights[j] * xStd[j];
  return sigmoid(z);
}

export function auc(scores, labels) {
  const pairs = scores.map((s, i) => ({ s, y: labels[i] })).sort((a, b) => a.s - b.s);
  const pos = labels.filter((y) => y === 1).length;
  const neg = labels.length - pos;
  if (!pos || !neg) return null;
  let rankSum = 0;
  let i = 0;
  while (i < pairs.length) {
    let j = i;
    while (j + 1 < pairs.length && pairs[j + 1].s === pairs[i].s) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (pairs[k].y === 1) rankSum += avgRank;
    i = j + 1;
  }
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

export function evaluateModel(model, X, y) {
  const probs = X.map((row) => predictOne(model, row));
  const preds = probs.map((p) => (p >= 0.5 ? 1 : 0));
  const correct = preds.filter((p, i) => p === y[i]).length;
  const baseRate = mean(y);
  const brier = mean(probs.map((p, i) => (p - y[i]) ** 2));
  const bins = Array.from({ length: 10 }, (_, b) => ({ bin: b, n: 0, predSum: 0, actualSum: 0 }));
  probs.forEach((p, i) => {
    const b = Math.min(9, Math.floor(p * 10));
    bins[b].n++;
    bins[b].predSum += p;
    bins[b].actualSum += y[i];
  });
  return {
    n: y.length,
    accuracy: y.length ? correct / y.length : null,
    baseRate,
    /* 全猜多數類的準確率，用來判斷模型是否真的有用 */
    majorityAccuracy: Math.max(baseRate, 1 - baseRate),
    auc: auc(probs, y),
    brier,
    calibration: bins
      .filter((b) => b.n > 0)
      .map((b) => ({ bin: b.bin, n: b.n, predicted: b.predSum / b.n, actual: b.actualSum / b.n })),
  };
}

/* ---------------------------------------------------------------------------
   機率校準

   羅吉斯迴歸的原始輸出常常過度自信（例如在毫無訊號時說 98%）。
   這裡在「驗證集」上估計每個機率區間的實際命中率，再把分數映射成校正後機率。
   驗證集與測試集分開，因此最終報告的樣本外指標沒有作弊。
   ------------------------------------------------------------------------- */

export function fitCalibration(probs, y, bins = 8) {
  const pairs = probs.map((p, i) => ({ p, y: y[i] })).sort((a, b) => a.p - b.p);
  const globalRate = mean(y);
  const size = Math.max(1, Math.floor(pairs.length / bins));
  const points = [];
  for (let b = 0; b < bins; b++) {
    const slice = pairs.slice(b * size, b === bins - 1 ? pairs.length : (b + 1) * size);
    if (!slice.length) continue;
    const predicted = mean(slice.map((s) => s.p));
    const actual = mean(slice.map((s) => s.y));
    /* 樣本少的區間往整體機率收縮，避免用 3 筆資料就宣告 100% */
    const weight = slice.length / (slice.length + 20);
    points.push({ predicted, actual: actual * weight + globalRate * (1 - weight), n: slice.length });
  }
  return { points, globalRate };
}

export function applyCalibration(cal, p) {
  const pts = cal.points;
  if (!pts.length) return cal.globalRate;
  if (p <= pts[0].predicted) return pts[0].actual;
  if (p >= pts[pts.length - 1].predicted) return pts[pts.length - 1].actual;
  for (let i = 1; i < pts.length; i++) {
    if (p <= pts[i].predicted) {
      const a = pts[i - 1];
      const b = pts[i];
      const t = (p - a.predicted) / (b.predicted - a.predicted || 1);
      return a.actual * (1 - t) + b.actual * t;
    }
  }
  return pts[pts.length - 1].actual;
}

/* 依樣本外表現給出誠實的結論 */
export function judgeModel(outSample) {
  if (!outSample || outSample.accuracy === null) return { level: 'unknown', text: '樣本不足，無法評估' };
  const edge = outSample.accuracy - outSample.majorityAccuracy;
  const a = outSample.auc === null ? 0.5 : outSample.auc;
  if (outSample.n < 300) {
    return { level: 'unknown', text: `樣本外只有 ${outSample.n} 筆，統計上還不足以下結論` };
  }
  if (edge <= 0.005 || a < 0.52) {
    return {
      level: 'none',
      text:
        `樣本外準確率 ${(outSample.accuracy * 100).toFixed(1)}%，並未高於「一律猜多數類」的 ` +
        `${(outSample.majorityAccuracy * 100).toFixed(1)}%；AUC ${a.toFixed(3)} 也沒有辨別力。` +
        '結論：就目前的特徵與樣本，這個模型沒有可證實的預測優勢。',
    };
  }
  if (edge < 0.03) {
    return {
      level: 'weak',
      text:
        `樣本外準確率 ${(outSample.accuracy * 100).toFixed(1)}%，比基準高 ${(edge * 100).toFixed(1)} 個百分點，` +
        `AUC ${a.toFixed(3)}。屬於微弱且可能不穩定的優勢，不建議據此下單。`,
    };
  }
  return {
    level: 'positive',
    text:
      `樣本外準確率 ${(outSample.accuracy * 100).toFixed(1)}%，比基準高 ${(edge * 100).toFixed(1)} 個百分點，` +
      `AUC ${a.toFixed(3)}。在這段樣本上有可觀察的優勢，但單一期間的結果仍可能是運氣。`,
  };
}

/* ---------------------------------------------------------------------------
   條件機率表：不做黑箱，直接看「符合某條件時，歷史上漲的機率是多少」
   ------------------------------------------------------------------------- */

export const CONDITIONS = [
  { key: 'disclosureBuy', label: '近 90 天申報淨買入 > $1M', test: (r) => r.x.buyNet90 > Math.log1p(1) },
  { key: 'freshBuy', label: '近 30 天內有買入申報', test: (r) => r.x.freshness > Math.exp(-Math.LN2 * (30 / 45)) },
  { key: 'manyBuys', label: '近 90 天買入 ≥ 3 筆', test: (r) => r.x.buyCount90 >= Math.log1p(3) },
  { key: 'policyBull', label: '政策對照為受惠型', test: (r) => r.x.policySens > 0 },
  { key: 'policyBear', label: '政策對照為受損型', test: (r) => r.x.policySens < 0 },
  { key: 'policyEvent', label: '近 60 天有相關政策文件', test: (r) => r.x.policyEvents60 > 0 },
  { key: 'strongMom', label: '60 日動能 > +15%', test: (r) => r.x.mom60 > 0.15 },
  { key: 'weakMom', label: '60 日動能 < −15%', test: (r) => r.x.mom60 < -0.15 },
  { key: 'nearHigh', label: '距 52 週高點 < 3%', test: (r) => r.x.distHigh > -0.03 },
  { key: 'deepDrawdown', label: '距 52 週高點 > 20%', test: (r) => r.x.distHigh < -0.2 },
  { key: 'volumeSpike', label: '成交量 > 60 日均量 1.5 倍', test: (r) => r.x.volRatio > 1.5 },
  { key: 'highVol', label: '年化波動 > 45%', test: (r) => r.x.vol20 > 0.45 },
];

export function conditionalStats(rows, horizonDays) {
  const all = {
    n: rows.length,
    hitRate: mean(rows.map((r) => r.y)),
    avgReturn: mean(rows.map((r) => r.forwardReturn)),
  };
  const table = CONDITIONS.map((c) => {
    const subset = rows.filter((r) => {
      try {
        return c.test(r);
      } catch {
        return false;
      }
    });
    if (!subset.length) return { key: c.key, label: c.label, n: 0, hitRate: null, avgReturn: null, lift: null };
    const hitRate = mean(subset.map((r) => r.y));
    return {
      key: c.key,
      label: c.label,
      n: subset.length,
      hitRate,
      avgReturn: mean(subset.map((r) => r.forwardReturn)),
      lift: hitRate - all.hitRate,
    };
  }).filter((c) => c.n >= 30);
  table.sort((a, b) => b.hitRate - a.hitRate);
  return { horizonDays, all, table };
}

/* 目前有哪些標的「正符合」歷史上有效的條件 */
export function conditionWatchlist(predictions, conditions) {
  const matchedFor = (test) =>
    predictions
      .filter((p) => {
        try {
          return test({ x: p.features });
        } catch {
          return false;
        }
      })
      .map((p) => ({ ticker: p.ticker, probUp: p.probUp, close: p.close }));
  return conditions.table
    .map((c) => {
      const cond = CONDITIONS.find((x) => x.key === c.key);
      if (!cond) return null;
      const matched = matchedFor(cond.test);
      return { ...c, matched: matched.slice(0, 12), matchedCount: matched.length };
    })
    .filter((c) => c && c.matchedCount > 0)
    .sort((a, b) => b.hitRate - a.hitRate);
}

/* 比較不同特徵組合的樣本外表現：讓「哪一組真的有用」可以被檢驗 */
export function compareVariants(rows, opts = {}) {
  const { testRatio = 0.3, variants = [] } = opts;
  const testCount = Math.max(50, Math.floor(rows.length * testRatio));
  const valCount = Math.max(30, Math.floor(rows.length * 0.15));
  const trainEnd = rows.length - testCount - valCount;
  const valEnd = rows.length - testCount;
  const trainRows = rows.slice(0, trainEnd);
  const valRows = rows.slice(trainEnd, valEnd);
  const testRows = rows.slice(valEnd);

  return variants.map((v) => {
    const toX = (list) => list.map((r) => v.keys.map((k) => r.x[k]));
    const scaler = fitScaler(toX(trainRows));
    const Xtr = toX(trainRows).map((r) => applyScaler(r, scaler));
    const Xval = toX(valRows).map((r) => applyScaler(r, scaler));
    const Xte = toX(testRows).map((r) => applyScaler(r, scaler));
    const trainY = trainRows.map((r) => r.y);
    const valY = valRows.map((r) => r.y);
    const testY = testRows.map((r) => r.y);
    const model = trainLogistic(Xtr, trainY);
    const cal = fitCalibration(Xval.map((r) => predictOne(model, r)), valY);
    const probs = Xte.map((r) => applyCalibration(cal, predictOne(model, r)));
    const accuracy = mean(probs.map((p, i) => ((p >= 0.5 ? 1 : 0) === testY[i] ? 1 : 0)));
    const base = mean(testY);
    return {
      id: v.id,
      label: v.label,
      featureCount: v.keys.length,
      accuracy,
      baseRate: base,
      edge: accuracy - Math.max(base, 1 - base),
      auc: auc(probs, testY),
    };
  });
}

/* ---------------------------------------------------------------------------
   訊號計分卡：同一個訊號在不同持有期間的命中率（衰減曲線）與資訊係數（IC）

   交易的關鍵問題不是「這個訊號準不準」，而是「它在第幾天開始失效」。
   ------------------------------------------------------------------------- */

function spearman(xs, ys) {
  const n = xs.length;
  if (n < 20) return null;
  const rank = (arr) => {
    const idx = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const out = new Array(n);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++;
      const r = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) out[idx[k].i] = r;
      i = j + 1;
    }
    return out;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

export function signalScorecard(rows, horizons = [1, 5, 10, 20, 40, 60]) {
  const usable = rows.filter((r) => r.forward);
  const overall = horizons.map((h) => {
    const vals = usable.map((r) => r.forward[h]).filter(Number.isFinite);
    return {
      horizon: h,
      n: vals.length,
      hitRate: vals.length ? vals.filter((v) => v > 0).length / vals.length : null,
      avgReturn: vals.length ? mean(vals) : null,
    };
  });

  const signals = CONDITIONS.map((c) => {
    const subset = usable.filter((r) => {
      try {
        return c.test(r);
      } catch {
        return false;
      }
    });
    if (subset.length < 30) return null;
    return {
      key: c.key,
      label: c.label,
      n: subset.length,
      byHorizon: horizons.map((h) => {
        const vals = subset.map((r) => r.forward[h]).filter(Number.isFinite);
        const hitRate = vals.length ? vals.filter((v) => v > 0).length / vals.length : null;
        const o = overall.find((x) => x.horizon === h);
        return {
          horizon: h,
          hitRate,
          avgReturn: vals.length ? mean(vals) : null,
          lift: hitRate !== null && o && o.hitRate !== null ? hitRate - o.hitRate : null,
        };
      }),
    };
  }).filter(Boolean);

  const ic = FEATURES.map((f) => ({
    key: f.key,
    label: f.label,
    byHorizon: horizons.map((h) => {
      const pairs = usable
        .map((r) => [r.x[f.key], r.forward[h]])
        .filter(([, y]) => Number.isFinite(y));
      return {
        horizon: h,
        n: pairs.length,
        ic: pairs.length >= 20 ? spearman(pairs.map((p) => p[0]), pairs.map((p) => p[1])) : null,
      };
    }),
  }));

  return { horizons, overall, signals, ic, sampleCount: usable.length };
}

/* ---------------------------------------------------------------------------
   完整流程：建立資料集 → 時間切分 → 訓練 → 樣本外檢驗 → 對最新一日預測
   ------------------------------------------------------------------------- */

export function runProbabilityModel(input) {
  const {
    trades = [],
    market,
    policy = null,
    docsByTheme = {},
    themes = [],
    asOf,
    horizonDays = 20,
    stepDays = 5,
    testRatio = 0.3,
    indexAtOrBeforeFn = indexAtOrBefore,
    daysBetweenFn,
    midAmountFn,
  } = input;

  const datasetArgs = {
    trades, market, policy, docsByTheme, themes, asOf,
    horizonDays, stepDays, indexAtOrBeforeFn, daysBetweenFn, midAmountFn,
  };
  const rows = buildDataset(datasetArgs);
  if (rows.length < 200) {
    return { ok: false, reason: `樣本不足（只有 ${rows.length} 筆），需要至少 200 筆才能訓練`, horizonDays, samples: rows.length };
  }

  /* 三段時間切分：訓練 → 校準（驗證集）→ 樣本外測試。
     校準必須用驗證集，否則報告的樣本外指標會作弊。 */
  const testCount = Math.max(50, Math.floor(rows.length * testRatio));
  const valCount = Math.max(30, Math.floor(rows.length * 0.15));
  const trainEnd = rows.length - testCount - valCount;
  const valEnd = rows.length - testCount;
  const trainRows = rows.slice(0, trainEnd);
  const valRows = rows.slice(trainEnd, valEnd);
  const testRows = rows.slice(valEnd);

  const toX = (list) => list.map((r) => FEATURE_KEYS.map((k) => r.x[k]));
  const scaler = fitScaler(toX(trainRows));
  const Xtr = toX(trainRows).map((row) => applyScaler(row, scaler));
  const Xval = toX(valRows).map((row) => applyScaler(row, scaler));
  const Xte = toX(testRows).map((row) => applyScaler(row, scaler));
  const trainY = trainRows.map((r) => r.y);
  const valY = valRows.map((r) => r.y);
  const testY = testRows.map((r) => r.y);

  const model = trainLogistic(Xtr, trainY);
  const inSample = evaluateModel(model, Xtr, trainY);

  /* 用驗證集校正機率，再拿校正後的分數做樣本外評估 */
  const rawValProbs = Xval.map((row) => predictOne(model, row));
  const calibration = fitCalibration(rawValProbs, valY);
  const rawTestProbs = Xte.map((row) => predictOne(model, row));
  const calTestProbs = rawTestProbs.map((p) => applyCalibration(calibration, p));
  const outSample = evaluateModel(model, Xte, testY);
  outSample.rawAccuracy = outSample.accuracy;
  outSample.rawAuc = outSample.auc;
  outSample.rawBrier = outSample.brier;
  /* 以校正後的機率重新計算樣本外指標（校準只用了驗證集） */
  outSample.accuracy = mean(
    calTestProbs.map((p, i) => ((p >= 0.5 ? 1 : 0) === testY[i] ? 1 : 0))
  );
  outSample.auc = auc(calTestProbs, testY);
  outSample.brier = mean(calTestProbs.map((p, i) => (p - testY[i]) ** 2));
  outSample.overconfidence = mean(rawTestProbs.map((p, i) => Math.abs(p - testY[i])));
  outSample.calibratedOverconfidence = mean(calTestProbs.map((p, i) => Math.abs(p - testY[i])));
  outSample.calibrationCurve = calibration.points;
  const verdict = judgeModel(outSample);
  const conditions = conditionalStats(rows, horizonDays);

  const features = FEATURES.map((f, j) => ({
    key: f.key,
    label: f.label,
    desc: f.desc,
    weight: model.weights[j],
  })).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));

  /* 對「最新一天」預測：只使用截至 asOf 的資訊 */
  const predictions = [];
  const disclosureIndex = buildDisclosureIndex(trades);
  for (const [ticker, series] of Object.entries(market.series || {})) {
    if (!series || series.length < 80) continue;
    const i = series.length - 1;
    const date = series[i].date;
    if (asOf && date > asOf) continue;
    const bi = indexAtOrBeforeFn(market.benchmark || [], date);
    const pf = priceFeatures(series, i, market.benchmark, bi);
    const df = disclosureFeatures(disclosureIndex.get(ticker) || [], date, daysBetweenFn, midAmountFn);
    const pt = (policy && policy.tickers && policy.tickers[ticker]) || { sensitivity: 0, themes: [] };
    const themeIds = new Set((pt.themes || []).map((t) => t.id));
    let policyEvents60 = 0;
    for (const theme of themes) {
      if (!themeIds.has(theme.id)) continue;
      for (const d of (docsByTheme[theme.id] && docsByTheme[theme.id].items) || []) {
        const dd = (d.publishedAt || '').slice(0, 10);
        if (dd && dd <= date && dd >= addDays(date, -60)) policyEvents60++;
      }
    }
    const x = {
      mom20: pf.mom20, mom60: pf.mom60, excess60: pf.excess60, vol20: pf.vol20,
      distHigh: pf.distHigh, volRatio: pf.volRatio,
      buyNet90: df.buyNet90, buyCount90: df.buyCount90, freshness: df.freshness,
      policySens: pt.sensitivity || 0, policyEvents60: Math.log1p(policyEvents60),
    };
    if (FEATURE_KEYS.some((k) => !Number.isFinite(x[k]))) continue;
    const row = FEATURE_KEYS.map((k) => x[k]);
    const std = applyScaler(row, scaler);
    const raw = predictOne(model, std);
    /* 顯示校正後的機率；未校正的原始分數另外保留，方便使用者比較過度自信的程度 */
    const prob = applyCalibration(calibration, raw);
    const contributions = FEATURE_KEYS.map((k, j) => ({
      key: k,
      label: FEATURES.find((f) => f.key === k).label,
      value: x[k],
      contribution: model.weights[j] * std[j],
    })).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
    predictions.push({
      ticker,
      date,
      close: series[i].close,
      rawProbUp: raw,
      probUp: prob,
      probDown: 1 - prob,
      features: x,
      contributions: contributions.slice(0, 4),
    });
  }
  predictions.sort((a, b) => b.probUp - a.probUp);

  const watchlist = conditionWatchlist(predictions, conditions);
  const variants = compareVariants(rows, {
    testRatio,
    variants: [
      { id: 'all', label: '全部 11 個特徵', keys: FEATURE_KEYS },
      { id: 'disclosure', label: '只用申報訊號（3 個）', keys: ['buyNet90', 'buyCount90', 'freshness'] },
      {
        id: 'disclosure-momentum',
        label: '申報＋動能（6 個）',
        keys: ['buyNet90', 'buyCount90', 'freshness', 'mom20', 'mom60', 'excess60'],
      },
      {
        id: 'price-only',
        label: '只用價格與量（6 個）',
        keys: ['mom20', 'mom60', 'excess60', 'vol20', 'distHigh', 'volRatio'],
      },
    ],
  });

  return {
    ok: true,
    horizonDays,
    stepDays,
    trainedAt: new Date().toISOString(),
    asOf: asOf || null,
    samples: {
      total: rows.length,
      train: trainRows.length,
      test: testRows.length,
      trainFrom: trainRows[0].date,
      trainTo: trainRows[trainRows.length - 1].date,
      testFrom: testRows[0].date,
      testTo: testRows[testRows.length - 1].date,
      tickers: new Set(rows.map((r) => r.ticker)).size,
    },
    inSample,
    outSample,
    verdict,
    conditions,
    watchlist,
    variants,
    features,
    scaler,
    model,
    predictions,
    topUp: predictions.slice(0, 15),
    topDown: predictions.slice(-15).reverse(),
  };
}
