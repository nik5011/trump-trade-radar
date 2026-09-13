/* ============================================================================
   SEC Form 4 內部人交易分析

   為什麼這比申報交易有用：Form 4 必須在交易後 2 個營業日內申報，
   幾乎沒有延遲，而且是「本人用真金白銀下單」的直接證據。

   交易代碼（只列常用的）：
     P = 公開市場買進（唯一真正的看多訊號）
     S = 公開市場賣出（雜訊大：多半是既定的分散或 10b5-1 計畫）
     A = 授予、M = 行使選擇權、F = 稅務扣繳、G = 贈與 → 屬於薪酬流程，不是訊號

   因此分數只用「買進」計算；賣出只作為背景資訊呈現（研究文獻普遍認為
   內部人賣出的預測力很弱，買進尤其是集群買進才有意義）。
   ========================================================================== */

export const TRANSACTION_CODES = {
  P: { label: '公開市場買進', kind: 'buy', bullish: true },
  S: { label: '公開市場賣出', kind: 'sell', bullish: false },
  A: { label: '股票授予', kind: 'grant', bullish: null },
  M: { label: '行使選擇權', kind: 'grant', bullish: null },
  F: { label: '稅務扣繳', kind: 'grant', bullish: null },
  G: { label: '贈與', kind: 'grant', bullish: null },
  C: { label: '轉換', kind: 'grant', bullish: null },
  I: { label: '間接持有（裁量）', kind: 'grant', bullish: null },
  D: { label: '處分', kind: 'sell', bullish: false },
  E: { label: '到期', kind: 'grant', bullish: null },
  J: { label: '其他取得', kind: 'grant', bullish: null },
};

const SENIOR_ROLE = /(chief|ceo|cfo|coo|cto|chairman|chair|president|founder)/i;

