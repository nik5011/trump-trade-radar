/* ============================================================================
   特朗普交易雷達 — 零依賴 Node 後端
   啟動：node server.mjs [--port 8787]
   同時提供：靜態前端、REST API、共用評分引擎（同一份 engine.mjs）
   ========================================================================== */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyze,
  analyzePolicy,
  buildMarketData,
  importTrades,
  parseCSV,
  selectPriceUniverse,
  PRICE_UNIVERSE_LIMIT,
  daysBetween,
  midAmount,
  addDays,
  DEFAULT_WEIGHTS,
  PRICE_END,
} from './engine.mjs';
import { demoStore, DATA_SOURCES, IMPORT_TEMPLATE_CSV } from './demo-data.mjs';
import { POLICY_THEMES, POLICY_DISCLAIMER } from './policy-map.mjs';
import { runProbabilityModel } from './model.mjs';
import { buildDataset, signalScorecard } from './model.mjs';
import { computeCapacity, buildEventClock, EVENT_TYPES } from './desk.mjs';
import { fetchUpcomingPolicyEvents, fetchEarningsRange, nextBusinessDays } from './providers.mjs';
import { computeRegime, regimeConditionalScorecard, REGIME_SYMBOLS, REGIME_DIMENSIONS } from './regime.mjs';
import { CONDITIONS } from './model.mjs';
import { normalizePositions, analyzePositions } from './portfolio.mjs';
import { summarizeInsiders, recentTransactions, flattenForm4, TRANSACTION_CODES } from './insiders.mjs';
import { fetchCikMap, fetchCompanyForm4Filings, fetchForm4Xml, parseForm4 } from './providers.mjs';
import {
  PROVIDERS_INFO,
  fetchLivePrices,
  fetchNewsFeed,
  fetchPolicyDocs,
  isRelevantPolicyDoc,
  quarterWindows,
  fetchContracts,
  fetchDisclosureEndpoint,
  fetchOgeFilings,
  diffFilings,
  filingKey,
  downloadFilingPdf,
  safeFileName,
  EXTERNAL_DATASETS,
  fetchExternalDatasetFiles,
  convertExternalDataset,
  buildEqualWeightBenchmark,
} from './providers.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const CACHE_FILE = path.join(DATA_DIR, 'live-cache.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const POSITIONS_FILE = path.join(DATA_DIR, 'positions.json');

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = Number(process.env.PORT || (portArg >= 0 ? args[portArg + 1] : 8787));

/* 機率模型訓練一次約數秒，用簡單的記憶體快取避免每次切換時間窗都重算 */
let probabilityCache = { key: null, value: null };
let deskCache = { key: null, value: null };
let regimeCache = { key: null, value: null };

/* ---------------------------------------------------------------------------
   資料儲存層：單一 JSON 檔，初次啟動時以示範資料建立
   ------------------------------------------------------------------------- */

