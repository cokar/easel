// 本地端到端冒烟测试。需要先启动 `npm run dev`（默认 127.0.0.1:8787）。
//
//   node scripts/smoke-test.mjs [--port 8787] [--password test-password-123]
//
// 覆盖：登录鉴权 -> 项目名校验 -> begin -> 分片上传（含路径穿越与垃圾文件）-> finalize
//       -> 子域名分发（入口、静态资源、无扩展名回退、404、ETag 304）-> 覆盖部署清理残留 -> 删除。

import http from 'node:http';
import { zipSync, strToU8 } from 'fflate';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = Number(opt('port', '8787'));
const PASSWORD = opt('password', 'test-password-123');
const ORIGIN = `http://127.0.0.1:${PORT}`;

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 指定 Host 头发请求（fetch 不允许改 Host，所以走原生 http）。 */
function request(method, path, { host = '127.0.0.1', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, method, path, headers: { Host: host, ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function api(method, path, { json, form, cookie } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  let body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = Buffer.from(JSON.stringify(json));
  } else if (form) {
    headers['Content-Type'] = form.contentType;
    body = form.body;
  }
  const res = await request(method, path, { headers, body });
  let data = null;
  try {
    data = JSON.parse(res.body.toString('utf8'));
  } catch {
    /* 非 JSON */
  }
  return { ...res, data };
}

/** 手工拼 multipart：按「先 path 后 file」的成对顺序，和后端解析方式一致。 */
function buildMultipart(deploy, files) {
  const boundary = `----smoke${Math.random().toString(16).slice(2)}`;
  const parts = [];
  const push = (s) => parts.push(Buffer.from(s, 'utf8'));
  const field = (name, value) => {
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`);
    push(`${value}\r\n`);
  };
  field('deploy', deploy);
  for (const file of files) {
    field('path', file.path);
    push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="blob"\r\n`);
    push('Content-Type: application/octet-stream\r\n\r\n');
    parts.push(Buffer.from(file.bytes));
    push('\r\n');
  }
  push(`--${boundary}--\r\n`);
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(parts) };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeTestZip() {  return zipSync({
    'site/index.html': strToU8(
      '<!doctype html><html><head><link rel="stylesheet" href="assets/app.css"></head>' +
        '<body><h1>冒烟测试</h1></body></html>'
    ),
    'site/assets/app.css': strToU8('h1{color:#639}'),
    'site/about.html': strToU8('<h1>About</h1>'),
    'site/__MACOSX/._index.html': strToU8('junk'),
    'site/.DS_Store': strToU8('junk'),
    'site/../../../etc/evil.txt': strToU8('traversal'),
  });
}

// ------------------------------------------------------------------ 用例

console.log(`\n冒烟测试 -> ${ORIGIN}\n`);

console.log('1. 会话与鉴权');
{
  const anon = await api('GET', '/api/session');
  check('未登录时 /api/session 返回 authenticated=false', anon.data?.authenticated === false);
  check('后端已配置密钥', anon.data?.configured === true, JSON.stringify(anon.data));

  const guarded = await api('GET', '/api/projects');
  check('未登录访问 /api/projects 被拒（401）', guarded.status === 401, `got ${guarded.status}`);

  const wrong = await api('POST', '/api/login', { json: { password: 'nope' } });
  check('错误口令返回 401', wrong.status === 401, `got ${wrong.status}`);

  const login = await api('POST', '/api/login', { json: { password: PASSWORD } });
  check('正确口令登录成功', login.status === 200 && login.data?.ok === true, JSON.stringify(login.data));
  const setCookie = login.headers['set-cookie']?.[0] || '';
  check('下发了 HttpOnly 会话 Cookie', /hh_session=/.test(setCookie) && /HttpOnly/i.test(setCookie));
  globalThis.cookie = setCookie.split(';')[0];
}

const auth = () => ({ cookie: globalThis.cookie });

console.log('\n0. 清理上次运行的残留');
{
  const cleanup = await api('DELETE', '/api/projects/smoke-site', auth());
  check('起始状态干净', cleanup.status === 200, `status=${cleanup.status}`);
  await sleep(300); // 等边缘缓存里上一个版本的键自然失联
}

console.log('\n2. 项目名校验');
{
  const reserved = await api('POST', '/api/projects/check', { json: { id: 'admin' }, ...auth() });
  check('保留名 admin 被拒绝', reserved.data?.valid === false, JSON.stringify(reserved.data));

  const bad = await api('POST', '/api/projects/check', { json: { id: 'Bad_Name' }, ...auth() });
  check('非法字符被拒绝', bad.data?.valid === false);

  const good = await api('POST', '/api/projects/check', { json: { id: 'smoke-site' }, ...auth() });
  check('合法名可用', good.data?.valid === true && good.data?.available === true);
}

console.log('\n3. 上传部署');
let deployId;
{
  const begin = await api('POST', '/api/projects/smoke-site/begin', {
    json: { title: '冒烟测试站点', sourceName: 'site.zip', fileCount: 3, totalBytes: 200 },
    ...auth(),
  });
  check('begin 成功', begin.data?.ok === true, JSON.stringify(begin.data));
  deployId = begin.data?.deployId;

  const zip = makeTestZip();
  console.log(`     （测试用 ZIP ${zip.length} 字节）`);

  // 路径穿越必须被拒
  const traversal = await api('POST', '/api/projects/smoke-site/files', {
    form: buildMultipart(deployId, [{ path: '../../evil.txt', bytes: strToU8('x') }]),
    ...auth(),
  });
  check('路径穿越被拒（400）', traversal.status === 400, `got ${traversal.status}`);

  const unknown = await api('POST', '/api/projects/smoke-site/files', {
    form: buildMultipart('wrong-deploy-id', [{ path: 'a.txt', bytes: strToU8('x') }]),
    ...auth(),
  });
  check('过期 deployId 被拒（409）', unknown.status === 409, `got ${unknown.status}`);

  const upload = await api('POST', '/api/projects/smoke-site/files', {
    form: buildMultipart(deployId, [
      { path: 'index.html', bytes: strToU8('<!doctype html><h1>冒烟测试</h1>') },
      { path: 'assets/app.css', bytes: strToU8('h1{color:#639}') },
      { path: 'about.html', bytes: strToU8('<h1>About</h1>') },
    ]),
    ...auth(),
  });
  check('分片上传成功', upload.data?.ok === true && upload.data?.written === 3, JSON.stringify(upload.data));

  const badEntry = await api('POST', '/api/projects/smoke-site/finalize', {
    json: { deploy: deployId, entry: 'nope.html', fileCount: 3, totalBytes: 100 },
    ...auth(),
  });
  check('入口文件不存在时 finalize 失败', badEntry.status === 400);

  const finalize = await api('POST', '/api/projects/smoke-site/finalize', {
    json: { deploy: deployId, entry: 'index.html', fileCount: 3, totalBytes: 100 },
    ...auth(),
  });
  check('finalize 成功', finalize.data?.ok === true, JSON.stringify(finalize.data));

  const list = await api('GET', '/api/projects', auth());
  check('列表里能看到项目', list.data?.projects?.some((p) => p.id === 'smoke-site') === true);
}

console.log('\n4. 子域名分发');
{
  const host = 'smoke-site.localhost';
  const root = await request('GET', '/', { host });
  check('GET / 返回入口 HTML', root.status === 200 && root.body.toString().includes('冒烟测试'), `status=${root.status}`);
  check('Content-Type 是 HTML', /text\/html/.test(root.headers['content-type'] || ''), root.headers['content-type']);
  check('带上 nosniff', root.headers['x-content-type-options'] === 'nosniff');
  check('HTML 浏览器缓存 60 秒', /max-age=60/.test(root.headers['cache-control'] || ''), root.headers['cache-control']);
  check('首次访问是回源（MISS）', root.headers['x-cache'] === 'MISS', root.headers['x-cache']);

  const again = await request('GET', '/', { host });
  check('第二次访问命中边缘缓存（HIT）', again.headers['x-cache'] === 'HIT', again.headers['x-cache']);

  const noCache = await request('GET', '/?fresh=1', { host });
  check(
    '?fresh=1 绕过两层缓存',
    noCache.headers['x-cache'] === 'BYPASS' && /no-store/.test(noCache.headers['cache-control'] || ''),
    `${noCache.headers['x-cache']} / ${noCache.headers['cache-control']}`
  );

  const css = await request('GET', '/assets/app.css', { host });
  check('静态资源可访问', css.status === 200 && css.body.toString().includes('#639'));
  check('CSS Content-Type 正确', /text\/css/.test(css.headers['content-type'] || ''), css.headers['content-type']);
  check('资源浏览器缓存 10 分钟', /max-age=600/.test(css.headers['cache-control'] || ''), css.headers['cache-control']);

  const pretty = await request('GET', '/about', { host });
  check('无扩展名回退到 .html', pretty.status === 200 && pretty.body.toString().includes('About'), `status=${pretty.status}`);

  const etag = css.headers.etag;
  check('静态资源带 ETag', Boolean(etag), `etag=${etag}`);
  if (etag) {
    const cached = await request('GET', '/assets/app.css', { host, headers: { 'If-None-Match': etag } });
    check('ETag 命中返回 304', cached.status === 304, `status=${cached.status}`);
  }

  const missing = await request('GET', '/nope/not-here', { host });
  check('不存在的路径返回 404 页面', missing.status === 404 && /页面不存在/.test(missing.body.toString()), `status=${missing.status}`);

  const unknownProject = await request('GET', '/', { host: 'no-such-project.localhost' });
  check('不存在的项目返回 404 且提示', unknownProject.status === 404 && /项目不存在/.test(unknownProject.body.toString()));

  const reserved = await request('GET', '/', { host: 'www.localhost' });
  check('www 返回 302', reserved.status === 302, `status=${reserved.status}`);

  const traversal = await request('GET', '/%2e%2e/%2e%2e/etc/passwd', { host });
  check('分发路径穿越被拒', traversal.status === 404 || traversal.status === 400, `status=${traversal.status}`);
}

console.log('\n5. 对外入口页（根域名）');
{
  // 本地开发下根域名等价于 localhost / 127.0.0.1
  const landing = await request('GET', '/', { host: 'localhost' });
  const html = landing.body.toString();
  check('根域名返回入口页', landing.status === 200 && /text\/html/.test(landing.headers['content-type'] || ''), `status=${landing.status}`);
  check('渲染了站点标题', html.includes('我的网页收藏'), html.slice(0, 80));
  check('列出了托管中的项目', html.includes('smoke-site') && html.includes('冒烟测试站点'));
  check('项目链接指向子域名', html.includes('smoke-site.localhost'));
  check('带上了统计信息', /个页面/.test(html) && /个文件/.test(html));
  check('入口页有搜索框', html.includes('id="filter"'));
  check('入口页缓存 60 秒', /max-age=60/.test(landing.headers['cache-control'] || ''), landing.headers['cache-control']);

  const adminLink = html.match(/class="admin-link" href="([^"]+)"/);
  check('入口页带后台入口链接', adminLink !== null && adminLink[1].includes('admin.localhost'), adminLink?.[1]);
  check('页脚也有后台入口', (html.match(/admin\.localhost/g) || []).length >= 2);

  // 关键回归：后台子域名不能被入口页顶掉
  const admin = await request('GET', '/', { host: 'admin.localhost' });
  const adminHtml = admin.body.toString();
  check('admin 子域名仍是管理后台', admin.status === 200 && adminHtml.includes('Easel') && adminHtml.includes('loginForm'), `status=${admin.status}`);
  check('后台不是入口页', !adminHtml.includes('我的网页收藏'));

  const apex = await request('GET', '/', { host: '127.0.0.1' });
  check('127.0.0.1 也走入口页', apex.status === 200 && apex.body.toString().includes('我的网页收藏'));

  const head = await request('HEAD', '/', { host: 'localhost' });
  check('入口页支持 HEAD', head.status === 200 && head.body.length === 0, `status=${head.status} len=${head.body.length}`);

  const post = await request('POST', '/', { host: 'localhost' });
  check('入口页拒绝 POST', post.status === 405, `status=${post.status}`);
}

