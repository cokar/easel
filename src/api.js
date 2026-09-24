// 上传与管理 API。
//
// 硬性约束（决定了下面的分片与并发策略）：
//   Workers 免费版每次调用 CPU 10ms、内存 128MB、子请求 50 个。
//   所以前端把 ZIP 解压好、按「每批 ≤40 个文件 / ≤30MB」分片推上来，
//   每个文件一次 R2 put（一次子请求），并用 4 并发避开同时连接数上限。

import { json, validateProjectId, safePath, deployId, mapPool } from './util.js';
import { contentTypeFor } from './mime.js';
import {
  isAuthenticated, verifyPassword, issueSession, sessionCookie, clearedCookie,
} from './auth.js';

const MAX_FILES_PER_PROJECT = 5000;
const MAX_FILES_PER_BATCH = 40;
const MAX_BATCH_BYTES = 30 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const PUT_CONCURRENCY = 4;
const MAX_LIST_PAGES = 20; // 每页 1000 个对象，配合删除批次确保子请求不超 50

// 进程内登录节流。只在单个 isolate 里生效，属于纵深防御；
// 真正的全局限流请在 Dashboard 里加一条 Rate Limiting 规则。
const throttle = { failures: 0, blockedUntil: 0 };

export async function handleApi(request, env, hostInfo) {
  const url = new URL(request.url);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  const method = request.method.toUpperCase();

  if (path === '/api/session' && method === 'GET') return sessionInfo(request, env);
  if (path === '/api/login' && method === 'POST') return login(request, env);
  if (path === '/api/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': clearedCookie() });
  }
  if (path === '/api/projects' && method === 'GET') {
    return guard(request, env, () => listProjects(env));
  }
  if (path === '/api/projects/check' && method === 'POST') {
    return guard(request, env, () => checkProject(request, env));
  }

  const rest = path.startsWith('/api/projects/') ? path.slice('/api/projects/'.length) : null;
  if (rest) {
    const slash = rest.indexOf('/');
    const id = slash < 0 ? rest : rest.slice(0, slash);
    const action = slash < 0 ? '' : rest.slice(slash + 1);

    if (action === 'begin' && method === 'POST') {
      return guard(request, env, () => beginProject(request, env, id));
    }
    if (action === 'files' && method === 'POST') {
      return guard(request, env, () => uploadFiles(request, env, id));
    }
    if (action === 'finalize' && method === 'POST') {
      return guard(request, env, () => finalizeProject(request, env, id));
    }
    if (action === '' && method === 'DELETE') {
      return guard(request, env, () => deleteProject(env, id));
    }
  }

  return json({ ok: false, error: `未知接口：${method} ${path}` }, 404);
}

async function guard(request, env, fn) {
  if (!(await isAuthenticated(request, env))) {
    return json({ ok: false, error: '未登录或会话已过期' }, 401);
  }
  try {
    return await fn();
  } catch (err) {
    const status = Number(err?.status) || 500;
    return json({ ok: false, error: err?.message || String(err) }, status);
  }
}

// ---------------------------------------------------------------- 会话

function adminHost(env) {
  return env.ROOT_DOMAIN ? `${env.ADMIN_SUBDOMAIN || 'admin'}.${env.ROOT_DOMAIN}` : '';
}

function projectUrl(env, id) {
  return env.ROOT_DOMAIN ? `https://${id}.${env.ROOT_DOMAIN}/` : '';
}

async function sessionInfo(request, env) {
  const authenticated = await isAuthenticated(request, env);
  return json({
    ok: true,
    authenticated,
    domain: env.ROOT_DOMAIN || '',
    adminHost: adminHost(env),
    configured: Boolean(env.ADMIN_PASSWORD && env.AUTH_SECRET),
    limits: {
      maxFilesPerProject: MAX_FILES_PER_PROJECT,
      maxFilesPerBatch: MAX_FILES_PER_BATCH,
      maxBatchBytes: MAX_BATCH_BYTES,
      maxFileBytes: MAX_FILE_BYTES,
    },
  });
}

async function login(request, env) {
  if (Date.now() < throttle.blockedUntil) {
    const retry = Math.ceil((throttle.blockedUntil - Date.now()) / 1000);
    return json({ ok: false, error: `尝试过于频繁，请 ${retry} 秒后再试` }, 429, {
      'Retry-After': String(retry),
    });
  }
  if (!env.ADMIN_PASSWORD) {
    return json({ ok: false, error: '服务端未设置 ADMIN_PASSWORD，请先执行 npx wrangler secret put ADMIN_PASSWORD' }, 500);
  }

  const body = await readJson(request);
  const ok = await verifyPassword(env, body?.password);
  if (!ok) {
    throttle.failures++;
    if (throttle.failures >= 5) {
      throttle.failures = 0;
      throttle.blockedUntil = Date.now() + 60_000;
    }
    await new Promise((r) => setTimeout(r, 400)); // 抬高单次尝试成本
    return json({ ok: false, error: '口令不正确' }, 401);
  }

  throttle.failures = 0;
  const { token, maxAge } = await issueSession(env);
  return json(
    { ok: true, domain: env.ROOT_DOMAIN || '', adminHost: adminHost(env) },
    200,
    { 'Set-Cookie': sessionCookie(token, maxAge) }
  );
}

