// 管理后台逻辑：登录、选文件、解压（交给 Web Worker）、分片上传、列表管理。
// 没有框架也没有构建步骤，直接跑 ES 模块。

const $ = (id) => document.getElementById(id);
const BATCH_MAX = 40;
const RETRY_MAX = 3;

const state = {
  session: null,
  projects: [],
  file: null,
  plan: null,
  worker: null,
  deploying: false,
  autoStart: false,
};

// ------------------------------------------------------------------ 启动

async function init() {
  show('boot');
  try {
    const session = await api('/api/session');
    state.session = session;

    document.querySelectorAll('.root-domain').forEach((el) => {
      el.textContent = session.domain || '你的域名';
    });
    $('domainLabel').textContent = session.adminHost || location.host;
    $('siteLink').href = siteOrigin() || '/';

    if (!session.configured) {
      showLogin('服务端还没设置 ADMIN_PASSWORD 或 AUTH_SECRET，请先按 README 配置 Worker Secret。');
      return;
    }
    if (!session.authenticated) {
      showLogin();
      return;
    }
    show('app');
    await loadProjects();
  } catch (err) {
    showLogin(`无法连接后端：${err.message}`);
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    /* 后端可能返回了非 JSON（例如网关错误页） */
  }
  if (!response.ok) {
    const err = new Error(data?.error || `请求失败（HTTP ${response.status}）`);
    err.status = response.status;
    throw err;
  }
  return data ?? {};
}

function show(which) {
  $('boot').hidden = which !== 'boot';
  $('login').hidden = which !== 'login';
  $('app').hidden = which !== 'app';
}

function showLogin(message) {
  show('login');
  if (message) {
    $('loginHint').textContent = message;
    $('loginHint').classList.add('bad');
  }
  $('passwordInput').focus();
}

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.target.querySelector('button[type=submit]');
  const errorBox = $('loginError');
  errorBox.hidden = true;
  button.disabled = true;
  button.textContent = '登录中…';
  try {
    await api('/api/login', { method: 'POST', body: { password: $('passwordInput').value } });
    $('passwordInput').value = '';
    await init();
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = '登录';
  }
});

$('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  location.reload();
});

$('refreshBtn').addEventListener('click', () => loadProjects().catch((e) => toast(e.message, 'error')));

// ------------------------------------------------------------------ 项目列表

async function loadProjects() {
  const data = await api('/api/projects');
  state.projects = data.projects || [];
  renderProjects(data.summary);
}

function renderProjects(summary) {
  const wrap = $('projects');
  wrap.textContent = '';
  $('emptyState').hidden = state.projects.length > 0;

  for (const project of state.projects) wrap.append(projectCard(project));

  if (summary) {
    const used = summary.totalBytes || 0;
    const quota = summary.freeQuotaBytes || 1;
    const percent = Math.min(100, (used / quota) * 100);
    $('quotaLabel').textContent =
      `${summary.count} 个项目 · 共 ${formatBytes(used)} · 免费额度 10GB 用了 ${percent.toFixed(2)}%`;
    $('quotaBar').hidden = false;
    $('quotaFill').style.width = `${Math.max(percent, used > 0 ? 0.6 : 0)}%`;
  }
}

function projectCard(project) {
  const domain = state.session?.domain || '';
  const url = projectUrl(project.id);

  return el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', {
        class: 'avatar',
        style: avatarStyle(project.id),
        text: String(project.title || project.id).trim().charAt(0).toUpperCase() || '#',
      }),
      el('div', { class: 'card-title' },
        el('strong', { text: project.title || project.id }),
        el('a', { href: url, target: '_blank', rel: 'noopener', text: `${project.id}.${domain}` }),
      ),
    ),
    el('div', { class: 'card-meta' },
      el('span', { text: `${formatInt(project.fileCount)} 个文件` }),
      el('span', { text: formatBytes(project.totalBytes) }),
      el('span', { text: formatDate(project.updatedAt || project.createdAt) }),
      project.status !== 'ready' ? el('span', { class: 'badge warn', text: '上传未完成' }) : null,
    ),
    el('div', { class: 'card-actions' },
      el('button', { class: 'mini', onClick: () => window.open(url, '_blank', 'noopener') }, '打开'),
      el('button', { class: 'mini', onClick: () => copyText(url) }, '复制链接'),
      el('button', { class: 'mini', onClick: () => beginRedeploy(project) }, '重新部署'),
      el('button', { class: 'mini danger', onClick: () => removeProject(project) }, '删除'),
    ),
  );
}

