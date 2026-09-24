// 静态分发：<项目名>.域名 -> R2 对象 -> 响应。
//
// 缓存分两层，各自解决一个问题：
//   浏览器缓存  Cache-Control: max-age（HTML 60 秒 / 其他资源 10 分钟），
//               没有内容哈希，只能靠短 TTL 让重新部署后的内容自愈。
//   边缘缓存    Cache API，缓存键里带 deploy_id。
//               Cache API 的 delete 只能清掉当前数据中心的副本，全球立即失效做不到，
//               但换键可以：重新部署后 deploy_id 变了，旧键再也不会被读到，
//               等效于一次全局失效，也不会出现新旧文件混着返回。
// 调试时给 URL 加 ?fresh=1 可同时绕过这两层。

import { safePath, escapeHtml } from './util.js';
import { contentTypeFor, cacheControlFor } from './mime.js';

const MAX_CACHEABLE_BYTES = 100 * 1024 * 1024;

export async function serveProject(request, env, ctx, projectId) {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }

  const row = await env.DB.prepare(
    'SELECT id, entry, status, deploy_id FROM projects WHERE id = ?'
  ).bind(projectId).first();

  if (!row) {
    return infoPage(
      404,
      '项目不存在',
      `没有名为 <code>${escapeHtml(projectId)}</code> 的项目。`,
      env
    );
  }
  if (row.status !== 'ready') {
    return infoPage(
      503,
      '正在部署',
      `项目 <code>${escapeHtml(projectId)}</code> 正在上传文件，请稍后刷新。`,
      env,
      { 'Retry-After': '10' }
    );
  }

  const url = new URL(request.url);
  const bypassCache = url.searchParams.has('fresh');

  // 缓存键里带上 deploy_id：Cache API 的 delete 只能清掉当前数据中心的副本，
  // 靠版本号换键就等效于「一次全局失效」——重新部署后旧键再也不会被读到，
  // 不需要等 TTL 过期，也不会出现新旧文件混着返回的情况。
  const cacheUrl = new URL(url.toString());
  cacheUrl.searchParams.set('__v', String(row.deploy_id));
  const cache = caches.default;
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });

  if (method === 'GET' && !bypassCache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      // cache.match 命中时不会替我们处理条件请求，这里自己判一次，
      // 否则浏览器带着 If-None-Match 来也会拿到完整响应体，白白浪费流量。
      const notModified = conditionalResponse(request, hit.headers.get('ETag'), hit.headers.get('Cache-Control'));
      if (notModified) return withHeader(notModified, 'X-Cache', 'HIT');
      return withHeader(hit, 'X-Cache', 'HIT');
    }
  }

  const candidates = resolveCandidates(url.pathname, row.entry);
  if (!candidates) {
    return infoPage(400, '路径非法', '请求路径中包含非法片段。', env);
  }

  let object = null;
  let objectKey = null;
  for (const candidate of candidates) {
    const key = `${projectId}/${candidate}`;
    const found = method === 'HEAD'
      ? await env.BUCKET.head(key)
      : await env.BUCKET.get(key);
    if (found) {
      object = found;
      objectKey = key;
      break;
    }
  }

  if (!object) {
    const custom404 = await env.BUCKET.get(`${projectId}/404.html`);
    if (custom404) {
      return withHeader(
        buildResponse(request, custom404, `${projectId}/404.html`, 404, bypassCache),
        'X-Cache',
        'BYPASS'
      );
    }
    return infoPage(
      404,
      '页面不存在',
      `<code>${escapeHtml(url.pathname)}</code> 在项目 <code>${escapeHtml(projectId)}</code> 中找不到。`,
      env
    );
  }

  const response = buildResponse(request, object, objectKey, 200, bypassCache);
  const cacheable =
    method === 'GET' &&
    !bypassCache &&
    response.status === 200 &&
    object.size <= MAX_CACHEABLE_BYTES;

  if (cacheable) {
    response.headers.set('X-Cache', 'MISS');
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  } else {
    response.headers.set('X-Cache', bypassCache ? 'BYPASS' : 'NOCACHE');
  }
  return response;
}

