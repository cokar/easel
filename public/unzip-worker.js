// 在 Web Worker 里解压 ZIP。
//
// 为什么不在服务端做：Cloudflare Workers 免费版每次调用只有 10ms CPU、128MB 内存、
// 50 个子请求，服务端解压稍大的包必然 1102 超时。放到浏览器里，这三条限制就都不存在了。
//
// 两遍扫描：
//   1) analyze —— 用 unzipSync 的 filter 只读中央目录（不展开数据）拿到完整清单，
//      据此决定「要不要剥掉顶层目录」和「入口文件是哪个」。
//   2) stream  —— 流式解压，边解边按批（≤40 个文件 / ≤20MB）发给主线程上传，
//      每批等主线程回 ack 再继续喂数据，避免把整个包同时摊在内存里。

import { unzipSync, Unzip, UnzipInflate } from './vendor/fflate.js';

const MAX_FILES = 5000;
const MAX_TOTAL_BYTES = 300 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const BATCH_FILES = 40;
const BATCH_BYTES = 20 * 1024 * 1024;
const PUSH_CHUNK = 1 << 20; // 1MB：每喂一块就检查一次有没有批次可以交出去

// 操作系统/版本控制产生的垃圾文件，直接丢弃（丢弃数量会回报给界面）。
const JUNK = [
  /^__MACOSX\//i,
  /(^|\/)\.DS_Store$/i,
  /(^|\/)Thumbs\.db$/i,
  /(^|\/)desktop\.ini$/i,
  /(^|\/)\._[^/]*$/, // AppleDouble
  /(^|\/)\.git\//i,
  /(^|\/)\.svn\//i,
  /(^|\/)\.hg\//i,
];

const ackResolvers = new Map();
let abortRequested = false;
let plan = null;
let sourceBuffer = null;

function isJunk(name) {
  return JUNK.some((re) => re.test(name));
}

/** 归一化条目路径；越界或非法返回 null，目录条目返回 ''。 */
function normalizePath(name) {
  let p = String(name).replace(/\\/g, '/');
  if (p.startsWith('/')) p = p.slice(1);
  const parts = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') return null;
    parts.push(seg);
  }
  return parts.join('/');
}

/** 所有条目都在同一个顶层目录下就剥掉它（打包时最常见的形态）。 */
function detectPrefix(entries) {
  const firstSegments = new Set(entries.map((e) => e.path.split('/')[0]));
  if (firstSegments.size !== 1) return '';
  const [seg] = [...firstSegments];
  if (!seg) return '';
  if (!entries.every((e) => e.path.includes('/'))) return '';
  return `${seg}/`;
}

/** 挑入口文件：优先根目录的 index.html，其次浅层的 home/default/main。 */
function detectEntry(entries) {
  const htmls = entries.filter((e) => /\.html?$/i.test(e.path));
  if (!htmls.length) return null;

  const score = (p) => {
    const base = p.split('/').pop().toLowerCase();
    const depth = p.split('/').length - 1;
    let value = 0;
    if (base === 'index.html' || base === 'index.htm') value += 1000;
    else if (base === 'home.html') value += 500;
    else if (base === 'default.html') value += 400;
    else if (base === 'main.html') value += 300;
    return value - depth * 10 - p.length * 0.01;
  };

  htmls.sort((a, b) => score(b.path) - score(a.path));
  return htmls[0].path;
}

function analyze(buffer) {
  const rawEntries = [];
  try {
    unzipSync(new Uint8Array(buffer), {
      // 返回 false = 不展开数据，所以这一遍只读中央目录，很快
      filter: (file) => {
        if (!file.name.endsWith('/')) {
          rawEntries.push({ name: file.name, size: file.originalSize || 0 });
        }
        return false;
      },
    });
  } catch (err) {
    throw new Error(`无法解析这个压缩包：${err?.message || err}（加密包或损坏的文件不支持）`);
  }

  if (!rawEntries.length) throw new Error('压缩包是空的，或者里面只有目录');

  let skipped = 0;
  const entries = [];
  for (const entry of rawEntries) {
    if (isJunk(entry.name)) {
      skipped++;
      continue;
    }
    const path = normalizePath(entry.name);
    if (!path) {
      skipped++;
      continue;
    }
    entries.push({ path, size: entry.size });
  }
  if (!entries.length) throw new Error('压缩包里没有可用的文件（可能只包含系统垃圾文件）');

  const prefix = detectPrefix(entries);
  const stripped = prefix
    ? entries.map((e) => ({ path: e.path.slice(prefix.length), size: e.size })).filter((e) => e.path)
    : entries;

  const entry = detectEntry(stripped);
  if (!entry) throw new Error('压缩包里找不到 .html 文件，无法确定入口页面');
  if (stripped.length > MAX_FILES) {
    throw new Error(`文件太多：${stripped.length} 个，单个项目上限 ${MAX_FILES} 个`);
  }

  const totalBytes = stripped.reduce((sum, e) => sum + e.size, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error(`解压后约 ${Math.round(totalBytes / 1024 / 1024)}MB，超过 300MB 上限，请拆分后分项目上传`);
  }

  return {
    prefix,
    entry,
    fileCount: stripped.length,
    totalBytes,
    archiveBytes: buffer.byteLength,
    skipped,
  };
}