// ---------------------------------------------------------------- 项目列表

async function listProjects(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, title, entry, file_count, total_bytes, status, source_name, created_at, updated_at
       FROM projects ORDER BY created_at DESC LIMIT 500`
  ).all();

  const projects = (results || []).map((row) => ({
    id: row.id,
    title: row.title,
    entry: row.entry,
    fileCount: row.file_count,
    totalBytes: row.total_bytes,
    status: row.status,
    sourceName: row.source_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    url: projectUrl(env, row.id),
  }));

  return json({
    ok: true,
    projects,
    summary: {
      count: projects.length,
      totalBytes: projects.reduce((sum, p) => sum + (p.totalBytes || 0), 0),
      // R2 免费额度 10GB，给前端一个直观的余量提示
      freeQuotaBytes: 10 * 1024 * 1024 * 1024,
    },
  });
}

async function checkProject(request, env) {
  const body = await readJson(request);
  const id = String(body?.id || '').trim().toLowerCase();
  const invalid = validateProjectId(id);
  if (invalid) return json({ ok: true, id, valid: false, available: false, error: invalid });

  const row = await env.DB.prepare('SELECT id FROM projects WHERE id = ?').bind(id).first();
  return json({
    ok: true,
    id,
    valid: true,
    available: !row,
    existing: Boolean(row),
    error: row ? `子域名 ${id}.${env.ROOT_DOMAIN} 已被占用` : null,
  });
}

// ---------------------------------------------------------------- 部署三步

async function beginProject(request, env, id) {
  const invalid = validateProjectId(id);
  if (invalid) return json({ ok: false, error: invalid }, 400);

  const body = await readJson(request);
  const fileCount = clampInt(body?.fileCount, 0, Number.MAX_SAFE_INTEGER);
  if (fileCount > MAX_FILES_PER_PROJECT) {
    return json({ ok: false, error: `单个项目最多 ${MAX_FILES_PER_PROJECT} 个文件，当前 ${fileCount} 个` }, 400);
  }

  const now = Date.now();
  const did = deployId();
  const title = String(body?.title || id).slice(0, 120);
  const sourceName = String(body?.sourceName || '').slice(0, 200);
  const totalBytes = clampInt(body?.totalBytes, 0, Number.MAX_SAFE_INTEGER);

  const existing = await env.DB.prepare('SELECT id FROM projects WHERE id = ?').bind(id).first();

  if (existing) {
    await env.DB.prepare(
      `UPDATE projects
          SET title = ?, source_name = ?, file_count = ?, total_bytes = ?,
              deploy_id = ?, status = 'uploading', updated_at = ?
        WHERE id = ?`
    ).bind(title, sourceName, fileCount, totalBytes, did, now, id).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO projects
         (id, title, entry, file_count, total_bytes, deploy_id, status, source_name, created_at, updated_at)
       VALUES (?, ?, 'index.html', ?, ?, ?, 'uploading', ?, ?, ?)`
    ).bind(id, title, fileCount, totalBytes, did, sourceName, now, now).run();
  }

  return json({ ok: true, id, deployId: did, overwrite: Boolean(existing) });
}

async function uploadFiles(request, env, id) {
  const invalid = validateProjectId(id);
  if (invalid) return json({ ok: false, error: invalid }, 400);

  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > MAX_BATCH_BYTES + 2 * 1024 * 1024) {
    return json({ ok: false, error: `单批请求体过大，上限约 ${mb(MAX_BATCH_BYTES)}` }, 413);
  }

  const row = await env.DB.prepare('SELECT id, deploy_id FROM projects WHERE id = ?').bind(id).first();
  if (!row) return json({ ok: false, error: '项目尚未登记，请先调用 begin' }, 409);

  let form;
  try {
    form = await request.formData();
  } catch (err) {
    return json({ ok: false, error: `无法解析 multipart 请求体：${err?.message || err}` }, 400);
  }

  const deploy = String(form.get('deploy') || '');
  if (deploy !== row.deploy_id) {
    return json({ ok: false, error: '部署已过期（可能在其他标签页重新上传过），请刷新页面重试' }, 409);
  }

  // 按「先 path 后 file」的成对顺序解析，不依赖 multipart 的 filename 字段
  // （各浏览器对带斜杠的 filename 处理不一致）。
  const pairs = [];
  let pendingPath = null;
  for (const [name, value] of form.entries()) {
    if (name === 'path') {
      pendingPath = String(value);
      continue;
    }
    if (name !== 'file') continue;
    if (pendingPath === null) {
      return json({ ok: false, error: 'multipart 字段顺序错乱：file 之前缺少 path' }, 400);
    }
    pairs.push({ path: pendingPath, blob: value });
    pendingPath = null;
  }
  if (pendingPath !== null) {
    return json({ ok: false, error: 'multipart 字段顺序错乱：path 之后缺少 file' }, 400);
  }
  if (!pairs.length) return json({ ok: false, error: '这一批没有任何文件' }, 400);
  if (pairs.length > MAX_FILES_PER_BATCH) {
    return json({ ok: false, error: `单批最多 ${MAX_FILES_PER_BATCH} 个文件，当前 ${pairs.length} 个` }, 413);
  }

  const keys = [];
  for (const { path, blob } of pairs) {
    const safe = safePath(`/${path}`);
    if (!safe) return json({ ok: false, error: `非法文件路径：${path}` }, 400);
    if (blob.size > MAX_FILE_BYTES) {
      return json({ ok: false, error: `单文件超出 ${mb(MAX_FILE_BYTES)} 上限：${safe}` }, 413);
    }
    keys.push(safe);
  }

  const failures = [];
  const sizes = await mapPool(pairs, PUT_CONCURRENCY, async ({ blob }, i) => {
    try {
      await env.BUCKET.put(`${id}/${keys[i]}`, blob.stream(), {
        httpMetadata: { contentType: contentTypeFor(keys[i]) },
        // 记下所属部署，finalize 时据此清理上一版的残留文件
        customMetadata: { d: row.deploy_id },
      });
      return blob.size;
    } catch (err) {
      failures.push({ path: keys[i], error: err?.message || String(err) });
      return 0;
    }
  });

  if (failures.length) {
    return json(
      {
        ok: false,
        error: `${failures.length}/${pairs.length} 个文件写入 R2 失败，本批可整体重试`,
        failures: failures.slice(0, 10),
      },
      502
    );
  }

  return json({
    ok: true,
    written: pairs.length,
    bytes: sizes.reduce((a, b) => a + b, 0),
  });
}

