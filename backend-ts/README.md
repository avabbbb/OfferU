# OfferU TS backend

OfferU 的主线后端。一个运行时无关的 Hono 应用（`src/app.ts` 的 `createApp(deps)`），规则全部来自 `packages/core`，跑在三个地方：

| 入口 | 文件 | 存储 | 用途 |
| --- | --- | --- | --- |
| Node 伴侣 | `src/server.ts`（127.0.0.1:8767，`OFFERU_TS_PORT`） | SQLite（与 Python 同表结构） | 桌面版 / 本机开发，带本机能力 |
| 浏览器页面内 | `frontend/src/lib/local/backend.ts` 导入本目录源码 | IndexedDB | 网页版（`VITE_OFFERU_MODE=local-web`） |
| Cloudflare Worker | `src/worker.ts` + `wrangler.toml` | 无 | 发静态前端 + 无状态模型转发 `/llm-proxy`，其余 `/api/*` 回 501 |

架构和能力矩阵见 [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)，部署见 [docs/DEPLOY-CLOUDFLARE.md](../docs/DEPLOY-CLOUDFLARE.md)，迁移进度见 [docs/backend-ts-migration.md](../docs/backend-ts-migration.md)。

## 目录

```text
src/app.ts            createApp(deps)、AppDeps（每个运行形态注入的能力）、CORS / 配对 / 错误映射
src/routes/           运行时无关的路由：tools、research、resume、agent、data、agent-board、config
src/routes/companion/ 只在 Node 上的适配器和路由：文件、Playwright、poppler、BOSS CLI、Agent 看板、配置文件
src/server.ts         Node 伴侣组装（SQLite + companion 适配器）
src/worker.ts         Cloudflare Worker
src/cli.ts, mcp.ts    offeru-ts CLI 和 stdio MCP
src/store.ts          SQLite CoreStore（node:sqlite）
test/                 vitest；fixtures/ 里是 Python 生成的契约期望
```

`src/app.ts` 和 `src/routes/*.ts`（不含 `companion/`）不能 import `node:*`：它们会被打进浏览器包和 Worker。前端的 `npm run build:web` 会检查。

## 命令

```bash
npm install
npm run dev                       # Node 伴侣（tsx），数据在 OFFERU_DATA_DIR / OFFERU_DB_PATH
npm run cli -- doctor             # 也有：tool <name> '<json>'、mcp、serve
npm test && npm run typecheck
npm run build:web                 # 构建网页版到 ../frontend/dist
npm run worker:dev                # 本地跑 Worker（wrangler dev）
npm run worker:dry-run            # wrangler deploy --dry-run
npm run deploy                    # build:web + wrangler deploy
```

默认数据库 `backend-ts/.data/offeru.db`，和真实桌面数据分开，除非 `OFFERU_DB_PATH` 指过去。

## 加东西

1. 规则写在 `packages/core`（纯函数，依赖从参数注入）；工具在 core 的 `ALL_TOOL_SPECS` 登记后，HTTP / MCP / CLI / 内置 Agent 自动可用。
2. 路由在 `src/routes/<领域>.ts` 导出 `registerX(app)`，`routes/index.ts` 加一行；依赖从 `c.get("deps")` 取，没有就抛 `CoreError(..., "unsupported")`（501）。
3. 只有本机能做的放 `src/routes/companion/`，在 `server.ts` 注入。
4. 新依赖加到 `AppDeps`（可选字段），并在 `server.ts` 和 `frontend/src/lib/local/backend.ts` 各自接上或明确不接。
5. 每个迁移的工具 / 路由：一条和 Python 对照的契约用例 + 一条走 HTTP 的测试。

## 还没迁的

邮箱同步（IMAP）、HTTP `/mcp`、面试 / 连接 / consent 路由、模型设置的系统钥匙串与一键导入、TS 伴侣的生产打包。这些仍由 Python 后端（`backend/`）提供；Python 保留为回滚路径，在 TS 版有同样的数据、错误、恢复行为并通过备份往返之前不删。
