// 对外的访问入口页（根域名）。列出所有托管中的项目，并给出管理后台的入口。
//
// 这里选择在 Worker 里直接渲染 HTML，而不是放一个静态页 + 前端 fetch：
// 反正 run_worker_first 下取静态资源同样要占用一次 Worker 请求，
// 服务端渲染省掉一次取数据的请求、不依赖 JS、首屏也没有空白闪烁。
//
// CSS 直接内联在页面里，同样是为了省掉一个 CSS 请求（请求数是最先撞到的免费额度）。
// 访客浏览器的缓存交给 max-age，不额外做边缘缓存 —— 入口页的内容随项目列表变化，
// 而缓存键要包含列表摘要才能正确失效，那还不如每次直接渲染来得简单可靠。

import { escapeHtml } from './util.js';

const MAX_PROJECTS = 200;

export async function serveLanding(request, env, ctx) {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }

  let projects = [];
  let dbError = null;
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, title, file_count, total_bytes, created_at, updated_at
         FROM projects
        WHERE status = 'ready'
        ORDER BY created_at DESC
        LIMIT ?`
    ).bind(MAX_PROJECTS).all();
    projects = (results || []).map((row) => ({
      id: row.id,
      title: row.title || row.id,
      fileCount: Number(row.file_count) || 0,
      totalBytes: Number(row.total_bytes) || 0,
      createdAt: Number(row.created_at) || 0,
    }));
  } catch (err) {
    // 首次部署还没建表时，入口页给一个空状态比直接 500 好得多
    dbError = err?.message || String(err);
  }

  const html = renderPage(env, request, projects, dbError);

  return new Response(method === 'HEAD' ? null : html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

function siteUrl(request, env, hostPrefix) {
  const url = new URL(request.url);
  const domain = env.ROOT_DOMAIN || url.hostname;
  const host = hostPrefix ? `${hostPrefix}.${domain}` : domain;
  const port = url.port ? `:${url.port}` : '';
  return `${url.protocol}//${host}${port}/`;
}