function beginRedeploy(project) {
  $('projectId').value = project.id;
  $('projectTitle').value = project.title || '';
  state.autoStart = true;
  validateId();
  toast(`覆盖模式：选择要替换 ${project.id} 的 ZIP 或 HTML 文件`, 'success');
  $('fileInput').click();
}

async function removeProject(project) {
  if (!confirm(`删除 "${project.title || project.id}"？\n\nR2 里的所有文件都会被删除，此操作不可撤销。`)) return;
  try {
    const result = await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' });
    toast(`已删除 ${project.id}（${formatInt(result.deleted)} 个文件）`, 'success');
    await loadProjects();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ------------------------------------------------------------------ 选择文件与分析

const dropzone = $('dropzone');
const fileInput = $('fileInput');

dropzone.addEventListener('click', () => {
  if (!state.deploying) fileInput.click();
});
dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    fileInput.click();
  }
});
for (const type of ['dragenter', 'dragover']) {
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add('dragging');
  });
}
for (const type of ['dragleave', 'drop']) {
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.remove('dragging');
  });
}
dropzone.addEventListener('drop', (event) => {
  if (state.deploying) return;
  const file = event.dataTransfer?.files?.[0];
  if (file) selectFile(file);
});
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (file) selectFile(file);
});

const MAX_ZIP_BYTES = 250 * 1024 * 1024;

async function selectFile(file) {
  resetLog();
  state.file = file;
  state.plan = null;
  disposeWorker();
  $('planBox').hidden = true;
  $('uploadBtn').disabled = true;
  $('fileNameLabel').textContent = `${file.name} · ${formatBytes(file.size)}`;

  if (!$('projectId').value.trim() || !state.autoStart) {
    $('projectId').value = slugifyClient(file.name);
  }
  if (!$('projectTitle').value.trim()) {
    $('projectTitle').value = file.name.replace(/\.(zip|html?|htm)$/i, '');
  }
  validateId();

  try {
    showPlan({ entry: null, fileCount: null, totalBytes: file.size, note: '正在读取文件…' });

    const isZip = await looksLikeZip(file);
    if (!isZip) {
      if (!/\.html?$/i.test(file.name)) {
        throw new Error('只支持 .zip 压缩包或单个 .html / .htm 文件');
      }
      state.plan = {
        entry: 'index.html',
        fileCount: 1,
        totalBytes: file.size,
        skipped: 0,
        single: true,
      };
    } else {
      if (file.size > MAX_ZIP_BYTES) {
        throw new Error(`压缩包 ${formatBytes(file.size)} 超过 250MB，请精简后重试`);
      }
      state.worker = new Worker('/unzip-worker.js', { type: 'module' });
      state.plan = await analyzeWithWorker(state.worker, file);
    }

    showPlan(state.plan);
    $('uploadBtn').disabled = false;
    if (state.autoStart) {
      state.autoStart = false;
      startDeploy().catch(() => {});
    }
  } catch (err) {
    state.plan = null;
    $('fileNameLabel').textContent = file.name;
    showPlanError(err.message);
    toast(err.message, 'error');
  }
}

function showPlan(plan) {
  const box = $('planBox');
  box.hidden = false;
  box.textContent = '';

  if (plan.note) {
    box.append(el('div', { class: 'kv' }, el('b', { text: '状态' }), el('span', { text: plan.note })));
    return;
  }

  box.append(row('入口文件', code(plan.entry)));
  box.append(row('文件数量', `${formatInt(plan.fileCount)} 个${plan.fileCount > BATCH_MAX
    ? `（分 ${Math.ceil(plan.fileCount / BATCH_MAX)} 批上传）` : ''}`));
  box.append(row('解压后体积', formatBytes(plan.totalBytes)));
  if (plan.prefix) {
    box.append(row('已剥掉顶层目录', code(plan.prefix)));
  }
  if (plan.skipped) {
    box.append(row('已忽略', `${plan.skipped} 个系统垃圾文件（.DS_Store / __MACOSX 等）`));
  }

  function row(label, value) {
    return el('div', { class: 'kv' }, el('b', { text: label }), el('span', {}, value));
  }
}

