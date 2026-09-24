// 把 fflate 的浏览器版 ESM 单文件拷进 public/vendor/，
// 这样前端 Web Worker 可以直接 `import` 它，不需要任何打包器（也没有 CDN 外部依赖）。
import { mkdir, copyFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'node_modules/fflate/esm/browser.js');
const dest = resolve(root, 'public/vendor/fflate.js');

try {
  await access(src);
} catch {
  console.error('[vendor] 找不到 node_modules/fflate/esm/browser.js');
  console.error('[vendor] 请先执行：npm install');
  process.exit(1);
}

await mkdir(dirname(dest), { recursive: true });
await copyFile(src, dest);
console.log(`[vendor] ${src} -> ${dest}`);
