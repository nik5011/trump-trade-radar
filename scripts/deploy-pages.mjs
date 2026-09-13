/* ============================================================================
   一鍵部署到 GitHub Pages（含每日自動更新）

   前置：需要一個 GitHub Personal Access Token
     方式 A（建議，權限最小）：Fine-grained token
        → 權限：Contents: Read and write、Workflows: Read and write、Pages: Read and write
        → 帳號層級另需允許建立 repository（或在下方先自己建好空 repo）
     方式 B：Classic token，勾選 repo 與 workflow 兩個 scope

   用法：
     set GITHUB_TOKEN=ghp_xxx          (PowerShell: $env:GITHUB_TOKEN="ghp_xxx")
     node scripts/deploy-pages.mjs --repo trump-trade-radar

   這個腳本會：建立 repo（若不存在）→ 推送程式 → 開啟 Pages（用 GitHub Actions 建置）
   → 觸發一次部署 → 印出你的網站網址。
   ========================================================================== */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pushViaApi } from './push-via-api.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

/* 取得 token 的三種方式（優先順序）：
   1) --token-file 指定的檔案（最安全：不必貼在對話或指令列）
   2) 環境變數 GITHUB_TOKEN / GH_TOKEN
   3) --token 參數（會留在 shell 歷史，不建議） */
const tokenFile = argOf('--token-file');
const fileToken = tokenFile && fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : null;
const TOKEN = fileToken || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || argOf('--token');
const REPO_NAME = argOf('--repo', 'trump-trade-radar');
const PRIVATE = args.includes('--private');
/* 這個沙箱不允許 Node 啟動子程序（spawn EPERM），所以 git 推送可以改由外部執行，
   加上 --skip-git 只做 GitHub API 的部分（啟用 Pages、觸發部署）。 */
const SKIP_GIT = args.includes('--skip-git');
/* 沒有完整 git（例如缺少 git-remote-https）或沙箱禁止啟動子程序時，
   改用 GitHub REST API 推送。 */
const VIA_API = args.includes('--via-api');

if (!TOKEN) {
  console.error('缺少 GitHub token。三種提供方式（任選一種）：');
  console.error('  A) 存成檔案後執行：node scripts/deploy-pages.mjs --token-file data/github-token.txt');
  console.error('  B) 設定環境變數：     $env:GITHUB_TOKEN="github_pat_xxx"; node scripts/deploy-pages.mjs');
  console.error('  C) 直接帶參數（不建議，會留在指令紀錄）：--token github_pat_xxx');
  process.exit(1);
}

/* 這個環境的代理設定會擋住 git，且 Windows schannel 在此無法取得憑證，
   所以 git 指令一律清掉代理並改用 OpenSSL 後端。 */
/* 這個工作區的 .git 目錄是唯讀的，所以另外用一個可寫的目錄當 git 倉庫 */
const GIT_DIR = path.join(ROOT, '.git-local');
const gitEnv = {
  ...process.env,
  GIT_DIR,
  GIT_WORK_TREE: ROOT,
  HTTP_PROXY: '',
  HTTPS_PROXY: '',
  ALL_PROXY: '',
  GIT_HTTP_PROXY: '',
  GIT_HTTPS_PROXY: '',
  GIT_TERMINAL_PROMPT: '0',
};
const git = (gitArgs, opts = {}) =>
  execFileSync('git', ['-c', 'http.sslBackend=openssl', ...gitArgs], {
    cwd: ROOT,
    env: gitEnv,
    encoding: 'utf8',
    stdio: opts.quiet ? 'pipe' : 'inherit',
  });

async function api(pathname, init = {}) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
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
}

const step = (msg) => console.log(`\n▶ ${msg}`);

/* 1. 確認身份 */
step('確認 GitHub 身份');
const me = await api('/user');
if (!me.ok) {
  console.error('  ✗ Token 無效：', me.json && me.json.message);
  process.exit(1);
}
const owner = me.json.login;
console.log(`  ✓ 已登入：${owner}`);