function concat(chunks, total) {
  if (!chunks.length) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function stream(buffer, prefix, onBatch) {
  let pending = [];
  let pendingBytes = 0;
  let batchIndex = 0;
  let totalWritten = 0;
  let fileCount = 0;
  let totalBytes = 0;
  const queue = [];
  const current = { path: null, chunks: null, bytes: 0 };

  function makeBatch() {
    const batch = {
      index: batchIndex++,
      paths: pending.map((f) => f.path),
      blobs: pending.map((f) => f.blob),
      bytes: pendingBytes,
      count: pending.length,
    };
    pending = [];
    pendingBytes = 0;
    return batch;
  }

  function flushIfFull() {
    if (!pending.length) return;
    if (pending.length < BATCH_FILES && pendingBytes < BATCH_BYTES) return;
    queue.push(makeBatch());
  }

  // 队列里有批次就传走。push 是同步的，所以 drain 被调用时该攒的已经攒好了。
  async function drain() {
    while (queue.length) {
      if (abortRequested) throw new Error('上传已取消');
      const batch = queue.shift();
      totalWritten += batch.bytes;
      await onBatch(batch);
    }
  }

  const unzipper = new Unzip((file) => {
    const normalized = normalizePath(file.name);
    if (!normalized || isJunk(file.name)) return; // 不调用 start() 即为跳过
    if (prefix && !normalized.startsWith(prefix)) return;
    const path = prefix ? normalized.slice(prefix.length) : normalized;
    if (!path) return;

    current.path = path;
    current.chunks = [];
    current.bytes = 0;

    file.ondata = (err, chunk, final) => {
      if (err) {
        current.path = null;
        return;
      }
      if (chunk && chunk.length) {
        current.chunks.push(chunk);
        current.bytes += chunk.length;
        // 增量检查，避免坏包/超大条目把内存吃光
        if (current.bytes > MAX_FILE_BYTES) {
          throw new Error(`单个文件超出 50MB 上限：${current.path}`);
        }
      }
      if (!final || !current.path) return;

      const bytes = concat(current.chunks, current.bytes);
      totalBytes += bytes.length;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error('解压后总体积超过 300MB 上限，请拆分后分项目上传');
      }
      pending.push({ path: current.path, blob: new Blob([bytes]) });
      pendingBytes += bytes.length;
      fileCount++;
      current.path = null;
      current.chunks = null;
      flushIfFull();
    };

    file.start();
  });

  unzipper.register(UnzipInflate);

  const view = new Uint8Array(buffer);
  for (let offset = 0; offset < view.length; offset += PUSH_CHUNK) {
    const end = Math.min(offset + PUSH_CHUNK, view.length);
    unzipper.push(view.subarray(offset, end), end >= view.length);
    // 每喂一块就检查一次：攒够一批先传走再继续解压，
    // 因此内存里最多只有一个批 + 一个正在解的文件。
    await drain();
  }

  // 收尾：把最后不足一批的余数交出去。
  // 必须判空 —— 文件数正好是 BATCH_FILES 的整数倍时（40、80…），
  // 最后一批已经在 flushIfFull 里交出去了，这里再 push 会造出一个空批次，
  // 服务端会以「这一批没有任何文件」拒掉，导致整个上传白跑。
  if (pending.length) queue.push(makeBatch());
  await drain();
  return { fileCount, totalBytes, totalWritten };
}

// ------------------------------------------------------------------ 消息协议

self.onmessage = async (event) => {
  const message = event.data || {};

  if (message.type === 'analyze') {
    sourceBuffer = message.buffer;
    try {
      plan = analyze(sourceBuffer);
      self.postMessage({ type: 'plan', ...plan });
    } catch (err) {
      self.postMessage({ type: 'error', message: err?.message || String(err) });
    }
    return;
  }

  if (message.type === 'start') {
    if (!plan || !sourceBuffer) {
      self.postMessage({ type: 'error', message: '内部状态错误：还没有分析压缩包' });
      return;
    }
    try {
      const result = await stream(sourceBuffer, plan.prefix, async (batch) => {
        self.postMessage({ type: 'batch', ...batch });
        // 等主线程把这一批传完再继续解压，形成回压
        await new Promise((resolve) => {
          ackResolvers.set(batch.index, resolve);
        });
      });
      self.postMessage({ type: 'done', ...result });
    } catch (err) {
      self.postMessage({ type: 'error', message: err?.message || String(err) });
    }
    return;
  }

  if (message.type === 'ack') {
    const resolve = ackResolvers.get(message.index);
    if (resolve) {
      ackResolvers.delete(message.index);
      resolve();
    }
    return;
  }

  if (message.type === 'abort') {
    abortRequested = true;
    for (const resolve of ackResolvers.values()) resolve();
    ackResolvers.clear();
  }
};
