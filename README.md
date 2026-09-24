# Easel

上传一个 ZIP（或单个 HTML 文件），得到一个 `<项目名>.你的域名`。整套东西跑在 Cloudflare 免费额度内，成本 $0，上线只需要一条 `npm run deploy`。

访客看到的是根域名上的**入口页**：列出所有托管中的页面，点开任意一个直接浏览，右上角有进管理后台的入口。你自己在 `admin.<你的域名>` 上传和删除。

核心取舍只有一句话：**解压放在浏览器里做，不放服务端**。Workers 免费版每次调用只有 10ms CPU、128MB 内存、50 个子请求，服务端解压稍大的包必然超时；挪到浏览器之后这三条限制全部消失，而且 R2 本身没有 25MiB 单文件限制，能托管的项目比"每个项目建一个 Pages 站点"的方案宽得多。

---

## 目录

- [它是怎么工作的](#它是怎么工作的)
- [上线步骤（从零开始）](#上线步骤从零开始)
- [日常使用](#日常使用)
- [本地开发与测试](#本地开发与测试)
- [免费额度核算](#免费额度核算)
- [已知的取舍与限制](#已知的取舍与限制)
- [故障排查](#故障排查)
- [目录结构](#目录结构)

---

## 它是怎么工作的

| 环节 | 由谁负责 |
| :--- | :--- |
| 解压 ZIP | 你的浏览器（`public/unzip-worker.js`，用 fflate 在 Web Worker 里流式解压） |
| 分片上传 | 浏览器按「≤40 个文件 / ≤20MB」一批推给 `/api/projects/<名字>/files` |
| 存文件 | Worker 把每个文件写到 R2，键是 `<项目名>/<路径>` |
| 存元数据 | D1（入口文件名、文件数、体积、部署版本） |
| 对外入口页 | 根域名上由 Worker 渲染项目列表 + 后台入口（`src/landing.js`） |
| 分发访问 | 同一个 Worker 按 Host 取项目名 → 读 R2 → 按 `deploy_id` 做边缘缓存 |

三个 Host 各司其职，只需要两条路由（都由部署脚本从 `ROOT_DOMAIN` 自动生成）：

```
<你的域名>            ->  对外入口页（项目列表 + 后台入口）     路由：<域名>/*
admin.<你的域名>      ->  管理后台界面 + /api/*               路由：*.<域名>/*
<项目名>.<你的域名>    ->  该项目在 R2 里的静态文件  ─────────┘
```

通配路由**不匹配根域名本身**，所以根域名那条必须单独写一条。两条都是 zone route，因此不会撞上"每个域名 100 个自定义域名"的上限。

管理后台由 Worker 自己托管（Workers Static Assets），不用 Cloudflare Pages —— Pages 不支持通配自定义域名，而且有 100 个项目 / 20000 文件 / 每月 500 次构建的限制。

**为什么选子域名而不是路径**：子域名天然隔离，项目里的 `/style.css` 这类绝对路径不会串到别的项目，不需要改写 HTML，也不用担心 `<base>`。

---

## 上线步骤（从零开始）

全新账号大约 15 分钟。下面每一步都给出实际命令、预期输出和常见报错 —— 建议按顺序走，每步验证过再进行下一步，出问题能立刻定位到环节。

<details>
<summary>已经熟悉 wrangler 的话，最短路径（点开）</summary>

```bash
npm install
npx wrangler login
npx wrangler r2 bucket create <全局唯一的桶名>
npx wrangler d1 create html-hosting
# ↓ 把上面两条命令的输出填进 wrangler.jsonc 的 bucket_name / database_id，并改 ROOT_DOMAIN
npm run db:remote
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put AUTH_SECRET
npm run deploy
# ↓ 还差 Dashboard 里的两条 DNS 记录（* 和 @，都要开橙云）
```

</details>

### 第 0 步：准备账号、域名和环境

**0.1 Cloudflare 账号**

没有就去 [dash.cloudflare.com](https://dash.cloudflare.com) 注册，免费套餐足够。

**0.2 域名必须已经托管在 Cloudflare**

判断方法：Dashboard 首页能看到这个域名，且状态是「有效 / Active」。域名在别处注册的话，需要先把 NS 改成 Cloudflare 给的那两个地址，等生效（通常几分钟，最长 24 小时）。

为什么必须：本项目靠 Workers 路由（`*.<域名>/*`）工作，只有托管在 Cloudflare 的域名才能配路由，也才能拿到 `*.<域名>` 的免费证书。

**0.3 开通 R2 订阅**

R2 即使只用免费额度，也要先在账号里**走一次开通流程**：

Dashboard → 左侧 **Storage & databases** → **R2** → **Overview** → 按提示完成 checkout。

这一步会要求添加支付方式。免费额度内的用量（10GB 存储 + 每月 100 万次 A 类 + 1000 万次 B 类操作）不产生费用，但**不做这一步，第 1 步创建桶会直接失败**。

**0.4 Node 环境与 wrangler 登录**

```bash
node --version          # 需要 18 以上（本机验证用的是 v26）
npm install             # 装 fflate / wrangler，并把 fflate 拷进 public/vendor/
npx wrangler login      # 会打开浏览器要求授权
npx wrangler whoami     # 确认已登录，并核对是你要用的那个账号
```

`wrangler whoami` 会列出账号名和账号 ID。**如果你有多个 Cloudflare 账号，这一步一定要看清**，后面所有资源都会建在它下面。未登录时它会提示 `You are not authenticated`。

### 第 1 步：创建 R2 桶

```bash
npx wrangler r2 bucket create <你的桶名>
```

桶名规则（Cloudflare 强制）：

- **全球唯一** —— 所有 Cloudflare 用户共用一个命名空间，`html-hosting`、`static`、`files` 这类名字基本都被占了
- 3–63 个字符，只能用小写字母、数字、连字符，首尾必须是字母或数字
- 建议加个随机后缀，例如 `html-hosting-a7f3c1`

命令输出会显示桶名和位置提示（location hint）。成功后把桶名填进 `wrangler.jsonc`：

```jsonc
  "r2_buckets": [
    {
      "binding": "BUCKET",
      "bucket_name": "html-hosting-a7f3c1"   // ← 改成你刚创建的那个名字
    }
  ],
```

验证：

```bash
npx wrangler r2 bucket list      # 应该能看到刚建的桶
```

> 别用 `--update-config` 让 wrangler 自动改配置：它会直接重写 `wrangler.jsonc`、把里面的注释丢掉。手工粘贴上面这一处更稳妥。

**常见报错**：提示需要 R2 订阅 → 第 0.3 步没做。

### 第 2 步：创建 D1 数据库

```bash
npx wrangler d1 create html-hosting
```

（数据库名可以改，但改了三处都要跟着改：`wrangler.jsonc` 的 `database_name`，以及 `package.json` 里 `db:local` / `db:remote` 两条脚本中的 `html-hosting`。）

命令会输出一段可直接粘贴的配置片段，里面有一个 `database_id`（形如 `a1b2c3d4-0000-1111-2222-333344445555`）。**复制那个 id**，填进 `wrangler.jsonc`：

```jsonc
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "html-hosting",
      "database_id": "a1b2c3d4-0000-1111-2222-333344445555"   // ← 替换掉 REPLACE_WITH_YOUR_D1_DATABASE_ID
    }
  ],
```

验证：

```bash
npx wrangler d1 list
```

> 注意区分：`database_name` 是给人看的名字（账号内唯一），`database_id` 是 UUID（全局标识）。要填的是 **id**。

### 第 3 步：建表

```bash
npm run db:remote
```

实际执行的是 `wrangler d1 execute html-hosting --remote --file=schema.sql -y`，只做一件事：在**线上** D1 里建 `projects` 表和索引。语句是 `CREATE TABLE IF NOT EXISTS`，重复执行也安全。

预期输出里有 `2 commands executed successfully`。

验证表确实建好了：

```bash
npx wrangler d1 execute html-hosting --remote --command "SELECT name FROM sqlite_master WHERE type='table'"
```

应该看到 `projects`。

**常见报错**：后台报 `no such table: projects` → 这一步没做，或者做成了 `--local`。本地开发用 `npm run db:local`，两者互不影响。

### 第 4 步：填配置变量

打开 `wrangler.jsonc` 的 `vars`：

| 变量 | 默认值 | 要不要改 | 说明 |
| :--- | :--- | :--- | :--- |
| `ROOT_DOMAIN` | `example.com` | ⚠️ **必改** | 你的域名。两条路由（`<域名>/*` 和 `*.<域名>/*`）都由它自动推导，**不要另外去配 routes** |
| `ADMIN_SUBDOMAIN` | `admin` | 一般不用 | 后台所在子域名，即 `admin.<域名>` |
| `SITE_TITLE` | `我的网页收藏` | 建议改 | 入口页大标题，也用作浏览器标签页标题 |
| `SITE_DESCRIPTION` | 一句话 | 建议改 | 入口页标题下方的描述，同时作为页面 SEO 描述 |
| `LANDING_AT_APEX` | `true` | 视情况 | 见下方说明 |

改完大概长这样：

```jsonc
  "vars": {
    "ROOT_DOMAIN": "mydomain.dev",
    "ADMIN_SUBDOMAIN": "admin",
    "SITE_TITLE": "我的网页收藏",
    "SITE_DESCRIPTION": "这里托管着我收集的静态页面，点开任意一个都能直接浏览。",
    "LANDING_AT_APEX": true
  }
```

**`LANDING_AT_APEX` 什么时候改成 `false`**：入口页要放在根域名，就需要一条 `<域名>/*` 路由，而这条路由会**把根域名上原本的站点顶掉**。如果你的根域名上已经挂着博客或其他服务，改成 `false` —— 部署脚本就只生成通配路由，入口页改用 `www.<域名>` 或任意子域名访问。

### 第 5 步：加 DNS 记录

Dashboard → 选中你的域名 → 左侧 **DNS** → **Records** → **Add record**，加两条：

| 类型 | 名称（Name）| IPv4 地址 | 代理状态 |
| :--- | :--- | :--- | :--- |
| `A` | `*` | `192.0.2.1` | **Proxied（橙云）** |
| `A` | `@` | `192.0.2.1` | **Proxied（橙云）** |

三个要点：

- **IP 为什么可以随便填**：这两个主机名的请求会被 Worker 路由截获，永远不会回源，IP 是什么根本到不了。`192.0.2.1` 是 RFC 5737 保留给文档示例的地址，不会撞上真实主机。
- **为什么必须开橙云**：只有被代理（橙云）的请求才会经过 Cloudflare 边缘，才能命中 Worker 路由、才能用上 `*.<域名>` 的免费证书。灰云（DNS only）会让请求直接去连那个不存在的 IP，结果是连接失败。
- **`@` 那条**只在入口页放根域名时才需要；`LANDING_AT_APEX=false` 就跳过。**根域名若已有记录（比如指向你的博客），不要动它。**

关于 SSL/TLS 模式：这两个主机名都由 Worker 直接处理、不回源，所以 Flexible / Full 在这里没有区别，不用改。

验证 DNS 已生效（可能需要等一两分钟）：

```bash
nslookup anything.mydomain.dev
```

返回 **Cloudflare 的 IP**（而不是 `192.0.2.1`）就说明代理生效了。

### 第 6 步：设置两个密钥

这两个是 Worker Secret，存在 Cloudflare 侧、不属于代码库。它们**不是** `vars` —— `vars` 会明文写进配置文件，只能放非敏感内容。

```bash
npx wrangler secret put ADMIN_PASSWORD
```

回车后提示 `Enter a secret value:`，**粘贴你的后台口令**再回车（输入过程不回显）。这个口令就是你登录 `admin.<域名>` 用的那个。

```bash
# 先生成一个 64 位随机串
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 再把上面输出的串粘贴进去
npx wrangler secret put AUTH_SECRET
```

`AUTH_SECRET` 用于给会话 Cookie 签名，和登录口令是两回事，泄露它等同于泄露后台。

验证：

```bash
npx wrangler secret list      # 应该列出 ADMIN_PASSWORD 和 AUTH_SECRET
```

几个要点：

- **不要在命令行参数里传口令**（比如 `echo "xxx" | wrangler secret put ...`），那样会留在 shell 历史里。交互式粘贴最安全。
- Secret 存在 Cloudflare 侧，**后续 `wrangler deploy` 不会覆盖或清掉它们**，只有再执行一次 `secret put` 才会改。
- 首次部署前必须先设好，否则后台会提示"服务端未设置 ADMIN_PASSWORD"。
- 本地开发读的是 `.dev.vars` 里的同名变量，与线上互不影响。

### 第 7 步：部署

```bash
npm run deploy
```

这条命令串了三步，任何一步失败都会停下：

1. `node scripts/preflight.mjs` —— 检查占位值是否已改（`ROOT_DOMAIN`、`database_id`）、`public/vendor/fflate.js` 是否存在。不通过会打印**具体要改哪一行**然后退出。
2. `node scripts/build-config.mjs` —— 从 `ROOT_DOMAIN` 生成 `wrangler.deploy.jsonc`，把两条路由写进去。这是生成物，已在 `.gitignore` 里，不要手改。
3. `wrangler deploy -c wrangler.deploy.jsonc` —— 真正上传。

预期输出（关键几行；`Total Upload` 那行是实测值，路由列表的文字以 wrangler 版本为准）：

```
✔ 配置检查通过（域名 mydomain.dev，桶 html-hosting-a7f3c1）
✔ 已生成 wrangler.deploy.jsonc（路由 mydomain.dev/* + *.mydomain.dev/*）
Total Upload: 53.58 KiB / gzip: 16.69 KiB
Deployed html-hosting triggers
  mydomain.dev/*
  *.mydomain.dev/*
```

**只要最后能看到你期望的两条路由**（`<域名>/*` 和 `*.<域名>/*`），就说明路由挂上了。

**常见报错**：

| 报错 | 原因 |
| :--- | :--- |
| `vars.ROOT_DOMAIN 还是占位值 "example.com"` | 第 4 步没做 |
| `d1_databases[0].database_id 还没填` | 第 2 步的 id 没填 |
| `✖ 缺少 public/vendor/fflate.js，请先执行：npm run vendor` | 没跑 `npm install`（或 `npm run vendor`） |
| `Could not find zone "mydomain.dev"` | 域名不在当前账号下，或 `wrangler whoami` 是另一个账号 |
| `A worker with the name "html-hosting" already exists` | 账号里已有同名 Worker：删掉它，或改 `wrangler.jsonc` 的 `name` |
| 提示超出账号 Worker 数量上限 | 免费套餐上限 100 个 Worker |

查部署状态：

```bash
npx wrangler deployments list     # 最近 10 次部署
npx wrangler deployments status   # 当前线上生效的版本
```

### 第 8 步：逐个验证

按顺序来，每步确认了再往下，出问题能立刻定位。

**8.1 入口页** —— 浏览器打开 `https://你的域名/`

预期：入口页（大标题 + 空状态"还没有托管任何页面" + 右上角「管理后台」）。

| 现象 | 原因 |
| :--- | :--- |
| 404 | 根域名的 `@` DNS 记录没加或没开代理；或 `LANDING_AT_APEX=false` |
| 显示的是别的站点 | 根域名本来就有记录，路由没生效 —— 检查 `@` 指向了哪里 |
| `ERR_TOO_MANY_REDIRECTS` | 别处配了重定向规则（如 Always Use HTTPS + 页面规则冲突） |

**8.2 后台** —— 点右上角「管理后台」，或直接开 `https://admin.你的域名/`

预期：登录界面；输入第 6 步的口令后进入控制台。

| 现象 | 原因 |
| :--- | :--- |
| 提示"服务端未设置 ADMIN_PASSWORD" | 第 6 步的 secret 没设，或设完没重新部署 |
| 提示"口令不正确" | 口令不对（大小写、首尾空格都算） |
| 页面一直转圈 | 开浏览器控制台看 `/api/session` 报什么错 |

**8.3 上传第一个项目**

在后台拖一个 ZIP 上去（手边没有就随意压一个含 `index.html` 的文件夹）。观察四件事：

1. 选完文件立刻出现探测结果：入口文件、文件数量、解压后体积
2. 点「开始上传」，进度条走到 100%
3. 日志出现 `✓ 上线：https://<项目名>.你的域名/`
4. 项目列表里出现卡片

**8.4 打开项目** —— 点卡片上的「打开」

预期：新标签页打开 `https://<项目名>.你的域名/`，显示你上传的页面。

| 现象 | 原因 |
| :--- | :--- |
| 证书错误 / `ERR_SSL_VERSION_OR_CIPHER_MISMATCH` | 通配证书还在签发（Universal SSL 通常几分钟，最长 24 小时）；或子域名超过一层 |
| 404「项目不存在」 | 子域名和项目名对不上，核对卡片上的地址 |
| 一直显示"正在部署" | 上次上传中断了，重新部署一次即可覆盖 |

**8.5 回入口页** —— 刷新 `https://你的域名/`

预期：新项目出现在列表里。入口页给浏览器缓存了 60 秒，等一会儿或加 `?v=1` 立刻看到。

### 部署后建议做的一件事：给登录接口限流

口令只有一层保护。代码里有常量时间比较和单 isolate 内的尝试节流，但没有全局限流。免费套餐含 1 条 WAF 速率限制规则，加一条就够：

Dashboard → 你的域名 → **Security** → **WAF** → **Rate limiting rules** → **Create rule**

- 匹配条件：`URI Path` 等于 `/api/login`
- 阈值：例如「60 秒内超过 10 次请求」
- 动作：Block，持续 60 秒

### 以后怎么更新

| 你想做什么 | 怎么做 |
| :--- | :--- |
| 改代码（`src/`、`public/`） | `npm run deploy` |
| 改入口页文案 | 改 `wrangler.jsonc` 的 `SITE_TITLE` / `SITE_DESCRIPTION` → `npm run deploy`（访客侧最多 60 秒后生效） |
| 换域名 | 改 `ROOT_DOMAIN` → 给新域名加两条 DNS 记录 → `npm run deploy`。旧域名的路由会被移除，但旧 DNS 记录要自己删 |
| 改后台口令 | `npx wrangler secret put ADMIN_PASSWORD`（**不需要**重新部署） |
| 增删项目、重新部署项目 | 全在后台界面操作，不涉及 `npm run deploy` |
| 回滚到上一个版本 | `npx wrangler rollback`，或 Dashboard → Workers → 该 Worker → Deployments → 选历史版本 Rollback |

### 想彻底卸载

```bash
npx wrangler delete                       # 删 Worker（路由一并移除）
npx wrangler r2 bucket delete <桶名>       # 删桶（需先清空里面的对象）
npx wrangler d1 delete html-hosting       # 删数据库
```

最后回 Dashboard 的 DNS 页面手动删掉那两条 `A` 记录。

---

## 日常使用

**对访客**（`https://你的域名/`）：

- 列出所有托管中的页面，点卡片直接打开
- 顶部有搜索框（按 `/` 聚焦，`Esc` 清空），项目多了也能快速找到
- 右上角「管理后台」是给你用的入口

**对你**（`https://admin.<你的域名>/`）：

- **上传新项目**：拖入 ZIP 或点选文件。项目名会自动从文件名推导，可以改。界面会先显示探测结果（入口文件、文件数量、解压后体积、是否剥掉了顶层目录、忽略了几个系统垃圾文件），确认后再上传。
- **项目卡片**：打开 / 复制链接 / 重新部署（覆盖） / 删除。
- 顶栏「查看入口页」可以直接跳到访客看到的那一页。
- 上传进度和每一步的结果都写在日志区，失败会自动重试 3 次（指数退避）。

**自动处理的事情**：

- 剥离 ZIP 里常见的单层顶层目录（`mysite/index.html` → `index.html`）
- 丢弃 `__MACOSX/`、`.DS_Store`、`Thumbs.db`、`desktop.ini`、`._*`、`.git/` 等垃圾
- 丢弃带 `..` 或绝对路径的条目（防路径穿越）
- 入口文件探测：优先根目录 `index.html`，其次浅层的 `home/default/main.html`
- 覆盖部署时按 `deploy_id` 清理上一版残留的文件
- 入口页只列出部署完成的项目，上传中的不会露出来

**URL 行为**：

- `/` → 入口文件
- `/about` → 先试 `about/index.html`，再试 `about.html`
- 找不到时，如果项目里有 `404.html` 就返回它
- 加 `?fresh=1` 绕过所有缓存，用来核对线上内容

---

## 本地开发与测试

```bash
cp .dev.vars.example .dev.vars      # 本地密钥模板，已在 .gitignore 里
npm run db:local                     # 给本地 D1 建表
npm run dev                          # http://127.0.0.1:8787
```

本地不需要 Cloudflare 账号 —— Miniflare 会在 `.wrangler/state` 里模拟 R2 和 D1。

**本地有两个入口**（Chrome 会把 `*.localhost` 解析到 `127.0.0.1`）：

| 看什么 | 地址 |
| :--- | :--- |
| 访客视角的入口页 | `http://127.0.0.1:8787/` 或 `http://localhost:8787/` |
| 管理后台 | `http://admin.localhost:8787/` |
| 某个项目 | `http://<项目名>.localhost:8787/` |

`.dev.vars` 里把 `ROOT_DOMAIN` 设成 `localhost` 就是为了让这三者各归其位。

> 本地改了入口页的文案后如果没看到变化，是浏览器缓存了 60 秒 —— 加个 `?v=1` 之类的查询串就能立刻看到。

**自动化冒烟测试**：另开一个终端跑 `npm run dev`，然后

```bash
npm run smoke
```

会用真实 ZIP 走完整流程，覆盖 60 项断言：鉴权、项目名校验、路径穿越拦截、分片上传、入口文件校验、子域名分发、Content-Type、ETag 304、无扩展名回退、404、对外入口页（含「admin 子域名不被入口页顶掉」这条回归）、覆盖部署与残留清理、边缘缓存命中/绕过、删除。改完代码跑一遍，比手点可靠。

> ⚠️ 一个容易踩的坑：**不要把 `routes` 写回 `wrangler.jsonc`**。只要配置里存在 routes，`wrangler dev` 的本地服务器就会把所有请求的 Host 重写成路由域名（实测会把任何 Host 变成 `example.com`），于是本地完全没法测试子域名分发。这就是路由被挪到部署时生成的原因，详见 `scripts/build-config.mjs` 顶部注释。

---

## 免费额度核算

以 200 个项目、每个 1000 个文件共 5MB 计：

| 项目 | 用量 | 免费额度 | 余量 |
| :--- | :--- | :--- | :--- |
| R2 存储 | 1 GB | 10 GB / 月 | 10% |
| R2 A 类操作（上传、列出、删除） | 约 20 万 / 月 | 100 万 / 月 | 20% |
| R2 B 类操作（读取） | 边缘缓存未命中才计 | 1000 万 / 月 | 充裕 |
| D1 读 | 每个资源请求 1 次（用于取 `deploy_id`），入口页每次 1 次 | 500 万 / 天 | 充裕 |
| D1 写 | 每次部署 2~3 次 | 10 万 / 天 | 充裕 |
| **Workers 请求** | **每访问一个资源算 1 次**，入口页每次 1 次 | **10 万 / 天** | **最先撞墙** |

**最需要留意的一条**：边缘缓存能减少 R2 读取、降低延迟，但**不能减少 Worker 的请求计数** —— 一个含 20 个资源的页面每天被访问 5000 次就吃满 10 万/天，之后当天返回错误页。个人收藏夹的流量下够用；如果要分享给较多人，唯一的现实付费点是升级 Workers Paid（$5/月，含 1000 万请求/月）。

另外 R2 免费额度只适用于 Standard 存储，出口流量免费。

---

## 已知的取舍与限制

- **浏览器缓存有延迟**：边缘缓存按 `deploy_id` 换键，重新部署在边缘是**立刻全局生效**的；但访客浏览器自己的副本要等 `max-age` 过期（HTML 60 秒，其他资源 10 分钟）。给资源换文件名可以立刻绕过。想调这两个值改 `src/mime.js` 的 `cacheControlFor`。入口页同理缓存 60 秒（改文案后加 `?v=1` 可立刻看到）。
- **单次上传体积上限**：单文件 ≤50MB、单批 ≤30MB、单项目解压后 ≤300MB、≤5000 个文件。这些是浏览器内存和 Workers 请求体（100MB）限制推导出来的，常量写在 `public/unzip-worker.js` 和 `src/api.js` 顶部。
- **口令暴力破解防护有限**：只有常量时间比较 + 单 isolate 内的尝试节流，没有全局限流。建议在 Dashboard → Security → WAF → Rate limiting rules 里对 `/api/login` 加一条规则（免费套餐含 1 条）。
- **项目名必须是合法 DNS 标签**：小写字母数字与连字符，≤40 字符，不能连续连字符，且不能在保留名单里（`www`/`admin`/`api`/`mail` 等，见 `src/util.js`）。
- **`www.<域名>` 会 302 到根域名**，不参与托管。
- **会话 Cookie 有效期 7 天**，过期后重新登录。

**刻意不做的事**：不改写项目内的绝对路径引用（子域名方案天然隔离，这正是选它的原因）、不做多用户注册、不做访问统计、不生成缩略图、默认不保留原始 ZIP。

---

## 故障排查

| 现象 | 原因 |
| :--- | :--- |
| 访问 `<项目>.<域名>` 显示的是管理后台 | `vars.ROOT_DOMAIN` 和实际域名不一致，或通配 DNS 记录没建/没开代理 |
| 根域名打开是 404，或还是原来那个站点 | 根域名的 A 记录（名称 `@`）没建或没开代理，或者 `LANDING_AT_APEX` 是 `false` 而根域名没走 Worker |
| 改了 `SITE_TITLE` 但入口页没变 | 入口页给浏览器缓存了 60 秒，等一会儿或加 `?v=1` 强制刷新 |
| 某个项目没出现在入口页 | 它还在上传中（`status != ready`），部署完成才会出现 |
| `npm run deploy` 报 zone not found | 域名不在当前登录的账号下，或 `wrangler login` 登错了账号 |
| 后台提示"服务端未设置 ADMIN_PASSWORD" | 第 6 步的 secret 没设，或没重新部署 |
| 上传到一半失败 | 单批请求超限（多半是单文件超过 50MB，或某批总字节超 30MB）；日志区会写明是哪一批 |
| 部署一直停在"正在部署" | 上次上传中断了。重新部署一次即可覆盖 |
| 内容更新了但页面没变 | 先加 `?fresh=1` 排除边缘缓存；如果是浏览器自己的副本，等 max-age 过期或强制刷新 |
| 项目名提示"已被占用" | 名字被别的项目用了。删掉旧项目或换个名字 |
| 想换成另一个域名 | 改 `wrangler.jsonc` 的 `ROOT_DOMAIN` → 建新的 DNS 记录（根域名 + 通配两条）→ `npm run deploy` |

---

## 目录结构

```
├─ wrangler.jsonc          主配置（不含 routes，原因见上面那个坑）
├─ wrangler.deploy.jsonc   部署时自动生成，含通配路由，不要手改
├─ schema.sql              D1 建表语句
├─ .dev.vars.example       本地密钥模板
├─ src/
│  ├─ index.js             入口：按 Host 分流入口页 / 后台 / 项目 / 保留子域名
│  ├─ landing.js           对外入口页（服务端渲染 + 内联 CSS + 搜索过滤）
│  ├─ api.js               登录、项目增删、分片上传、finalize、残留清理
│  ├─ serve.js             R2 读取、Content-Type、ETag、边缘缓存
│  ├─ auth.js              HMAC 签名会话 Cookie、常量时间口令比较
│  ├─ mime.js              扩展名 → Content-Type、缓存时长
│  └─ util.js              主机名解析、项目名校验、路径规范化
├─ public/                 管理后台（由 Worker 自己托管）
│  ├─ index.html
│  ├─ app.js               登录、上传编排、进度与重试、列表管理
│  ├─ style.css
│  ├─ unzip-worker.js      Web Worker：两遍扫描（先读中央目录做规划，再流式解压分片）
│  └─ vendor/fflate.js     由 npm run vendor 从 node_modules 拷入，不进版本库
└─ scripts/
   ├─ vendor.mjs           拷贝 fflate
   ├─ preflight.mjs        部署前配置体检
   ├─ build-config.mjs     生成带路由的部署配置
   └─ smoke-test.mjs       60 项端到端断言
```
