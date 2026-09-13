/* ============================================================================
   特朗普交易雷達 — 前端主程式
   分析全部由共用的 /engine.mjs 在前端即時計算，調整權重不需往返伺服器。
   ========================================================================== */

import {
  analyze,
  analyzePolicy,
  buildMarketData,
  buildPriceSeries,
  COMPONENTS,
  DEFAULT_WEIGHTS,
  DEFAULT_PORTFOLIO,
  DEFAULT_BACKTEST,
  PRICE_END,
  fmtMoney,
  midAmount,
  daysBetween,
/* 相對路徑：本機伺服器與靜態空間（含 GitHub Pages 子目錄）都能運作 */
} from './engine.mjs';

/* ----------------------------- 全域狀態 ----------------------------- */

const state = {
  trades: [],
  sectors: {},
  meta: {},
  sources: [],
  importTemplate: '',
  market: null,
  asOf: PRICE_END,
  priceMeta: null,
  providers: null,
  news: { items: [] },
  frFeed: { items: [] },
  contracts: { items: [] },
  oge: { filings: [], freshKeys: [] },
  policyThemes: [],
  docsByTheme: {},
  policy: null,
  policyWindowDays: 30,
  policyThemeId: null,
  policyDisclaimer: '',
  weights: { ...DEFAULT_WEIGHTS },
  portfolioParams: { ...DEFAULT_PORTFOLIO },
  backtestParams: { ...DEFAULT_BACKTEST },
  analysis: null,
  selected: null,
  filter: { search: '', side: '', amount: 0, from: '', to: '' },
  sort: { key: 'tradeDate', dir: -1 },
  tradePage: 1,
  signalLimit: 150,
};

const PALETTE = ['#2dd4bf', '#f0b429', '#64a8ff', '#a78bfa', '#f472b6', '#4ade80', '#fb923c', '#38bdf8', '#facc15', '#94a3b8'];

/* ----------------------------- 小工具 ----------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (x, d = 1) => (x === null || x === undefined || Number.isNaN(x) ? '—' : `${(x * 100).toFixed(d)}%`);
const signed = (x, d = 1) => (x === null || x === undefined ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const cls = (x) => (x === null || x === undefined ? 'muted' : x >= 0 ? 'up' : 'down');
const scoreClass = (s) => (s >= 65 ? 'score-strong' : s >= 45 ? 'score-mid' : 'score-weak');
const dollars = (n) => `$${fmtMoney(n ?? 0)}`;
const moneyFull = (n) => `$${Math.round(n ?? 0).toLocaleString('en-US')}`;

/* ---------------------------------------------------------------------------
   資料來源：同一份程式碼同時支援「本機伺服器」與「靜態快照」
   本機：GET/POST /api/xxx
   靜態：GET 改讀 data/xxx.json（查詢參數忽略，因為值是建置時烘進去的）；
        寫入操作在靜態版不支援，直接回 400。
   ------------------------------------------------------------------------- */
const STATIC_MODE = typeof window !== 'undefined' && !!window.__TTR_STATIC__;
const API_BASE = (typeof window !== 'undefined' && window.__TTR_API_BASE__) || '/api/';
const STATIC_DATA_BASE = STATIC_MODE && window.__TTR_STATIC__.dataBase ? window.__TTR_STATIC__.dataBase : 'data/';