async function finalizeProject(request, env, id) {
  const row = await env.DB.prepare(
    'SELECT id, deploy_id, created_at FROM projects WHERE id = ?'
  ).bind(id).first();
  if (!row) return json({ ok: false, error: '项目不存在' }, 404);

  const body = await readJson(request);
  if (body?.deploy && String(body.deploy) !== row.deploy_id) {
    return json({ ok: false, error: '部署已过期，请刷新页面重试' }, 409);
  }

  const entry = safePath(`/${String(body?.entry || 'index.html')}`);
  if (!entry) return json({ ok: false, error: '入口文件路径非法' }, 400);

  const head = await env.BUCKET.head(`${id}/${entry}`);
  if (!head) return json({ ok: false, error: `入口文件不在 R2 中：${entry}` }, 400);

  const fileCount = clampInt(body?.fileCount, 0, MAX_FILES_PER_PROJECT);
  const totalBytes = clampInt(body?.totalBytes, 0, Number.MAX_SAFE_INTEGER);

  await env.DB.prepare(
    `UPDATE projects
        SET entry = ?, file_count = ?, total_bytes = ?, status = 'ready', updated_at = ?
      WHERE id = ?`
  ).bind(entry, fileCount, totalBytes, Date.now(), id).run();

  const purged = await purgeStale(env, id, row.deploy_id);

  return json({
    ok: true,
    id,
    entry,
    url: projectUrl(env, id),
    purgedStale: purged,
  });
}

async function deleteProject(env, id) {
  let deleted = 0;
  let cursor;
  let truncated = false;

  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const listed = await env.BUCKET.list({ prefix: `${id}/`, cursor, limit: 1000 });
    if (listed.objects.length) {
      await env.BUCKET.delete(listed.objects.map((o) => o.key));
      deleted += listed.objects.length;
    }
    if (!listed.truncated) {
      cursor = undefined;
      break;
    }
    cursor = listed.cursor;
    if (page === MAX_LIST_PAGES - 1) truncated = true;
  }

  await env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(id).run();

  return json({
    ok: true,
    id,
    deleted,
    truncated,
    warning: truncated
      ? `对象数超过 ${MAX_LIST_PAGES * 1000} 个，仅删除了前 ${MAX_LIST_PAGES * 1000} 个，请再执行一次`
      : undefined,
    notice: '边缘缓存最长 1 小时后才会彻底消失（Cache API 无法全球立即清除）',
  });
}

/**
 * 删除同一项目下不属于本次部署的残留文件。
 * 每次 put 都带了 customMetadata.d = deploy_id，所以这里比对即可，
 * 不需要前端上传完整清单。
 */
async function purgeStale(env, id, currentDeploy) {
  const stale = [];
  let cursor;

  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const listed = await env.BUCKET.list({
      prefix: `${id}/`,
      cursor,
      limit: 1000,
      include: ['customMetadata'],
    });
    for (const obj of listed.objects) {
      if (String(obj.customMetadata?.d || '') !== currentDeploy) stale.push(obj.key);
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }

  let deleted = 0;
  for (let i = 0; i < stale.length; i += 1000) {
    const chunk = stale.slice(i, i + 1000);
    await env.BUCKET.delete(chunk);
    deleted += chunk.length;
  }
  return deleted;
}

// ---------------------------------------------------------------- 小工具

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function clampInt(value, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
}

function mb(bytes) {
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}
