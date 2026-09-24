// 通用工具：主机名解析、项目名校验、路径规范化、响应构造。

// 这些子域名不能用作项目名，否则会和后台、邮件、DNS 等基础设施抢名字。
export const RESERVED_SUBDOMAINS = new Set([
  'www', 'admin', 'api', 'app', 'assets', 'static', 'cdn', 'img', 'images', 'files',
  'download', 'downloads', 'mail', 'smtp', 'imap', 'pop', 'webmail', 'ftp', 'ssh', 'vpn',
  'ns', 'ns1', 'ns2', 'ns3', 'ns4', 'dns', 'mx', 'dev', 'test', 'staging', 'stage',
  'demo', 'beta', 'preview', 'internal', 'intranet', 'status', 'monitor', 'metrics',
  'log', 'logs', 'db', 'database', 'redis', 'cache', 'queue', 'worker', 'workers',
  'git', 'gitlab', 'jenkins', 'grafana', 'prometheus', 'sentry', 'localhost',
]);

export const PROJECT_ID_MAX = 40;

// DNS 标签规则：小写字母数字与连字符，首尾不能是连字符。
const ID_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** 返回错误说明字符串；合法则返回 null。 */
export function validateProjectId(id) {
  if (typeof id !== 'string') return '项目名必须是字符串';
  const v = id.trim().toLowerCase();
  if (!v) return '项目名不能为空';
  if (v.length > PROJECT_ID_MAX) return `项目名最长 ${PROJECT_ID_MAX} 个字符`;
  if (!ID_RE.test(v)) return '只能使用小写字母、数字和连字符，且不能以连字符开头或结尾';
  if (v.includes('--')) return '不能出现连续的连字符';
  if (v.startsWith('xn--')) return '不能使用 xn-- 开头的项目名';
  if (RESERVED_SUBDOMAINS.has(v)) return `"${v}" 是系统保留名，请换一个`;
  return null;
}

/**
 * 判断请求落在哪个位置。
 * 返回 { kind, projectId?, label? }，kind 取值：
 *   apex     根域名本身
 *   admin    后台子域名（ROOT_DOMAIN 里的 ADMIN_SUBDOMAIN）
 *   project  项目子域名
 *   www      www 子域名，做 302 跳转
 *   reserved 其他保留子域名
 *   local    localhost / 127.0.0.1，本地开发时当后台用
 *   invalid  多级子域名之类无法处理的情况
 *   unknown  不属于 ROOT_DOMAIN 的主机（例如 *.workers.dev 预览域名），当后台用
 */
export function parseHost(hostname, rootDomain, adminSubdomain = 'admin') {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');

  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
    return { kind: 'local' };
  }

  const root = String(rootDomain || '').toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
  if (!root) return { kind: 'unknown' };

  if (host === root) return { kind: 'apex' };

  const suffix = `.${root}`;
  if (host.endsWith(suffix)) {
    const label = host.slice(0, host.length - suffix.length);
    // 通配 DNS 记录本身是多级的，但免费版 Universal SSL 只覆盖一层子域名，
    // 所以 a.b.example.com 走 HTTPS 会证书错误 —— 直接按无效主机处理。
    if (!label || label.includes('.')) return { kind: 'invalid' };
    return labelHost(label, adminSubdomain);
  }

  // 本地开发：Chrome 会把 *.localhost 解析到 127.0.0.1，用 myproj.localhost:8787 就能测项目分发。
  if (host.endsWith('.localhost')) {
    const label = host.slice(0, -'.localhost'.length);
    if (label && !label.includes('.')) return labelHost(label, adminSubdomain);
  }

  return { kind: 'unknown' };
}

function labelHost(label, adminSubdomain) {
  if (label === adminSubdomain) return { kind: 'admin' };
  if (label === 'www') return { kind: 'www' };
  if (RESERVED_SUBDOMAINS.has(label)) return { kind: 'reserved', label };
  return { kind: 'project', projectId: label };
}

/**
 * 把 URL 路径转成安全的相对键片段。
 * 返回 '' 表示项目根；返回 null 表示路径非法（穿越、空字节、坏编码）。
 */
export function safePath(pathname) {
  let p = String(pathname || '');
  try {
    p = decodeURIComponent(p);
  } catch {
    return null;
  }
  p = p.replace(/\\/g, '/');
  if (p.includes('\0')) return null;

  const out = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    out.push(seg);
  }
  const joined = out.join('/');
  // 单段长度上限够用了，同时避免超长键把 R2 写爆。
  if (joined.length > 1024) return null;
  return joined;
}

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

export function deployId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * 带并发上限的 map。Workers 免费版同时打开的连接数有限，
 * 所以往 R2 写文件时用 4 并发而不是 Promise.all 全放出去。
 */
export async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    })
  );
  return results;
}