function showPlanError(message) {
  const box = $('planBox');
  box.hidden = false;
  box.textContent = '';
  box.style.borderLeftColor = 'var(--danger)';
  box.append(el('div', { class: 'kv' }, el('b', { text: '无法上传' }), el('span', { text: message })));
  setTimeout(() => {
    box.style.borderLeftColor = '';
  }, 100);
}

// ------------------------------------------------------------------ 项目名校验

let checkTimer = null;
let lastCheck = null;

$('projectId').addEventListener('input', validateId);

function validateId() {
  clearTimeout(checkTimer);
  const id = $('projectId').value.trim().toLowerCase();
  const hint = $('idHint');
  const input = $('projectId');

  if (!id) {
    input.classList.remove('invalid');
    hint.textContent = '';
    hint.className = 'hint';
    $('uploadBtn').disabled = true;
    return false;
  }

  const localError = validateIdClient(id);
  if (localError) {
    input.classList.add('invalid');
    hint.textContent = localError;
    hint.className = 'hint bad';
    $('uploadBtn').disabled = true;
    return false;
  }

  input.classList.remove('invalid');
  hint.textContent = '检查中…';
  hint.className = 'hint';
  $('uploadBtn').disabled = !state.plan;

  const queryId = id;
  checkTimer = setTimeout(async () => {
    try {
      const result = await api('/api/projects/check', { method: 'POST', body: { id: queryId } });
      if ($('projectId').value.trim().toLowerCase() !== queryId) return;
      lastCheck = result;
      if (!result.valid) {
        hint.textContent = result.error;
        hint.className = 'hint bad';
      } else if (result.available) {
        hint.textContent = `可用 · ${queryId}.${state.session.domain}`;
        hint.className = 'hint good';
      } else {
        hint.textContent = `已存在，上传会覆盖它`;
        hint.className = 'hint bad';
      }
    } catch (err) {
      hint.textContent = err.message;
      hint.className = 'hint bad';
    }
  }, 320);

  return true;
}

function validateIdClient(id) {
  if (id.length > 40) return '项目名最长 40 个字符';
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(id)) {
    return '只能使用小写字母、数字和连字符，且不能以连字符开头或结尾';
  }
  if (id.includes('--')) return '不能出现连续的连字符';
  return null;
}

// ------------------------------------------------------------------ 上传流程

$('uploadBtn').addEventListener('click', () => {
  startDeploy().catch(() => {});
});

$('cancelBtn').addEventListener('click', () => {
  state.worker?.postMessage({ type: 'abort' });
  toast('正在取消…', 'error');
});

