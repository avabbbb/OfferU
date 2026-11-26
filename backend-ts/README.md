# OfferU TS backend

OfferU 的主线后端。一个运行时无关的 Hono 应用（`src/app.ts` 的 `createApp(deps)`），规则全部来自 `packages/core`，跑在三个地方：

| 入口 | 文件 | 存储 | 用途 |
| --- | --- | --- | --- |
| Node 伴侣 | `src/server.ts`（127.0.0.1:8767，`OFFERU_TS_PORT`） | SQLite（`records / changes`，沿用 Python 版表结构） | 桌面版 / 本机开发，带本机能力 |
| 浏览器页面内 | `frontend/src/lib/local/backend.ts` 导入本目录源码 | IndexedDB | 网页版（`VITE_OFFERU_MODE=local-web`） |
| Cloudflare Worker | `src/worker.ts` + `wrangler.toml` | 无 | 发静态前端 + 无状态模型转发 `/llm-proxy`，其余 `/api/*` 回 501 |

架构和能力矩阵见 [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)，部署见 [docs/DEPLOY-CLOUDFLARE.md](../docs/DEPLOY-CLOUDFLARE.md)，旧 Python 路由的去向见 [docs/route-coverage.md](../docs/route-coverage.md)。

## 目录

```text
src/app.ts            createApp(deps)、AppDeps（每个运行形态注入的能力）、CORS / 配对 / 错误映射
src/routes/           运行时无关的路由：tools、research、resume、agent、data、agent-board、config
src/routes/companion/ 只在 Node 上的适配器和路由：文件、Playwright、poppler、BOSS CLI、Agent 看板、配置文件
src/server.ts         Node 伴侣组装（SQLite + companion 适配器）
src/worker.ts         Cloudflare Worker
src/cli.ts            offeru-ts CLI（外置 Agent 的唯一入口）
src/store.ts          SQLite CoreStore（node:sqlite）
test/                 vitest；fixtures/ 里是契约期望（最初由 Python 版生成）
src/sync.ts           伴侣端 S3/R2 端到端加密同步（引擎在 packages/sync，见 docs/sync.md）
```

`src/app.ts` 和 `src/routes/*.ts`（不含 `companion/`）不能 import `node:*`：它们会被打进浏览器包和 Worker。前端的 `npm run build:web` 会检查。

## 命令

```bash
npm install
npm run dev                       # Node 伴侣（tsx），数据在 OFFERU_DATA_DIR / OFFERU_DB_PATH
npm run cli -- doctor             # 也有：tool、tool <name> --help、tool <name> '<json>'、recipe <id>、serve
npm test && npm run typecheck
npm run build:web                 # 构建网页版到 ../frontend/dist
npm run worker:dev                # 本地跑 Worker（wrangler dev）
npm run worker:dry-run            # wrangler deploy --dry-run
npm run deploy                    # build:web + wrangler deploy
```

默认数据库 `backend-ts/.data/offeru.db`，和真实桌面数据分开，除非 `OFFERU_DB_PATH` 指过去。

## 加东西

1. 规则写在 `packages/core`（纯函数，依赖从参数注入）；工具在 core 的 `ALL_TOOL_SPECS` 登记后，HTTP / CLI / 内置 Agent 自动可用。
2. 路由在 `src/routes/<领域>.ts` 导出 `registerX(app)`，`routes/index.ts` 加一行；依赖从 `c.get("deps")` 取，没有就抛 `CoreError(..., "unsupported")`（501）。
3. 只有本机能做的放 `src/routes/companion/`，在 `server.ts` 注入。
4. 新依赖加到 `AppDeps`（可选字段），并在 `server.ts` 和 `frontend/src/lib/local/backend.ts` 各自接上或明确不接。
5. 每个工具 / 路由：一条契约用例 + 一条走 HTTP 的测试。

## 还没迁的

Python 后端已删除（tag `python-backend-final`）。没迁的：邮箱同步（IMAP，邀约邮件改为贴给 Agent）、模型设置的系统钥匙串与一键导入。按决定不迁的路由见 [docs/route-coverage.md](../docs/route-coverage.md)。
