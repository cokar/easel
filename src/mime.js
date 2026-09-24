// 扩展名 -> Content-Type。上传时写入 R2 的 httpMetadata，分发时优先用它；
// 这里同时作为老对象或元数据缺失时的回退表。

const TEXT = '; charset=utf-8';

const TYPES = {
  html: `text/html${TEXT}`,
  htm: `text/html${TEXT}`,
  xhtml: `application/xhtml+xml${TEXT}`,
  css: `text/css${TEXT}`,
  js: `text/javascript${TEXT}`,
  mjs: `text/javascript${TEXT}`,
  cjs: `text/javascript${TEXT}`,
  json: `application/json${TEXT}`,
  map: `application/json${TEXT}`,
  txt: `text/plain${TEXT}`,
  md: `text/markdown${TEXT}`,
  csv: `text/csv${TEXT}`,
  xml: `application/xml${TEXT}`,
  rss: `application/rss+xml${TEXT}`,
  atom: `application/atom+xml${TEXT}`,
  svg: `image/svg+xml${TEXT}`,
  webmanifest: `application/manifest+json${TEXT}`,

  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  tif: 'image/tiff',
  tiff: 'image/tiff',

  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',

  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',

  wasm: 'application/wasm',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  br: 'application/brotli',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
  epub: 'application/epub+zip',
};

export function extOf(path) {
  const name = String(path || '').split('/').pop() || '';
  const i = name.lastIndexOf('.');
  if (i < 0 || i === name.length - 1) return '';
  return name.slice(i + 1).toLowerCase();
}

export function contentTypeFor(path) {
  return TYPES[extOf(path)] || 'application/octet-stream';
}

const HTML_TYPES = new Set(['html', 'htm', 'xhtml']);

export function isHtmlPath(path) {
  return HTML_TYPES.has(extOf(path));
}

/**
 * 浏览器缓存时长。
 *
 * 这里只影响访客浏览器自己的副本，边缘缓存的失效由缓存键里的 deploy_id 负责
 * （见 serve.js），所以重新部署在边缘是立刻生效的，不需要把这两个值调小。
 * 浏览器这一侧没有内容哈希，只能靠短 TTL 自愈：
 *   HTML      60 秒   -> 重新部署后刷新一两次就能看到新内容
 *   其他资源  10 分钟 -> 换名字（如 app.2.css）可以立即绕过
 */
export function cacheControlFor(path) {
  return isHtmlPath(path) ? 'public, max-age=60' : 'public, max-age=600';
}