function renderPage(env, request, projects, dbError) {
  const title = env.SITE_TITLE || '我的网页收藏';
  const description =
    env.SITE_DESCRIPTION || '这里托管着我收集的静态页面，点开任意一个都能直接浏览。';
  const adminUrl = siteUrl(request, env, env.ADMIN_SUBDOMAIN || 'admin');

  const totalFiles = projects.reduce((sum, p) => sum + p.fileCount, 0);
  const totalBytes = projects.reduce((sum, p) => sum + p.totalBytes, 0);
  const latest = projects.reduce((max, p) => Math.max(max, p.createdAt), 0);

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="theme-color" content="#08090d">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="website">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%236366f1'/%3E%3Cpath d='M16 6.5l7.5 4.3v8.4L16 23.5l-7.5-4.3v-8.4L16 6.5z' fill='none' stroke='white' stroke-width='2.2' stroke-linejoin='round'/%3E%3C/svg%3E">
<style>${STYLES}</style>
</head>
<body>
<div class="aurora" aria-hidden="true"></div>

<header class="topbar">
  <a class="brand" href="/">
    <span class="brand-mark" aria-hidden="true"></span>
    <span class="brand-name">${escapeHtml(title)}</span>
  </a>
  <a class="admin-link" href="${escapeHtml(adminUrl)}">
    <span class="dot" aria-hidden="true"></span>
    管理后台
    <span class="arrow" aria-hidden="true">&#8594;</span>
  </a>
</header>

<main>
  <section class="hero">
    <p class="eyebrow">静态页面托管</p>
    <h1>${escapeHtml(title)}</h1>
    <p class="lede">${escapeHtml(description)}</p>

    <div class="stats">
      <div class="stat">
        <b>${projects.length}</b>
        <span>个页面</span>
      </div>
      <div class="stat">
        <b>${formatInt(totalFiles)}</b>
        <span>个文件</span>
      </div>
      <div class="stat">
        <b>${formatBytes(totalBytes)}</b>
        <span>总大小</span>
      </div>
      ${latest ? `<div class="stat"><b>${formatDate(latest)}</b><span>最近添加</span></div>` : ''}
    </div>
  </section>

  ${dbError ? renderNotice(dbError) : ''}

  ${
    projects.length
      ? `<section class="collection">
    <div class="collection-head">
      <h2>全部页面<span class="count">${projects.length}</span></h2>
      <label class="search">
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        <input id="filter" type="search" placeholder="搜索标题或地址…" autocomplete="off" spellcheck="false" aria-label="搜索页面">
      </label>
    </div>
    <div class="grid" id="grid">
${projects.map((p, i) => renderCard(p, request, env, i)).join('\n')}
    </div>
    <p class="no-match" id="noMatch" hidden>没有匹配的页面。</p>
  </section>`
      : `<section class="empty">
    <div class="empty-mark" aria-hidden="true"></div>
    <h2>还没有托管任何页面</h2>
    <p>${dbError ? '数据库里还没有数据表，先按 README 执行一次建表。' : '从管理后台上传一个 ZIP 或单个 HTML 文件，它就会出现在这里。'}</p>
    <a class="button" href="${escapeHtml(adminUrl)}">前往管理后台上传</a>
  </section>`
  }
</main>

<footer>
  <span>由 Cloudflare Workers + R2 驱动</span>
  <span class="sep" aria-hidden="true">·</span>
  <a href="${escapeHtml(adminUrl)}">管理后台</a>
</footer>

<script>${SCRIPT}</script>
</body>
</html>`;
}

function renderCard(project, request, env, index = 0) {
  const url = siteUrl(request, env, project.id);
  const initial = escapeHtml(String(project.title).trim().charAt(0).toUpperCase() || '#');
  const hue = hueOf(project.id);
  const search = escapeHtml(`${project.title} ${project.id}`.toLowerCase());

  return `      <a class="card" href="${escapeHtml(url)}" data-search="${search}" style="--i:${index}">
        <span class="avatar" style="--h:${hue}" aria-hidden="true">${initial}</span>
        <span class="card-body">
          <strong>${escapeHtml(project.title)}</strong>
          <span class="host">${escapeHtml(project.id)}.${escapeHtml(env.ROOT_DOMAIN || '')}</span>
          <span class="meta">${formatInt(project.fileCount)} 个文件 · ${formatBytes(project.totalBytes)}</span>
        </span>
        <span class="go" aria-hidden="true">&#8594;</span>
      </a>`;
}

function renderNotice(message) {
  return `  <div class="notice">
    <b>数据库暂时读不到项目列表</b>
    <span>${escapeHtml(message)}</span>
  </div>`;
}

/** 和后台界面一致的哈希取色，让同一个项目在两处有一致的视觉标识。 */
function hueOf(id) {
  let hash = 0;
  for (const ch of String(id)) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return hash;
}

function formatInt(n) {
  return (Number(n) || 0).toLocaleString('zh-CN');
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

function formatDate(timestamp) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

// 下面两个常量被上面的 renderPage 引用。const 在模块作用域里有暂时性死区，
// 但 renderPage 只会在模块求值完成后（收到请求时）被调用，所以是安全的；
// 把它们放在页面模板下方纯粹是为了让逻辑先读、样式后翻。

// 内联脚本里刻意不用模板字符串，免得和外层的模板字符串打架。
const SCRIPT = `
(function () {
  var input = document.getElementById('filter');
  if (!input) return;
  var cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
  var noMatch = document.getElementById('noMatch');

  function apply() {
    var q = input.value.trim().toLowerCase();
    var shown = 0;
    for (var i = 0; i < cards.length; i++) {
      var hit = !q || cards[i].getAttribute('data-search').indexOf(q) !== -1;
      cards[i].hidden = !hit;
      if (hit) shown++;
    }
    if (noMatch) noMatch.hidden = shown > 0;
  }

  input.addEventListener('input', apply);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { input.value = ''; apply(); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement !== input) { e.preventDefault(); input.focus(); }
  });
})();
`;

const STYLES = `
:root {
  color-scheme: dark;
  --bg: #08090d;
  --panel: rgba(255, 255, 255, 0.028);
  --panel-hi: rgba(255, 255, 255, 0.055);
  --border: rgba(255, 255, 255, 0.085);
  --border-hi: rgba(255, 255, 255, 0.16);
  --text: #eef0f6;
  --muted: #949db0;
  --faint: #6b7488;
  --accent: #6366f1;
  --accent-hi: #a5b4fc;
  --cyan: #22d3ee;
  --radius: 16px;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.65 system-ui, -apple-system, "Segoe UI", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
  -webkit-font-smoothing: antialiased;
  display: flex;
  flex-direction: column;
  overflow-x: hidden;
}
/* 背景光晕：两团径向渐变，纯装饰 */
.aurora {
  position: fixed;
  inset: -20% -10% auto -10%;
  height: 78vh;
  pointer-events: none;
  z-index: 0;
  background:
    radial-gradient(58% 60% at 18% 8%, rgba(99, 102, 241, 0.20), transparent 62%),
    radial-gradient(46% 52% at 84% 0%, rgba(34, 211, 238, 0.13), transparent 60%);
  filter: blur(6px);
}
a { color: inherit; text-decoration: none; }
:focus-visible { outline: 2px solid var(--accent-hi); outline-offset: 3px; border-radius: 8px; }

