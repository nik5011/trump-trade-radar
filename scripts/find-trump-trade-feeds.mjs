/* 尋找「已解析好的特朗普交易資料」的機器可讀來源 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function get(url, opts = {}) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*', ...(opts.headers || {}) },
      signal: AbortSignal.timeout(30000),
    });
    const body = await res.text();
    return { url, status: res.status, ok: res.ok, body, type: res.headers.get('content-type') || '' };
  } catch (err) {
    return { url, status: 0, ok: false, error: err.message, body: '' };
  }
}

console.log('\n[1] GitHub 上是否已有人把 OGE 申報整理成資料集');
console.log('='.repeat(96));
for (const q of ['trump+stock+trades', 'oge+278+disclosure+scraper', 'presidential+financial+disclosure+data', 'trump+portfolio+tracker']) {
  const r = await get(`https://api.github.com/search/repositories?q=${q}&sort=updated&per_page=5`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!r.ok) {
    console.log(`  「${q}」→ HTTP ${r.status}`);
    continue;
  }
  const json = JSON.parse(r.body);
  console.log(`\n  「${q.replace(/\+/g, ' ')}」→ ${json.total_count} 個倉庫`);
  for (const item of (json.items || []).slice(0, 5)) {
    console.log(`    ★${String(item.stargazers_count).padStart(4)}  ${item.full_name}  (更新 ${item.updated_at.slice(0, 10)})`);
    if (item.description) console.log(`           ${item.description.slice(0, 110)}`);
  }
}

console.log('\n[2] Quiver Quantitative 的特朗普交易頁面與內部資料端點');
console.log('='.repeat(96));
const home = await get('https://www.quiverquant.com/');
if (home.ok) {
  const links = [...new Set([...home.body.matchAll(/href="([^"]+)"/g)].map((m) => m[1]))];
  const trumpLinks = links.filter((h) => /trump/i.test(h));
  console.log(`  首頁 ${home.body.length} bytes，含 trump 的連結 ${trumpLinks.length} 個`);
  for (const l of trumpLinks.slice(0, 10)) console.log(`    ${l}`);
  const apiHints = [...new Set([...home.body.matchAll(/https?:\/\/[a-z0-9.-]*(?:api|quiver)[a-z0-9.\-/]*/gi)].map((m) => m[0]))];
  console.log('  API 相關字串：');
  for (const h of apiHints.slice(0, 10)) console.log(`    ${h}`);
}

for (const url of [
  'https://www.quiverquant.com/trumptrades/',
  'https://www.quiverquant.com/live/trumptrades',
  'https://www.quiverquant.com/live/politician/Trump',
  'https://api.quiverquant.com/beta/live/trumptrades',
]) {
  const r = await get(url);
  console.log(`  ${r.ok ? '可  ' : '不可'} ${String(r.status).padEnd(4)} ${url}  ${r.ok ? r.body.length + ' bytes' : ''}`);
}

console.log('\n[3] Unusual Whales 政治頁內的資料端點線索');
console.log('='.repeat(96));
const uw = await get('https://unusualwhales.com/politics');
if (uw.ok) {
  const apis = [...new Set([...uw.body.matchAll(/https?:\/\/[a-z0-9.-]*unusualwhales[a-z0-9.\-/]*/gi)].map((m) => m[0]))];
  console.log(`  頁面 ${uw.body.length} bytes`);
  for (const a of apis.slice(0, 12)) console.log(`    ${a}`);
  const nextData = uw.body.includes('__NEXT_DATA__') ? '有 __NEXT_DATA__' : '無 __NEXT_DATA__';
  const trumpMentions = (uw.body.match(/trump/gi) || []).length;
  console.log(`  ${nextData}，頁面出現 "trump" ${trumpMentions} 次`);
}

console.log('\n[4] Capitol Trades（帶瀏覽器標頭重試）');
console.log('='.repeat(96));
for (const url of [
  'https://bff.capitoltrades.com/trades?page=1&pageSize=5',
  'https://www.capitoltrades.com/trades',
]) {
  const r = await get(url, {
    headers: {
      Origin: 'https://www.capitoltrades.com',
      Referer: 'https://www.capitoltrades.com/',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  console.log(`  ${r.ok ? '可  ' : '不可'} ${String(r.status).padEnd(4)} ${url}  ${r.ok ? r.body.length + ' bytes' : ''}`);
  if (r.ok) console.log(`      preview: ${r.body.slice(0, 160)}`);
}

console.log('\n[5] 其他可能的特朗普交易追蹤站');
console.log('='.repeat(96));
for (const url of [
  'https://trumptrades.com/',
  'https://www.trumptrades.org/',
  'https://trumpstocktrades.com/',
  'https://www.tracktrumptrades.com/',
  'https://trumpportfolio.com/',
]) {
  const r = await get(url, { headers: { Accept: 'text/html' } });
  console.log(`  ${r.ok ? '可  ' : '不可'} ${String(r.status).padEnd(4)} ${url}  ${r.ok ? r.body.length + ' bytes' : r.error || ''}`);
}
console.log('');