export function roleOf(owner) {
  const title = (owner.officerTitle || '').trim();
  if (owner.isTenPercentOwner) return { id: 'tenPercent', label: '10% 股東', weight: 0.7 };
  if (SENIOR_ROLE.test(title)) return { id: 'executive', label: title || '高階主管', weight: 1 };
  if (owner.isOfficer) return { id: 'officer', label: title || '主管', weight: 0.8 };
  if (owner.isDirector) return { id: 'director', label: '董事', weight: 0.6 };
  return { id: 'other', label: '其他', weight: 0.4 };
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

/* 把 Form 4 的原始交易攤平成統一格式 */
export function flattenForm4(parsed, filing) {
  const role = roleOf(parsed);
  return (parsed.transactions || []).map((t) => ({
    ticker: parsed.ticker,
    issuerCik: parsed.issuerCik,
    issuerName: parsed.issuerName,
    ownerName: parsed.ownerName,
    ownerRole: role.id,
    ownerRoleLabel: role.label,
    roleWeight: role.weight,
    isDirector: parsed.isDirector,
    isOfficer: parsed.isOfficer,
    isTenPercentOwner: parsed.isTenPercentOwner,
    officerTitle: parsed.officerTitle || '',
    date: t.date,
    filedDate: filing ? filing.filedDate : null,
    code: t.code,
    codeLabel: (TRANSACTION_CODES[t.code] || {}).label || `代碼 ${t.code}`,
    kind: (TRANSACTION_CODES[t.code] || {}).kind || 'other',
    shares: t.shares,
    price: t.price,
    value: t.value,
    plan: t.plan,
    sharesAfter: t.sharesAfter,
    direct: t.direct,
    accession: filing ? filing.accession : null,
  }));
}

/* 依 ticker 彙總（只看最近 windowDays 天） */
export function summarizeInsiders(transactions, opts = {}) {
  const { asOf, windowDays = 90, clusterWindowDays = 30 } = opts;
  const byTicker = new Map();
  for (const t of transactions) {
    if (!t.ticker || !t.date) continue;
    if (asOf && t.date > asOf) continue;
    if (asOf && daysBetween(t.date, asOf) > windowDays) continue;
    const list = byTicker.get(t.ticker);
    if (list) list.push(t);
    else byTicker.set(t.ticker, [t]);
  }

  const rows = [];
  for (const [ticker, list] of byTicker) {
    const buys = list.filter((t) => t.code === 'P');
    const sells = list.filter((t) => t.code === 'S' || t.code === 'D');
    const grants = list.filter((t) => (TRANSACTION_CODES[t.code] || {}).kind === 'grant');

    const buyValue = buys.reduce((a, t) => a + (t.value || 0), 0);
    const sellValue = sells.reduce((a, t) => a + (t.value || 0), 0);
    const buyers = [...new Set(buys.map((t) => t.ownerName))];
    const sellers = [...new Set(sells.map((t) => t.ownerName))];

    /* 集群買進：clusterWindowDays 內有幾位不同的內部人買進 */
    const buyDates = buys.map((t) => ({ date: t.date, owner: t.ownerName })).sort((a, b) => (a.date < b.date ? -1 : 1));
    let cluster = 0;
    for (let i = 0; i < buyDates.length; i++) {
      const owners = new Set();
      for (let j = i; j < buyDates.length; j++) {
        if (daysBetween(buyDates[i].date, buyDates[j].date) > clusterWindowDays) break;
        owners.add(buyDates[j].owner);
      }
      cluster = Math.max(cluster, owners.size);
    }

    const bestBuyerWeight = buys.reduce((a, t) => Math.max(a, t.roleWeight || 0), 0);
    const clusterScore = clamp01(cluster / 3);
    const valueScore = clamp01(Math.log10(1 + buyValue / 100000) / 3);
    const roleScore = bestBuyerWeight;
    const score = Math.round(100 * (0.45 * clusterScore + 0.35 * valueScore + 0.2 * roleScore) * 10) / 10;

    const flags = [];
    if (cluster >= 2) flags.push({ level: 'good', text: `${clusterWindowDays} 天內有 ${cluster} 位內部人買進（集群買進）` });
    if (buys.some((t) => SENIOR_ROLE.test(t.officerTitle || ''))) {
      flags.push({ level: 'good', text: `高階主管買進：${buys.find((t) => SENIOR_ROLE.test(t.officerTitle || '')).officerTitle}` });
    }
    if (buyValue >= 1_000_000) flags.push({ level: 'good', text: `買進金額達 $${(buyValue / 1e6).toFixed(2)}M` });
    if (!buys.length && sells.length) flags.push({ level: 'info', text: `近 ${windowDays} 天只有賣出紀錄（${sellers.length} 位）` });
    if (!buys.length && !sells.length && grants.length) flags.push({ level: 'info', text: '只有薪酬相關紀錄（授予／稅務），沒有實質買賣' });

    rows.push({
      ticker,
      issuerName: list[0].issuerName,
      transactionCount: list.length,
      buyCount: buys.length,
      buyValue,
      buyerCount: buyers.length,
      sellCount: sells.length,
      sellValue,
      sellerCount: sellers.length,
      netValue: buyValue - sellValue,
      cluster,
      lastBuyDate: buys.length ? buys.map((t) => t.date).sort().slice(-1)[0] : null,
      lastSellDate: sells.length ? sells.map((t) => t.date).sort().slice(-1)[0] : null,
      score,
      flags,
    });
  }
  rows.sort((a, b) => b.score - a.score || b.buyValue - a.buyValue);
  return rows;
}

/* 最近的交易明細（給前端表格用） */
export function recentTransactions(transactions, opts = {}) {
  const { asOf, limit = 200, windowDays = 90, onlyMeaningful = false, codes = null } = opts;
  return transactions
    .filter((t) => {
      if (!t.date) return false;
      if (asOf && daysBetween(t.date, asOf) > windowDays) return false;
      if (onlyMeaningful && t.code !== 'P' && t.code !== 'S') return false;
      if (codes && !codes.includes(t.code)) return false;
      return true;
    })
    /* 先過濾再取前 N 筆：否則較早發生的買進會被後面的賣出洗掉 */
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, limit);
}