/* ---------------------------------------------------------------- 顶栏 */
.topbar {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 15px clamp(18px, 5vw, 44px);
  background: rgba(8, 9, 13, 0.72);
  backdrop-filter: saturate(150%) blur(14px);
  border-bottom: 1px solid rgba(255, 255, 255, 0.055);
}
.brand { display: flex; align-items: center; gap: 11px; min-width: 0; }
.brand-mark {
  flex: 0 0 auto;
  width: 27px; height: 27px; border-radius: 9px;
  background: linear-gradient(140deg, var(--accent), var(--cyan));
  box-shadow: 0 6px 18px -6px rgba(99, 102, 241, 0.85);
}
.brand-name {
  font-weight: 600; font-size: 15px; letter-spacing: 0.01em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.admin-link {
  flex: 0 0 auto;
  display: inline-flex; align-items: center; gap: 8px;
  padding: 8px 15px;
  font-size: 13.5px;
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel);
  transition: color .18s, border-color .18s, background .18s;
}
.admin-link:hover { color: var(--text); border-color: var(--border-hi); background: var(--panel-hi); }
.admin-link .dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: #34d399;
  box-shadow: 0 0 0 3px rgba(52, 211, 153, 0.16);
}
.admin-link .arrow { transition: transform .18s; }
.admin-link:hover .arrow { transform: translateX(3px); }

/* ---------------------------------------------------------------- 主体 */
main {
  position: relative; z-index: 1;
  flex: 1;
  width: 100%;
  max-width: 1080px;
  margin: 0 auto;
  padding: clamp(52px, 8.5vw, 92px) clamp(18px, 5vw, 44px) 64px;
}
/* 居中英雄区：左对齐时右侧会空出一大片，居中后版面才稳。
   下面那条渐隐细线是给英雄区收口用的，让列表区和标题区有明确分界。 */
.hero { max-width: 700px; margin: 0 auto; text-align: center; }
.hero::after {
  content: "";
  display: block;
  width: min(100%, 460px);
  height: 1px;
  margin: clamp(38px, 5vw, 52px) auto 0;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.16), transparent);
}
.eyebrow {
  margin: 0 0 18px;
  font-size: 12.5px; font-weight: 500; letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--accent-hi);
}
.hero h1 {
  margin: 0 0 16px;
  font-size: clamp(33px, 6.6vw, 56px);
  line-height: 1.13;
  letter-spacing: -0.024em;
  font-weight: 700;
  text-wrap: balance;
  background: linear-gradient(112deg, #ffffff 6%, #c7cbf7 40%, var(--accent-hi) 72%, var(--cyan) 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}
/* 中文的 ch 比实际字宽窄，用 ch 限制宽度会让末字单独折行。
   这里用 px 限宽，再让浏览器把孤字处理掉（不支持 text-wrap 的浏览器只是差一点观感）。 */
.lede {
  margin: 0 auto;
  font-size: clamp(15px, 2.1vw, 17.5px);
  color: var(--muted);
  max-width: 560px;
  text-wrap: pretty;
}

.stats { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; margin-top: 34px; }
.stat {
  display: flex; align-items: baseline; gap: 7px;
  padding: 9px 15px;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: var(--panel);
}
.stat b {
  font-size: 16.5px; font-weight: 650; font-variant-numeric: tabular-nums;
  background: linear-gradient(160deg, #ffffff, #b9c0f5);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
}
.stat span { font-size: 12.5px; color: var(--faint); }

/* ---------------------------------------------------------------- 列表 */
.collection { margin-top: clamp(34px, 4.5vw, 46px); }
.collection-head {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}
.collection-head h2 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: 0.01em; }
.collection-head .count {
  margin-left: 9px; font-weight: 400; font-variant-numeric: tabular-nums; color: var(--faint);
}
.search {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 8px 13px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: rgba(9, 10, 14, 0.7);
  color: var(--faint);
  transition: border-color .18s;
}
.search:focus-within { border-color: var(--accent); }
.search svg { width: 14px; height: 14px; flex: 0 0 auto; }
.search input {
  width: clamp(120px, 30vw, 208px);
  border: 0; background: none; outline: none;
  color: var(--text); font: inherit; font-size: 14px;
}
.search input::placeholder { color: var(--faint); }
.search input::-webkit-search-cancel-button { -webkit-appearance: none; }

.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(288px, 1fr)); gap: 15px; }

@keyframes rise {
  from { opacity: 0; transform: translateY(9px); }
  to { opacity: 1; transform: none; }
}