function apiFetch(path, init) {
  const method = String((init && init.method) || 'GET').toUpperCase();
  if (STATIC_MODE) {
    if (method !== 'GET') {
      return Promise.resolve(
        new Response(JSON.stringify({ error: '這是靜態快照版本，不支援同步或匯入；請在本機執行 node server.mjs 使用完整功能。' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }
    const name = String(path).split('?')[0].replace(/^\/+/, '');
    return fetch(`${STATIC_DATA_BASE}${name}.json`, init);
  }
  return fetch(`${API_BASE}${String(path).replace(/^\/+/, '')}`, init);
}

function setLoading(on) {
  $('#loading').hidden = !on;
}

/* 拖動滑桿時以 requestAnimationFrame 合併重算，避免每個 input 事件都重跑分析 */
let recomputePending = false;
function scheduleRecompute(...tabs) {
  if (recomputePending) return;
  recomputePending = true;
  requestAnimationFrame(() => {
    recomputePending = false;
    recompute();
    markDirty(...tabs);
    renderActiveTab();
  });
}

/* ----------------------------- 啟動流程 ----------------------------- */

async function boot() {
  setLoading(true);
  try {
    const [stateRes, marketRes, providerRes, newsRes, policyRes, contractRes, ogeRes] = await Promise.all([
      apiFetch('state'),
      apiFetch('market'),
      apiFetch('providers'),
      apiFetch('news'),
      apiFetch('policy'),
      apiFetch('contracts'),
      apiFetch('oge'),
    ]);
    const policyMapRes = await apiFetch('policy-map');
    if (policyMapRes.ok) {
      const pm = await policyMapRes.json();
      state.policyThemes = pm.themes || [];
      state.docsByTheme = pm.docsByTheme || {};
      state.policyDisclaimer = pm.disclaimer || '';
      state.policyWindowDays = Number($('#pol-window') ? $('#pol-window').value : 30) || 30;
      if (!state.policyThemeId && state.policyThemes.length) state.policyThemeId = state.policyThemes[0].id;
    }
    if (!stateRes.ok) throw new Error(`載入失敗（HTTP ${stateRes.status}）`);
    const data = await stateRes.json();
    state.trades = data.trades || [];
    state.sectors = data.sectors || {};
    state.meta = data.meta || {};
    state.sources = data.sources || [];
    state.importTemplate = data.importTemplate || '';

    const tickers = [...new Set(state.trades.map((t) => t.ticker))].sort();
    const market = marketRes.ok ? await marketRes.json() : null;
    if (market && market.series) {
      state.market = { series: market.series, benchmark: market.benchmark };
      state.priceMeta = market;
      state.asOf = market.asOf || market.benchmark[market.benchmark.length - 1].date;
    } else {
      state.market = buildMarketData(tickers);
      state.priceMeta = { source: 'synthetic', provider: 'builtin', fetchedAt: null, errors: [] };
      state.asOf = state.market.benchmark[state.market.benchmark.length - 1].date;
    }
    const today = new Date().toISOString().slice(0, 10);
    if (state.asOf > today) {
      state.asOf = today;
    }
    const lastSeriesDate = state.market.benchmark[state.market.benchmark.length - 1].date;
    if (state.asOf > lastSeriesDate) state.asOf = lastSeriesDate;

    state.providers = providerRes.ok ? await providerRes.json() : null;
    state.news = newsRes.ok ? await newsRes.json() : { items: [] };
    state.frFeed = policyRes.ok ? await policyRes.json() : { items: [] };
    state.contracts = contractRes.ok ? await contractRes.json() : { items: [] };
    state.oge = ogeRes.ok ? await ogeRes.json() : { filings: [], freshKeys: [] };

    state.selected = state.selected && tickers.includes(state.selected) ? state.selected : null;
    recompute();
    renderAll();
  } catch (err) {
    console.error(err);
    $('#banner').hidden = false;
    $('#banner').className = 'banner';
    $('#banner').innerHTML = `<b>載入失敗：</b>${esc(err.message)}`;
  } finally {
    setLoading(false);
  }
}

function recompute() {
  state.analysis = analyze({
    trades: state.trades,
    sectors: state.sectors,
    market: state.market,
    weights: state.weights,
    asOf: state.asOf,
    portfolioParams: state.portfolioParams,
    backtestParams: state.backtestParams,
  });
  state.policy = analyzePolicy({
    trades: state.trades,
    themes: state.policyThemes,
    docsByTheme: state.docsByTheme,
    asOf: state.asOf,
    windowDays: state.policyWindowDays,
  });
}

function renderAll() {
  renderChips();
  renderBanner();
  markAllDirty();
  renderActiveTab(true);
}

/* ---------------------------------------------------------------------------
   頁籤延遲渲染
   真實資料有數千筆交易與上千檔標的，若在載入時把八個頁籤全部畫出來，
   主執行緒會被卡住好幾秒（連點擊都會逾時）。因此只渲染「目前可見」的頁籤，
   其餘標記為待更新，切換過去時才畫。
   ------------------------------------------------------------------------- */

const RENDERERS = {
  overview: () => renderOverview(),
  signals: () => {
    renderSignalTable();
    renderDetail();
  },
  trades: () => renderTradeTable(),
  portfolio: () => renderPortfolio(),
  backtest: () => renderBacktest(),
  policy: () => renderPolicy(),
  ai: () => renderAi(),
  events: () => renderEvents(),
  desk: () => renderDesk(),
  regime: () => renderRegime(),
  book: () => renderBook(),
  insiders: () => renderInsiders(),
  live: () => {
    renderExplainer();
    renderPriceSource();
    renderOgeMonitor();
    renderNewsFeed();
    renderPolicyFeed();
    renderContractsFeed();
  },
  data: () => renderDataTab(),
};

const dirtyTabs = new Set();
let activeTab = 'overview';

function markDirty(...tabs) {
  for (const t of tabs) dirtyTabs.add(t);
}
function markAllDirty() {
  for (const t of Object.keys(RENDERERS)) dirtyTabs.add(t);
}
function renderTab(tab, force = false) {
  if (!force && !dirtyTabs.has(tab)) return;
  const fn = RENDERERS[tab];
  if (!fn) return;
  fn();
  dirtyTabs.delete(tab);
}
function renderActiveTab(force = false) {
  renderTab(activeTab, force);
}

function timeAgo(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return '—';
  const mins = Math.round(diff / 60000);
  if (mins < 1) return '剛剛';
  if (mins < 60) return `${mins} 分鐘前`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} 小時前`;
  return `${Math.round(hours / 24)} 天前`;
}

/* ----------------------------- 頂欄與橫幅 ----------------------------- */

function renderChips() {
  const kind = state.meta.datasetKind || 'demo';
  const labels = { demo: '示範資料集', mixed: '示範 + 匯入（混合）', imported: '已匯入真實格式資料' };
  const chip = $('#chip-dataset');
  chip.textContent = labels[kind] || kind;
  chip.className = `chip ${kind === 'imported' ? 'live' : 'demo'}`;
  $('#chip-asof').textContent = `資料截止 ${state.asOf}`;
}

function renderBanner() {
  const kind = state.meta.datasetKind || 'demo';
  const live = state.priceMeta && state.priceMeta.source === 'live';
  const priceLine = live
    ? `價格來源：<b>真實市場資料（${esc(state.priceMeta.provider)}，更新於 ${esc(timeAgo(state.priceMeta.fetchedAt))}）</b>。`
    : '價格來源：<b>內建模擬序列</b>（可在「即時情報」頁同步真實價格）。';
  const el = $('#banner');
  el.hidden = false;
  if (kind === 'demo') {
    el.className = 'banner';
    el.innerHTML =
      '<b>目前顯示的是內建示範資料集，不是特朗普本人的真實申報紀錄。</b> ' +
      `請到「資料管理」頁匯入 OGE 278-T / 國會申報 CSV 後再依賴分析結果。${priceLine}`;
  } else if (kind === 'mixed') {
    el.className = 'banner';
    el.innerHTML =
      '<b>資料集為「示範資料 + 你的匯入紀錄」混合狀態。</b> ' +
      `若要純用真實資料分析，請以「取代現有資料集」模式重新匯入。${priceLine}`;
  } else {
    el.className = 'banner live';
    el.innerHTML =
      `<b>已載入 ${state.trades.length} 筆申報紀錄、涵蓋 ${new Set(state.trades.map((t) => t.ticker)).size} 檔標的。</b> ` +
      `提醒：申報金額僅為法定區間且有延遲。${priceLine}`;
  }
}

/* ------------------------------ 總覽 ------------------------------ */

function renderOverview() {
  const { summary, scores } = state.analysis;

  $('#kpis').innerHTML = [
    kpi('追蹤標的', `${summary.tickerCount}`, `${summary.tradeCount} 筆申報紀錄`),
    kpi('申報淨買入', dollars(summary.netAmount), `買入 ${dollars(summary.totalBuy)}／賣出 ${dollars(summary.totalSell)}`, summary.netAmount >= 0 ? 'pos' : 'neg'),
    kpi('最新申報日', summary.lastFiledDate || '—', `最後成交 ${summary.lastTradeDate || '—'}`),
    kpi('平均申報延遲', summary.avgDisclosureLag === null ? '—' : `${summary.avgDisclosureLag} 天`, '成交日 → 公開日', summary.avgDisclosureLag >= 30 ? 'warn' : ''),
    kpi('平均訊號分數', `${summary.avgScore}`, '滿分 100', summary.avgScore >= 60 ? 'pos' : ''),
    kpi('高分標的數', `${scores.filter((s) => s.score >= 60).length}`, '分數 ≥ 60'),
  ].join('');

  $('#overview-top').innerHTML = scores
    .slice(0, 5)
    .map(
      (s, i) => `
      <div class="rank-item ${i === 0 ? 'top' : ''}" data-ticker="${esc(s.ticker)}">
        <div class="rank-no">${i + 1}</div>
        <div class="rank-main">
          <div class="rank-title">
            <span class="rank-ticker">${esc(s.ticker)}</span>
            <span class="tag sector">${esc(s.sector)}</span>
          </div>
          <div class="rank-company">${esc(s.company)}</div>
          <div class="rank-meta">淨買入 ${dollars(s.stats.netAmount)} · 最近申報 ${esc(s.stats.lastFiledDate || '—')} · ${s.stats.buyCount} 筆買入</div>
        </div>
        <div class="rank-score ${scoreClass(s.score)}">${s.score}</div>
      </div>`
    )
    .join('');

  /* 產業買入金額分布 */
  const bySector = {};
  for (const t of state.trades) {
    if (t.side !== 'BUY') continue;
    const sector = state.sectors[t.ticker] || '其他';
    bySector[sector] = (bySector[sector] || 0) + midAmount(t);
  }
  const sectorRows = Object.entries(bySector).sort((a, b) => b[1] - a[1]);
  const maxAmt = Math.max(1, ...sectorRows.map((r) => r[1]));
  $('#overview-sectors').innerHTML = sectorRows.length
    ? sectorRows
        .map(
          ([sector, amt]) => `
      <div class="bar-row">
        <span class="bar-label">${esc(sector)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${(amt / maxAmt) * 100}%"></span></span>
        <span class="bar-value">${dollars(amt)}</span>
      </div>`
        )
        .join('')
    : '<p class="hint">尚無資料</p>';

  /* 最新申報動態 */
  const recent = [...state.trades]
    .sort((a, b) => (a.filedDate < b.filedDate ? 1 : a.filedDate > b.filedDate ? -1 : 0))
    .slice(0, 12);
  $('#overview-timeline').innerHTML = recent
    .map((t) => {
      const lag = daysBetween(t.tradeDate, t.filedDate);
      return `
      <div class="tl-item">
        <span class="tl-date">${esc(t.filedDate)}</span>
        <span>
          <b>${esc(t.ticker)}</b>
          <span class="tag ${t.side === 'BUY' ? 'buy' : 'sell'}">${t.side === 'BUY' ? '買入' : '賣出'}</span>
          <span class="muted"> · ${esc(t.company)} · ${dollars(midAmount(t))}區間中位</span>
        </span>
        <span class="tag ${lag >= 30 ? 'warn' : ''}">延遲 ${lag} 天</span>
      </div>`;
    })
    .join('');

  /* 風險提示 */
  const warnFlags = [];
  for (const s of scores) {
    for (const f of s.flags) {
      if (f.level === 'warn') warnFlags.push({ ticker: s.ticker, text: f.text, score: s.score });
    }
  }
  warnFlags.sort((a, b) => b.score - a.score);
  const livePrice = state.priceMeta && state.priceMeta.source === 'live';
  const general = [
    {
      level: 'info',
      ticker: '制度',
      text: `申報資料平均延遲 ${summary.avgDisclosureLag ?? '—'} 天，且只揭露金額區間；跟單成本與申報內容必然有落差。`,
    },
    {
      level: 'info',
      ticker: '價格',
      text: livePrice
        ? `動能與回測使用真實市場資料（${state.priceMeta.provider}，${timeAgo(state.priceMeta.fetchedAt)}），日線收盤價，非逐筆即時。`
        : '目前使用模擬價格序列，動能分數與回測結果僅供流程驗證。',
    },
    {
      level: 'info',
      ticker: '資料集',
      text:
        state.meta.datasetKind === 'imported'
          ? '交易紀錄來自你匯入的申報資料，請確認來源與完整性。'
          : '交易紀錄目前為示範資料；請在「即時情報」或「資料管理」頁載入真實申報資料。',
    },
    { level: 'info', ticker: '集中度', text: '單一申報人的交易可能來自第三方受託帳戶，未必代表主動選股意圖。' },
  ];
  const newestAge = summary.lastTradeDate ? daysBetween(summary.lastTradeDate, state.asOf) : null;
  if (newestAge !== null && newestAge > 60) {
    general.unshift({
      level: 'warn',
      ticker: '時效',
      text:
        `最新可解析的申報交易已是 ${newestAge} 天前（最新一份申報是掃描檔，需要 OCR 才能解析），` +
        `在 45 天半衰期下「新穎度」分數普遍偏低，所以總分看起來不高。` +
        `若要找近期動作，請看「加碼節奏」與「申報熱度」兩項，或到「即時情報」頁追蹤最新申報。`,
    });
  }
  const shown = [...warnFlags.slice(0, 8), ...general];
  $('#overview-warnings').innerHTML = shown
    .map(
      (f) => `<div class="flag ${f.level}">
        <span class="tag ${f.level}">${esc(f.ticker)}</span>
        <span>${esc(f.text)}</span>
      </div>`
    )
    .join('');
}

function kpi(label, value, sub = '', variant = '') {
  return `<div class="kpi ${variant}">
    <div class="k-label">${esc(label)}</div>
    <div class="k-value">${esc(value)}</div>
    <div class="k-sub">${esc(sub)}</div>
  </div>`;
}

/* ------------------------------ 訊號排行 ------------------------------ */

function renderSignalTable() {
  const tbody = $('#signal-table tbody');
  const all = state.analysis.scores;
  const rows = all.slice(0, state.signalLimit);
  const moreBtn = $('#btn-signal-more');
  if (moreBtn) {
    moreBtn.hidden = all.length <= state.signalLimit;
    moreBtn.textContent = `顯示全部 ${all.length} 檔`;
  }
  const countEl = $('#signal-count');
  if (countEl) {
    countEl.textContent =
      all.length > state.signalLimit ? `顯示前 ${rows.length} / ${all.length} 檔（依分數排序）` : `共 ${all.length} 檔`;
  }
  tbody.innerHTML = rows
    .map((s) => {
      const mini = Object.keys(COMPONENTS)
        .map((k) => {
          const v = s.components[k] || 0;
          return `<i style="height:${Math.max(3, v * 22)}px" title="${esc(COMPONENTS[k].label)} ${Math.round(v * 100)}"></i>`;
        })
        .join('');
      const warns = s.flags.filter((f) => f.level === 'warn');
      return `
      <tr class="clickable ${state.selected === s.ticker ? 'selected' : ''}" data-ticker="${esc(s.ticker)}">
        <td class="num">${s.rank}</td>
        <td><b>${esc(s.ticker)}</b></td>
        <td><span class="tag sector">${esc(s.sector)}</span></td>
        <td class="num"><span class="${scoreClass(s.score)}" style="font-weight:700">${s.score}</span></td>
        <td><div class="mini-bars">${mini}</div></td>
        <td class="num">${dollars(s.stats.netAmount)}</td>
        <td class="num">${s.lastClose === null ? '—' : `$${s.lastClose.toFixed(2)}`}</td>
        <td class="num ${cls(s.momentum.r60)}">${signed(s.momentum.r60)}</td>
        <td class="num muted">${esc(s.stats.lastFiledDate || '—')}</td>
        <td>${warns.length ? `<span class="tag warn">${warns.length} 項</span>` : '<span class="tag good">無</span>'}</td>
      </tr>`;
    })
    .join('');
}

function renderWeightSliders() {
  $('#weight-sliders').innerHTML = Object.keys(DEFAULT_WEIGHTS)
    .map((k) => {
      const c = COMPONENTS[k];
      return `
      <div class="slider">
        <div class="slider-head"><b>${esc(c.label)}</b><span id="wv-${k}">${(state.weights[k] * 100).toFixed(0)}%</span></div>
        <input type="range" min="0" max="1" step="0.01" value="${state.weights[k]}" data-weight="${k}" />
        <div class="desc">${esc(c.desc)}</div>
      </div>`;
    })
    .join('');
}

function renderDetail() {
  const card = $('#detail-card');
  if (!state.selected) {
    card.hidden = true;
    return;
  }
  const s = state.analysis.scores.find((x) => x.ticker === state.selected);
  if (!s) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $('#detail-title').innerHTML =
    `${esc(s.ticker)} · ${esc(s.company)} <span class="tag sector">${esc(s.sector)}</span> ` +
    `<span class="${scoreClass(s.score)}" style="font-size:16px">${s.score} 分</span>`;

  const compRows = Object.keys(COMPONENTS)
    .map((k) => {
      const v = s.components[k] || 0;
      return `<div class="comp-row">
        <span class="muted">${esc(COMPONENTS[k].short)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${v * 100}%"></span></span>
        <span class="bar-value">${Math.round(v * 100)}</span>
      </div>`;
    })
    .join('');

  const mine = state.trades
    .filter((t) => t.ticker === s.ticker)
    .sort((a, b) => (a.tradeDate < b.tradeDate ? 1 : -1));

  const policy = state.policy && state.policy.tickers ? state.policy.tickers[s.ticker] : null;
  const policyHtml = policy
    ? `<div>
        <h3>政策曝險</h3>
        <div class="hint" style="margin-bottom:6px">政策敏感度 ${
          policy.sensitivity > 0
            ? `+${policy.sensitivity}（受惠型）`
            : policy.sensitivity < 0
              ? `${policy.sensitivity}（受損型）`
              : '0（中性）'
        }</div>
        <ul>${policy.themes
          .map(
            (t) =>
              `<li><b>${esc(t.name)}</b> <span class="tag ${t.dir > 0 ? 'buy' : t.dir < 0 ? 'sell' : ''}">${
                t.dir > 0 ? '受惠' : t.dir < 0 ? '受損' : '中性'
              }</span><br><span class="muted">${esc(t.reason)}</span></li>`
          )
          .join('')}</ul>
        <p class="footnote">政策方向為啟用式對照，可在 policy-map.mjs 調整；詳見「政策雷達」頁。</p>
      </div>`
    : '';

  $('#detail-body').innerHTML = `
    <div>
      <h3>價格與申報點位（${state.market.series[s.ticker] ? '真實市場資料' : '模擬序列'}）</h3>
      <div id="detail-chart"></div>
      <p class="footnote">▲ 買入申報 · ▼ 賣出申報 · 標記位置為申報日，非成交日。</p>
    </div>
    <div>
      <h3>分項拆解</h3>
      <div class="component-grid">${compRows}</div>
      <p class="footnote">
        淨賣出比重 ${pct(s.sellRatio)} → 套用 ${pct(s.sellPenalty)} 係數；
        60 日動能 ${signed(s.momentum.r60)}、120 日動能 ${signed(s.momentum.r120)}。
      </p>
    </div>
    <div>
      <h3>診斷理由</h3>
      <ul>${s.reasons.map((r) => `<li>${esc(r)}</li>`).join('') || '<li class="muted">無</li>'}</ul>
    </div>
    <div>
      <h3>風險與訊號旗標</h3>
      <div class="flag-list">
        ${s.flags.map((f) => `<div class="flag ${f.level}"><span class="tag ${f.level}">${f.level === 'warn' ? '注意' : f.level === 'good' ? '正面' : '提示'}</span><span>${esc(f.text)}</span></div>`).join('') || '<p class="hint">暫無</p>'}
      </div>
      <h3 style="margin-top:14px">申報紀錄</h3>
      <ul>${mine
        .map(
          (t) =>
            `<li>${esc(t.tradeDate)} ${t.side === 'BUY' ? '買入' : '賣出'} ${dollars(t.amountMin)}–${dollars(t.amountMax)}` +
            `（申報 ${esc(t.filedDate)}，延遲 ${daysBetween(t.tradeDate, t.filedDate)} 天，${esc(t.owner)}）</li>`
        )
        .join('')}</ul>
    </div>
    ${policyHtml}`;

  const realSeries = state.market.series[s.ticker];
  const series = realSeries || buildPriceSeries(s.ticker);
  const from = state.asOf < '2025-06-01' ? series[0].date : '2025-06-01';
  const points = series.filter((p) => p.date >= from);
  const markers = mine
    .filter((t) => t.filedDate >= from)
    .map((t) => ({
      date: t.filedDate,
      close: pointOn(series, t.filedDate),
      side: t.side,
      ticker: t.ticker,
    }));
  lineChart($('#detail-chart'), [{ name: s.ticker, color: '#2dd4bf', points }], { markers, height: 260 });
  if (!realSeries) {
    $('#detail-chart').insertAdjacentHTML(
      'afterbegin',
      '<p class="hint" style="margin-bottom:6px">此標的未在價格分析池內（未列入前 120 大申報金額），下方為模擬序列，僅供走勢參考。</p>'
    );
  }
}

function pointOn(series, iso) {
  let val = null;
  for (const p of series) {
    if (p.date <= iso) val = p.close;
    else break;
  }
  return val;
}

/* ------------------------------ 交易明細 ------------------------------ */

function filteredTrades() {
  const f = state.filter;
  return state.trades.filter((t) => {
    if (f.search) {
      const q = f.search.toLowerCase();
      if (!t.ticker.toLowerCase().includes(q) && !String(t.company).toLowerCase().includes(q)) return false;
    }
    if (f.side && t.side !== f.side) return false;
    if (f.amount && midAmount(t) < f.amount) return false;
    if (f.from && t.tradeDate < f.from) return false;
    if (f.to && t.tradeDate > f.to) return false;
    return true;
  });
}

function renderTradeTable() {
  const rows = filteredTrades();
  const { key, dir } = state.sort;
  const val = (t) => {
    if (key === 'amount') return midAmount(t);
    if (key === 'lag') return daysBetween(t.tradeDate, t.filedDate);
    return t[key];
  };
  rows.sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
  });

  /* 真實資料有數千筆，一次全部塞進 DOM 會卡住好幾秒 → 分頁顯示 */
  const PAGE_SIZE = 100;
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  state.tradePage = Math.min(Math.max(1, state.tradePage), pages);
  const start = (state.tradePage - 1) * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);

  $('#trade-table tbody').innerHTML = pageRows
    .map((t) => {
      const lag = daysBetween(t.tradeDate, t.filedDate);
      return `
      <tr class="clickable" data-ticker="${esc(t.ticker)}">
        <td>${esc(t.tradeDate)}</td>
        <td>${esc(t.filedDate)}</td>
        <td class="num ${lag >= 30 ? 'muted' : ''}">${lag} 天</td>
        <td><b>${esc(t.ticker)}</b></td>
        <td>${esc(t.company)}</td>
        <td><span class="tag ${t.side === 'BUY' ? 'buy' : 'sell'}">${t.side === 'BUY' ? '買入' : '賣出'}</span></td>
        <td class="num muted">${dollars(t.amountMin)} – ${dollars(t.amountMax)}</td>
        <td class="num">${moneyFull(midAmount(t))}</td>
        <td class="muted">${esc(t.owner)}</td>
      </tr>`;
    })
    .join('');

  const pager = $('#trade-pager');
  if (pager) {
    pager.innerHTML =
      `<button class="btn ghost small" data-page="first"${state.tradePage === 1 ? ' disabled' : ''}>« 最前</button>
       <button class="btn ghost small" data-page="prev"${state.tradePage === 1 ? ' disabled' : ''}>‹ 上一頁</button>
       <span class="hint">第 ${state.tradePage} / ${pages} 頁</span>
       <button class="btn ghost small" data-page="next"${state.tradePage === pages ? ' disabled' : ''}>下一頁 ›</button>
       <button class="btn ghost small" data-page="last"${state.tradePage === pages ? ' disabled' : ''}>最後 »</button>`;
  }

  $('#trade-count').textContent =
    `符合條件 ${rows.length} / ${state.trades.length} 筆` +
    (rows.length !== state.trades.length ? '（已套用篩選）' : '') +
    `　· 買入 ${rows.filter((t) => t.side === 'BUY').length} 筆、賣出 ${rows.filter((t) => t.side === 'SELL').length} 筆` +
    `　· 本頁顯示第 ${rows.length ? start + 1 : 0}–${Math.min(start + PAGE_SIZE, rows.length)} 筆`;
}

/* ---------------------------- 投資組合建議 ---------------------------- */

const PORTFOLIO_DEFS = [
  { key: 'topN', label: '持股檔數上限', min: 3, max: 15, step: 1, fmt: (v) => `${v} 檔` },
  { key: 'maxWeight', label: '單一持股上限', min: 0.05, max: 0.4, step: 0.01, fmt: (v) => pct(v, 0) },
  { key: 'sectorCap', label: '單一產業上限', min: 0.1, max: 0.8, step: 0.05, fmt: (v) => pct(v, 0) },
  { key: 'cashMin', label: '最低現金比重', min: 0, max: 0.5, step: 0.05, fmt: (v) => pct(v, 0) },
  { key: 'minScore', label: '最低入選分數', min: 0, max: 100, step: 5, fmt: (v) => `${v} 分` },
  { key: 'gamma', label: '高分集中度 γ', min: 0.5, max: 3, step: 0.1, fmt: (v) => Number(v).toFixed(1) },
];

function renderPortfolioSliders() {
  $('#portfolio-sliders').innerHTML = PORTFOLIO_DEFS.map((d) => `
    <div class="slider">
      <div class="slider-head"><b>${esc(d.label)}</b><span id="pv-${d.key}">${d.fmt(state.portfolioParams[d.key])}</span></div>
      <input type="range" min="${d.min}" max="${d.max}" step="${d.step}" value="${state.portfolioParams[d.key]}" data-portfolio="${d.key}" />
    </div>`).join('');
}

function renderPortfolio() {
  const p = state.analysis.portfolio;
  $('#portfolio-gross').textContent = `投入 ${pct(1 - p.cash, 0)} · 現金 ${pct(p.cash, 0)}`;

  if (!p.positions.length) {
    $('#portfolio-alloc').innerHTML = '<p class="hint">沒有標的達到門檻，建議全數持有現金。</p>';
  } else {
    $('#portfolio-alloc').innerHTML = p.positions
      .map(
        (pos) => `
      <div class="alloc-row">
        <div class="alloc-name"><b>${esc(pos.ticker)}</b><span>${esc(pos.company)}</span></div>
        <span class="bar-track"><span class="bar-fill" style="width:${(pos.weight / (p.params.maxWeight || 0.4)) * 100}%"></span></span>
        <span class="bar-value">${pct(pos.weight, 1)}</span>
      </div>`
      )
      .join('');
  }

  const slices = p.sectorBreakdown.map((s, i) => ({ label: s.sector, value: s.weight, color: PALETTE[i % PALETTE.length] }));
  if (p.cash > 0.001) slices.push({ label: '現金', value: p.cash, color: '#3b4a5e' });
  $('#portfolio-sectors').innerHTML = donut(slices, { size: 170, unit: (v) => pct(v, 1) });
  $('#portfolio-notes').innerHTML = p.notes.map((n) => `<li>${esc(n)}</li>`).join('');

  $('#portfolio-reasons').innerHTML = p.positions
    .map(
      (pos) => {
        const pol = state.policy && state.policy.tickers ? state.policy.tickers[pos.ticker] : null;
        const polLine = pol
          ? `<div class="hint" style="margin-top:6px">政策曝險：
              <span class="${pol.sensitivity > 0 ? 'up' : pol.sensitivity < 0 ? 'down' : 'muted'}">${
                pol.sensitivity > 0 ? '受惠型' : pol.sensitivity < 0 ? '受損型' : '中性'
              } ${pol.sensitivity}</span>
              ${pol.themes.length ? `（${pol.themes.map((t) => esc(t.name)).join('、')}）` : ''}
              ${pol.themes.length ? `<br><span class="muted">${pol.themes.map((t) => esc(t.reason)).join('；')}</span>` : ''}
            </div>`
          : '';
        return `
    <div class="reason-card">
      <h3><span>${esc(pos.ticker)} <span class="tag sector">${esc(pos.sector)}</span></span>
        <span class="${scoreClass(pos.score)}">${pos.score} 分 / ${pct(pos.weight, 1)}</span></h3>
      <p>${esc(pos.reason)}</p>
      ${polLine}
      ${pos.risks.length ? `<div class="risks">風險：${pos.risks.map(esc).join('；')}</div>` : '<div class="muted" style="font-size:12px">未偵測到顯著警訊</div>'}
    </div>`;
      }
    )
    .join('') || '<p class="hint">沒有可建議的標的</p>';
}

/* ------------------------------- 回測 ------------------------------- */

const BACKTEST_DEFS = [
  { key: 'lagDays', label: '申報後進場時點', min: 1, max: 20, step: 1, fmt: (v) => `T+${v} 交易日` },
  { key: 'holdDays', label: '持有期間', min: 5, max: 250, step: 5, fmt: (v) => `${v} 交易日` },
  { key: 'positionSize', label: '單筆部位（初始資金比重）', min: 0.05, max: 0.5, step: 0.05, fmt: (v) => pct(v, 0) },
  { key: 'maxConcurrent', label: '最大同時持倉', min: 1, max: 10, step: 1, fmt: (v) => `${v} 筆` },
  { key: 'minAmount', label: '最低申報金額門檻', min: 0, max: 1000000, step: 15000, fmt: (v) => `$${fmtMoney(v)}` },
  { key: 'feeBps', label: '單邊手續費', min: 0, max: 50, step: 1, fmt: (v) => `${v} bps` },
];

function renderBacktestSliders() {
  $('#backtest-sliders').innerHTML =
    BACKTEST_DEFS.map((d) => `
    <div class="slider">
      <div class="slider-head"><b>${esc(d.label)}</b><span id="bv-${d.key}">${d.fmt(state.backtestParams[d.key])}</span></div>
      <input type="range" min="${d.min}" max="${d.max}" step="${d.step}" value="${state.backtestParams[d.key]}" data-backtest="${d.key}" />
    </div>`).join('') +
    `<div class="slider">
      <div class="slider-head"><b>納入賣出申報</b><span>${state.backtestParams.includeSells ? '開' : '關'}</span></div>
      <label class="hint"><input type="checkbox" id="b-includeSells" ${state.backtestParams.includeSells ? 'checked' : ''} /> 勾選後會把賣出申報也當成訊號事件（原義上為反向訊號，僅供對照）</label>
    </div>`;
}

function renderBacktest() {
  const bt = state.analysis.backtest;
  const st = bt.stats;
  $('#backtest-kpis').innerHTML = [
    kpi('策略總報酬', pct(st.totalReturn), `${moneyFull(bt.params.capital)} → ${moneyFull(st.finalValue)}`, st.totalReturn >= 0 ? 'pos' : 'neg'),
    kpi('示範大盤報酬', pct(st.benchReturn), '等權買進持有', st.benchReturn >= 0 ? 'pos' : 'neg'),
    kpi('超額報酬', pct(st.totalReturn - st.benchReturn), '策略 − 大盤', st.totalReturn - st.benchReturn >= 0 ? 'pos' : 'neg'),
    kpi('年化報酬 CAGR', pct(st.cagr), '以回測期間換算'),
    kpi('最大回撤', pct(st.maxDrawdown), '峰值到谷底', 'warn'),
    kpi('勝率', pct(st.winRate), `${st.trades} 筆已進場`),
    kpi('夏普值', st.sharpe.toFixed(2), `年化波動 ${pct(st.volatility)}`),
    kpi('獲利因子', st.profitFactor === null ? '—' : st.profitFactor.toFixed(2), `平均獲利 ${pct(st.avgWin)}／虧損 ${pct(st.avgLoss)}`),
  ].join('');

  const eq = bt.equity.filter((_, i) => i % 2 === 0);
  lineChart(
    $('#equity-chart'),
    [
      { name: '策略', color: '#2dd4bf', points: eq.map((p) => ({ date: p.date, close: p.value })) },
      { name: '示範大盤（等權）', color: '#64a8ff', points: eq.map((p) => ({ date: p.date, close: p.bench })) },
    ],
    { height: 320, markers: [], yPrefix: '$' }
  );

  $('#backtest-events-hint').textContent =
    `${bt.events.length} 筆進場` +
    (bt.skipped ? `，${bt.skipped} 筆因同時持倉上限被略過` : '') +
    (bt.skippedNoPrice ? `，${bt.skippedNoPrice} 筆因不在價格分析池內未回測` : '') +
    (bt.skippedAmount ? `，${bt.skippedAmount} 筆未達金額門檻` : '') +
    `（訊號總數 ${bt.signalCount}）`;
  $('#backtest-table tbody').innerHTML = bt.events
    .slice()
    .reverse()
    .map(
      (e) => `
    <tr>
      <td><b>${esc(e.ticker)}</b></td>
      <td>${esc(e.tradeDate)}</td>
      <td>${esc(e.signalDate)}</td>
      <td>${esc(e.entryDate)}</td>
      <td>${esc(e.exitDate)}</td>
      <td class="num">${e.holdDaysActual}</td>
      <td class="num">$${e.entryPrice.toFixed(2)}</td>
      <td class="num">$${e.exitPrice.toFixed(2)}</td>
      <td class="num ${cls(e.netReturn)}">${signed(e.netReturn, 2)}</td>
    </tr>`
    )
    .join('');
}

/* ----------------------------- 資料管理 ----------------------------- */

/* ----------------------------- 政策雷達 ----------------------------- */

/* ----------------------------- 事件時鐘 ----------------------------- */

const EVENT_LABELS = {
  policyEffective: { label: '政策生效', cls: 'warn' },
  commentDeadline: { label: '評論截止', cls: 'info' },
  earnings: { label: '財報', cls: 'good' },
  contract: { label: '合約', cls: 'sector' },
  filing: { label: '申報', cls: '' },
};

function daysUntil(iso) {
  return daysBetween(state.asOf, iso);
}

async function loadEvents(days) {
  $('#events-status').textContent = '載入中…';
  try {
    const res = await apiFetch(`events?days=${days}`);
    state.events = await res.json();
    renderEvents();
  } catch (err) {
    $('#events-status').textContent = `載入失敗：${err.message}`;
  }
}

function renderEvents() {
  const e = state.events;
  if (!e) {
    loadEvents(Number(($('#events-days') && $('#events-days').value) || 30));
    return;
  }
  $('#events-range').textContent = `涵蓋 ${e.from} ~ ${e.to}`;
  $('#events-status').textContent = e.fetchedAt
    ? `上次抓取 ${timeAgo(e.fetchedAt)}${e.policyError ? '（政策來源部分失敗）' : ''}`
    : '尚未抓取（清單為空，請按右側按鈕）';

  const counts = e.counts || {};
  const next7 = e.events.filter((x) => daysUntil(x.date) <= 7).length;
  $('#events-kpis').innerHTML = [
    kpi('未來事件', `${e.events.length}`, `${e.from} ~ ${e.to}`),
    kpi('政策生效', `${counts.policyEffective || 0}`, 'Federal Register effective_on', 'warn'),
    kpi('財報', `${counts.earnings || 0}`, 'Nasdaq 日曆 · 僅追蹤標的', 'pos'),
    kpi('評論截止', `${counts.commentDeadline || 0}`, '規則尚未定案'),
    kpi('7 天內', `${next7}`, '最需要留意的區間', next7 > 0 ? 'warn' : ''),
  ].join('');

  renderEventDensity(e);

  const list = e.events.filter((x) => EVENT_LABELS[x.type]);
  $('#events-list').innerHTML = list.length
    ? list
        .map((x) => {
          const meta = EVENT_LABELS[x.type] || { label: x.type, cls: '' };
          const t = daysUntil(x.date);
          const when = t === 0 ? '今天' : t === 1 ? '明天' : `T+${t}`;
          const tickers = (x.tickers || []).slice(0, 8);
          const title = x.title.length > 88 ? `${x.title.slice(0, 86)}…` : x.title;
          return `<div class="feed-item ${t <= 3 ? 'hit' : ''}">
        <span>
          <span class="tag ${meta.cls}">${esc(meta.label)}</span>
          <b style="margin-left:6px">${esc(x.date)}</b>
          <span class="muted">（${esc(when)}）</span>
          ${x.link ? ` <a href="${esc(x.link)}" target="_blank" rel="noreferrer noopener">${esc(title)}</a>` : ` ${esc(title)}`}
        </span>
        <span class="feed-time">${esc(x.source || '')}</span>
        <div class="feed-meta">
          <span>${esc(x.detail || '')}</span>
          ${tickers.length ? `<span class="muted">該主題對照標的：${tickers.map((tk) => esc(tk)).join('、')}</span>` : ''}
          ${x.ticker ? `<span class="tag sector">${esc(x.ticker)}</span>` : ''}
        </div>
      </div>`;
        })
        .join('')
    : '<p class="feed-empty">目前沒有事件。按「抓取最新事件」向 Federal Register 與 Nasdaq 取得最新日曆。</p>';
}

function renderEventDensity(e) {
  const W = 960;
  const H = 120;
  const pad = { l: 8, r: 8, t: 16, b: 26 };
  const dates = [];
  let cursor = e.from;
  while (cursor <= e.to) {
    dates.push(cursor);
    cursor = new Date(new Date(`${cursor}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);
  }
  const counts = dates.map((d) => e.events.filter((x) => x.date === d).length);
  const max = Math.max(1, ...counts);
  const bw = (W - pad.l - pad.r) / Math.max(1, dates.length);
  const bars = dates
    .map((d, i) => {
      const h = (counts[i] / max) * (H - pad.t - pad.b);
      const weekend = [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay());
      return `<rect x="${(pad.l + i * bw).toFixed(1)}" y="${(H - pad.b - h).toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}"
        fill="${counts[i] ? (weekend ? '#3b4a5e' : '#2dd4bf') : '#16202d'}" opacity="${counts[i] ? 0.9 : 0.45}" rx="1"><title>${d}：${counts[i]} 個事件</title></rect>`;
    })
    .join('');
  const ticks = dates
    .map((d, i) => (d.slice(8, 10) === '01' || i === 0 ? `<text x="${(pad.l + i * bw).toFixed(1)}" y="${H - 8}" fill="#7d93ae" font-size="10">${d.slice(5)}</text>` : ''))
    .join('');
  $('#events-density').innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" style="height:${H}px">${bars}${ticks}</svg>`;
}

/* ----------------------------- 執行與計分 ----------------------------- */

async function loadDesk() {
  $('#desk-status').textContent = '計算中…';
  try {
    const res = await apiFetch('desk');
    state.desk = await res.json();
    renderDesk();
  } catch (err) {
    $('#desk-status').textContent = `計算失敗：${err.message}`;
  }
}

function renderDesk() {
  const d = state.desk;
  if (!d || !d.ok) {
    loadDesk();
    return;
  }
  const cap = d.capacity || [];
  const traded = cap.filter((c) => c.tradeCount > 0);
  $('#desk-status').textContent = `${cap.length} 檔標的 · 資料截止 ${d.asOf} · ${d.priceSource === 'live' ? '真實價格' : '模擬價格'}`;

  const hardest = traded.slice().sort((a, b) => (b.daysForAllDisclosed || 0) - (a.daysForAllDisclosed || 0))[0];
  const risky = traded.slice().sort((a, b) => (b.tailRisk95 || 0) - (a.tailRisk95 || 0))[0];
  const sorted = cap.slice().sort((a, b) => a.adv20Value - b.adv20Value);
  const medianAdv = sorted.length ? sorted[Math.floor(sorted.length / 2)].adv20Value : 0;
  $('#desk-kpis').innerHTML = [
    kpi('可交易標的', `${cap.length}`, `其中 ${traded.length} 檔有申報紀錄`),
    kpi('成交金額中位數', `$${fmtMoney(medianAdv)}`, '20 日均額（每日可交易金額）'),
    hardest ? kpi('最難消化', hardest.ticker, `申報金額＝${(hardest.daysForAllDisclosed * 100).toFixed(1)}% 的日成交量`, 'warn') : '',
    risky ? kpi('跳空風險最高', risky.ticker, `單日波動 95 分位 ${pct(risky.tailRisk95, 1)}`, 'warn') : '',
    kpi('計分樣本', `${d.scorecard ? d.scorecard.sampleCount : 0}`, '標的 × 日期的觀察值'),
  ].join('');

  renderDeskTable();
  renderDeskDecay(d.scorecard);
  renderDeskSignalTable(d.scorecard);
  renderDeskIcTable(d.scorecard);
}

function sortedCapacity() {
  const cap = (state.desk.capacity || []).slice();
  const mode = $('#desk-sort').value;
  const filter = $('#desk-filter').value;
  const rows = filter === 'traded' ? cap.filter((c) => c.tradeCount > 0) : cap;
  if (mode === 'hard') rows.sort((a, b) => (b.daysForAllDisclosed || 0) - (a.daysForAllDisclosed || 0));
  else if (mode === 'risk') rows.sort((a, b) => (b.tailRisk95 || 0) - (a.tailRisk95 || 0));
  else rows.sort((a, b) => b.adv20Value - a.adv20Value);
  return rows;
}

function renderDeskTable() {
  const rows = sortedCapacity().slice(0, 120);
  $('#desk-table tbody').innerHTML = rows
    .map(
      (c) => `<tr class="clickable" data-ticker="${esc(c.ticker)}">
        <td><b>${esc(c.ticker)}</b></td>
        <td class="num">$${c.close}</td>
        <td class="num">$${fmtMoney(c.adv20Value)}</td>
        <td><span class="tag ${c.liquidityId === 'low' || c.liquidityId === 'very-low' ? 'warn' : 'sector'}">${esc(c.liquidity)}</span></td>
        <td class="num ${c.daysForAllDisclosed > 0.1 ? 'down' : ''}">${c.tradeCount ? `${(c.daysForAllDisclosed * 100).toFixed(1)}% 天` : '—'}</td>
        <td class="num">${c.tradeCount ? `${(c.daysForLargestTrade * 100).toFixed(3)}% 天` : '—'}</td>
        <td class="num muted">$${fmtMoney(c.suggestedMaxPosition)}</td>
        <td class="num ${(c.tailRisk95 || 0) > 0.05 ? 'down' : ''}">${c.tailRisk95 === null ? '—' : pct(c.tailRisk95, 1)}</td>
        <td class="num">${c.tradeCount}</td>
      </tr>`
    )
    .join('');
}

function renderDeskDecay(sc) {
  if (!sc || !sc.signals || !sc.signals.length) {
    $('#desk-decay').innerHTML = '<p class="hint">沒有足夠樣本</p>';
    return;
  }
  const W = 960;
  const H = 320;
  const pad = { l: 58, r: 168, t: 18, b: 40 };
  const horizons = sc.horizons;
  const allLifts = sc.signals.flatMap((s) => s.byHorizon.map((b) => b.lift)).filter((v) => v !== null);
  const maxAbs = Math.max(0.06, ...allLifts.map(Math.abs)) * 1.15;
  const X = (i) => pad.l + (i / Math.max(1, horizons.length - 1)) * (W - pad.l - pad.r);
  const Y = (v) => pad.t + (H - pad.t - pad.b) * (1 - (v + maxAbs) / (2 * maxAbs));
  const grid = [-1, -0.5, 0, 0.5, 1]
    .map((f) => {
      const v = maxAbs * f;
      return `<line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="${f === 0 ? '#2a3d5c' : '#1a2634'}"/>
        <text x="${pad.l - 8}" y="${(Y(v) + 4).toFixed(1)}" fill="#7d93ae" font-size="10.5" text-anchor="end">${v >= 0 ? '+' : '−'}${(Math.abs(v) * 100).toFixed(1)}pp</text>`;
    })
    .join('');
  const xTicks = horizons
    .map((h, i) => `<text x="${X(i).toFixed(1)}" y="${H - pad.b + 16}" fill="#7d93ae" font-size="10.5" text-anchor="middle">${h} 日</text>`)
    .join('');
  const colors = ['#2dd4bf', '#f0b429', '#64a8ff', '#a78bfa', '#f472b6', '#4ade80', '#fb923c'];
  const lines = sc.signals
    .map((s, k) => {
      const color = colors[k % colors.length];
      const pts = s.byHorizon.map((b, i) => ({ x: X(i), y: Y(b.lift === null ? 0 : b.lift) }));
      const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
      const last = pts[pts.length - 1];
      return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2"/>
        ${pts
          .map(
            (p, i) =>
              `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="${color}"><title>${esc(s.label)}：${horizons[i]} 日，提升 ${(
                s.byHorizon[i].lift * 100
              ).toFixed(1)}pp（n=${s.n}）</title></circle>`
          )
          .join('')}
        <text x="${(last.x + 6).toFixed(1)}" y="${(last.y + 4).toFixed(1)}" fill="${color}" font-size="10.5">${esc(s.label.slice(0, 15))}</text>`;
    })
    .join('');
  $('#desk-decay').innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" style="height:${H}px">
    ${grid}${xTicks}${lines}
    <text x="${pad.l}" y="${H - 4}" fill="#7d93ae" font-size="10.5">持有期間（交易日）</text>
  </svg>`;
  $('#desk-decay-legend').innerHTML =
    '<span>縱軸＝該訊號命中率減去同期全體平均（正數代表比平均會漲）</span>' +
    `<span>樣本數：${sc.signals.map((s) => `${esc(s.label)} ${s.n}`).join('、')}</span>`;
}

function renderDeskSignalTable(sc) {
  if (!sc || !sc.signals) return;
  $('#desk-signal-table thead').innerHTML = `<tr><th>訊號</th><th class="num">樣本</th>${sc.horizons
    .map((h) => `<th class="num">${h} 日</th>`)
    .join('')}</tr>`;
  $('#desk-signal-table tbody').innerHTML = sc.signals
    .map(
      (s) => `<tr>
        <td>${esc(s.label)}</td>
        <td class="num muted">${s.n}</td>
        ${s.byHorizon
          .map(
            (b) =>
              `<td class="num ${b.lift > 0.02 ? 'up' : b.lift < -0.02 ? 'down' : 'muted'}">${
                b.lift === null ? '—' : `${b.lift >= 0 ? '+' : ''}${(b.lift * 100).toFixed(1)}`
              }</td>`
          )
          .join('')}
      </tr>`
    )
    .join('');
}

function renderDeskIcTable(sc) {
  if (!sc || !sc.ic) return;
  $('#desk-ic-table thead').innerHTML = `<tr><th>特徵</th>${sc.horizons.map((h) => `<th class="num">${h} 日</th>`).join('')}</tr>`;
  $('#desk-ic-table tbody').innerHTML = sc.ic
    .map(
      (f) => `<tr>
        <td>${esc(f.label)}</td>
        ${f.byHorizon
          .map(
            (b) =>
              `<td class="num ${Math.abs(b.ic || 0) > 0.05 ? 'up' : 'muted'}">${
                b.ic === null ? '—' : `${b.ic >= 0 ? '+' : ''}${b.ic.toFixed(3)}`
              }</td>`
          )
          .join('')}
      </tr>`
    )
    .join('');
}

/* ----------------------------- 市場體制 ----------------------------- */

/* ----------------------------- 我的部位 ----------------------------- */

/* ----------------------------- 內部人交易 ----------------------------- */

async function loadInsiders(days) {
  $('#ins-status').textContent = '載入中…';
  try {
    const res = await apiFetch(`insiders?days=${days}`);
    const data = await res.json();
    state.insiders = data;
    renderInsiders();
  } catch (err) {
    $('#ins-status').textContent = `載入失敗：${err.message}`;
  }
}

function renderInsiders() {
  const d = state.insiders;
  if (!d) {
    loadInsiders(Number(($('#ins-days') && $('#ins-days').value) || 120));
    return;
  }
  if (!d.ok) {
    $('#ins-status').textContent = d.reason || '尚未抓取';
    $('#ins-kpis').innerHTML = '';
    return;
  }
  const t = d.totals;
  $('#ins-status').textContent = `掃描 ${d.scannedTickers} 檔 · 統計近 ${d.windowDays} 天 · 更新於 ${timeAgo(d.fetchedAt)}`;
  $('#ins-kpis').innerHTML = [
    kpi('掃描標的', `${d.scannedTickers}`, '申報金額前 36 大 ＋ 我的部位'),
    kpi('內部人買進', `${t.buyCount} 筆`, `$${fmtMoney(t.buyValue)} · ${t.buyers} 檔標的`, 'pos'),
    kpi('內部人賣出', `${t.sellCount} 筆`, `$${fmtMoney(t.sellValue)}`, 'neg'),
    kpi('集群買進', `${t.clusterTickers}`, '30 天內 ≥ 2 位內部人買進', t.clusterTickers ? 'pos' : ''),
    kpi('交易總筆數', `${t.transactions}`, '含授予、稅務等薪酬紀錄'),
  ].join('');

  const rows = d.summary.filter((r) => r.buyCount > 0 || r.sellCount > 0 || r.transactionCount > 0);
  $('#ins-table tbody').innerHTML = rows
    .map(
      (r) => `<tr class="clickable ${r.buyCount ? '' : 'muted'}" data-ticker="${esc(r.ticker)}">
        <td><b>${esc(r.ticker)}</b><br><span class="muted" style="font-size:11px">${esc((r.issuerName || '').slice(0, 22))}</span></td>
        <td class="num ${r.score >= 50 ? 'up' : r.score > 0 ? '' : 'muted'}">${r.score || '—'}</td>
        <td class="num">${r.buyCount || '—'}</td>
        <td class="num">${r.buyerCount || '—'}</td>
        <td class="num ${r.cluster >= 2 ? 'up' : 'muted'}">${r.cluster >= 2 ? `${r.cluster} 人` : '—'}</td>
        <td class="num">${r.buyValue ? `$${fmtMoney(r.buyValue)}` : '—'}</td>
        <td class="num">${r.sellCount || '—'}</td>
        <td class="num">${r.sellValue ? `$${fmtMoney(r.sellValue)}` : '—'}</td>
        <td class="num muted">${esc(r.lastBuyDate || '—')}</td>
        <td>${r.flags.length ? r.flags.map((f) => `<span class="tag ${f.level === 'good' ? 'buy' : 'sector'}">${esc(f.text.slice(0, 18))}</span>`).join(' ') : '<span class="muted">—</span>'}</td>
      </tr>`
    )
    .join('');

  $('#ins-buys').innerHTML = d.buys.length
    ? d.buys
        .map(
          (b) => `<div class="feed-item hit">
        <span><b>${esc(b.ticker)}</b> <span class="up prob-badge">$${fmtMoney(b.value || 0)}</span>
          <span class="muted">　${esc(b.ownerName)}</span></span>
        <span class="feed-time">${esc(b.date)}</span>
        <div class="feed-meta">
          <span>${esc(b.officerTitle || (b.isDirector ? '董事' : '內部人'))}</span>
          <span>${b.shares ? `${Math.round(b.shares).toLocaleString('en-US')} 股 @ $${b.price}` : ''}</span>
          ${b.plan === true ? '<span class="tag">10b5-1 計畫</span>' : ''}
        </div>
      </div>`
        )
        .join('')
    : '<p class="feed-empty">這段期間沒有內部人公開市場買進紀錄（多數公司只有賣出）。</p>';

  $('#ins-cross').innerHTML = d.crossRef.length
    ? d.crossRef
        .map(
          (c) => `<div class="feed-item">
        <span><b>${esc(c.ticker)}</b>
          <span class="tag buy">內部人 ${c.insiderScore} 分</span>
          ${c.insiderCluster >= 2 ? `<span class="tag buy">集群 ${c.insiderCluster} 人</span>` : ''}
        </span>
        <span class="feed-time">$${fmtMoney(c.insiderBuyValue || 0)}</span>
        <div class="feed-meta">
          <span>總統申報淨額：<b class="${c.disclosedNet >= 0 ? 'up' : 'down'}">${c.disclosedNet >= 0 ? '+' : '−'}$${fmtMoney(Math.abs(c.disclosedNet))}</b>（${c.disclosedCount} 筆）</span>
          ${c.policySensitivity !== null ? `<span>政策：${c.policySensitivity > 0 ? '受惠型' : c.policySensitivity < 0 ? '受損型' : '中性'}</span>` : ''}
          ${c.policyThemes.length ? `<span class="muted">${c.policyThemes.map(esc).join('、')}</span>` : ''}
        </div>
      </div>`
        )
        .join('')
    : '<p class="feed-empty">目前沒有「內部人買進」的標的可以交叉比對。</p>';

  $('#ins-recent-hint').textContent = `${d.recent.length} 筆（近 ${d.windowDays} 天）`;
  $('#ins-recent tbody').innerHTML = d.recent
    .slice(0, 300)
    .map(
      (r) => `<tr class="clickable" data-ticker="${esc(r.ticker)}">
        <td>${esc(r.date)}</td>
        <td><b>${esc(r.ticker)}</b></td>
        <td>${esc(r.ownerName)}</td>
        <td class="muted">${esc(r.officerTitle || (r.isDirector ? '董事' : ''))}</td>
        <td><span class="tag ${r.code === 'P' ? 'buy' : r.code === 'S' ? 'sell' : ''}">${esc(r.code)}</span> <span class="muted" style="font-size:11px">${esc(r.codeLabel)}</span></td>
        <td class="num">${r.shares === null ? '—' : Math.round(r.shares).toLocaleString('en-US')}</td>
        <td class="num">${r.price === null ? '—' : `$${r.price}`}</td>
        <td class="num ${r.code === 'P' ? 'up' : ''}">${r.value === null ? '—' : `$${fmtMoney(r.value)}`}</td>
        <td class="num muted">${r.sharesAfter === null ? '—' : Math.round(r.sharesAfter).toLocaleString('en-US')}</td>
      </tr>`
    )
    .join('');
}

/* ----------------------------- 我的部位 ----------------------------- */

const BOOK_TEMPLATE = ['ticker,shares,avgCost', 'NVDA,120,180.50', 'AMZN,80,230.00', 'COST,25,900.00'].join('\n');

async function loadBook() {
  $('#book-status').textContent = '載入中…';
  try {
    const res = await apiFetch('positions');
    const data = await res.json();
    state.book = data;
    renderBook();
  } catch (err) {
    $('#book-status').textContent = `載入失敗：${err.message}`;
  }
}

function renderBook() {
  const b = state.book;
  if (!b) {
    loadBook();
    return;
  }
  const analysis = $('#book-analysis');
  const tableCard = $('#book-table-card');
  if (!b.ok) {
    $('#book-status').textContent = b.reason || '尚未匯入部位';
    analysis.hidden = true;
    tableCard.hidden = true;
    return;
  }

  analysis.hidden = false;
  tableCard.hidden = false;
  $('#book-status').textContent = `${b.summary.positionCount} 檔部位 · 資料截止 ${b.asOf}`;
  $('#book-updated').textContent = b.updatedAt ? `匯入於 ${new Date(b.updatedAt).toLocaleString('zh-TW')}` : '';

  const s = b.summary;
  $('#book-kpis').innerHTML = [
    kpi('總市值', `$${fmtMoney(s.totalValue)}`, `${s.positionCount} 檔（${s.withPriceData} 檔有價格資料）`),
    kpi('最大部位', s.largestTicker || '—', s.largestWeight !== null ? `占 ${pct(s.largestWeight, 1)}` : '', s.largestWeight > 0.25 ? 'warn' : ''),
    s.totalPnl !== null
      ? kpi('未實現損益', `${s.totalPnl >= 0 ? '+' : '−'}$${fmtMoney(Math.abs(s.totalPnl))}`, '依你提供的成本計算', s.totalPnl >= 0 ? 'pos' : 'neg')
      : kpi('未實現損益', '—', '沒有成本欄位無法計算'),
    kpi('單日 95% 風險', pct(s.portfolioTailRisk, 2), '各部位加總，未考慮相關性', s.portfolioTailRisk > 0.03 ? 'warn' : ''),
    b.regime
      ? kpi('目前體制', b.regime.state, `綜合分數 ${Math.round(b.regime.score)} / 100`, b.regime.score >= 65 ? 'pos' : b.regime.score <= 35 ? 'neg' : 'warn')
      : kpi('目前體制', '—', '尚未抓取跨資產資料'),
  ].join('');

  const slices = s.sectorBreakdown.map((x, i) => ({ label: x.sector, value: x.weight, color: PALETTE[i % PALETTE.length] }));
  $('#book-sectors').innerHTML = slices.length ? donut(slices, { size: 170, unit: (v) => pct(v, 1) }) : '<p class="hint">沒有資料</p>';

  $('#book-warnings').innerHTML = b.warnings.length
    ? b.warnings
        .map(
          (w) => `<div class="flag ${w.level}">
            <span class="tag ${w.level === 'warn' ? 'warn' : 'info'}">${esc(w.ticker)}</span>
            <span>${esc(w.text)}</span>
          </div>`
        )
        .join('')
    : '<p class="hint">沒有偵測到需要處理的警示</p>';

  $('#book-table tbody').innerHTML = b.rows
    .map(
      (r) => `<tr class="clickable" data-ticker="${esc(r.ticker)}">
        <td><b>${esc(r.ticker)}</b></td>
        <td class="muted">${esc(r.sector || '—')}</td>
        <td class="num">${r.shares.toLocaleString('en-US')}</td>
        <td class="num">${r.close === null ? '—' : `$${r.close}`}</td>
        <td class="num">${r.value === null ? '—' : `$${fmtMoney(r.value)}`}</td>
        <td class="num">${r.weight === null ? '—' : pct(r.weight, 1)}</td>
        <td class="num ${r.pnl === null ? '' : r.pnl >= 0 ? 'up' : 'down'}">${
          r.pnl === null ? '—' : `${r.pnl >= 0 ? '+' : '−'}$${fmtMoney(Math.abs(r.pnl))}（${signed(r.pnlPct, 1)}）`
        }</td>
        <td class="num ${r.advShare !== null && r.advShare > 0.05 ? 'down' : ''}">${
          r.advShare === null ? '—' : `${(r.advShare * 100).toFixed(2)}%`
        }</td>
        <td class="num ${(r.tailRisk95 || 0) > 0.05 ? 'down' : ''}">${r.tailRisk95 === null ? '—' : pct(r.tailRisk95, 1)}</td>
        <td>${r.policy ? `<span class="tag ${r.policy.sensitivity > 0 ? 'buy' : r.policy.sensitivity < 0 ? 'sell' : ''}">${
          r.policy.sensitivity > 0 ? '受惠' : r.policy.sensitivity < 0 ? '受損' : '中性'
        }</span>` : '<span class="muted">—</span>'}</td>
        <td class="num ${r.prob && r.prob.down > 0.6 ? 'down' : ''}">${r.prob ? pct(r.prob.down, 1) : '—'}</td>
        <td>${r.earnings ? `<span class="tag warn">${esc(r.earnings.date)}</span>` : '<span class="muted">—</span>'}</td>
      </tr>`
    )
    .join('');
}

/* ----------------------------- 市場體制 ----------------------------- */

async function loadRegime() {
  $('#regime-status').textContent = '計算中…';
  try {
    const res = await apiFetch('regime');
    const data = await res.json();
    state.regime = data;
    renderRegime();
  } catch (err) {
    $('#regime-status').textContent = `載入失敗：${err.message}`;
  }
}

const regimeColor = (score) => {
  if (score === null || score === undefined) return '#3b4a5e';
  if (score >= 65) return '#2dd4bf';
  if (score >= 55) return '#4ade80';
  if (score >= 45) return '#94a3b8';
  if (score >= 35) return '#f0b429';
  return '#ff5d5d';
};

function renderRegime() {
  const d = state.regime;
  if (!d) {
    loadRegime();
    return;
  }
  if (!d.ok) {
    $('#regime-status').textContent = d.reason || '尚未取得資料';
    $('#regime-kpis').innerHTML = '';
    $('#regime-dimensions').innerHTML = '<p class="hint">請按「更新體制資料」抓取跨資產序列。</p>';
    $('#regime-timeline').innerHTML = '';
    $('#regime-table').querySelector('tbody').innerHTML = '';
    return;
  }
  const r = d.regime;
  $('#regime-status').textContent = `資料截止 ${r.asOf}${d.fetchedAt ? ` · 更新於 ${timeAgo(d.fetchedAt)}` : ''}`;

  const dims = (r.dimensions || []).filter((x) => x.score !== null);
  const strongest = dims.slice().sort((a, b) => b.score - a.score)[0];
  const weakest = dims.slice().sort((a, b) => a.score - b.score)[0];
  $('#regime-kpis').innerHTML = [
    kpi('目前體制', r.state, `綜合分數 ${r.score === null ? '—' : Math.round(r.score)} / 100`, r.score >= 65 ? 'pos' : r.score <= 35 ? 'neg' : 'warn'),
    kpi('最強維度', strongest ? strongest.label : '—', strongest ? `${Math.round(strongest.score)} / 100` : '', 'pos'),
    kpi('最弱維度', weakest ? weakest.label : '—', weakest ? `${Math.round(weakest.score)} / 100` : '', 'neg'),
    kpi('維度數', `${dims.length}`, `共 ${(d.dimensionMeta || []).length} 個跨資產指標`),
    kpi('條件樣本', `${d.conditional ? d.conditional.sampleCount : 0}`, '用來計算體制別表現'),
  ].join('');

  $('#regime-dimensions').innerHTML = (r.dimensions || [])
    .map((x) => {
      const score = x.score === null || x.score === undefined ? 0 : x.score;
      const raw = x.raw === null || x.raw === undefined ? '—' : Math.abs(x.raw) < 1 ? x.raw.toFixed(4) : x.raw.toFixed(2);
      return `<div style="margin-bottom:9px">
        <div style="display:flex;justify-content:space-between;font-size:12px">
          <span title="${esc(x.desc || '')}">${esc(x.label)}</span>
          <span class="muted">${esc(String(raw))} · <b style="color:${regimeColor(x.score)}">${x.score === null ? '—' : Math.round(x.score)}</b></span>
        </div>
        <div class="bar-track" style="height:8px"><div class="bar-fill" style="width:${score}%;background:${regimeColor(x.score)}"></div></div>
      </div>`;
    })
    .join('');

  renderRegimeTimeline(d);
  renderRegimeTable(d.conditional);
}

function renderRegimeTimeline(d) {
  const tl = d.timeline || [];
  const spy = d.spy || [];
  if (!tl.length) {
    $('#regime-timeline').innerHTML = '<p class="hint">沒有時間軸資料</p>';
    return;
  }
  const W = 960;
  const H = 320;
  const pad = { l: 44, r: 16, t: 16, b: 34 };
  const n = tl.length;
  const bw = (W - pad.l - pad.r) / n;
  const bodyH = H - pad.t - pad.b;
  const spyValues = spy.map((p) => p.close).filter((v) => Number.isFinite(v));
  const spyMin = spyValues.length ? Math.min(...spyValues) : 0;
  const spyMax = spyValues.length ? Math.max(...spyValues) : 1;
  const Y = (v) => pad.t + bodyH * (1 - (v - spyMin) / (spyMax - spyMin || 1));
  const band = tl
    .map((t, i) => {
      const h = bodyH * ((t.overall === null ? 50 : t.overall) / 100);
      return `<rect x="${(pad.l + i * bw).toFixed(1)}" y="${(H - pad.b - h).toFixed(1)}" width="${Math.max(1, bw).toFixed(1)}" height="${h.toFixed(1)}"
        fill="${regimeColor(t.overall)}" opacity="0.18"><title>${t.date}：體制分數 ${t.overall === null ? '—' : Math.round(t.overall)}</title></rect>`;
    })
    .join('');
  const spyLine = spy.length
    ? spy.map((p, i) => `${i === 0 ? 'M' : 'L'}${(pad.l + i * bw).toFixed(1)},${Y(p.close).toFixed(1)}`).join(' ')
    : '';
  const grid = [0, 50, 100]
    .map((v) => {
      const y = H - pad.b - bodyH * (v / 100);
      return `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#1a2634"/>
        <text x="${pad.l - 8}" y="${(y + 4).toFixed(1)}" fill="#7d93ae" font-size="10" text-anchor="end">${v}</text>`;
    })
    .join('');
  const labels = tl
    .map((t, i) =>
      i % 20 === 0 ? `<text x="${(pad.l + i * bw).toFixed(1)}" y="${H - 10}" fill="#7d93ae" font-size="10">${t.date.slice(2, 7)}</text>` : ''
    )
    .join('');
  $('#regime-timeline').innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" style="height:${H}px">
    ${grid}${band}
    <path d="${spyLine}" fill="none" stroke="#64a8ff" stroke-width="1.8"/>
    ${labels}
  </svg>`;
}

function renderRegimeTable(cond) {
  if (!cond || !cond.signals) return;
  const h = cond.horizons.includes(20) ? 20 : cond.horizons[cond.horizons.length - 1];
  $('#regime-conditional-hint').textContent = `持有期間 ${h} 個交易日 · 相對同體制基準的差距（pp）`;
  $('#regime-table thead').innerHTML = `<tr><th>訊號</th>${cond.overall
    .map((b) => `<th class="num">${esc(b.label)}<br><span class="muted" style="font-weight:400">n=${b.n}</span></th>`)
    .join('')}</tr>`;
  const rows = cond.signals
    .map(
      (s) => `<tr>
        <td>${esc(s.label)}</td>
        ${s.byBucket
          .map((b) => {
            const cell = b.byHorizon.find((x) => x.horizon === h);
            if (!cell || cell.lift === null) return '<td class="num muted">—</td>';
            const cls = cell.lift > 0.02 ? 'up' : cell.lift < -0.02 ? 'down' : 'muted';
            return `<td class="num ${cls}">${cell.lift >= 0 ? '+' : ''}${(cell.lift * 100).toFixed(1)}<span class="muted" style="font-size:10px"> (${b.n})</span></td>`;
          })
          .join('')}
      </tr>`
    )
    .join('');
  const totals = cond.overall
    .map((b) => {
      const cell = b.byHorizon.find((x) => x.horizon === h);
      return `<td class="num">${cell && cell.hitRate !== null ? pct(cell.hitRate, 1) : '—'}</td>`;
    })
    .join('');
  $('#regime-table tbody').innerHTML =
    rows + `<tr style="border-top:1px solid var(--line)"><td><b>全體平均命中率</b></td>${totals}</tr>`;
}

/* ----------------------------- AI 機率 ----------------------------- */

function renderAi() {
  const m = state.probability;
  const status = $('#ai-status');
  if (!m) {
    status.textContent = '尚未訓練';
    return;
  }
  if (!m.ok) {
    status.textContent = '無法訓練';
    $('#ai-verdict').className = 'verdict unknown';
    $('#ai-verdict').innerHTML = `<div class="v-head">資料不足</div>${esc(m.reason || '')}`;
    $('#ai-kpis').innerHTML = '';
    return;
  }

  const v = m.verdict || { level: 'unknown', text: '' };
  const levelText = { none: '沒有可證實的預測優勢', weak: '只有微弱且不穩定的優勢', positive: '樣本上有可觀察的優勢', unknown: '樣本不足' };
  status.textContent = `未來 ${m.horizonDays} 個交易日 · 訓練於 ${new Date(m.trainedAt).toLocaleTimeString('zh-TW')} · ${m.priceSource === 'live' ? '真實價格' : '模擬價格'}`;
  $('#ai-verdict').className = `verdict ${v.level}`;
  $('#ai-verdict').innerHTML = `
    <div class="v-head"><span class="tag ${v.level === 'positive' ? 'good' : v.level === 'none' ? 'warn' : 'info'}">${
      v.level === 'positive' ? '有優勢' : v.level === 'none' ? '無優勢' : v.level === 'weak' ? '微弱' : '樣本不足'
    }</span>${esc(levelText[v.level] || '')}</div>
    <div>${esc(v.text)}</div>`;

  const os = m.outSample;
  $('#ai-kpis').innerHTML = [
    kpi('訓練樣本', `${m.samples.train}`, `${m.samples.trainFrom} ~ ${m.samples.trainTo}`),
    kpi('樣本外測試', `${m.samples.test}`, `${m.samples.testFrom} ~ ${m.samples.testTo}`),
    kpi('樣本外準確率', pct(os.accuracy, 1), `基準率 ${pct(os.majorityAccuracy, 1)}`, os.accuracy > os.majorityAccuracy + 0.01 ? 'pos' : 'warn'),
    kpi('AUC', (os.auc || 0).toFixed(3), '0.5 = 與亂猜無異', (os.auc || 0) > 0.55 ? 'pos' : 'warn'),
    kpi('預測誤差', pct(os.calibratedOverconfidence, 1), `校正前 ${pct(os.overconfidence, 1)}`),
    kpi('涵蓋標的', `${m.samples.tickers}`, `${m.samples.total} 筆觀察值`),
  ].join('');

  renderAiConditions(m);
  renderAiRanking(m);
  renderAiWeights(m);
  renderAiCalibration(m);
  renderAiVariants(m);
  $('#ai-method').innerHTML =
    `特徵只用「觀察日當天已經公開」的資訊：申報特徵以<b>申報日（filedDate）</b>計算而非成交日，避免使用當時還沒公開的資訊；` +
    `價格與量能取當日與之前的收盤資料。資料切成三段：前段訓練、中段做機率校準、後段才是樣本外測試，` +
    `因此上面的準確率與 AUC 沒有用到測試期間的資訊。` +
    `<br><br>限制：樣本只有 ${m.samples.tickers} 檔標的、約 ${Math.round(m.samples.total / m.samples.tickers)} 個觀察日 × ${m.samples.tickers} 檔，` +
    `期間涵蓋多頭市場（基準上漲率 ${pct(os.baseRate, 1)}%）；股票短期漲跌接近隨機，` +
    `任何在單一期間看起來有效的模型都可能是運氣。<b>本頁數字不是投資建議，也不構成任何買賣推薦。</b>`;
}

function renderAiConditions(m) {
  const c = m.conditions;
  const head = `<div class="cond-row head">
      <span>條件</span><span class="num">樣本數</span><span class="num">上漲機率</span>
      <span class="num">提升</span><span class="num">平均報酬</span>
    </div>`;
  const rows = c.table
    .map((row) => {
      const watch = (m.watchlist || []).find((w) => w.key === row.key);
      const matches = watch && watch.matched.length
        ? `<div class="cond-matches">目前符合：${watch.matched.map((x) => `<b>${esc(x.ticker)}</b>`).join('、')}${
            watch.matchedCount > watch.matched.length ? ` 等 ${watch.matchedCount} 檔` : ''
          }</div>`
        : '';
      return `<div class="cond-row">
        <span>${esc(row.label)}</span>
        <span class="num muted">${row.n}</span>
        <span class="num prob-badge ${row.hitRate >= c.all.hitRate ? 'up' : 'down'}">${pct(row.hitRate, 1)}</span>
        <span class="num ${row.lift >= 0 ? 'up' : 'down'}">${row.lift >= 0 ? '+' : ''}${(row.lift * 100).toFixed(1)}pp</span>
        <span class="num ${row.avgReturn >= 0 ? 'up' : 'down'}">${signed(row.avgReturn, 2)}</span>
      </div>${matches}`;
    })
    .join('');
  $('#ai-conditions').innerHTML =
    `<div class="cond-row cond-row-all">
      <span><b>全體平均</b></span><span class="num muted">${c.all.n}</span>
      <span class="num">${pct(c.all.hitRate, 1)}</span><span class="num muted">—</span>
      <span class="num ${c.all.avgReturn >= 0 ? 'up' : 'down'}">${signed(c.all.avgReturn, 2)}</span>
    </div>${head}${rows}`;
}

function renderAiRanking(m) {
  const card = (p, kind) => {
    const prob = kind === 'up' ? p.probUp : p.probDown;
    const cls = kind === 'up' ? 'up' : 'down';
    return `<div class="feed-item">
      <span>
        <b>${esc(p.ticker)}</b>
        <span class="${cls} prob-badge" style="margin-left:8px">${pct(prob, 1)}</span>
        <span class="muted">　現價 $${p.close}</span>
      </span>
      <span class="feed-time">${kind === 'up' ? '上升' : '下跌'}機率</span>
      <div class="feed-meta">
        ${p.contributions.slice(0, 3).map((x) =>
          `<span>${esc(x.label)} <span class="${x.contribution >= 0 ? 'up' : 'down'}">${x.contribution >= 0 ? '+' : ''}${x.contribution.toFixed(2)}</span></span>`
        ).join('')}
      </div>
    </div>`;
  };
  $('#ai-up').innerHTML = m.topUp.map((p) => card(p, 'up')).join('');
  $('#ai-down').innerHTML = m.topDown.map((p) => card(p, 'down')).join('');
}

function renderAiWeights(m) {
  const rows = m.features;
  const max = Math.max(...rows.map((r) => Math.abs(r.weight)), 0.0001);
  $('#ai-weights').innerHTML = rows
    .map((f) => {
      const w = f.weight;
      const width = (Math.abs(w) / max) * 50;
      const left = w >= 0 ? 50 : 50 - width;
      return `<div style="display:grid;grid-template-columns:120px 1fr 56px;gap:9px;align-items:center;margin-bottom:7px">
        <span style="font-size:12px" title="${esc(f.desc)}">${esc(f.label)}</span>
        <span style="position:relative;height:12px;background:#0d141d;border-radius:5px;border:1px solid var(--line-soft)">
          <span style="position:absolute;left:50%;top:-2px;bottom:-2px;width:1px;background:#2a3d5c"></span>
          <span style="position:absolute;left:${left}%;width:${width}%;top:1px;bottom:1px;border-radius:4px;background:${
            w >= 0 ? 'linear-gradient(90deg,#1c8f9c,#2dd4bf)' : 'linear-gradient(270deg,#8f2b2b,#ff5d5d)'
          }"></span>
        </span>
        <span class="num ${w >= 0 ? 'up' : 'down'}" style="font-size:11.5px">${w >= 0 ? '+' : ''}${w.toFixed(3)}</span>
      </div>`;
    })
    .join('');
}

function renderAiCalibration(m) {
  const pts = m.outSample.calibrationCurve || [];
  if (!pts.length) {
    $('#ai-calibration').innerHTML = '<p class="hint">沒有校正資料</p>';
    return;
  }
  const W = 420;
  const H = 300;
  const pad = { l: 48, r: 18, t: 16, b: 40 };
  const X = (v) => pad.l + v * (W - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - v) * (H - pad.t - pad.b);
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((v) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="#1a2634"/>
      <text x="${pad.l - 7}" y="${(Y(v) + 4).toFixed(1)}" fill="#7d93ae" font-size="10" text-anchor="end">${(v * 100).toFixed(0)}%</text>
      <line x1="${X(v).toFixed(1)}" x2="${X(v).toFixed(1)}" y1="${pad.t}" y2="${H - pad.b}" stroke="#16202d"/>
      <text x="${X(v).toFixed(1)}" y="${H - pad.b + 15}" fill="#7d93ae" font-size="10" text-anchor="middle">${(v * 100).toFixed(0)}%</text>`)
    .join('');
  const diag = `<line x1="${X(0)}" y1="${Y(0)}" x2="${X(1)}" y2="${Y(1)}" stroke="#3b4a5e" stroke-dasharray="4 4"/>`;
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${X(p.predicted).toFixed(1)},${Y(p.actual).toFixed(1)}`).join(' ');
  const dots = pts
    .map((p) => `<circle cx="${X(p.predicted).toFixed(1)}" cy="${Y(p.actual).toFixed(1)}" r="${Math.min(9, 3 + p.n / 120).toFixed(1)}" fill="#2dd4bf" opacity="0.85"><title>模型說 ${(p.predicted * 100).toFixed(1)}%，實際 ${(p.actual * 100).toFixed(1)}%（n=${p.n}）</title></circle>`)
    .join('');
  $('#ai-calibration').innerHTML = `
    <svg class="chart" viewBox="0 0 ${W} ${H}" style="height:${H}px">
      ${grid}${diag}<path d="${line}" fill="none" stroke="#2dd4bf" stroke-width="2"/>${dots}
      <text x="${(W + pad.l) / 2}" y="${H - 6}" fill="#7d93ae" font-size="10.5" text-anchor="middle">模型預測機率</text>
    </svg>
    <p class="footnote">虛線是完美校正線。點越靠近虛線，代表模型說的機率越可信；樣本越大點越大。</p>`;
}

function renderAiVariants(m) {
  $('#ai-variants tbody').innerHTML = (m.variants || [])
    .map(
      (v) => `<tr>
        <td>${esc(v.label)}</td>
        <td class="num">${v.featureCount}</td>
        <td class="num">${pct(v.accuracy, 1)}</td>
        <td class="num muted">${pct(v.baseRate, 1)}</td>
        <td class="num ${v.edge > 0.01 ? 'up' : v.edge < 0 ? 'down' : 'muted'}">${v.edge >= 0 ? '+' : ''}${(v.edge * 100).toFixed(1)}pp</td>
        <td class="num ${(v.auc || 0) > 0.55 ? 'up' : 'muted'}">${(v.auc || 0).toFixed(3)}</td>
      </tr>`
    )
    .join('');
}

async function loadProbability(force = false) {
  if (state.probabilityLoading) return;
  const horizon = $('#ai-horizon').value;
  state.probabilityLoading = true;
  $('#ai-status').textContent = '訓練中…（約 2～5 秒）';
  try {
    const res = await apiFetch(`probability?horizon=${horizon}${force ? `&t=${Date.now()}` : ''}`);
    const data = await res.json();
    state.probability = data;
    renderAi();
  } catch (err) {
    $('#ai-status').textContent = `訓練失敗：${err.message}`;
  } finally {
    state.probabilityLoading = false;
  }
}

function renderPolicy() {
  const p = state.policy;
  if (!p || !$('#policy-status')) return;
  const docsTotal = p.summary.docCount;
  $('#policy-status').textContent = docsTotal
    ? `已載入 ${docsTotal} 份官方政策文件 · 交集 ${p.summary.pairCount} 筆`
    : '尚未抓取政策文件（可按下方按鈕抓取）';

  const covered = state.policyThemes.filter(
    (t) => state.docsByTheme[t.id] && (state.docsByTheme[t.id].items || []).length
  ).length;
  $('#policy-coverage').textContent =
    state.policyThemes.length ? `${covered}/${state.policyThemes.length} 個主題已有官方文件` : '（無法載入政策對照表）';

  const themeNet = p.summary.themeNet;
  const closest = p.pairs[0];
  $('#policy-kpis').innerHTML = [
    kpi('政策主題', `${p.summary.themeCount}`, `${docsTotal} 份 Federal Register 文件`),
    kpi('敏感標的', `${p.summary.tradedExposedTickers}`, `對照表共 ${p.summary.exposedTickers} 檔`),
    kpi('政策－交易交集', `${p.summary.pairCount}`, `時間窗 ±${p.windowDays} 天`, p.summary.pairCount ? 'warn' : ''),
    kpi('主題合計淨買賣', `$${fmtMoney(themeNet)}`, themeNet >= 0 ? '淨買入' : '淨賣出', themeNet >= 0 ? 'pos' : 'neg'),
    closest
      ? kpi('最近的一筆交集', `${closest.gapDays >= 0 ? '+' : ''}${closest.gapDays} 天`, `${closest.ticker} · ${closest.docDate}`, 'warn')
      : kpi('最近的一筆交集', '—', '尚無交集'),
  ].join('');

  renderPolicyScatter(p);
  renderSectorTreemap();
  renderPolicyThemeSelect(p);
  renderPolicyTimeline(p);
  renderPolicyThemes(p);
  renderPolicyPairs(p);
  $('#policy-disclaimer').textContent = state.policyDisclaimer;
}

function sectorAggregates() {
  const agg = {};
  for (const t of state.trades) {
    const sector = state.sectors[t.ticker] || '其他';
    const mid = midAmount(t);
    const a = (agg[sector] = agg[sector] || { sector, buy: 0, sell: 0, count: 0, tickers: new Set() });
    if (t.side === 'BUY') a.buy += mid;
    else a.sell += mid;
    a.count++;
    a.tickers.add(t.ticker);
  }
  return Object.values(agg)
    .map((a) => ({ ...a, net: a.buy - a.sell, volume: a.buy + a.sell, tickerCount: a.tickers.size }))
    .sort((a, b) => b.volume - a.volume);
}

function renderPolicyScatter(p) {
  const points = Object.values(p.tickers)
    .filter((t) => t.count > 0)
    .map((t) => ({
      x: t.sensitivity,
      y: t.net / 1e6,
      r: Math.sqrt(t.buy + t.sell) / 900 + 3,
      label: t.ticker,
      color: t.net >= 0 ? '#2dd4bf' : '#ff5d5d',
      ticker: t,
    }));
  scatterChart($('#policy-scatter'), points, { height: 320 });
}

function renderSectorTreemap() {
  const rows = sectorAggregates();
  if (!rows.length) {
    $('#sector-treemap').innerHTML = '<p class="hint">沒有資料</p>';
    return;
  }
  const W = 960;
  const H = 360;
  const rects = squarify(
    rows.map((r) => ({ ...r, value: r.volume })),
    { x: 2, y: 2, w: W - 4, h: H - 4 }
  );
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.net)), 1);
  const cells = rects
    .map((r) => {
      const t = Math.abs(r.net) / maxAbs;
      const color =
        r.net >= 0
          ? `rgb(${Math.round(20 + 10 * (1 - t))},${Math.round(110 + 90 * t)},${Math.round(105 + 60 * t)})`
          : `rgb(${Math.round(150 + 90 * t)},${Math.round(70 - 30 * t)},${Math.round(70 - 20 * t)})`;
      const showLabel = r.w > 74 && r.h > 30;
      const showNet = r.w > 74 && r.h > 48;
      return `<g><title>${esc(r.sector)}｜申報金額 $${fmtMoney(r.volume)}｜淨 ${r.net >= 0 ? '+' : ''}$${fmtMoney(r.net)}｜${r.count} 筆｜${r.tickerCount} 檔</title>
        <rect x="${r.x.toFixed(1)}" y="${r.y.toFixed(1)}" width="${Math.max(0, r.w - 2).toFixed(1)}" height="${Math.max(0, r.h - 2).toFixed(1)}"
          rx="6" fill="${color}" opacity="0.92" stroke="#0a0e14" stroke-width="1.5"/>
        ${showLabel ? `<text x="${(r.x + 10).toFixed(1)}" y="${(r.y + 20).toFixed(1)}" fill="#06231f" font-size="12.5" font-weight="700">${esc(r.sector)}</text>` : ''}
        ${showNet ? `<text x="${(r.x + 10).toFixed(1)}" y="${(r.y + 38).toFixed(1)}" fill="#06231f" font-size="11.5">淨 ${r.net >= 0 ? '+' : '−'}$${fmtMoney(Math.abs(r.net))}</text>` : ''}
      </g>`;
    })
    .join('');
  $('#sector-treemap').innerHTML =
    `<svg class="chart" viewBox="0 0 ${W} ${H}" style="height:${H}px">${cells}</svg>` +
    '<p class="footnote">綠色＝淨買入、紅色＝淨賣出，區塊面積代表該產業的申報交易總金額。</p>';
}

function renderPolicyThemeSelect(p) {
  const sel = $('#pol-theme');
  if (!sel) return;
  const current = state.policyThemeId || (p.themes[0] && p.themes[0].id);
  sel.innerHTML = p.themes.map((t) => `<option value="${esc(t.id)}"${t.id === current ? ' selected' : ''}>${esc(t.name)}（${t.pairCount} 筆交集）</option>`).join('');
}

function renderPolicyTimeline(p) {
  const theme = p.themes.find((t) => t.id === state.policyThemeId) || p.themes[0];
  if (!theme) {
    $('#policy-timeline').innerHTML = '<p class="hint">沒有政策主題資料</p>';
    return;
  }
  $('#policy-timeline-hint').textContent = `${theme.name} · ${theme.docCount} 份文件 · ${theme.tradeCount} 筆相關交易 · 淨 ${theme.netFlow >= 0 ? '+' : '−'}$${fmtMoney(Math.abs(theme.netFlow))}`;

  const tickers = new Set(
    [...theme.bullish, ...theme.bearish, ...theme.neutral].map((r) => r.ticker)
  );
  const trades = state.trades.filter((t) => tickers.has(t.ticker));
  if (!trades.length && !theme.docs.length) {
    $('#policy-timeline').innerHTML = '<p class="hint">這個主題目前沒有可繪製的文件或交易。</p>';
    return;
  }

  const W = 960;
  const H = 300;
  const pad = { l: 54, r: 16, t: 46, b: 46 };
  const allDates = [...trades.map((t) => t.tradeDate), ...theme.docs.map((d) => d.date)].filter(Boolean).sort();
  const t0 = new Date(`${allDates[0]}T00:00:00Z`).getTime();
  const t1 = new Date(`${allDates[allDates.length - 1]}T00:00:00Z`).getTime();
  const X = (d) => pad.l + ((new Date(`${d}T00:00:00Z`).getTime() - t0) / (t1 - t0 || 1)) * (W - pad.l - pad.r);

  /* 以週為單位彙總淨買賣 */
  const weeks = new Map();
  for (const t of trades) {
    const ms = new Date(`${t.tradeDate}T00:00:00Z`).getTime();
    const weekStart = new Date(Math.floor((ms - t0) / (7 * 86400000)) * 7 * 86400000 + t0).toISOString().slice(0, 10);
    const w = weeks.get(weekStart) || { buy: 0, sell: 0 };
    if (t.side === 'BUY') w.buy += midAmount(t);
    else w.sell += midAmount(t);
    weeks.set(weekStart, w);
  }
  const weekRows = [...weeks.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const maxWeek = Math.max(1, ...weekRows.map(([, w]) => Math.max(w.buy, w.sell)));
  const midY = pad.t + (H - pad.t - pad.b) * 0.62;
  const barW = Math.max(3, (W - pad.l - pad.r) / Math.max(1, weekRows.length) - 2);

  /* 政策文件日期附近畫出交集時間窗 */
  const windowDays = p.windowDays;
  const bands = theme.docs
    .map((d) => {
      const x0 = X(new Date(new Date(`${d.date}T00:00:00Z`).getTime() - windowDays * 86400000).toISOString().slice(0, 10));
      const x1 = X(new Date(new Date(`${d.date}T00:00:00Z`).getTime() + windowDays * 86400000).toISOString().slice(0, 10));
      return `<rect x="${Math.max(pad.l, x0).toFixed(1)}" y="${pad.t}" width="${Math.max(0, Math.min(W - pad.r, x1) - Math.max(pad.l, x0)).toFixed(1)}"
        height="${(H - pad.t - pad.b).toFixed(1)}" fill="#f0b429" opacity="0.07"/>`;
    })
    .join('');

  const bars = weekRows
    .map(([date, w]) => {
      const x = X(date);
      const upH = (w.buy / maxWeek) * (midY - pad.t - 8);
      const dnH = (w.sell / maxWeek) * (H - pad.b - midY - 8);
      const netUp = w.buy - w.sell >= 0;
      return `<g><title>${date} 起算的一週：買 $${fmtMoney(w.buy)}／賣 $${fmtMoney(w.sell)}</title>
        <rect x="${x.toFixed(1)}" y="${(midY - upH).toFixed(1)}" width="${barW.toFixed(1)}" height="${upH.toFixed(1)}" fill="#2dd4bf" opacity="${netUp ? 0.95 : 0.45}" rx="2"/>
        <rect x="${x.toFixed(1)}" y="${midY.toFixed(1)}" width="${barW.toFixed(1)}" height="${dnH.toFixed(1)}" fill="#ff5d5d" opacity="${netUp ? 0.45 : 0.95}" rx="2"/>
      </g>`;
    })
    .join('');

  const docMarkers = theme.docs
    .map((d, i) => {
      const x = X(d.date);
      const label = d.title.length > 44 ? `${d.title.slice(0, 42)}…` : d.title;
      return `<g><title>${esc(d.date)}｜${esc(d.title)}｜${esc(d.agencies || '')}</title>
        <line x1="${x.toFixed(1)}" y1="${pad.t - 6}" x2="${x.toFixed(1)}" y2="${midY.toFixed(1)}" stroke="#f0b429" stroke-width="1.4" stroke-dasharray="3 3"/>
        <circle cx="${x.toFixed(1)}" cy="${pad.t - 12}" r="5" fill="#f0b429"/>
        <text x="${x.toFixed(1)}" y="${pad.t - 20}" fill="#f0b429" font-size="10" text-anchor="${i % 2 ? 'start' : 'end'}">${esc(label)}</text>
      </g>`;
    })
    .join('');

  const monthTicks = [];
  const cursor = new Date(`${allDates[0]}T00:00:00Z`);
  cursor.setUTCDate(1);
  while (cursor.getTime() <= t1) {
    const iso = cursor.toISOString().slice(0, 10);
    if (iso >= allDates[0]) {
      const x = X(iso);
      monthTicks.push(`<line x1="${x.toFixed(1)}" y1="${midY}" x2="${x.toFixed(1)}" y2="${H - pad.b}" stroke="#1e2b3c"/>
        <text x="${x.toFixed(1)}" y="${H - pad.b + 15}" fill="#7d93ae" font-size="10" text-anchor="middle">${iso.slice(2, 7)}</text>`);
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  $('#policy-timeline').innerHTML = `
    <svg class="chart" viewBox="0 0 ${W} ${H}" style="height:${H}px">
      ${bands}${monthTicks}
      <line x1="${pad.l}" y1="${midY.toFixed(1)}" x2="${W - pad.r}" y2="${midY.toFixed(1)}" stroke="#2a3d5c"/>
      <text x="${pad.l - 8}" y="${(pad.t + 12).toFixed(1)}" fill="#7d93ae" font-size="10" text-anchor="end">買 ${fmtMoney(maxWeek)}</text>
      <text x="${pad.l - 8}" y="${(H - pad.b).toFixed(1)}" fill="#7d93ae" font-size="10" text-anchor="end">賣 ${fmtMoney(maxWeek)}</text>
      ${bars}${docMarkers}
    </svg>
    <div class="chart-legend">
      <span><i style="background:#f0b429"></i>政策文件（點位為發布日）</span>
      <span><i style="background:#2dd4bf"></i>該週淨買入</span>
      <span><i style="background:#ff5d5d"></i>該週淨賣出</span>
      <span><i style="background:#f0b429;opacity:0.25"></i>交集時間窗 ±${p.windowDays} 天</span>
    </div>`;
}

function renderPolicyThemes(p) {
  $('#policy-themes').innerHTML = p.themes
    .map((t) => {
      const list = (rows, cls, title) =>
        rows.length
          ? `<div style="margin-top:8px"><div class="hint">${title}</div>${rows
              .slice(0, 6)
              .map(
                (r) =>
                  `<div class="status-item" style="padding:3px 0"><span><b>${esc(r.ticker)}</b> <span class="muted">${
                    r.count ? `${r.count} 筆` : '未交易'
                  }</span></span><span class="${cls}">${r.count ? `${r.net >= 0 ? '+' : '−'}$${fmtMoney(Math.abs(r.net))}` : '—'}</span></div>`
              )
              .join('')}</div>`
          : '';
      return `<div class="reason-card">
        <h3>
          <span>${esc(t.name)} <span class="tag sector">${esc(t.axis)}</span></span>
          <span class="${t.pairCount ? 'score-mid' : 'muted'}">${t.pairCount} 筆交集</span>
        </h3>
        <p>${esc(t.description)}</p>
        <div class="hint">他在此主題標的的淨額：<span class="${t.netFlow >= 0 ? 'up' : 'down'}">${t.netFlow >= 0 ? '+' : '−'}$${fmtMoney(Math.abs(t.netFlow))}</span>
          （買 $${fmtMoney(t.buyTotal)}／賣 $${fmtMoney(t.sellTotal)}，${t.tradeCount} 筆）</div>
        ${list(t.bullish, 'up', '政策方向相對受惠')}
        ${list(t.bearish, 'down', '政策方向相對受損')}
        ${
          t.docs.length
            ? `<div style="margin-top:10px" class="hint">最新官方文件</div>` +
              t.docs
                .slice(0, 3)
                .map(
                  (d) =>
                    `<div style="font-size:12px;margin-top:3px"><a href="${esc(d.link)}" target="_blank" rel="noreferrer noopener">${esc(
                      d.title.length > 58 ? `${d.title.slice(0, 56)}…` : d.title
                    )}</a> <span class="muted">${esc(d.date)}</span></div>`
                )
                .join('')
            : '<div class="hint" style="margin-top:8px">尚未抓取此主題的官方文件</div>'
        }
      </div>`;
    })
    .join('');
}

function renderPolicyPairs(p) {
  const rows = p.pairs.slice(0, 80);
  $('#policy-pairs-hint').textContent = p.summary.pairCount
    ? `共 ${p.summary.pairCount} 筆（顯示最接近的 ${rows.length} 筆，時間窗 ±${p.windowDays} 天）`
    : `時間窗 ±${p.windowDays} 天內沒有交集（可放寬時間窗或先抓取政策文件）`;
  $('#policy-pairs-table tbody').innerHTML = rows
    .map(
      (r) => `
    <tr>
      <td><span class="tag sector">${esc(r.themeName)}</span></td>
      <td><b>${esc(r.ticker)}</b></td>
      <td><span class="tag ${r.direction > 0 ? 'buy' : r.direction < 0 ? 'sell' : ''}">${r.direction > 0 ? '受惠' : r.direction < 0 ? '受損' : '中性'}</span></td>
      <td><a href="${esc(r.docUrl)}" target="_blank" rel="noreferrer noopener">${esc(r.docTitle.length > 56 ? `${r.docTitle.slice(0, 54)}…` : r.docTitle)}</a></td>
      <td class="num muted">${esc(r.docDate)}</td>
      <td class="num">${esc(r.tradeDate)}</td>
      <td class="num ${Math.abs(r.gapDays) <= 3 ? 'up' : ''}">${r.gapDays >= 0 ? '+' : ''}${r.gapDays} 天</td>
      <td><span class="tag ${r.side === 'BUY' ? 'buy' : 'sell'}">${r.side === 'BUY' ? '買入' : '賣出'}</span></td>
      <td class="num">$${fmtMoney(r.amount)}</td>
    </tr>`
    )
    .join('');
}

/* ----------------------------- 即時情報 ----------------------------- */

function renderOgeMonitor() {
  const oge = state.oge || { filings: [], freshKeys: [] };
  const fresh = new Set(oge.freshKeys || []);
  const tx = oge.filings.filter((f) => f.isTransactionReport);
  $('#oge-status').textContent = oge.fetchedAt
    ? `上次檢查 ${timeAgo(oge.fetchedAt)}· 278-T 共 ${tx.length} 筆`
    : '尚未檢查（按右側按鈕向 OGE 官方資料庫查詢）';

  if (!oge.filings.length) {
    $('#live-oge').innerHTML =
      '<p class="feed-empty">尚未取得申報清單。按「檢查有無新申報」向 OGE 官方資料庫（官方 API，無需金鑰）查詢。</p>';
    return;
  }

  const sorted = oge.filings
    .slice()
    .sort((a, b) => (a.docDate < b.docDate ? 1 : a.docDate > b.docDate ? -1 : 0))
    .slice(0, 24);

  $('#live-oge').innerHTML = sorted
    .map((f) => {
      const isNew = fresh.has([f.docDate, f.name, f.type, f.file || ''].join('|'));
      const tag = f.isTransactionReport ? '<span class="tag buy">278-T 交易申報</span>' : `<span class="tag">${esc(f.type)}</span>`;
      const action = f.isPdf
        ? `<button class="btn ghost small" data-oge-download="${esc(f.link)}" data-oge-file="${esc(f.file || '')}">下載 PDF</button>`
        : f.needsRequest
          ? `<a class="btn ghost small" href="${esc(f.requestLink)}" target="_blank" rel="noreferrer noopener">向 OGE 申請</a>`
          : '';
      return `<div class="feed-item ${isNew ? 'hit' : ''}">
        <span>
          ${isNew ? '<span class="tag good">新申報</span> ' : ''}
          ${tag}
          <b style="margin-left:6px">${esc(f.docDate)}</b>
          <span class="muted"> ${esc(f.type)}</span>
        </span>
        <span class="feed-time">${esc(f.agency || '')}</span>
        <div class="feed-meta">
          <span>${esc(f.name)}</span>
          ${action}
        </div>
      </div>`;
    })
    .join('');
}

function renderExplainer() {
  $('#live-explainer').innerHTML = `
    <div class="step warn">
      <h3>1. 法規延遲（技術無法突破）</h3>
      <p>總統依《政府倫理法》以 <b>OGE Form 278-T</b> 申報股票交易，法定期限是
      <b>成交後 30 天內</b>申報，申報後還要經過公開作業才上網。所以「成交 → 你能看到」通常落後
      <b>1~6 週</b>，這就是這個題目的物理上限。</p>
      <div class="lag-meter"><span></span></div>
      <p>成交日 →（0~30 天申報）→ 申報日 →（數日公開）→ 你看到</p>
    </div>
    <div class="step">
      <h3>2. 揭露顆粒度很粗</h3>
      <p>申報只給<b>金額區間</b>（例如 $1,000,001–$5,000,000）與<b>成交日</b>，
      不含精確股數與成交價。所以「跟單成本」與申報內容必然有落差，本 App 也把這件事標在每個訊號上。</p>
    </div>
    <div class="step">
      <h3>3. 真正能做到即時的三條線</h3>
      <p>① <b>市價</b>：Yahoo／Stooq，盤中延遲約 15 分鐘；② <b>新聞快訊</b>：發布後數分鐘；
      ③ <b>政策與採購公告</b>：公布即取得。這三條線是申報資料的領先指標，本頁都接好了。</p>
    </div>
    <div class="step">
      <h3>4. 可自動化的最佳實務</h3>
      <p>① 用排程抓 OGE／Capitol Trades 匯出檔 → 匯入本 App；
      ② 同時監看新聞與政府合約訊號做交叉驗證；
      ③ 若你已有 Quiver／Unusual Whales 訂閱，把端點貼進下方的通用匯入欄位即可每日自動更新。</p>
    </div>`;
}

function renderPriceSource() {
  const meta = state.priceMeta || { source: 'synthetic', provider: 'builtin' };
  const isLive = meta.source === 'live';
  const live = state.trades.length;
  $('#price-status').textContent = isLive ? `即時／收盤價 · ${timeAgo(meta.fetchedAt)}` : '模擬價格（無連外）';

  const rows = [
    ['目前來源', isLive ? `真實市場資料（${meta.provider}）` : '內建模擬序列'],
    ['更新時間', meta.fetchedAt ? new Date(meta.fetchedAt).toLocaleString('zh-TW') : '—'],
    ['價格頻率', `${meta.granularity || '1d'}（日線）`],
    ['資料截止', state.asOf],
    [
      '涵蓋標的',
      `${Object.keys(state.market.series).length} 檔` +
        (meta.universe
          ? `（共 ${meta.universe.total} 檔，取申報金額前 ${meta.universe.included} 檔，` +
            `涵蓋約 ${pct(meta.universe.totalVolume ? meta.universe.coveredVolume / meta.universe.totalVolume : 0, 0)} 申報金額）`
          : `（追蹤 ${live} 檔）`),
    ],
  ];
  if (isLive && meta.filledWithSynthetic && meta.filledWithSynthetic.length) {
    rows.push(['以模擬補齊', meta.filledWithSynthetic.join('、')]);
  }
  if (meta.errors && meta.errors.length) {
    rows.push(['個別失敗', meta.errors.map((e) => `${e.ticker}: ${e.error}`).slice(0, 4).join('；')]);
  }
  $('#live-price').innerHTML = rows
    .map(([k, v]) => `<div class="status-item"><span>${esc(k)}</span><span>${esc(v)}</span></div>`)
    .join('');
}

function renderFeed(el, items, emptyText, mapper) {
  if (!items || !items.length) {
    el.innerHTML = `<p class="feed-empty">${esc(emptyText)}</p>`;
    return;
  }
  el.innerHTML = items.map(mapper).join('');
}

/* 判斷標題是否提到我們正在追蹤的標的 */
function newsHit(title) {
  const t = String(title).toUpperCase();
  const tickers = [...new Set(state.trades.map((x) => x.ticker))].filter((x) => x.length >= 2);
  const hitTicker = tickers.find((x) => new RegExp(`\\b${x}\\b`).test(t));
  if (hitTicker) return { hit: true, label: hitTicker };
  const name = state.trades.find((x) => {
    const base = String(x.company).split(/\s+/)[0].toUpperCase();
    return base.length > 3 && t.includes(base);
  });
  return name ? { hit: true, label: name.ticker } : { hit: false, label: null };
}

function renderNewsFeed() {
  const news = state.news || { items: [] };
  $('#news-status').textContent = news.fetchedAt
    ? `關鍵字「${news.query}」· ${timeAgo(news.fetchedAt)}· ${news.items.length} 則`
    : '尚未同步（需要連外）';
  renderFeed(
    $('#live-news'),
    news.items,
    '還沒有新聞資料。按「更新快訊」向 Google News RSS 抓取即時標題（需要網路連線）。',
    (item) => {
      const m = newsHit(item.title);
      return `<div class="feed-item ${m.hit ? 'hit' : ''}">
        <a href="${esc(item.link)}" target="_blank" rel="noreferrer noopener">${esc(item.title)}</a>
        <span class="feed-time">${esc(timeAgo(item.publishedAt))}</span>
        <div class="feed-meta">
          <span>${esc(item.source || '未知來源')}</span>
          ${m.hit ? `<span class="tag good">可能涉及 ${esc(m.label)}</span>` : ''}
          <span>${esc((item.publishedAt || '').slice(0, 10))}</span>
        </div>
      </div>`;
    }
  );
}

function renderPolicyFeed() {
  const policy = state.frFeed || { items: [] };
  $('#fr-status').textContent = policy.fetchedAt
    ? `關鍵字「${policy.term}」· ${timeAgo(policy.fetchedAt)}`
    : '尚未同步';
  renderFeed($('#live-policy'), policy.items, '尚未取得政策文件。', (d) => `
    <div class="feed-item">
      <a href="${esc(d.link)}" target="_blank" rel="noreferrer noopener">${esc(d.title)}</a>
      <span class="feed-time">${esc((d.publishedAt || '').slice(0, 10))}</span>
      <div class="feed-meta"><span>${esc(d.type || '')}</span><span>${esc(d.agencies || '')}</span></div>
    </div>`);
}

function renderContractsFeed() {
  const data = state.contracts || { items: [] };
  $('#contracts-status').textContent = data.fetchedAt ? `${timeAgo(data.fetchedAt)}· ${data.items.length} 筆` : '尚未同步';
  renderFeed($('#live-contracts'), data.items, '尚未取得合約資料。', (c) => `
    <div class="feed-item">
      <a href="${esc(c.link)}" target="_blank" rel="noreferrer noopener">${esc(c.title)}</a>
      <span class="feed-time">${c.amount ? `$${fmtMoney(c.amount)}` : ''}</span>
      <div class="feed-meta"><span>${esc(c.agency || '')}</span><span>${esc((c.publishedAt || '').slice(0, 10))}</span></div>
    </div>`);
}

function showResult(el, html) {
  el.innerHTML = html;
}

async function syncPost(path, body, resultEl, onOk) {
  const btn = resultEl.closest('.card').querySelector('.btn.primary');
  if (btn) btn.disabled = true;
  showResult(resultEl, '<p class="hint">處理中…</p>');
  try {
    const res = await apiFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showResult(resultEl, `<p class="ok">${esc(onOk(data))}</p>`);
    return data;
  } catch (err) {
    showResult(
      resultEl,
      `<p class="err">失敗：${esc(err.message)}</p>` +
        '<p class="hint">若你的環境無法連外，請改用模擬價格或稍後再試；這些來源都需要網際網路。</p>'
    );
    return null;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderDataTab() {
  const kind = state.meta.datasetKind || 'demo';
  const tickers = new Set(state.trades.map((t) => t.ticker));
  const kpisRow = [
    ['資料集類型', { demo: '示範資料集（模擬）', mixed: '示範 + 匯入混合', imported: '匯入資料集' }[kind] || kind],
    ['申報交易筆數', `${state.trades.length} 筆`],
    ['涵蓋標的', `${tickers.size} 檔`],
    ['買入 / 賣出', `${state.trades.filter((t) => t.side === 'BUY').length} / ${state.trades.filter((t) => t.side === 'SELL').length} 筆`],
    ['最新申報日', state.analysis.summary.lastFiledDate || '—'],
    ['最近匯入時間', state.meta.importedAt ? new Date(state.meta.importedAt).toLocaleString('zh-TW') : '—'],
    [
      '價格來源',
      state.priceMeta && state.priceMeta.source === 'live'
        ? `真實市場資料（${state.priceMeta.provider}）· ${timeAgo(state.priceMeta.fetchedAt)}`
        : '內建模擬序列',
    ],
    [
      '價格區間',
      `${state.market.benchmark[0].date} ~ ${state.market.benchmark[state.market.benchmark.length - 1].date}`,
    ],
  ];
  if (state.meta.sourceFile) {
    kpisRow.splice(1, 0, ['來源檔案', state.meta.sourceFile]);
  }
  if (state.meta.externalDataset) {
    kpisRow.splice(1, 0, [
      '第三方資料集',
      `${state.meta.externalDataset.name || state.meta.externalDataset.repo}（${state.meta.externalDataset.totals?.txCount ?? '—'} 筆原始交易）`,
    ]);
  }
  $('#data-status').innerHTML = kpisRow
    .map(([k, v]) => `<div class="status-item"><span>${esc(k)}</span><span>${esc(v)}</span></div>`)
    .join('');

  $('#data-sources').innerHTML = state.sources
    .map(
      (s) => `<div class="source-item">
        <a href="${esc(s.url)}" target="_blank" rel="noreferrer noopener">${esc(s.name)} ↗</a>
        <p>${esc(s.note)}</p>
      </div>`
    )
    .join('');

  renderRealData();
}

/* 資料管理：載入真實資料集（第三方 Q1 資料集 + data/ 下的 CSV） */
async function renderRealData() {
  const box = $('#rd-files');
  if (!box) return;
  box.innerHTML = '<div class="status-item"><span>掃描中…</span><span></span></div>';
  try {
    const res = await apiFetch('import/files');
    const data = await res.json();
    state.importFiles = data.files || [];
    state.externalDatasets = data.externalDatasets || [];
  } catch {
    state.importFiles = [];
  }

  const rows = [];
  for (const ds of state.externalDatasets || []) {
    rows.push(`
      <div class="status-item">
        <span>
          <b>${esc(ds.name)}</b>
          <span class="tag sector">第三方解析</span>
          <div class="hint">${esc(ds.note)}</div>
        </span>
        <span><button class="btn ghost small" data-load-external="${esc(ds.id)}">載入</button></span>
      </div>`);
  }
  const importable = (state.importFiles || []).filter((f) => f.rows !== null || /\.json$/.test(f.name));
  if (importable.length) {
    rows.push(
      importable
        .map(
          (f) => `
      <div class="status-item">
        <span>
          <b>${esc(f.path)}</b>
          <div class="hint">${f.rows === null ? 'JSON 檔' : `${f.rows} 列`} · ${(f.bytes / 1024).toFixed(0)} KB${
            f.columns && f.columns.length ? ` · 欄位：${esc(f.columns.slice(0, 8).join(', '))}` : ''
          }</div>
        </span>
        <span><button class="btn ghost small" data-import-file="${esc(f.path)}">匯入這個檔案</button></span>
      </div>`
        )
        .join('')
    );
  } else {
    rows.push('<div class="status-item"><span>data/ 目錄下沒有可匯入的 CSV</span><span></span></div>');
  }
  box.innerHTML = rows.join('');
}

async function doImport() {
  const btn = $('#btn-import');
  const out = $('#import-result');
  const text = $('#i-text').value;
  if (!text.trim()) {
    out.innerHTML = '<p class="err">請先貼上 CSV 或 JSON 內容（可先按「載入範本」）。</p>';
    return;
  }
  btn.disabled = true;
  out.innerHTML = '<p class="hint">匯入中…</p>';
  try {
    const res = await apiFetch('import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: $('#i-format').value, mode: $('#i-mode').value, text }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '匯入失敗');
    out.innerHTML =
      `<p class="ok">匯入成功：接受 ${data.accepted} 筆、略過 ${data.rejected} 筆，` +
      `資料集現有 ${data.tradeCount} 筆 / ${data.tickerCount} 檔（${esc(data.datasetKind)}）。</p>` +
      (data.errors && data.errors.length
        ? `<pre>${esc(data.errors.map((e) => `第 ${e.rowNumber} 列：${e.reason}`).join('\n'))}</pre>`
        : '');
    await boot();
  } catch (err) {
    out.innerHTML = `<p class="err">${esc(err.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------ 圖表 ------------------------------ */

const CHART_W = 960;

function lineChart(el, seriesList, opts = {}) {
  if (!el) return;
  const H = opts.height || 300;
  const pad = { l: 62, r: 18, t: 14, b: 28 };
  const all = seriesList.flatMap((s) => s.points);
  if (!all.length) {
    el.innerHTML = '<p class="hint">沒有可繪製的資料</p>';
    return;
  }
  const tOf = (d) => new Date(`${d}T00:00:00Z`).getTime();
  const xMin = Math.min(...all.map((p) => tOf(p.date)));
  const xMax = Math.max(...all.map((p) => tOf(p.date)));
  let yMin = Math.min(...all.map((p) => p.close));
  let yMax = Math.max(...all.map((p) => p.close));
  const padY = (yMax - yMin) * 0.08 || Math.abs(yMax) * 0.05 || 1;
  yMin -= padY;
  yMax += padY;

  const X = (d) => pad.l + ((CHART_W - pad.l - pad.r) * (tOf(d) - xMin)) / (xMax - xMin || 1);
  const Y = (v) => pad.t + (H - pad.t - pad.b) * (1 - (v - yMin) / (yMax - yMin || 1));

  const fmtY = (v) => (opts.yPrefix === '$' ? `$${fmtMoney(v)}` : v.toFixed(v >= 1000 ? 0 : v < 10 ? 2 : 1));

  const gridLines = Array.from({ length: 5 }, (_, i) => {
    const v = yMin + ((yMax - yMin) * i) / 4;
    const y = Y(v);
    return `<line x1="${pad.l}" x2="${CHART_W - pad.r}" y1="${y}" y2="${y}" stroke="#1e2b3c" stroke-width="1"/>
            <text x="${pad.l - 9}" y="${y + 4}" fill="#7d93ae" font-size="11" text-anchor="end">${fmtY(v)}</text>`;
  }).join('');

  const nTicks = 5;
  const xTicks = Array.from({ length: nTicks }, (_, i) => {
    const t = xMin + ((xMax - xMin) * i) / (nTicks - 1);
    const x = pad.l + ((CHART_W - pad.l - pad.r) * (t - xMin)) / (xMax - xMin || 1);
    const d = new Date(t).toISOString().slice(0, 10);
    return `<text x="${x}" y="${H - 8}" fill="#7d93ae" font-size="11" text-anchor="middle">${d.slice(2, 7)}</text>`;
  }).join('');

  const paths = seriesList
    .map((s) => {
      const d = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${X(p.date).toFixed(1)},${Y(p.close).toFixed(1)}`).join(' ');
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>`;
    })
    .join('');

  const area = seriesList.length
    ? `<path d="${seriesList[0].points.map((p, i) => `${i === 0 ? 'M' : 'L'}${X(p.date).toFixed(1)},${Y(p.close).toFixed(1)}`).join(' ')}
        L${X(seriesList[0].points[seriesList[0].points.length - 1].date).toFixed(1)},${H - pad.b}
        L${X(seriesList[0].points[0].date).toFixed(1)},${H - pad.b} Z"
        fill="url(#g1)" opacity="0.35"/>`
    : '';

  const markers = (opts.markers || [])
    .filter((m) => m.close !== null && m.close !== undefined)
    .map((m) => {
      const x = X(m.date);
      const y = Y(m.close);
      const up = m.side === 'BUY';
      const color = up ? '#2ecc71' : '#ff5d5d';
      const pts = up
        ? `${x},${y - 7} ${x - 5},${y + 3} ${x + 5},${y + 3}`
        : `${x},${y + 7} ${x - 5},${y - 3} ${x + 5},${y - 3}`;
      return `<polygon points="${pts}" fill="${color}" stroke="#0a0e14" stroke-width="1"><title>${esc(m.ticker || '')} ${up ? '買入' : '賣出'} ${esc(m.date)}</title></polygon>`;
    })
    .join('');

  const legend = seriesList.length > 1
    ? `<div class="chart-legend">${seriesList.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>`
    : '';

  el.innerHTML = `${legend}<svg class="chart" viewBox="0 0 ${CHART_W} ${H}" preserveAspectRatio="none" style="height:${H}px">
    <defs><linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${seriesList[0].color}" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="${seriesList[0].color}" stop-opacity="0"/>
    </linearGradient></defs>
    ${gridLines}${xTicks}${area}${paths}${markers}
  </svg>`;
}

function donut(slices, opts = {}) {
  const size = opts.size || 180;
  const r = size / 2 - 16;
  const cx = size / 2;
  const cy = size / 2;
  const C = 2 * Math.PI * r;
  const total = slices.reduce((a, b) => a + b.value, 0) || 1;
  let acc = 0;
  const arcs = slices
    .map((s) => {
      const frac = s.value / total;
      const len = frac * C;
      const el = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="18"
        stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-acc}"
        transform="rotate(-90 ${cx} ${cy})"><title>${esc(s.label)} ${(frac * 100).toFixed(1)}%</title></circle>`;
      acc += len;
      return el;
    })
    .join('');
  const legend = slices
    .map(
      (s) => `<div><i style="background:${s.color}"></i>${esc(s.label)}
        <span class="muted">${opts.unit ? opts.unit(s.value) : pct(s.value / total, 1)}</span></div>`
    )
    .join('');
  return `<div class="donut-wrap">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#16202d" stroke-width="18"/>
      ${arcs}
    </svg>
    <div class="legend">${legend}</div>
  </div>`;
}

/* 政策曝險散佈圖：x = 政策敏感度（−1 受損／+1 受惠）、y = 申報淨買賣（百萬美元）、大小 = 金額 */
function scatterChart(el, points, opts = {}) {
  if (!el) return;
  if (!points.length) {
    el.innerHTML = '<p class="hint">沒有可繪製的資料（先載入真實申報資料）</p>';
    return;
  }
  const W = 960;
  const H = opts.height || 320;
  const pad = { l: 62, r: 20, t: 16, b: 38 };
  const xs = points.map((p) => p.x);
  const xMin = Math.min(-1, ...xs);
  const xMax = Math.max(1, ...xs);
  const yAbs = Math.max(1, ...points.map((p) => Math.abs(p.y))) * 1.18;
  const X = (v) => pad.l + ((v - xMin) / (xMax - xMin || 1)) * (W - pad.l - pad.r);
  const Y = (v) => pad.t + (H - pad.t - pad.b) * (1 - (v + yAbs) / (2 * yAbs));

  const yGrid = [-1, -0.5, 0, 0.5, 1]
    .map((f) => {
      const v = yAbs * f;
      const y = Y(v);
      return `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${f === 0 ? '#2a3d5c' : '#1a2634'}" stroke-width="${f === 0 ? 1.4 : 1}"/>
        <text x="${pad.l - 8}" y="${(y + 4).toFixed(1)}" fill="#7d93ae" font-size="10.5" text-anchor="end">${v >= 0 ? '+' : '−'}$${fmtMoney(Math.abs(v))}</text>`;
    })
    .join('');

  const xTicks = [-1, -0.5, 0, 0.5, 1]
    .filter((v) => v >= xMin && v <= xMax)
    .map((v) => {
      const x = X(v);
      return `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${pad.t}" y2="${H - pad.b}" stroke="${v === 0 ? '#2a3d5c' : '#16202d'}"/>
        <text x="${x.toFixed(1)}" y="${H - pad.b + 15}" fill="#7d93ae" font-size="10.5" text-anchor="middle">${v === 0 ? '中性' : v > 0 ? `受惠 ${v}` : `受損 ${v}`}</text>`;
    })
    .join('');

  const labelSet = new Set(
    points
      .slice()
      .sort((a, b) => b.r - a.r)
      .slice(0, 18)
      .map((p) => p.label)
  );

  const bubbles = points
    .slice()
    .sort((a, b) => b.r - a.r)
    .map((p) => {
      const x = X(p.x);
      const y = Y(p.y);
      const r = Math.min(26, Math.max(4, p.r));
      const label = labelSet.has(p.label)
        ? `<text x="${(x + r + 4).toFixed(1)}" y="${(y + 3.5).toFixed(1)}" fill="#dbe6f3" font-size="11" font-weight="600">${esc(p.label)}</text>`
        : '';
      return `<g><title>${esc(p.label)}｜政策敏感度 ${p.x}｜淨 ${p.ticker.net >= 0 ? '+' : '−'}$${fmtMoney(Math.abs(p.ticker.net))}｜${p.ticker.count} 筆</title>
        <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${p.color}" opacity="0.55" stroke="${p.color}" stroke-width="1.5"/>
        ${label}</g>`;
    })
    .join('');

  el.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" style="height:${H}px">
    ${yGrid}${xTicks}${bubbles}
  </svg>`;
}

/* 簡易 squarified treemap 版面計算 */
function squarify(items, rect) {
  const out = [];
  const data = items.slice().sort((a, b) => b.value - a.value);
  const total = data.reduce((a, b) => a + b.value, 0) || 1;
  const scale = (rect.w * rect.h) / total;
  let box = { ...rect };
  let i = 0;
  while (i < data.length) {
    const short = Math.max(1, Math.min(box.w, box.h));
    const row = [];
    let rowSum = 0;
    let worst = Infinity;
    let j = i;
    while (j < data.length) {
      const area = data[j].value * scale;
      const newSum = rowSum + area;
      const side = newSum / short;
      let localWorst = 0;
      for (const r of [...row, { area }]) {
        const len = r.area / Math.max(0.0001, side);
        localWorst = Math.max(localWorst, Math.max(side / Math.max(0.0001, len), len / Math.max(0.0001, side)));
      }
      if (localWorst <= worst) {
        row.push({ item: data[j], area });
        rowSum = newSum;
        worst = localWorst;
        j++;
      } else break;
    }
    if (!row.length) {
      row.push({ item: data[i], area: data[i].value * scale });
      rowSum = row[0].area;
      j = i + 1;
    }
    const side = rowSum / short;
    let offset = 0;
    for (const r of row) {
      const len = r.area / Math.max(0.0001, side);
      if (box.w >= box.h) {
        out.push({ ...r.item, x: box.x, y: box.y + offset, w: side, h: len });
      } else {
        out.push({ ...r.item, x: box.x + offset, y: box.y, w: len, h: side });
      }
      offset += len;
    }
    if (box.w >= box.h) box = { x: box.x + side, y: box.y, w: box.w - side, h: box.h };
    else box = { x: box.x, y: box.y + side, w: box.w, h: box.h - side };
    i = j;
    if (box.w <= 0.5 || box.h <= 0.5) break;
  }
  return out;
}

/* ------------------------------ 事件綁定 ------------------------------ */

function bindEvents() {
  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    $$('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${btn.dataset.tab}`));
    activeTab = btn.dataset.tab;
    if (state.syncTabSelect) state.syncTabSelect();
    renderActiveTab();
    /* AI 機率頁第一次打開時自動訓練（伺服器端有快取，之後切換幾乎即時） */
    if (activeTab === 'ai' && !state.probability && !state.probabilityLoading) {
      loadProbability();
    }
  });

  /* 手機版用下拉選單切換頁面（14 個頁籤在手機上滑不完） */
  const tabSelect = $('#tab-select');
  if (tabSelect) {
    tabSelect.innerHTML = $$('.tab')
      .map((b) => `<option value="${esc(b.dataset.tab)}">${esc(b.textContent)}</option>`)
      .join('');
    tabSelect.addEventListener('change', (ev) => {
      const target = $$('.tab').find((b) => b.dataset.tab === ev.target.value);
      if (target) target.click();
    });
  }
  state.syncTabSelect = () => {
    const sel = $('#tab-select');
    if (sel && sel.value !== activeTab) sel.value = activeTab;
  };

  $('#btn-reload').addEventListener('click', () => boot());

  /* 權重 */
  $('#weight-sliders').addEventListener('input', (e) => {
    const key = e.target.dataset.weight;
    if (!key) return;
    state.weights[key] = Number(e.target.value);
    $(`#wv-${key}`).textContent = `${(state.weights[key] * 100).toFixed(0)}%`;
    scheduleRecompute('signals', 'overview', 'portfolio');
  });
  $('#btn-reset-weights').addEventListener('click', () => {
    state.weights = { ...DEFAULT_WEIGHTS };
    renderWeightSliders();
    recompute();
    markDirty('signals', 'overview', 'portfolio');
    renderActiveTab(true);
  });

  /* 組合參數 */
  $('#portfolio-sliders').addEventListener('input', (e) => {
    const key = e.target.dataset.portfolio;
    if (!key) return;
    state.portfolioParams[key] = Number(e.target.value);
    const def = PORTFOLIO_DEFS.find((d) => d.key === key);
    $(`#pv-${key}`).textContent = def.fmt(state.portfolioParams[key]);
    scheduleRecompute('portfolio');
  });

  /* 回測參數 */
  $('#backtest-sliders').addEventListener('input', (e) => {
    const key = e.target.dataset.backtest;
    if (!key) return;
    state.backtestParams[key] = Number(e.target.value);
    const def = BACKTEST_DEFS.find((d) => d.key === key);
    $(`#bv-${key}`).textContent = def.fmt(state.backtestParams[key]);
    scheduleRecompute('backtest');
  });
  $('#backtest-sliders').addEventListener('change', (e) => {
    if (e.target.id === 'b-includeSells') {
      state.backtestParams.includeSells = e.target.checked;
      recompute();
      renderBacktestSliders();
      markDirty('backtest');
      renderActiveTab(true);
    }
  });

  /* 選股詳情 */
  document.addEventListener('click', (e) => {
    const row = e.target.closest('[data-ticker]');
    if (!row) return;
    state.selected = row.dataset.ticker === state.selected ? null : row.dataset.ticker;
    markDirty('signals');
    renderTab('signals', true);
    if (state.selected) {
      $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'signals'));
      $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-signals'));
      activeTab = 'signals';
      $('#detail-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
  $('#btn-close-detail').addEventListener('click', (e) => {
    e.stopPropagation();
    state.selected = null;
    markDirty('signals');
    renderTab('signals', true);
  });

  /* 交易篩選 */
  const filterIds = ['f-search', 'f-side', 'f-amount', 'f-from', 'f-to'];
  filterIds.forEach((id) => {
    $(`#${id}`).addEventListener('input', () => {
      state.filter.search = $('#f-search').value.trim();
      state.filter.side = $('#f-side').value;
      state.filter.amount = Number($('#f-amount').value);
      state.filter.from = $('#f-from').value;
      state.filter.to = $('#f-to').value;
      state.tradePage = 1;
      renderTradeTable();
    });
  });
  $('#btn-clear-filters').addEventListener('click', () => {
    filterIds.forEach((id) => {
      const el = $(`#${id}`);
      if (el.tagName === 'SELECT') el.value = el.querySelector('option').value;
      else el.value = '';
    });
    state.filter = { search: '', side: '', amount: 0, from: '', to: '' };
    state.tradePage = 1;
    renderTradeTable();
  });
  $('#trade-pager').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-page]');
    if (!btn) return;
    const pages = Math.max(1, Math.ceil(filteredTrades().length / 100));
    const map = {
      first: 1,
      prev: state.tradePage - 1,
      next: state.tradePage + 1,
      last: pages,
    };
    state.tradePage = Math.min(Math.max(1, map[btn.dataset.page]), pages);
    renderTradeTable();
  });
  $$('#trade-table th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : -1 };
      state.tradePage = 1;
      renderTradeTable();
    });
  });
  $('#btn-signal-more').addEventListener('click', () => {
    state.signalLimit = state.signalLimit >= state.analysis.scores.length ? 150 : state.analysis.scores.length;
    markDirty('signals');
    renderTab('signals', true);
  });

  /* 資料管理 */
  $('#btn-template').addEventListener('click', () => {
    $('#i-text').value = state.importTemplate;
    $('#i-format').value = 'csv';
  });
  $('#btn-import').addEventListener('click', doImport);

  /* 載入真實資料集 */
  const loadExternal = async (datasetId) => {
    const mode = $('#rd-mode').value;
    const data = await syncPost(
      '/api/import/external',
      { datasetId, mode },
      $('#rd-result'),
      (d) =>
        `已載入 ${d.accepted} 筆真實交易：資料集現有 ${d.tradeCount} 筆、${d.tickerCount} 檔標的、` +
        `${d.sectorCount} 個產業。`
    );
    if (data) await boot();
  };
  $('#btn-load-external').addEventListener('click', () => loadExternal('trump-278t-q1-2026'));
  $('#btn-scan-files').addEventListener('click', () => renderRealData());
  $('#rd-files').addEventListener('click', async (e) => {
    const extBtn = e.target.closest('[data-load-external]');
    if (extBtn) {
      await loadExternal(extBtn.dataset.loadExternal);
      return;
    }
    const fileBtn = e.target.closest('[data-import-file]');
    if (!fileBtn) return;
    const mode = $('#rd-mode').value;
    const data = await syncPost(
      '/api/import/file',
      { path: fileBtn.dataset.importFile, mode },
      $('#rd-result'),
      (d) =>
        `已匯入 ${d.accepted} 筆：資料集現有 ${d.tradeCount} 筆、${d.tickerCount} 檔標的、${d.sectorCount} 個產業。`
    );
    if (data) await boot();
  });

  $('#btn-reset').addEventListener('click', async () => {
    if (!confirm('確定要清空目前已匯入的資料，回復成內建示範資料集嗎？')) return;
    await apiFetch('reset', { method: 'POST' });
    await boot();
  });

  /* 即時情報 */
  /* 政策雷達 */
  /* AI 機率 */
  $('#btn-ai-run').addEventListener('click', () => loadProbability(true));
  $('#ai-horizon').addEventListener('change', () => loadProbability(true));

  /* 事件時鐘 */
  $('#btn-sync-events').addEventListener('click', async () => {
    const days = Number($('#events-days').value) || 30;
    const data = await syncPost('/api/sync/events', { days }, $('#events-result'), (d) =>
      `已抓取未來 ${d.days} 天的事件：政策生效 ${d.counts.policyEffective}、評論截止 ${d.counts.commentDeadline}、財報 ${d.counts.earnings}` +
      (d.earningsErrors ? `（${d.earningsErrors} 天財報抓取失敗）` : '')
    );
    if (data) await loadEvents(days);
  });
  $('#events-days').addEventListener('change', () => loadEvents(Number($('#events-days').value) || 30));

  /* 執行與計分 */
  /* 我的部位 */
  /* 內部人交易 */
  $('#btn-sync-insiders').addEventListener('click', async () => {
    const data = await syncPost('/api/sync/insiders', { maxTickers: 36, perTicker: 5 }, $('#ins-result'), (d) =>
      `已抓取 ${d.tickers} 檔標的、${d.transactions} 筆交易（買進 ${d.buys}、賣出 ${d.sells}）` +
      (d.errorCount ? `，${d.errorCount} 筆失敗` : '') +
      (d.skipped && d.skipped.length ? `，${d.skipped.length} 檔在 EDGAR 找不到代號` : '')
    );
    if (data) await loadInsiders(Number($('#ins-days').value) || 120);
  });
  $('#ins-days').addEventListener('change', () => loadInsiders(Number($('#ins-days').value) || 120));

  $('#btn-book-template').addEventListener('click', () => {
    $('#book-text').value = BOOK_TEMPLATE;
  });
  $('#btn-book-import').addEventListener('click', async () => {
    const text = $('#book-text').value.trim();
    if (!text) {
      showResult($('#book-result'), '<p class="err">請先貼上部位資料，或按「載入範本」。</p>');
      return;
    }
    const data = await syncPost(
      '/api/positions',
      { text, mode: $('#book-mode').value },
      $('#book-result'),
      (d) => `已匯入 ${d.accepted} 筆部位（略過 ${d.rejected} 筆），目前共 ${d.positionCount} 檔。`
    );
    if (data) await loadBook();
  });
  $('#btn-book-refresh').addEventListener('click', () => loadBook());
  $('#btn-book-clear').addEventListener('click', async () => {
    if (!confirm('確定要清除已匯入的部位嗎？')) return;
    await apiFetch('positions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clear: true }),
    });
    state.book = null;
    await loadBook();
  });

  $('#btn-sync-regime').addEventListener('click', async () => {
    const data = await syncPost('/api/sync/regime', {}, $('#regime-result'), (d) =>
      `已更新 ${d.symbols}/${d.expected} 個跨資產序列` + (d.errors && d.errors.length ? `（${d.errors.length} 個失敗）` : '')
    );
    if (data) await loadRegime();
  });

  $('#desk-sort').addEventListener('change', () => {
    markDirty('desk');
    renderActiveTab(true);
  });
  $('#desk-filter').addEventListener('change', () => {
    markDirty('desk');
    renderActiveTab(true);
  });

  $('#pol-theme').addEventListener('change', (e) => {
    state.policyThemeId = e.target.value;
    renderPolicyTimeline(state.policy);
  });
  $('#pol-window').addEventListener('change', (e) => {
    state.policyWindowDays = Number(e.target.value) || 30;
    recompute();
    renderPolicy();
  });
  $('#btn-sync-policy-all').addEventListener('click', async () => {
    const data = await syncPost('/api/sync/policy', { all: true }, $('#policy-result'), (d) =>
      `已抓取 ${d.themes.length} 個主題、共 ${d.totalDocs} 份官方政策文件` + (d.failed ? `（${d.failed} 個主題失敗）` : '')
    );
    if (data) {
      const pm = await (await apiFetch('policy-map')).json();
      state.policyThemes = pm.themes || [];
      state.docsByTheme = pm.docsByTheme || {};
      state.policyDisclaimer = pm.disclaimer || '';
      recompute();
      renderPolicy();
    }
  });

  $('#btn-sync-oge').addEventListener('click', async () => {
    const name = $('#oge-name').value.trim() || 'Trump, Donald J';
    const data = await syncPost('/api/sync/oge', { name }, $('#oge-result'), (d) => {
      if (d.firstRun) return `首次建立基準：取得 ${d.total} 筆紀錄（278-T ${d.transactionReports} 筆），之後再檢查就能比對出新增申報。`;
      if (!d.fresh.length) return `沒有新申報。目前共 ${d.total} 筆（278-T ${d.transactionReports} 筆）。`;
      return `發現 ${d.fresh.length} 筆新申報！最新：${d.fresh[0].docDate} ${d.fresh[0].type}`;
    });
    if (data) {
      const oge = await (await apiFetch('oge')).json();
      state.oge = oge;
      renderOgeMonitor();
    }
  });

  $('#live-oge').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-oge-download]');
    if (!btn) return;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = '下載中…';
    try {
      const res = await apiFetch('oge/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ link: btn.dataset.ogeDownload, file: btn.dataset.ogeFile }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '下載失敗');
      btn.textContent = `已存到 ${(data.bytes / 1048576).toFixed(1)} MB`;
    } catch (err) {
      btn.textContent = original;
      btn.disabled = false;
      showResult($('#oge-result'), `<p class="err">${esc(err.message)}</p>`);
    }
  });

  $('#btn-sync-prices').addEventListener('click', async () => {
    const provider = $('#price-provider').value || undefined;
    const data = await syncPost(
      '/api/sync/prices',
      { provider },
      $('#live-price-result'),
      (d) =>
        `已同步 ${d.provider} 價格：${d.liveTickers}/${d.tickers} 檔取得真實資料，更新於 ${new Date(d.fetchedAt).toLocaleTimeString('zh-TW')}。` +
        (d.filledWithSynthetic && d.filledWithSynthetic.length
          ? `（${d.filledWithSynthetic.join('、')} 以模擬序列補齊）`
          : '')
    );
    if (data) await boot();
  });

  $('#btn-reset-prices').addEventListener('click', async () => {
    await apiFetch('sync/prices/reset', { method: 'POST' });
    await boot();
  });

  $('#btn-sync-news').addEventListener('click', async () => {
    const query = $('#n-query').value.trim() || 'Trump stock purchase disclosure';
    const data = await syncPost('/api/sync/news', { query }, $('#live-news'), (d) => `已更新 ${d.items.length} 則即時快訊。`);
    if (data) {
      state.news = data;
      renderNewsFeed();
    }
  });

  $('#btn-sync-policy').addEventListener('click', async () => {
    const term = $('#p-term').value.trim() || 'tariff';
    const data = await syncPost('/api/sync/policy', { term }, $('#live-policy'), (d) => `已更新 ${d.items.length} 份政策文件。`);
    if (data) {
      state.frFeed = data;
      renderPolicyFeed();
    }
  });

  $('#btn-sync-contracts').addEventListener('click', async () => {
    const data = await syncPost('/api/sync/contracts', { days: 30 }, $('#live-contracts'), (d) => `已更新 ${d.items.length} 筆合約。`);
    if (data) {
      state.contracts = data;
      renderContractsFeed();
    }
  });

  $('#btn-sync-disclosures').addEventListener('click', async () => {
    const url = $('#d-url').value.trim();
    if (!url) {
      showResult($('#live-disclosure-result'), '<p class="err">請先填入端點 URL。</p>');
      return;
    }
    const data = await syncPost(
      '/api/sync/disclosures',
      { url, apiKey: $('#d-key').value.trim() || undefined, mode: $('#d-mode').value },
      $('#live-disclosure-result'),
      (d) => `匯入成功：${d.accepted} 筆（略過 ${d.rejected} 筆），目前資料集 ${d.tradeCount} 筆 / ${d.tickerCount} 檔。`
    );
    if (data) {
      await boot();
    }
  });
}

/* ------------------------------ 初始化 ------------------------------ */

renderWeightSliders();
renderPortfolioSliders();
renderBacktestSliders();
bindEvents();
boot();
