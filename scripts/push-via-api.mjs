/* ============================================================================
   用 GitHub REST API 推送檔案（不需要 git）

   為什麼需要這個：某些環境沒有完整的 git（缺少 git-remote-https），
   或沙箱禁止 Node 啟動子程序。Git Data API 可以只用 HTTPS 就完成推送：
     建立 blob → 建立 tree → 建立 commit → 更新 ref
   ========================================================================== */

import fs from 'node:fs/promises';
import path from 'node:path';

/* 與 .gitignore 對應的排除規則（這裡不解析 .gitignore，直接列出） */
export const IGNORED_DIRS = new Set(['.git', '.git-local', 'dist', 'node_modules', 'tmp', '__pycache__']);
export const IGNORED_PATHS = new Set([
  'data/positions.json',
  'data/store.json',
  'data/live-cache.json',
  'data/config.json',
  'data/github-token.txt',
  'data/oge/index.json',
]);
export const IGNORED_PREFIXES = ['data/external/', 'data/oge/'];
export const ALLOW_EXCEPTIONS = new Set(['data/oge/transactions.csv']);

export function isIgnored(rel) {
  if (IGNORED_PATHS.has(rel)) return true;
  if (ALLOW_EXCEPTIONS.has(rel)) return false;
  return IGNORED_PREFIXES.some((p) => rel.startsWith(p));
}

/* 走訪工作目錄，收集要推送的檔案（回傳相對路徑，分隔線一律用 /） */
export async function collectFiles(root, rel = '') {
  const out = [];
  const dir = path.join(root, rel);
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || isIgnored(childRel)) continue;
      out.push(...(await collectFiles(root, childRel)));
    } else {
      if (isIgnored(childRel)) continue;
      out.push(childRel);
    }
  }
  return out;
}

export async function pushViaApi({ root, owner, repo, token, branch = 'main', message, log = console.log }) {
  const api = async (pathname, init = {}) => {
    const res = await fetch(`https://api.github.com${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'trump-trade-radar-deploy',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    return { ok: res.ok, status: res.status, json };
  };

  /* 全新的空倉庫沒辦法直接用 Git Data API 建立 blob（會回 "Git Repository is empty"），
     所以先用 Contents API 建立一個檔案，讓倉庫有第一個 commit。 */
  let bootstrapped = false;
  const emptyCheck = await api(`/repos/${owner}/${repo}/git/ref/heads/${branch}`);
  if (!emptyCheck.ok) {
    const seed = Buffer.from('# trump-trade-radar\n\n特朗普申報交易 × 政策 × 內部人交易的訊號分析儀表板。\n').toString('base64');
    const init = await api(`/repos/${owner}/${repo}/contents/.gitignore`, {
      method: 'PUT',
      body: JSON.stringify({ message: 'chore: 初始化倉庫', content: seed }),
    });
    if (!init.ok) throw new Error(`初始化倉庫失敗：${init.json && init.json.message}`);
    bootstrapped = true;
    log('  已建立初始 commit');
  }

  const files = await collectFiles(root);
  log(`  共 ${files.length} 個檔案要推送`);

  /* 1. 建立 blob（限制同時 6 個，避免打到 API 速率限制） */
  const tree = [];
  let cursor = 0;
  let done = 0;
  const worker = async () => {
    while (cursor < files.length) {
      const rel = files[cursor++];
      const content = await fs.readFile(path.join(root, rel));
      const res = await api(`/repos/${owner}/${repo}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }),
      });
      if (!res.ok) throw new Error(`建立 blob 失敗（${rel}）：${res.json && res.json.message}`);
      tree.push({ path: rel, mode: '100644', type: 'blob', sha: res.json.sha });
      done++;
      if (done % 10 === 0) log(`    已上傳 ${done}/${files.length}`);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
  log(`  ✓ 已上傳 ${tree.length} 個檔案`);

  /* 2. 建立 tree */
  const treeRes = await api(`/repos/${owner}/${repo}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ tree }),
  });
  if (!treeRes.ok) throw new Error(`建立 tree 失敗：${treeRes.json && treeRes.json.message}`);

  /* 3. 取得目前分支的 commit（第一次推送時不存在） */
  const refRes = await api(`/repos/${owner}/${repo}/git/ref/heads/${branch}`);
  const parents = refRes.ok ? [refRes.json.object.sha] : [];

  /* 4. 建立 commit */
  const commitRes = await api(`/repos/${owner}/${repo}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message: message || `update: ${new Date().toISOString()}`,
      tree: treeRes.json.sha,
      parents,
    }),
  });
  if (!commitRes.ok) throw new Error(`建立 commit 失敗：${commitRes.json && commitRes.json.message}`);

  /* 5. 更新或建立 ref */
  if (refRes.ok) {
    const upd = await api(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: commitRes.json.sha, force: true }),
    });
    if (!upd.ok) throw new Error(`更新 ref 失敗：${upd.json && upd.json.message}`);
  } else {
    const created = await api(`/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commitRes.json.sha }),
    });
    if (!created.ok) throw new Error(`建立 ref 失敗：${created.json && created.json.message}`);
  }

  return { files: tree.length, commit: commitRes.json.sha, parents: parents.length, bootstrapped };
}