/** 管理后台界面由 Worker 自己托管（Workers Static Assets），不需要 Cloudflare Pages。 */
export async function serveAdmin(request, env) {
  if (!env.ASSETS) {
    return infoPage(
      500,
      '静态资源未绑定',
      'wrangler.jsonc 里缺少 assets.binding 配置，管理后台无法加载。',
      env
    );
  }
  const origin = await env.ASSETS.fetch(request);
  const response = new Response(origin.body, origin);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

/**
 * 把 URL 路径解析成若干个可能的 R2 键（按顺序尝试）。
 * 返回 null 表示路径非法。
 */
function resolveCandidates(pathname, entry) {
  const safe = safePath(pathname);
  if (safe === null) return null;
  if (safe === '') return [entry || 'index.html'];
  if (pathname.endsWith('/')) return [`${safe}/index.html`];

  const lastSegment = safe.slice(safe.lastIndexOf('/') + 1);
  if (lastSegment.includes('.')) return [safe];
  // 无扩展名：先当成目录，再当成 .html 文件
  return [`${safe}/index.html`, `${safe}.html`];
}

function buildResponse(request, object, key, status, bypassCache = false) {
  const etag = object.httpEtag;
  // ?fresh=1 时连浏览器缓存也一起跳过，方便部署后立刻核对线上内容
  const cacheControl = bypassCache ? 'no-store' : cacheControlFor(key);

  if (!bypassCache) {
    const notModified = conditionalResponse(request, etag, cacheControl);
    if (notModified) return notModified;
  }

  const headers = new Headers({
    'Content-Type': object.httpMetadata?.contentType || contentTypeFor(key),
    ETag: etag,
    'Cache-Control': cacheControl,
    'Content-Length': String(object.size),
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline',
  });
  if (object.uploaded) headers.set('Last-Modified', new Date(object.uploaded).toUTCString());

  if (request.method.toUpperCase() === 'HEAD') {
    return new Response(null, { status, headers });
  }
  return new Response(object.body, { status, headers });
}

/** 条件请求命中就返回 304，否则返回 null。 */
function conditionalResponse(request, etag, cacheControl) {
  if (!etag) return null;
  if (!etagMatches(request.headers.get('If-None-Match'), etag)) return null;
  return new Response(null, {
    status: 304,
    headers: { ETag: etag, ...(cacheControl ? { 'Cache-Control': cacheControl } : {}) },
  });
}

function etagMatches(header, etag) {
  if (!header || !etag) return false;
  const normalized = etag.replace(/^W\//, '');
  return header.split(',').some((part) => {
    const token = part.trim();
    if (token === '*') return true;
    return token.replace(/^W\//, '') === normalized;
  });
}

function withHeader(response, name, value) {
  const copy = new Response(response.body, response);
  copy.headers.set(name, value);
  return copy;
}

function infoPage(status, title, message, env, extraHeaders = {}) {
  const root = env?.ROOT_DOMAIN || '';
  const admin = root ? `https://${env.ADMIN_SUBDOMAIN || 'admin'}.${root}/` : '';
  const body = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${status} · ${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#0b0d12; color:#e6e8ee;
         font:15px/1.7 system-ui,-apple-system,"Segoe UI","Noto Sans SC",sans-serif }
  .card { max-width:520px; padding:40px 36px; border:1px solid #232733; border-radius:16px;
          background:linear-gradient(180deg,#12151d,#0e1117); text-align:center }
  h1 { margin:0 0 4px; font-size:20px; letter-spacing:.01em }
  .code { font:600 46px/1 ui-monospace,SFMono-Regular,Menlo,monospace; color:#4b5568; margin-bottom:18px }
  p { margin:0; color:#9aa3b5 }
  code { font:13px ui-monospace,SFMono-Regular,Menlo,monospace; background:#1b1f2a; padding:2px 6px; border-radius:5px; color:#c9d1e4 }
  a { color:#6f9dfb; text-decoration:none }
  a:hover { text-decoration:underline }
  .foot { margin-top:22px; font-size:13px }
</style>
</head>
<body>
  <div class="card">
    <div class="code">${status}</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${message}</p>
    ${admin ? `<div class="foot"><a href="${admin}">前往管理后台</a></div>` : ''}
  </div>
</body>
</html>`;

  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

export { infoPage };