async function startDeploy() {
  if (state.deploying) return;

  const id = $('projectId').value.trim().toLowerCase();
  if (!id) return toast('请先填写项目名', 'error');
  if (!state.file || !state.plan) return toast('请先选择一个 ZIP 或 HTML 文件', 'error');

  const localError = validateIdClient(id);
  if (localError) return toast(localError, 'error');

  state.deploying = true;
  setBusy(true);
  resetLog();

  try {
    // 1) 确认项目名可用（不可用即视为覆盖）
    const check = await api('/api/projects/check', { method: 'POST', body: { id } });
    if (!check.valid) throw new Error(check.error);
    if (!check.available) {
      const ok = confirm(`子域名 ${id}.${state.session.domain} 已存在。\n\n继续将覆盖原项目，旧文件会被清理。确定吗？`);
      if (!ok) throw new Error('已取消');
    }

    const title = $('projectTitle').value.trim() || id;

    // 2) 登记部署，拿到 deployId
    setStage('正在登记部署…', 0.02);
    const begun = await api(`/api/projects/${encodeURIComponent(id)}/begin`, {
      method: 'POST',
      body: {
        title,
        sourceName: state.file.name,
        fileCount: state.plan.fileCount,
        totalBytes: state.plan.totalBytes,
      },
    });
    const deploy = begun.deployId;
    log(`部署 ${deploy} 开始${begun.overwrite ? '（覆盖已有项目）' : ''}`);

    // 3) 分片上传
    let filesSent = 0;
    let bytesSent = 0;
    const totalFiles = Math.max(1, state.plan.fileCount);
    const totalBytes = Math.max(1, state.plan.totalBytes);

    const batches = state.plan.single
      ? singleFileBatches(state.file)
      : workerBatches(state.worker);

    for await (const batch of batches) {
      if (!state.deploying) throw new Error('已取消');
      await sendBatch(id, deploy, batch);
      filesSent += batch.count;
      bytesSent += batch.bytes;
      const ratio = Math.max(filesSent / totalFiles, bytesSent / totalBytes);
      setStage(
        `已上传 ${formatInt(filesSent)} / ${formatInt(totalFiles)} 个文件 · ${formatBytes(bytesSent)}`,
        0.08 + ratio * 0.86
      );
    }

    // 4) 收尾：写入入口文件、统计信息，并清理上一版的残留文件
    setStage('正在收尾…', 0.96);
    const done = await api(`/api/projects/${encodeURIComponent(id)}/finalize`, {
      method: 'POST',
      body: {
        deploy,
        entry: state.plan.entry,
        fileCount: filesSent,
        totalBytes: bytesSent,
      },
    });

    setStage('完成', 1);
    log(`✓ 上线：${projectUrl(id)}`, 'ok');
    if (done.purgedStale) log(`已清理上一版的 ${formatInt(done.purgedStale)} 个残留文件`, 'ok');
    log('提示：边缘缓存按版本号换键，重新部署立刻全局生效；只有访客浏览器自己的副本要等 max-age 过期（HTML 60 秒，其他资源 10 分钟）。');

    toast(`上传完成：${id}.${state.session.domain}`, 'success');
    resetSelection();
    await loadProjects();
  } catch (err) {
    log(`✗ ${err.message}`, 'err');
    toast(err.message, 'error');
    setStage(`失败：${err.message}`, 0);
  } finally {
    state.deploying = false;
    setBusy(false);
    disposeWorker();
  }
}