.card {
  position: relative;
  display: flex; align-items: center; gap: 14px;
  padding: 17px 18px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.045), rgba(255, 255, 255, 0.012));
  overflow: hidden;
  /* 依次浮现，最多等 300ms，项目多了也不会拖很久。
     backwards 而不是 forwards：动画结束后交还给普通样式，不影响悬停位移。 */
  animation: rise .5s cubic-bezier(.22, .68, .32, 1) backwards;
  animation-delay: min(calc(var(--i, 0) * 30ms), 300ms);
  transition: border-color .2s, transform .2s, background .2s, box-shadow .2s;
}
/* 悬停时从左侧渗出来的品牌色 */
.card::before {
  content: "";
  position: absolute; inset: 0 auto 0 0;
  width: 3px;
  background: linear-gradient(180deg, var(--accent), var(--cyan));
  opacity: 0; transition: opacity .2s;
}
.card:hover {
  border-color: var(--border-hi);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.075), rgba(255, 255, 255, 0.025));
  transform: translateY(-2px);
  box-shadow: 0 20px 40px -28px rgba(0, 0, 0, 0.95);
}
.card:hover::before { opacity: 1; }
.card[hidden] { display: none; }

.avatar {
  flex: 0 0 auto;
  width: 42px; height: 42px;
  border-radius: 12px;
  display: grid; place-items: center;
  font-size: 17px; font-weight: 650; color: #fff;
  background: linear-gradient(140deg, hsl(var(--h) 64% 55%), hsl(calc(var(--h) + 46) 68% 46%));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.22);
}
.card-body { min-width: 0; display: grid; gap: 2px; }
.card-body strong {
  font-size: 14.5px; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.host {
  font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--accent-hi);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.meta { font-size: 12px; color: var(--faint); font-variant-numeric: tabular-nums; }
.go {
  margin-left: auto; flex: 0 0 auto;
  color: var(--faint); font-size: 15px;
  opacity: 0; transform: translateX(-4px);
  transition: opacity .2s, transform .2s, color .2s;
}
.card:hover .go { opacity: 1; transform: translateX(0); color: var(--accent-hi); }

.no-match { margin: 26px 0 0; color: var(--faint); font-size: 14px; }

/* ---------------------------------------------------------------- 空状态 / 提示 */
.empty {
  margin-top: clamp(48px, 8vw, 72px);
  padding: clamp(34px, 6vw, 54px) 28px;
  text-align: center;
  border: 1px dashed var(--border);
  border-radius: 20px;
  background: var(--panel);
}
.empty-mark {
  width: 46px; height: 46px; margin: 0 auto 18px;
  border-radius: 14px;
  background: linear-gradient(140deg, var(--accent), var(--cyan));
  opacity: .85;
}
.empty h2 { margin: 0 0 8px; font-size: 17px; font-weight: 600; }
/* 同 .lede：中文用 ch 限宽会孤字折行，改用 px 并交给浏览器处理孤字 */
.empty p { margin: 0 auto 22px; color: var(--muted); font-size: 14.5px; max-width: 460px; text-wrap: pretty; }
.button {
  display: inline-block;
  padding: 11px 22px;
  border-radius: 11px;
  font-size: 14px; font-weight: 500;
  color: #fff;
  background: linear-gradient(180deg, var(--accent-hi), var(--accent));
  box-shadow: 0 14px 30px -16px rgba(99, 102, 241, 0.95);
  transition: filter .18s, transform .12s;
}
.button:hover { filter: brightness(1.08); }
.button:active { transform: translateY(1px); }

.notice {
  display: grid; gap: 4px;
  margin-top: 34px; padding: 14px 17px;
  border: 1px solid rgba(251, 191, 36, 0.28);
  border-left: 3px solid #fbbf24;
  border-radius: 11px;
  background: rgba(251, 191, 36, 0.05);
  font-size: 13.5px;
}
.notice b { font-weight: 600; }
.notice span { color: var(--muted); font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }

/* ---------------------------------------------------------------- 页脚 */
footer {
  position: relative; z-index: 1;
  display: flex; align-items: center; justify-content: center; gap: 10px;
  flex-wrap: wrap;
  padding: 26px clamp(18px, 5vw, 44px) 34px;
  border-top: 1px solid rgba(255, 255, 255, 0.055);
  color: var(--faint);
  font-size: 13px;
}
footer a { color: var(--muted); border-bottom: 1px solid transparent; transition: color .18s, border-color .18s; }
footer a:hover { color: var(--text); border-bottom-color: var(--border-hi); }
.sep { opacity: .5; }

@media (max-width: 560px) {
  .brand-name { font-size: 14px; }
  .admin-link { padding: 7px 12px; font-size: 13px; }
  .grid { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
  .card:hover { transform: none; }
}
`;