async function readStore() {
  try {
    const raw = await fs.readFile(STORE_FILE, 'utf8');
    const store = JSON.parse(raw);
    if (!Array.isArray(store.trades)) throw new Error('store.json 格式不符');
    return store;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[store] 讀取失敗，改用示範資料：${err.message}`);
    }
    return demoStore();
  }
}

async function writeStore(store) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE_FILE, JSON.stringify(store, null, 2), 'utf8');
}

function dedupe(trades) {
  const seen = new Set();
  const out = [];
  for (const t of trades) {
    /* 用「來源 + 紀錄 id」當指紋：
       - 同一個檔案重複匯入 → id 相同 → 正確去重
       - 同一天、同金額、同標的的多筆獨立交易 → id 不同 → 全部保留（避免吃掉真實交易） */
    const key = `${t.source || ''}|${
      t.id || [t.ticker, t.tradeDate, t.side, t.amountMin, t.amountMax, t.owner].join('|')
    }`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.sort((a, b) => (a.tradeDate < b.tradeDate ? -1 : a.tradeDate > b.tradeDate ? 1 : 0));
}

function datasetKind(store) {
  if (store.meta && store.meta.datasetKind) return store.meta.datasetKind;
  return store.meta && store.meta.source === 'builtin' ? 'demo' : 'imported';
}

/* ---------------------------------------------------------------------------
   即時資料快取（價格／新聞／政策／合約）
   ------------------------------------------------------------------------- */

async function readCache() {
  try {
    return JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function updateCache(patch) {
  const cache = { ...(await readCache()), ...patch };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache), 'utf8');
  return cache;
}

async function readConfig() {
  try {
    return JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function readPositions() {
  try {
    const raw = await fs.readFile(POSITIONS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.positions) ? parsed : { positions: [], updatedAt: null };
  } catch {
    return { positions: [], updatedAt: null };
  }
}

async function writePositions(payload) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(POSITIONS_FILE, JSON.stringify(payload, null, 2), 'utf8');
}

/* 即時價格若有缺漏的標的，用模擬序列補齊，確保評分與回測仍可執行 */
function fillMissingPrices(series, tickers) {
  const missing = tickers.filter((t) => !series[t] || !series[t].length);
  if (!missing.length) return { series, missing };
  const synthetic = buildMarketData(missing).series;
  const merged = { ...series };
  for (const t of missing) merged[t] = synthetic[t];
  return { series: merged, missing };
}

/* 匯入合併邏輯（/api/import 與 /api/sync/disclosures 共用） */
function mergeImportedTrades(store, imported, { mode = 'replace', source = 'imported' } = {}) {
  const wasDemo = datasetKind(store).includes('demo');
  const merged = mode === 'append' ? dedupe([...store.trades, ...imported]) : dedupe(imported);
  return {
    meta: {
      ...store.meta,
      demo: false,
      datasetKind: wasDemo && mode === 'append' ? 'mixed' : 'imported',
      source,
      importedAt: new Date().toISOString(),
      lastImport: { mode, accepted: imported.length },
    },
    sectors: store.sectors || {},
    trades: merged,
  };
}

/* ---------------------------------------------------------------------------
   HTTP 工具
   ------------------------------------------------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function sendJSON(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function readBody(req, limitBytes = 12 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('上傳內容過大（上限 12MB）');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/* 只允許讀取白名單目錄，並擋掉路徑穿越 */
async function serveFile(res, baseDir, relPath) {
  const safeRel = path.normalize(relPath).replace(/^([/\\])+/, '');
  const abs = path.resolve(baseDir, safeRel);
  if (!abs.startsWith(path.resolve(baseDir))) {
    sendJSON(res, 403, { error: '禁止存取' });
    return;
  }
  try {
    const data = await fs.readFile(abs);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    sendJSON(res, 404, { error: `找不到 ${safeRel}` });
  }
}

/* ---------------------------------------------------------------------------
   分析參數解析
   ------------------------------------------------------------------------- */

function parseParams(url) {
  const q = url.searchParams;
  const num = (key, fallback) => {
    const v = q.get(key);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const weights = { ...DEFAULT_WEIGHTS };
  for (const k of Object.keys(DEFAULT_WEIGHTS)) {
    if (q.has(`w_${k}`)) weights[k] = Math.max(0, num(`w_${k}`, weights[k]));
  }
  return {
    weights,
    portfolioParams: {
      topN: Math.max(1, Math.round(num('topN', 8))),
      maxWeight: Math.min(1, Math.max(0.01, num('maxWeight', 0.18))),
      sectorCap: Math.min(1, Math.max(0.05, num('sectorCap', 0.4))),
      cashMin: Math.min(0.9, Math.max(0, num('cashMin', 0.1))),
      minScore: Math.min(100, Math.max(0, num('minScore', 45))),
      gamma: Math.max(0.1, num('gamma', 1.5)),
    },
    backtestParams: {
      lagDays: Math.max(0, Math.round(num('lagDays', 1))),
      holdDays: Math.max(1, Math.round(num('holdDays', 60))),
      capital: Math.max(1000, num('capital', 100000)),
      positionSize: Math.min(1, Math.max(0.01, num('positionSize', 0.2))),
      minAmount: Math.max(0, num('minAmount', 15001)),
      maxConcurrent: Math.max(1, Math.round(num('maxConcurrent', 5))),
      includeSells: q.get('includeSells') === '1',
      feeBps: Math.max(0, num('feeBps', 5)),
    },
  };
}

function toCSV(trades) {
  const header = 'tradeDate,filedDate,ticker,company,side,amountMin,amountMax,owner,source';
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [
    header,
    ...trades.map((t) =>
      [t.tradeDate, t.filedDate, t.ticker, t.company, t.side, t.amountMin, t.amountMax, t.owner, t.source]
        .map(esc)
        .join(',')
    ),
  ].join('\n');
}

/* ---------------------------------------------------------------------------
   路由
   ------------------------------------------------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname;

  try {
    if (route === '/api/state' && req.method === 'GET') {
      const store = await readStore();
      return sendJSON(res, 200, {
        meta: { ...store.meta, datasetKind: datasetKind(store) },
        sectors: store.sectors || {},
        trades: store.trades,
        sources: DATA_SOURCES,
        importTemplate: IMPORT_TEMPLATE_CSV,
        priceRange: { start: null, end: PRICE_END },
        components: null,
      });
    }

    if (route === '/api/analysis' && req.method === 'GET') {
      const store = await readStore();
      const params = parseParams(url);
      const universe = selectPriceUniverse(store.trades);
      const market = buildMarketData(universe.tickers);
      const result = analyze({
        trades: store.trades,
        sectors: store.sectors,
        market,
        ...params,
      });
      return sendJSON(res, 200, {
        ...result,
        universe: {
          total: universe.total,
          included: universe.tickers.length,
          omitted: universe.omitted,
          limit: PRICE_UNIVERSE_LIMIT,
        },
      });
    }

    /* 市場資料：有即時快取就用即時，否則用模擬序列 */
    if ((route === '/api/market' || route === '/api/prices') && req.method === 'GET') {
      const store = await readStore();
      const universe = selectPriceUniverse(store.trades);
      const tickers = universe.tickers;
      const cache = await readCache();
      const forceSynthetic = url.searchParams.get('source') === 'synthetic';
      const universeInfo = {
        total: universe.total,
        included: tickers.length,
        omitted: universe.omitted,
        coveredVolume: universe.coveredVolume,
        totalVolume: universe.totalVolume,
        limit: PRICE_UNIVERSE_LIMIT,
      };

      if (cache.prices && !forceSynthetic) {
        const cached = {};
        for (const t of tickers) if (cache.prices.series[t]) cached[t] = cache.prices.series[t];
        const filled = fillMissingPrices(cached, tickers);
        const benchmark = buildEqualWeightBenchmark(filled.series);
        return sendJSON(res, 200, {
          source: 'live',
          provider: cache.prices.provider,
          fetchedAt: cache.prices.fetchedAt,
          granularity: cache.prices.granularity || '1d',
          asOf: benchmark.length ? benchmark[benchmark.length - 1].date : PRICE_END,
          series: filled.series,
          benchmark,
          filledWithSynthetic: filled.missing,
          errors: cache.prices.errors || [],
          universe: universeInfo,
          note: '即時／收盤價資料。來源為公開非官方端點，請自行核對。',
        });
      }

      const synthetic = buildMarketData(tickers);
      return sendJSON(res, 200, {
        source: 'synthetic',
        provider: 'builtin',
        fetchedAt: null,
        granularity: '1d',
        asOf: synthetic.benchmark[synthetic.benchmark.length - 1].date,
        series: synthetic.series,
        benchmark: synthetic.benchmark,
        filledWithSynthetic: [],
        errors: [],
        universe: universeInfo,
        note: '模擬價格序列（非真實市價）。可在「即時情報」頁同步真實價格。',
      });
    }

    /* 同步即時價格 */
    if (route === '/api/sync/prices' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const store = await readStore();
      const tickers = selectPriceUniverse(store.trades).tickers;
      const config = await readConfig();
      const provider = body.provider || url.searchParams.get('provider') || config.priceProvider || null;
      try {
        const live = await fetchLivePrices(tickers, { provider, apiKey: config.priceApiKey });
        const filled = fillMissingPrices(live.series, tickers);
        const benchmark = buildEqualWeightBenchmark(filled.series);
        await updateCache({
          prices: {
            provider: live.provider,
            granularity: live.granularity,
            fetchedAt: live.fetchedAt,
            series: filled.series,
            benchmark,
            errors: live.errors,
            attempts: live.attempts,
          },
        });
        return sendJSON(res, 200, {
          ok: true,
          provider: live.provider,
          fetchedAt: live.fetchedAt,
          tickers: Object.keys(filled.series).length,
          liveTickers: tickers.length - filled.missing.length,
          filledWithSynthetic: filled.missing,
          perTickerErrors: live.errors,
          attempts: live.attempts,
        });
      } catch (err) {
        return sendJSON(res, 502, {
          error: err.message,
          attempts: err.attempts || [],
          hint: '若你的網路環境無法連外，請改用內建模擬價格；或設定 data/config.json 的 priceProvider。',
        });
      }
    }

    /* 回到模擬價格 */
    if (route === '/api/sync/prices/reset' && req.method === 'POST') {
      const hadCache = Boolean((await readCache()).prices);
      await updateCache({ prices: null });
      return sendJSON(res, 200, { ok: true, source: 'synthetic', hadCache });
    }

    /* 新聞快訊（Google News RSS） */
    if (route === '/api/sync/news' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const query = body.query || 'Trump stock purchase disclosure';
      try {
        const feed = await fetchNewsFeed({ query, limit: 40 });
        await updateCache({ news: feed });
        return sendJSON(res, 200, { ok: true, ...feed });
      } catch (err) {
        return sendJSON(res, 502, { error: err.message, hint: '新聞來源需要連外；可稍後再試或換關鍵字。' });
      }
    }

    if (route === '/api/news' && req.method === 'GET') {
      const cache = await readCache();
      return sendJSON(res, 200, cache.news || { items: [], query: null, fetchedAt: null });
    }

    /* 政策文件（Federal Register） */
    if (route === '/api/sync/policy' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');

      /* all=true：依政策主題逐一抓取（每個主題用自己的關鍵字搜尋） */
      if (body.all) {
        const cache = await readCache();
        const policyByTheme = { ...(cache.policyByTheme || {}) };
        const results = [];
        const store = await readStore();
        const tradeDates = store.trades.map((t) => t.tradeDate).filter(Boolean).sort();
        const fromISO = body.from || tradeDates[0] || '2025-01-01';
        const toISO = body.to || new Date().toISOString().slice(0, 10);
        /* 依季切窗，避免只抓到最新的幾筆而漏掉交易期間較早的月份 */
        const windows = quarterWindows(fromISO, toISO);
        const perWindow = Math.max(2, Math.round((body.limit || 24) / windows.length));
        const queue = [...POLICY_THEMES];
        const worker = async () => {
          while (queue.length) {
            const theme = queue.shift();
            const collected = [];
            let fetchedCount = 0;
            try {
              for (const w of windows) {
                try {
                  const docs = await fetchPolicyDocs({
                    term: theme.keywords[0],
                    limit: perWindow,
                    from: w.from,
                    to: w.to,
                    /* 只取總統文件與法規：排除例行公告與自律組織申報 */
                    types: ['PRESDOCU', 'RULE', 'PRORULE'],
                  });
                  fetchedCount += docs.items.length;
                  collected.push(...docs.items.map((d) => ({ ...d, window: `${w.from}~${w.to}` })));
                } catch {
                  /* 某些關鍵字在特定季度沒有文件是正常的 */
                }
              }
              const seen = new Set();
              const items = collected
                .filter((d) => isRelevantPolicyDoc(d, theme.keywords))
                .filter((d) => (seen.has(d.link) ? false : seen.add(d.link)))
                .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
              if (!items.length) throw new Error('此主題在此期間沒有文件');
              policyByTheme[theme.id] = {
                term: theme.keywords[0],
                items,
                fetched: fetchedCount,
                filteredOut: fetchedCount - items.length,
                windows: windows.map((w) => `${w.from}~${w.to}`),
                fetchedAt: new Date().toISOString(),
              };
              results.push({ themeId: theme.id, name: theme.name, count: items.length, fetched: fetchedCount });
            } catch (err) {
              results.push({ themeId: theme.id, name: theme.name, error: err.message });
            }
          }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
        await updateCache({ policyByTheme });
        const failed = results.filter((r) => r.error);
        return sendJSON(res, failed.length === results.length ? 502 : 200, {
          ok: failed.length < results.length,
          themes: results.sort((a, b) => (a.themeId < b.themeId ? -1 : 1)),
          totalDocs: results.reduce((a, r) => a + (r.count || 0), 0),
          failed: failed.length,
          window: `${fromISO} ~ ${toISO}`,
        });
      }

      const term = body.term || 'tariff';
      try {
        const docs = await fetchPolicyDocs({ term, limit: 20 });
        await updateCache({ policy: docs });
        return sendJSON(res, 200, { ok: true, ...docs });
      } catch (err) {
        return sendJSON(res, 502, { error: err.message });
      }
    }

    if (route === '/api/policy' && req.method === 'GET') {
      const cache = await readCache();
      return sendJSON(res, 200, cache.policy || { items: [], term: null, fetchedAt: null });
    }

    /* 政策主題對照表 + 每個主題已抓到的官方文件 */
    if (route === '/api/policy-map' && req.method === 'GET') {
      const cache = await readCache();
      const docsByTheme = cache.policyByTheme || {};
      return sendJSON(res, 200, {
        themes: POLICY_THEMES,
        docsByTheme,
        disclaimer: POLICY_DISCLAIMER,
        windowDays: 30,
        coverage: POLICY_THEMES.map((t) => ({
          id: t.id,
          name: t.name,
          docs: (docsByTheme[t.id] && docsByTheme[t.id].items.length) || 0,
          fetchedAt: docsByTheme[t.id] ? docsByTheme[t.id].fetchedAt : null,
        })),
      });
    }

    /* AI 機率模型：訓練 + 樣本外檢驗 + 對最新一日預測（結果快取，訓練一次約 4 秒） */
    if (route === '/api/probability' && req.method === 'GET') {
      const horizon = Math.max(1, Math.min(120, Number(url.searchParams.get('horizon')) || 20));
      const step = Math.max(1, Math.min(20, Number(url.searchParams.get('step')) || 5));
      const store = await readStore();
      const liveCache = await readCache();
      const cacheKey = [
        horizon,
        step,
        store.trades.length,
        liveCache.prices ? liveCache.prices.fetchedAt : 'synthetic',
        (liveCache.policyByTheme ? Object.keys(liveCache.policyByTheme).length : 0),
      ].join('|');
      if (probabilityCache.key === cacheKey) {
        return sendJSON(res, 200, probabilityCache.value);
      }

      const universe = selectPriceUniverse(store.trades);
      let market;
      if (liveCache.prices && url.searchParams.get('source') !== 'synthetic') {
        const series = {};
        for (const t of universe.tickers) if (liveCache.prices.series[t]) series[t] = liveCache.prices.series[t];
        market = { series, benchmark: buildEqualWeightBenchmark(series) };
      } else {
        market = buildMarketData(universe.tickers);
      }
      const docsByTheme = liveCache.policyByTheme || {};
      const asOf = market.benchmark.length
        ? market.benchmark[market.benchmark.length - 1].date
        : PRICE_END;
      const policy = analyzePolicy({
        trades: store.trades,
        themes: POLICY_THEMES,
        docsByTheme,
        asOf,
        windowDays: 30,
      });

      const result = runProbabilityModel({
        trades: store.trades,
        market,
        policy,
        docsByTheme,
        themes: POLICY_THEMES,
        asOf,
        horizonDays: horizon,
        stepDays: step,
        testRatio: 0.3,
        daysBetweenFn: daysBetween,
        midAmountFn: midAmount,
      });
      result.priceSource = liveCache.prices ? 'live' : 'synthetic';
      probabilityCache = { key: cacheKey, value: result };
      return sendJSON(res, 200, result);
    }

    /* 事件時鐘：抓未來 N 天的政策生效日與財報日 */
    if (route === '/api/sync/events' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const days = Math.max(7, Math.min(90, Number(body.days) || 30));
      const store = await readStore();
      const cache = await readCache();
      const universe = selectPriceUniverse(store.trades);
      const asOf = cache.prices && cache.prices.benchmark && cache.prices.benchmark.length
        ? cache.prices.benchmark[cache.prices.benchmark.length - 1].date
        : PRICE_END;
      const to = addDays(asOf, days);
      const businessDays = nextBusinessDays(asOf, Math.min(70, Math.ceil((days * 5) / 7) + 2));

      const [policyResult, earningsResult] = await Promise.all([
        fetchUpcomingPolicyEvents({
          themes: POLICY_THEMES,
          from: asOf,
          to,
          publishedFrom: addDays(asOf, -240),
          publishedTo: to,
          limit: 20,
        }).catch((err) => ({ items: [], error: err.message })),
        fetchEarningsRange({
          from: asOf,
          count: businessDays.length,
          tickers: universe.tickers,
        }).catch((err) => ({ items: [], errors: [{ date: '*', error: err.message }] })),
      ]);

      const payload = {
        asOf,
        days,
        policyEvents: policyResult.items || [],
        policyError: policyResult.error || null,
        earnings: earningsResult.items || [],
        earningsErrors: (earningsResult.errors || []).length,
        fetchedAt: new Date().toISOString(),
      };
      await updateCache({ events: payload });
      return sendJSON(res, 200, {
        ok: true,
        ...payload,
        counts: {
          policyEffective: (payload.policyEvents || []).filter((e) => e.effectiveOn >= asOf && e.effectiveOn <= to).length,
          commentDeadline: (payload.policyEvents || []).filter((e) => e.commentsCloseOn >= asOf && e.commentsCloseOn <= to).length,
          earnings: payload.earnings.length,
        },
      });
    }

    if (route === '/api/events' && req.method === 'GET') {
      const store = await readStore();
      const cache = await readCache();
      const days = Math.max(7, Math.min(120, Number(url.searchParams.get('days')) || (cache.events ? cache.events.days : 30)));
      const asOf = cache.events && cache.events.asOf
        ? cache.events.asOf
        : cache.prices && cache.prices.benchmark && cache.prices.benchmark.length
          ? cache.prices.benchmark[cache.prices.benchmark.length - 1].date
          : PRICE_END;
      const clock = buildEventClock({
        asOf,
        days,
        policyEvents: (cache.events && cache.events.policyEvents) || [],
        earnings: (cache.events && cache.events.earnings) || [],
        contracts: (cache.contracts && cache.contracts.items) || [],
        tickerSectors: store.sectors || {},
      });
      return sendJSON(res, 200, {
        ...clock,
        fetchedAt: cache.events ? cache.events.fetchedAt : null,
        policyError: (cache.events && cache.events.policyError) || null,
        earningsErrors: (cache.events && cache.events.earningsErrors) || 0,
        types: EVENT_TYPES,
      });
    }

    /* SEC Form 4 內部人交易：抓取並快取 */
    if (route === '/api/sync/insiders' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const perTicker = Math.max(1, Math.min(12, Number(body.perTicker) || 5));
      const maxTickers = Math.max(5, Math.min(60, Number(body.maxTickers) || 36));
      const store = await readStore();
      const universe = selectPriceUniverse(store.trades);
      const stored = await readPositions();
      /* 注意：要用「依申報金額排序」的 rankedTickers，不是字母序的 tickers */
      const wanted = [
        ...universe.rankedTickers.slice(0, maxTickers),
        ...stored.positions.map((p) => p.ticker),
      ];
      const tickers = [...new Set(wanted)].filter((t) => universe.tickers.includes(t)).slice(0, maxTickers + 10);

      try {
        const cikMap = await fetchCikMap();
        const transactions = [];
        const errors = [];
        const skipped = [];
        const queue = tickers.map((t) => ({ ticker: t, cik: cikMap[t] }));
        const worker = async () => {
          while (queue.length) {
            const item = queue.shift();
            if (!item.cik) {
              skipped.push(item.ticker);
              continue;
            }
            try {
              const recent = await fetchCompanyForm4Filings(item.cik, { limit: perTicker });
              for (const filing of recent.filings) {
                try {
                  const parsed = parseForm4(await fetchForm4Xml(item.cik, filing));
                  /* 這個 CIK 也可能只是申報人（例如 10% 股東），要確認它真的是發行人 */
                  if (String(parsed.issuerCik).padStart(10, '0') !== item.cik) continue;
                  transactions.push(...flattenForm4(parsed, filing));
                } catch (err) {
                  errors.push({ ticker: item.ticker, accession: filing.accession, error: err.message });
                }
              }
            } catch (err) {
              errors.push({ ticker: item.ticker, error: err.message });
            }
          }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
        const payload = {
          transactions,
          fetchedAt: new Date().toISOString(),
          tickers,
          perTicker,
          errorCount: errors.length,
          errors: errors.slice(0, 8),
          skipped,
        };
        await updateCache({ insiders: payload });
        return sendJSON(res, 200, {
          ok: true,
          fetchedAt: payload.fetchedAt,
          tickers: tickers.length,
          transactions: transactions.length,
          buys: transactions.filter((t) => t.code === 'P').length,
          sells: transactions.filter((t) => t.code === 'S').length,
          errorCount: errors.length,
          skipped,
        });
      } catch (err) {
        return sendJSON(res, 502, { error: `SEC EDGAR 抓取失敗：${err.message}` });
      }
    }

    if (route === '/api/insiders' && req.method === 'GET') {
      const cache = await readCache();
      if (!cache.insiders) {
        return sendJSON(res, 200, { ok: false, reason: '尚未抓取內部人交易，請先按「抓取 Form 4」' });
      }
      const store = await readStore();
      const asOf = cache.prices && cache.prices.benchmark && cache.prices.benchmark.length
        ? cache.prices.benchmark[cache.prices.benchmark.length - 1].date
        : PRICE_END;
      const windowDays = Math.max(30, Math.min(365, Number(url.searchParams.get('days')) || 120));

      const all = cache.insiders.transactions || [];
      const summary = summarizeInsiders(all, { asOf, windowDays });
      const recent = recentTransactions(all, { asOf, windowDays, limit: 300 });
      const buys = recentTransactions(all, { asOf, windowDays, limit: 150, codes: ['P'] });

      const docsByTheme = cache.policyByTheme || {};
      const policy = analyzePolicy({ trades: store.trades, themes: POLICY_THEMES, docsByTheme, asOf, windowDays: 30 });
      const byTicker = new Map();
      for (const t of store.trades) {
        const cur = byTicker.get(t.ticker) || { buy: 0, sell: 0, count: 0 };
        const mid = midAmount(t);
        if (t.side === 'BUY') cur.buy += mid;
        else cur.sell += mid;
        cur.count++;
        byTicker.set(t.ticker, cur);
      }
      const crossRef = summary
        .filter((r) => r.buyCount > 0)
        .map((r) => {
          const own = byTicker.get(r.ticker) || { buy: 0, sell: 0, count: 0 };
          const pol = policy.tickers[r.ticker];
          return {
            ticker: r.ticker,
            insiderScore: r.score,
            insiderBuyValue: r.buyValue,
            insiderBuyerCount: r.buyerCount,
            insiderCluster: r.cluster,
            disclosedNet: own.buy - own.sell,
            disclosedCount: own.count,
            policySensitivity: pol ? pol.sensitivity : null,
            policyThemes: pol ? pol.themes.map((t) => t.name) : [],
            flags: r.flags,
          };
        });

      const allBuys = all.filter((t) => t.code === 'P');
      const allSells = all.filter((t) => t.code === 'S');
      return sendJSON(res, 200, {
        ok: true,
        fetchedAt: cache.insiders.fetchedAt,
        asOf,
        windowDays,
        scannedTickers: (cache.insiders.tickers || []).length,
        summary,
        recent,
        buys,
        crossRef,
        codeLabels: TRANSACTION_CODES,
        totals: {
          transactions: all.length,
          buyCount: allBuys.length,
          buyValue: allBuys.reduce((a, t) => a + (t.value || 0), 0),
          sellCount: allSells.length,
          sellValue: allSells.reduce((a, t) => a + (t.value || 0), 0),
          clusterTickers: summary.filter((r) => r.cluster >= 2).length,
          buyers: summary.filter((r) => r.buyCount > 0).length,
        },
      });
    }

    /* 我的部位：匯入 / 讀取 / 清除 */
    if (route === '/api/positions' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (body.clear) {
        await writePositions({ positions: [], updatedAt: new Date().toISOString() });
        return sendJSON(res, 200, { ok: true, cleared: true, positionCount: 0 });
      }
      const text = String(body.text || '').trim();
      if (!text) return sendJSON(res, 400, { error: '沒有收到部位資料' });
      let rows;
      if (body.format === 'json' || text.startsWith('[') || text.startsWith('{')) {
        const parsed = JSON.parse(text);
        rows = Array.isArray(parsed) ? parsed : parsed.positions;
        if (!Array.isArray(rows)) return sendJSON(res, 400, { error: 'JSON 必須是陣列或含 positions 的物件' });
      } else {
        rows = parseCSV(text);
      }
      const { positions, errors } = normalizePositions(rows);
      if (!positions.length) {
        return sendJSON(res, 400, { error: '沒有有效的部位', errors: errors.slice(0, 10) });
      }
      const merged = body.mode === 'append'
        ? [...(await readPositions()).positions, ...positions]
        : positions;
      await writePositions({ positions: merged, updatedAt: new Date().toISOString() });
      return sendJSON(res, 200, {
        ok: true,
        accepted: positions.length,
        rejected: errors.length,
        errors: errors.slice(0, 10),
        positionCount: merged.length,
        totalValueNote: '成本為選填；沒有成本就只算市值與權重，不算損益。',
      });
    }

    if (route === '/api/positions' && req.method === 'GET') {
      const stored = await readPositions();
      if (!stored.positions.length) {
        return sendJSON(res, 200, { ok: false, reason: '尚未匯入部位', positions: [] });
      }
      const store = await readStore();
      const cache = await readCache();
      const universe = selectPriceUniverse(store.trades);
      let market;
      if (cache.prices) {
        const series = {};
        for (const t of universe.tickers) if (cache.prices.series[t]) series[t] = cache.prices.series[t];
        market = { series, benchmark: buildEqualWeightBenchmark(series) };
      } else {
        market = buildMarketData(universe.tickers);
      }
      const asOf = market.benchmark.length
        ? market.benchmark[market.benchmark.length - 1].date
        : PRICE_END;
      const capacity = computeCapacity({ market, trades: store.trades, asOf });
      const docsByTheme = cache.policyByTheme || {};
      const policy = analyzePolicy({ trades: store.trades, themes: POLICY_THEMES, docsByTheme, asOf, windowDays: 30 });

      /* 機率與事件是「加分項」：抓不到就略過，不影響部位分析 */
      let probability = null;
      try {
        const horizon = 20;
        const key = `pos|${horizon}|${store.trades.length}|${cache.prices ? cache.prices.fetchedAt : 'syn'}`;
        if (probabilityCache.key === key) probability = probabilityCache.value;
        else {
          probability = runProbabilityModel({
            trades: store.trades, market, policy, docsByTheme, themes: POLICY_THEMES, asOf,
            horizonDays: horizon, stepDays: 5, testRatio: 0.3,
            daysBetweenFn: daysBetween, midAmountFn: midAmount,
          });
          probabilityCache = { key, value: probability };
        }
      } catch {
        probability = null;
      }

      const events = cache.events
        ? buildEventClock({
            asOf,
            days: cache.events.days || 45,
            policyEvents: cache.events.policyEvents || [],
            earnings: cache.events.earnings || [],
            contracts: (cache.contracts && cache.contracts.items) || [],
            tickerSectors: store.sectors || {},
          })
        : null;

      let regime = null;
      if (cache.regime && cache.regime.series) {
        const r = computeRegime({ series: cache.regime.series });
        if (r.ok) regime = { state: r.state, score: r.score };
      }

      const analysis = analyzePositions({
        positions: stored.positions,
        market,
        capacity,
        policy,
        probability,
        events,
        regime,
        sectors: store.sectors || {},
        asOf,
      });
      return sendJSON(res, 200, {
        ok: true,
        updatedAt: stored.updatedAt,
        ...analysis,
        meta: { priceSource: cache.prices ? 'live' : 'synthetic', hasProbability: Boolean(probability), hasEvents: Boolean(events) },
      });
    }

    /* 市場體制：抓跨資產序列 */
    if (route === '/api/sync/regime' && req.method === 'POST') {
      const symbols = Object.values(REGIME_SYMBOLS);
      try {
        const live = await fetchLivePrices(symbols, { provider: 'yahoo', range: '2y' });
        await updateCache({
          regime: {
            series: live.series,
            fetchedAt: live.fetchedAt,
            errors: live.errors || [],
          },
        });
        return sendJSON(res, 200, {
          ok: true,
          fetchedAt: live.fetchedAt,
          symbols: Object.keys(live.series).length,
          expected: symbols.length,
          errors: live.errors || [],
        });
      } catch (err) {
        return sendJSON(res, 502, { error: err.message });
      }
    }

    /* 市場體制：維度分數 + 體制時間軸 + 體制別訊號表現 */
    if (route === '/api/regime' && req.method === 'GET') {
      const store = await readStore();
      const cache = await readCache();
      if (!cache.regime || !cache.regime.series) {
        return sendJSON(res, 200, { ok: false, reason: '尚未抓取跨資產資料，請先按「更新體制資料」' });
      }
      const regimeKey = `regime|${store.trades.length}|${cache.regime.fetchedAt}`;
      if (regimeCache.key === regimeKey) return sendJSON(res, 200, regimeCache.value);

      const regime = computeRegime({ series: cache.regime.series });
      const universe = selectPriceUniverse(store.trades);
      let market;
      if (cache.prices) {
        const series = {};
        for (const t of universe.tickers) if (cache.prices.series[t]) series[t] = cache.prices.series[t];
        market = { series, benchmark: buildEqualWeightBenchmark(series) };
      } else {
        market = buildMarketData(universe.tickers);
      }
      const asOf = regime.asOf || PRICE_END;
      const horizons = [1, 5, 20, 60];
      const rows = buildDataset({
        trades: store.trades,
        market,
        policy: null,
        docsByTheme: {},
        themes: [],
        asOf,
        horizonDays: 20,
        stepDays: 5,
        horizons,
        daysBetweenFn: daysBetween,
        midAmountFn: midAmount,
      });
      const conditional = regimeConditionalScorecard(rows, regime.timeline, CONDITIONS, horizons);

      const payload = {
        ok: true,
        fetchedAt: cache.regime.fetchedAt,
        errors: cache.regime.errors || [],
        regime: {
          asOf: regime.asOf,
          score: regime.score,
          state: regime.state,
          dimensions: regime.dimensions,
        },
        /* 時間軸只回傳每週取樣，避免前端畫 500 個點 */
        timeline: regime.timeline.filter((_, i) => i % 5 === 0 || i === regime.timeline.length - 1),
        spy: (cache.regime.series[REGIME_SYMBOLS.spy] || []).filter((_, i) => i % 5 === 0),
        conditional,
        dimensionMeta: REGIME_DIMENSIONS,
      };
      regimeCache = { key: regimeKey, value: payload };
      return sendJSON(res, 200, payload);
    }

    /* 執行面：容量／流動性 + 訊號計分卡（衰減曲線、IC） */
    if (route === '/api/desk' && req.method === 'GET') {
      const store = await readStore();
      const cache = await readCache();
      const universe = selectPriceUniverse(store.trades);
      let market;
      if (cache.prices) {
        const series = {};
        for (const t of universe.tickers) if (cache.prices.series[t]) series[t] = cache.prices.series[t];
        market = { series, benchmark: buildEqualWeightBenchmark(series) };
      } else {
        market = buildMarketData(universe.tickers);
      }
      const asOf = market.benchmark.length
        ? market.benchmark[market.benchmark.length - 1].date
        : PRICE_END;
      const deskKey = `desk|${store.trades.length}|${cache.prices ? cache.prices.fetchedAt : 'syn'}`;
      if (deskCache.key === deskKey) {
        return sendJSON(res, 200, deskCache.value);
      }
      const horizons = [1, 5, 10, 20, 40, 60];
      const capacity = computeCapacity({ market, trades: store.trades, asOf });
      /* 計分卡也要納入政策特徵，否則 policySens／policyEvents60 會全是 0 */
      const docsByTheme = cache.policyByTheme || {};
      const policy = analyzePolicy({
        trades: store.trades,
        themes: POLICY_THEMES,
        docsByTheme,
        asOf,
        windowDays: 30,
      });
      const rows = buildDataset({
        trades: store.trades,
        market,
        policy,
        docsByTheme,
        themes: POLICY_THEMES,
        asOf,
        horizonDays: 20,
        stepDays: 5,
        horizons,
        daysBetweenFn: daysBetween,
        midAmountFn: midAmount,
      });
      const scorecard = signalScorecard(rows, horizons);
      const payload = {
        ok: true,
        asOf,
        priceSource: cache.prices ? 'live' : 'synthetic',
        capacity,
        scorecard,
      };
      deskCache = { key: deskKey, value: payload };
      return sendJSON(res, 200, payload);
    }

    /* 政府採購合約（USAspending） */
    if (route === '/api/sync/contracts' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      try {
        const data = await fetchContracts({ days: body.days || 30, limit: 25 });
        await updateCache({ contracts: data });
        return sendJSON(res, 200, { ok: true, ...data });
      } catch (err) {
        return sendJSON(res, 502, { error: err.message });
      }
    }

    if (route === '/api/contracts' && req.method === 'GET') {
      const cache = await readCache();
      return sendJSON(res, 200, cache.contracts || { items: [], fetchedAt: null });
    }

    /* OGE 官方申報監看：抓特朗普本人的申報清單並標記「新出現的申報」 */
    if (route === '/api/sync/oge' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const name = body.name || 'Trump, Donald J';
      try {
        const result = await fetchOgeFilings({ name });
        const cache = await readCache();
        const previous = (cache.oge && cache.oge.filings) || [];
        const diff = diffFilings(previous, result.filings);
        /* 第一次執行只建立基準，不把既有紀錄全部標成「新申報」 */
        const firstRun = previous.length === 0;
        const freshKeys = firstRun ? [] : diff.fresh.map(filingKey);
        await updateCache({
          oge: {
            name,
            filings: result.filings,
            recordsTotal: result.recordsTotal,
            fetchedAt: result.fetchedAt,
            freshKeys,
            previousFetchedAt: cache.oge ? cache.oge.fetchedAt : null,
          },
        });
        return sendJSON(res, 200, {
          ok: true,
          name,
          total: result.filings.length,
          transactionReports: result.filings.filter((f) => f.isTransactionReport).length,
          fresh: freshKeys.length ? diff.fresh : [],
          removed: diff.removed.length,
          fetchedAt: result.fetchedAt,
          firstRun,
        });
      } catch (err) {
        return sendJSON(res, 502, {
          error: err.message,
          hint: 'OGE 端點需要連外；此為官方公開資料庫，通常不需特殊網路設定。',
        });
      }
    }

    if (route === '/api/oge' && req.method === 'GET') {
      const cache = await readCache();
      return sendJSON(res, 200, cache.oge || { filings: [], fetchedAt: null, freshKeys: [] });
    }

    /* 下載單一申報 PDF 正本到 data/oge/ */
    if (route === '/api/oge/download' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.link) return sendJSON(res, 400, { error: '缺少 link' });
      const fileName = safeFileName(body.file || `filing-${Date.now()}.pdf`);
      const dest = path.join(DATA_DIR, 'oge', fileName);
      try {
        const result = await downloadFilingPdf(body.link, dest, { fs, path });
        if (!result.ok) return sendJSON(res, 502, { error: `下載失敗：${result.error}` });
        return sendJSON(res, 200, {
          ok: true,
          file: fileName,
          bytes: result.bytes,
          localPath: path.relative(ROOT, dest).replace(/\\/g, '/'),
          note: '已存到本機；這些 PDF 是掃描影像，交易明細需要 OCR 才能轉成表格。',
        });
      } catch (err) {
        return sendJSON(res, 500, { error: err.message });
      }
    }

    /* 列出 data/ 下所有可匯入的 CSV，方便一鍵載入 */
    if (route === '/api/import/files' && req.method === 'GET') {
      const found = [];
      const walk = async (dir, depth = 0) => {
        if (depth > 3) return;
        let entries = [];
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(full, depth + 1);
          } else if (/\.(csv|json)$/i.test(entry.name) && entry.name !== 'store.json' && entry.name !== 'live-cache.json') {
            const stat = await fs.stat(full);
            let rows = null;
            let columns = [];
            if (/\.csv$/i.test(entry.name) && stat.size < 20 * 1024 * 1024) {
              const text = await fs.readFile(full, 'utf8');
              const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
              rows = Math.max(0, lines.length - 1);
              columns = (lines[0] || '').split(',').map((c) => c.trim()).slice(0, 14);
            }
            found.push({
              path: path.relative(ROOT, full).replace(/\\/g, '/'),
              name: entry.name,
              bytes: stat.size,
              rows,
              columns,
            });
          }
        }
      };
      await walk(DATA_DIR);
      found.sort((a, b) => b.bytes - a.bytes);
      return sendJSON(res, 200, { files: found, externalDatasets: EXTERNAL_DATASETS });
    }

    /* 匯入 data/ 下的既有 CSV（路徑必須在 data/ 之內） */
    if (route === '/api/import/file' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const rel = String(body.path || '').replace(/^[/\\]+/, '');
      const abs = path.resolve(ROOT, rel);
      if (!abs.startsWith(path.resolve(DATA_DIR))) {
        return sendJSON(res, 403, { error: '只能匯入 data/ 目錄下的檔案' });
      }
      let text;
      try {
        text = await fs.readFile(abs, 'utf8');
      } catch {
        return sendJSON(res, 404, { error: `找不到檔案 ${rel}` });
      }
      const isJson = /\.json$/i.test(abs);
      const parsed = importTrades(text, isJson ? 'json' : 'csv');
      if (!parsed.trades.length) {
        return sendJSON(res, 400, { error: '檔案中沒有可用的紀錄', errors: parsed.errors.slice(0, 10) });
      }
      /* 沒有來源欄位的紀錄，補上檔名以便追溯 */
      for (const t of parsed.trades) {
        if (!t.source || t.source === '使用者匯入') t.source = rel;
      }
      /* 若 CSV 帶有 sector 欄位，一併更新產業對照 */
      const sectorsFromFile = {};
      if (!isJson) {
        for (const row of parseCSV(text)) {
          const ticker = String(row.ticker || row.Ticker || '').trim().toUpperCase();
          const sector = String(row.sector || row.Sector || '').trim();
          if (ticker && sector) sectorsFromFile[ticker] = sector;
        }
      }
      const store = await readStore();
      const mode = body.mode === 'append' ? 'append' : 'replace';
      const next = mergeImportedTrades(store, parsed.trades, { mode, source: rel });
      next.sectors = { ...(next.sectors || {}), ...sectorsFromFile };
      next.meta.sourceFile = rel;
      await writeStore(next);
      const universe = selectPriceUniverse(next.trades);
      return sendJSON(res, 200, {
        ok: true,
        accepted: parsed.trades.length,
        rejected: parsed.errors.length,
        errors: parsed.errors.slice(0, 10),
        tradeCount: next.trades.length,
        tickerCount: universe.total,
        sectorCount: Object.keys(next.sectors || {}).length,
        datasetKind: next.meta.datasetKind,
        sourceFile: rel,
      });
    }

    /* 一鍵載入第三方已解析資料集（會自動下載到 data/external/） */
    if (route === '/api/import/external' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const dataset = EXTERNAL_DATASETS.find((d) => d.id === (body.datasetId || 'trump-278t-q1-2026'));
      if (!dataset) return sendJSON(res, 404, { error: '未知的資料集' });
      const localPath = path.join(DATA_DIR, 'external', 'dataset.json');
      let datasetJson;
      try {
        datasetJson = JSON.parse(await fs.readFile(localPath, 'utf8'));
      } catch {
        try {
          const files = await fetchExternalDatasetFiles(dataset);
          await fs.mkdir(path.join(DATA_DIR, 'external'), { recursive: true });
          for (const [name, content] of Object.entries(files)) {
            await fs.writeFile(path.join(DATA_DIR, 'external', name), content, 'utf8');
          }
          datasetJson = JSON.parse(files['dataset.json']);
        } catch (err) {
          return sendJSON(res, 502, { error: `無法取得資料集：${err.message}` });
        }
      }
      const converted = convertExternalDataset(datasetJson, {
        filedDate: body.filedDate || dataset.filedDate,
        sourceLabel: `OGE 278-T（第三方解析：${dataset.repo}）`,
      });
      if (!converted.trades.length) return sendJSON(res, 422, { error: '資料集轉換後沒有任何交易' });
      const store = await readStore();
      const mode = body.mode === 'append' ? 'append' : 'replace';
      const next = mergeImportedTrades(store, converted.trades, { mode, source: `dataset:${dataset.id}` });
      next.sectors = mode === 'append' ? { ...(next.sectors || {}), ...converted.sectors } : converted.sectors;
      next.meta.externalDataset = { ...converted.meta, name: dataset.name, note: dataset.note, repo: dataset.repo };
      await writeStore(next);
      return sendJSON(res, 200, {
        ok: true,
        accepted: converted.trades.length,
        tradeCount: next.trades.length,
        tickerCount: new Set(next.trades.map((t) => t.ticker)).size,
        sectorCount: Object.keys(next.sectors || {}).length,
        datasetKind: next.meta.datasetKind,
        meta: converted.meta,
      });
    }

    /* 通用申報端點：抓 JSON → 自動對應欄位 → 併入資料集 */
    if (route === '/api/sync/disclosures' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      try {
        const feed = await fetchDisclosureEndpoint({ url: body.url, apiKey: body.apiKey });
        const parsed = importTrades(JSON.stringify(feed.records), 'json');
        if (!parsed.trades.length) {
          return sendJSON(res, 422, {
            error: '端點有回傳紀錄，但沒有可用欄位（需要 ticker 與日期）',
            sample: feed.records[0],
          });
        }
        const store = await readStore();
        const mode = body.mode === 'append' ? 'append' : 'replace';
        const next = mergeImportedTrades(store, parsed.trades, { mode, source: 'endpoint' });
        await writeStore(next);
        return sendJSON(res, 200, {
          ok: true,
          accepted: parsed.trades.length,
          rejected: parsed.errors.length,
          errors: parsed.errors.slice(0, 10),
          tradeCount: next.trades.length,
          tickerCount: new Set(next.trades.map((t) => t.ticker)).size,
          datasetKind: next.meta.datasetKind,
        });
      } catch (err) {
        return sendJSON(res, 502, { error: err.message });
      }
    }

    /* 來源清單與快取狀態 */
    if (route === '/api/providers' && req.method === 'GET') {
      const cache = await readCache();
      const config = await readConfig();
      return sendJSON(res, 200, {
        providers: PROVIDERS_INFO,
        cache: {
          prices: cache.prices
            ? { provider: cache.prices.provider, fetchedAt: cache.prices.fetchedAt, tickers: Object.keys(cache.prices.series || {}).length }
            : null,
          news: cache.news ? { query: cache.news.query, fetchedAt: cache.news.fetchedAt, count: cache.news.items.length } : null,
          policy: cache.policy ? { term: cache.policy.term, fetchedAt: cache.policy.fetchedAt, count: cache.policy.items.length } : null,
          contracts: cache.contracts ? { fetchedAt: cache.contracts.fetchedAt, count: cache.contracts.items.length } : null,
          oge: cache.oge
            ? {
                name: cache.oge.name,
                fetchedAt: cache.oge.fetchedAt,
                count: cache.oge.filings.length,
                transactionReports: cache.oge.filings.filter((f) => f.isTransactionReport).length,
                fresh: (cache.oge.freshKeys || []).length,
              }
            : null,
        },
        config: { priceProvider: config.priceProvider || null, hasApiKey: Boolean(config.priceApiKey) },
      });
    }

    if (route === '/api/import' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const format = body.format === 'json' ? 'json' : 'csv';
      const mode = body.mode === 'append' ? 'append' : 'replace';
      const text = String(body.text || '');
      if (!text.trim()) return sendJSON(res, 400, { error: '沒有收到任何內容' });

      let parsed;
      try {
        parsed = importTrades(text, format);
      } catch (err) {
        return sendJSON(res, 400, { error: `解析失敗：${err.message}` });
      }
      if (!parsed.trades.length) {
        return sendJSON(res, 400, { error: '沒有任何有效紀錄', errors: parsed.errors.slice(0, 20) });
      }

      const store = await readStore();
      const next = mergeImportedTrades(store, parsed.trades, { mode, source: 'imported' });
      next.meta.lastImport = { mode, format, accepted: parsed.trades.length, rejected: parsed.errors.length };
      await writeStore(next);
      return sendJSON(res, 200, {
        ok: true,
        accepted: parsed.trades.length,
        rejected: parsed.errors.length,
        errors: parsed.errors.slice(0, 20),
        tradeCount: next.trades.length,
        tickerCount: new Set(next.trades.map((t) => t.ticker)).size,
        datasetKind: next.meta.datasetKind,
      });
    }

    if (route === '/api/reset' && req.method === 'POST') {
      await writeStore(demoStore());
      return sendJSON(res, 200, { ok: true, restored: 'demo' });
    }

    if (route === '/api/export.csv' && req.method === 'GET') {
      const store = await readStore();
      const csv = toCSV(store.trades);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="trump-trades.csv"',
      });
      return res.end('\uFEFF' + csv);
    }

    if (route === '/api/health') {
      return sendJSON(res, 200, { ok: true, uptime: process.uptime() });
    }

    if (route.startsWith('/api/')) {
      return sendJSON(res, 404, { error: `未知的 API 路徑 ${route}` });
    }

    if (route === '/' || route === '/index.html') {
      return serveFile(res, PUBLIC_DIR, 'index.html');
    }
    /* 前端需載入共用引擎與示範來源說明 */
    if (route === '/engine.mjs') return serveFile(res, ROOT, 'engine.mjs');
    if (route === '/demo-data.mjs') return serveFile(res, ROOT, 'demo-data.mjs');

    return serveFile(res, PUBLIC_DIR, route);
  } catch (err) {
    console.error('[server]', err);
    return sendJSON(res, 500, { error: err.message || '內部錯誤' });
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  特朗普交易雷達 / Trump Trade Radar');
  console.log(`  ➜  http://localhost:${PORT}`);
  console.log('  （內建示範資料集；可在「資料管理」頁匯入真實申報紀錄）');
  console.log('');
});
