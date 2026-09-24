-- 项目注册表。热路径（分发静态文件）每次只读一行，边缘缓存未命中时才真正落库。
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,                  -- 同时就是子域名的标签
  title       TEXT NOT NULL,                     -- 展示用标题
  entry       TEXT NOT NULL DEFAULT 'index.html',-- 访问 / 时返回的入口文件（相对项目根）
  file_count  INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  deploy_id   TEXT NOT NULL,                     -- 每次部署一个新的 id，用于清理上一版的残留文件
  status      TEXT NOT NULL DEFAULT 'uploading', -- uploading | ready
  source_name TEXT,                              -- 原始文件名，仅作记录
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_created ON projects (created_at DESC);