console.log('\n6. 覆盖部署与残留清理');
{
  const begin = await api('POST', '/api/projects/smoke-site/begin', {
    json: { title: '第二版', fileCount: 1, totalBytes: 30 },
    ...auth(),
  });
  check('覆盖模式下 begin 成功', begin.data?.ok === true && begin.data?.overwrite === true);

  const upload = await api('POST', '/api/projects/smoke-site/files', {
    form: buildMultipart(begin.data.deployId, [
      { path: 'index.html', bytes: strToU8('<!doctype html><h1>第二版</h1>') },
    ]),
    ...auth(),
  });
  check('第二版上传成功', upload.data?.ok === true);

  // 上传中旧项目应当返回 503（干净切换，不出现新旧混合）
  const during = await request('GET', '/', { host: 'smoke-site.localhost' });
  check('上传期间返回 503 部署中', during.status === 503, `status=${during.status}`);

  // 入口页只列 ready 的项目，上传中的不应该露出来
  const landingDuring = (await request('GET', '/', { host: 'localhost' })).body.toString();
  check(
    '入口页不列出未完成部署的项目',
    !landingDuring.includes('smoke-site.localhost') && !landingDuring.includes('冒烟测试站点')
  );

  const finalize = await api('POST', '/api/projects/smoke-site/finalize', {
    json: { deploy: begin.data.deployId, entry: 'index.html', fileCount: 1, totalBytes: 30 },
    ...auth(),
  });
  check('第二版 finalize 成功', finalize.data?.ok === true);
  check('清理了上一版的残留文件（2 个）', finalize.data?.purgedStale === 2, `purged=${finalize.data?.purgedStale}`);

  // 关键回归：重新部署后 deploy_id 变了，缓存键随之改变，
  // 所以这里必须立刻拿到新内容（而不是命中上一版的缓存）。
  const updated = await request('GET', '/', { host: 'smoke-site.localhost' });
  check('重新部署后立刻返回新内容', updated.body.toString().includes('第二版'), updated.body.toString().slice(0, 60));
  check('新版本是回源而不是命中旧缓存', updated.headers['x-cache'] === 'MISS', updated.headers['x-cache']);

  const stale = await request('GET', '/assets/app.css', { host: 'smoke-site.localhost' });
  check('上一版独有文件已删除（404）', stale.status === 404, `status=${stale.status}`);
}

console.log('\n7. 删除项目');
{
  const removed = await api('DELETE', '/api/projects/smoke-site', auth());
  check('删除成功', removed.data?.ok === true && removed.data?.deleted === 1, JSON.stringify(removed.data));

  const gone = await request('GET', '/', { host: 'smoke-site.localhost' });
  check('删除后子域名返回 404', gone.status === 404, `status=${gone.status}`);

  const list = await api('GET', '/api/projects', auth());
  check('列表中已移除', list.data?.projects?.some((p) => p.id === 'smoke-site') !== true);
}

console.log(`\n${failures.length ? '✖' : '✔'} 通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length) {
  console.log('\n失败明细：');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