async function sendBatch(id, deploy, batch) {
  let lastError = null;

  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    const form = new FormData();
    form.append('deploy', deploy);
    for (let i = 0; i < batch.paths.length; i++) {
      // 服务端按「先 path 后 file」的成对顺序取值，不依赖 filename
      form.append('path', batch.paths[i]);
      form.append('file', batch.blobs[i], 'blob');
    }

    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(id)}/files`, {
        method: 'POST',
        body: form,
        credentials: 'same-origin',
      });
      const data = await response.json().catch(() => null);

      if (response.ok && data?.ok) return data;

      const message = data?.error || `上传失败（HTTP ${response.status}）`;
      // 这几类错误重试没有意义
      if ([400, 401, 409, 413].includes(response.status)) throw fatal(message);
      lastError = new Error(message);
    } catch (err) {
      if (err.fatal) throw err;
      lastError = err;
    }

    if (attempt < RETRY_MAX) {
      const wait = 500 * 2 ** (attempt - 1);
      log(`第 ${attempt} 批（${batch.count} 个文件）失败：${lastError.message} — ${wait}ms 后重试`);
      await sleep(wait);
    }
  }

  throw lastError || new Error('上传失败');
}

/** 把 Web Worker 的批次消息转成 async 生成器；每批被消费后才回 ack，形成回压。 */
async function* workerBatches(worker) {
  const queue = [];
  let wake = null;
  let finished = false;
  let failure = null;

  const notify = () => {
    if (wake) {
      const resolve = wake;
      wake = null;
      resolve();
    }
  };

  worker.onmessage = ({ data }) => {
    if (data.type === 'batch') queue.push(data);
    else if (data.type === 'done') finished = true;
    else if (data.type === 'error') {
      failure = new Error(data.message);
      finished = true;
    }
    notify();
  };
  worker.onerror = (event) => {
    failure = new Error(event.message || '解压 Worker 崩溃');
    finished = true;
    notify();
  };

  worker.postMessage({ type: 'start' });

  let previous = null;
  while (true) {
    // 上一批已经被消费完，现在才允许 Worker 继续解压下一批
    if (previous !== null) {
      worker.postMessage({ type: 'ack', index: previous });
      previous = null;
    }
    while (!queue.length && !finished) {
      await new Promise((resolve) => {
        wake = resolve;
      });
    }
    if (queue.length) {
      const batch = queue.shift();
      previous = batch.index;
      yield batch;
      continue;
    }
    if (failure) throw failure;
    return;
  }
}

async function* singleFileBatches(file) {
  const blob = new Blob([file], { type: 'text/html' });
  yield { index: 0, paths: ['index.html'], blobs: [blob], bytes: file.size, count: 1 };
}

function analyzeWithWorker(worker, file) {
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.type === 'plan') resolve(data);
      else if (data.type === 'error') reject(new Error(data.message));
    };
    worker.onerror = (event) => reject(new Error(event.message || '解压 Worker 启动失败'));
    file
      .arrayBuffer()
      .then((buffer) => worker.postMessage({ type: 'analyze', buffer }, [buffer]))
      .catch((err) => reject(new Error(`读取文件失败：${err.message}`)));
  });
}

function disposeWorker() {
  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
  }
}

function resetSelection() {
  state.file = null;
  state.plan = null;
  state.autoStart = false;
  $('fileNameLabel').textContent = '';
  $('planBox').hidden = true;
  $('uploadBtn').disabled = true;
  $('projectId').value = '';
  $('projectTitle').value = '';
  $('idHint').textContent = '';
}

function setBusy(busy) {
  dropzone.classList.toggle('disabled', busy);
  $('uploadBtn').disabled = busy;
  $('cancelBtn').hidden = !busy;
  $('progressWrap').hidden = false;
  if (!busy) setTimeout(() => { if (!state.deploying) $('progressWrap').hidden = true; }, 2500);
}

function setStage(text, ratio) {
  $('progressStage').textContent = text;
  $('progressPercent').textContent = `${Math.round(ratio * 100)}%`;
  $('progressFill').style.width = `${Math.max(0, Math.min(100, ratio * 100))}%`;
}

function resetLog() {
  const log = $('log');
  log.textContent = '';
  log.hidden = true;
}

function log(message, kind) {
  const box = $('log');
  box.hidden = false;
  const line = document.createElement('div');
  if (kind) line.className = kind;
  line.textContent = `${new Date().toLocaleTimeString('zh-CN', { hour12: false })}  ${message}`;
  box.append(line);
  box.scrollTop = box.scrollHeight;
}

// ------------------------------------------------------------------ 小工具

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'style') node.setAttribute('style', value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function code(text) {
  return el('code', { text: text });
}

function avatarStyle(id) {
  let hash = 0;
  for (const ch of String(id)) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return `background:linear-gradient(140deg,hsl(${hash} 62% 54%),hsl(${(hash + 46) % 360} 68% 44%))`;
}

/**
 * 拼出某个子域名的访问地址（label 为空即根域名的入口页）。
 * 本地开发时 ROOT_DOMAIN 是 localhost，必须沿用当前的协议和端口
 * （http://名字.localhost:8787/），否则会拼出一个访问不到的 https 地址。
 */
function hostFor(label) {
  const domain = state.session?.domain;
  if (!domain) return '';
  const here = location.hostname.toLowerCase();
  const isLocal = here === 'localhost' || here.endsWith('.localhost') || /^[\d.:]+$/.test(here);
  const port = location.port ? `:${location.port}` : '';
  const host = label ? `${label}.localhost${port}` : `localhost${port}`;
  return isLocal
    ? `${location.protocol}//${host}/`
    : `https://${label ? `${label}.` : ''}${domain}/`;
}

const projectUrl = (id) => hostFor(id);
const siteOrigin = () => hostFor('');

function slugifyClient(name) {  return String(name)
    .toLowerCase()
    .replace(/\.(zip|html?|htm)$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '');
}

async function looksLikeZip(file) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return head[0] === 0x50 && head[1] === 0x4b && [3, 5, 7].includes(head[2]);
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

function formatInt(n) {
  return (Number(n) || 0).toLocaleString('zh-CN');
}

function formatDate(timestamp) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
    + ' ' + new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fatal(message) {
  const err = new Error(message);
  err.fatal = true;
  return err;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板', 'success');
  } catch {
    toast(`复制失败，链接是：${text}`, 'error');
  }
}

let toastTimer = null;
function toast(message, kind = '') {
  const box = $('toast');
  box.textContent = message;
  box.className = `toast ${kind}`;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.hidden = true;
  }, kind === 'error' ? 6000 : 3200);
}

window.addEventListener('beforeunload', (event) => {
  if (state.deploying) {
    event.preventDefault();
    event.returnValue = '';
  }
});

init();
