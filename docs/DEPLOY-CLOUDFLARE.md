# 部署网页版到 Cloudflare Workers（零成本）

网页版 = 静态前端 + 页面内后端（数据在用户浏览器）+ 一个无状态 Worker。架构见 [ARCHITECTURE](./ARCHITECTURE.md)。

## 为什么是零成本

- Worker 只做两件事：发 `frontend/dist` 的静态文件（Workers Static Assets，静态资源请求不计入 Worker 调用次数），以及转发浏览器没法直连的模型请求（`POST /llm-proxy`）。
- 不用 D1 / KV / Durable Objects / R2，没有任何按存储计费的东西；用户数据全在各自的浏览器 IndexedDB 里。
- 免费计划的限制（以 Cloudflare 当前文档为准）：Worker 每天 10 万次请求、每次 10 ms CPU。转发是流式 I/O，几乎不占 CPU；`wrangler.toml` 的 `run_worker_first` 只有 `/llm-proxy`，所以只有走转发的模型调用算 Worker 请求；页面里的 `/api/*` 全在浏览器内由页面内后端回答（含 `<img>` 里的上传图片、校徽、Agent 附件，见 `frontend/src/lib/apiAsset.tsx`），不出浏览器。单个静态文件 ≤ 25 MiB，文件数 ≤ 2 万（当前约 950 个，其中约 800 个是校徽 PNG）。

## 一次性准备

```bash
npm --prefix backend-ts install
npm --prefix frontend install
cd backend-ts && npx wrangler login      # 浏览器里授权你的 Cloudflare 账号
```

## 部署

```bash
cd backend-ts
npm run build:web          # = cd ../frontend && vite build --mode local-web + 浏览器包检查
npx wrangler deploy --dry-run   # 可选：只打包不上传，确认配置
npx wrangler deploy        # 上传；或 npm run deploy（构建 + 部署）
```

部署后地址是 `https://offeru.<你的子域>.workers.dev`（`wrangler.toml` 里 `name = "offeru"`、`workers_dev = true`）。要绑自己的域名，在 Cloudflare 控制台给这个 Worker 加 Custom Domain，不用改代码。

本地预览完整组合（静态 + 转发）：`npm run build:web && npm run worker:dev`。

## 配置（`wrangler.toml` 的 `[vars]`）

| 变量 | 作用 |
| --- | --- |
| `LLM_PROXY = "off"` | 完全关闭模型转发（只能用允许浏览器跨域的服务商或本地模型） |
| `LLM_PROXY_EXTRA_HOSTS = "llm.example.com"` | 允许转发到自建网关（逗号分隔）；默认只转发内置服务商预设里的 https 主机和 `api.anthropic.com` |

转发规则：只收本站页面的请求（Origin 同源）；目标必须 https、不带用户名密码；POST 用于对话，GET 只用于 `…/models`；只转发 `Authorization`、`x-api-key`、`anthropic-*`、`content-type`、`accept`，不转发 Cookie；请求体上限 8 MB；不记录、不缓存（`Cache-Control: no-store`）。用户的 Key 只经过 Worker 的内存。

## 用户需要知道的

- 数据只在当前浏览器：换浏览器、清站点数据就没了。设置里的「备份、恢复」在浏览器内建命名备份；跨浏览器 / 跨设备搬数据靠 `GET /api/data/export` → `POST /api/data/import` 的 JSON 快照（设置页的「导出」按钮还连着旧的 `/api/agent/data/export`，见 [KNOWN_ISSUES](./KNOWN_ISSUES.md)）。
- 模型 Key 在设置 → 模型里填写，加密后存在浏览器里。
- 网页版做不了的事（本机文件、PDF 导出、BOSS 登录、外置 Agent 看板）需要桌面版；自动读邮箱目前所有版本都没有，界面上会提示「不支持」而不是假装成功。

## 不要做的

- 不要给 Worker 加数据库或存储绑定来“方便同步”：同步走用户自己的 S3 / R2，见 [sync.md](./sync.md)。
- 不要把 `/llm-proxy` 改成通用代理（抓网页、任意主机）：那会变成开放代理，也会让 Worker 承担用户流量。