/* 2. 建立 repo（若已存在就沿用） */
step(`確認 repository：${owner}/${REPO_NAME}`);
let repoInfo = await api(`/repos/${owner}/${REPO_NAME}`);
if (!repoInfo.ok) {
  const created = await api('/user/repos', {
    method: 'POST',
    body: JSON.stringify({
      name: REPO_NAME,
      description: '特朗普申報交易 × 政策 × 內部人交易的訊號分析儀表板（每日自動更新）',
      private: PRIVATE,
      has_issues: false,
      has_wiki: false,
      auto_init: false,
    }),
  });
  if (!created.ok) {
    console.error('  ✗ 建立失敗：', created.json && created.json.message);
    console.error('    若是權限問題，請改用有 repo 建立權限的 token，或先手動建立空 repo。');
    process.exit(1);
  }
  repoInfo = created;
  console.log('  ✓ 已建立新的 repository');
} else {
  console.log('  ✓ repository 已存在，將更新內容');
}

if (VIA_API) {
  step('用 GitHub REST API 推送檔案');
  const result = await pushViaApi({
    root: ROOT,
    owner,
    repo: REPO_NAME,
    token: TOKEN,
    branch: 'main',
    message: 'init: 特朗普交易雷達（含每日自動更新的靜態部署）',
  });
  console.log(`  ✓ 已推送 ${result.files} 個檔案（commit ${result.commit.slice(0, 8)}）`);
} else if (!SKIP_GIT) {
step('建立本機提交');
try {
  git(['rev-parse', '--git-dir'], { quiet: true });
} catch {
  git(['init', '-b', 'main'], { quiet: true });
  console.log('  已初始化 git repository');
}
git(['config', 'user.name', owner], { quiet: true });
git(['config', 'user.email', `${owner}@users.noreply.github.com`], { quiet: true });
git(['add', '-A'], { quiet: true });
try {
  git(['commit', '-m', 'update: 資料與程式更新'], { quiet: true });
  console.log('  已建立提交');
} catch {
  console.log('  沒有需要提交的變更');
}

/* 4. 推送（token 只放在遠端 URL 中，不寫進 .git/config 之外的檔案） */
step('推送到 GitHub');
const remote = `https://x-access-token:${TOKEN}@github.com/${owner}/${REPO_NAME}.git`;
try {
  git(['remote', 'remove', 'origin'], { quiet: true });
} catch {
  /* 沒有 origin 是正常的 */
}
git(['remote', 'add', 'origin', remote], { quiet: true });
git(['push', '-u', 'origin', 'main', '--force']);
git(['remote', 'set-url', 'origin', `https://github.com/${owner}/${REPO_NAME}.git`], { quiet: true });
console.log('  ✓ 已推送');
} else {
  console.log('\n• 已指定 --skip-git：略過 git 提交與推送（改用外部指令完成）');
}

/* 5. 開啟 Pages（用 GitHub Actions 作為建置來源） */
step('開啟 GitHub Pages');
const pages = await api(`/repos/${owner}/${REPO_NAME}/pages`, {
  method: 'POST',
  body: JSON.stringify({ build_type: 'workflow' }),
});
if (pages.ok) {
  console.log('  ✓ 已啟用 Pages（GitHub Actions 建置）');
} else if (pages.status === 409) {
  console.log('  • Pages 已啟用，略過');
} else {
  console.log(`  ! 無法自動啟用（${pages.status}: ${pages.json && pages.json.message}）`);
  console.log(`    請手動到 https://github.com/${owner}/${REPO_NAME}/settings/pages`);
  console.log('    將 Source 設為「GitHub Actions」');
}

/* 6. 觸發一次部署 */
step('觸發第一次資料更新與部署');
await new Promise((r) => setTimeout(r, 3000));
const dispatch = await api(`/repos/${owner}/${REPO_NAME}/actions/workflows/deploy-pages.yml/dispatches`, {
  method: 'POST',
  body: JSON.stringify({ ref: 'main' }),
});
console.log(
  dispatch.status === 204 ? '  ✓ 已觸發（約需 3～6 分鐘完成）' : `  ! 觸發失敗（${dispatch.status}）：請到 Actions 頁面手動執行`
);

console.log('\n────────────────────────────────────────');
console.log(`網站網址（部署完成後生效）：https://${owner}.github.io/${REPO_NAME}/`);
console.log(`Actions 進度：https://github.com/${owner}/${REPO_NAME}/actions`);
console.log('之後每天台北時間 07:30 會自動更新資料並重新部署。');
console.log('────────────────────────────────────────\n');
