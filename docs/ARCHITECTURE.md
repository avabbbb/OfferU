# OfferU 架构（TypeScript 后端）

> 2026-11 起，TypeScript 后端是主线：一套规则（`packages/core`），三种运行形态（浏览器页面内、Cloudflare Worker、桌面伴侣）。Python 后端已删除（最后一版 tag `python-backend-final`），每条旧路由的去向见 [route-coverage](./route-coverage.md)。产品需求见 [PRD](./PRD.md)，数据模型与工具语义见 [DESIGN](./DESIGN.md)。

## 1. 原则

- **用户数据只在用户手里**：网页版存在浏览器 IndexedDB，桌面版存在本机伴侣的 SQLite。服务器（Cloudflare Worker）不存任何用户数据：不用 D1 / KV / Durable Objects / R2。
- **core 管规则，adapter 管 IO**：校验、枚举、overview、撤销、简历渲染、Agent 循环都在 `packages/core`，纯 TypeScript，不 import React / DOM / `node:*`。存储、文件、网络、渲染器由各运行形态注入。
- **同一个 HTTP 形状**：`backend-ts/src/app.ts` 的 `createApp(deps)` 是唯一的 Hono 应用，路径和 JSON 形状沿用原 Python 后端，前端不用分支。
- **缺能力就 501**：某个运行形态没有的能力（本机文件、Playwright PDF、BOSS 登录……）路由回 `501 {code: "unsupported"}`，不假装成功。
- **同步是另一件事**：多设备同步用用户自带的 S3 / R2 存储桶，端到端加密、增量快照、按记录合并，引擎在 `packages/sync`，设计见 [sync.md](./sync.md)。

## 2. 代码在哪

```text
packages/core/            纯规则：types / operations（records + changes + 撤销）/ tools（工具表与 schema）
                          llm / llm-config / llm-presets / config（/api/config 规则）
                          research / resume / attachments / data / data-backups / agent / agent-board
backend-ts/src/app.ts     createApp(deps)：CORS、配对 token、/api/health、错误映射，挂 routes/
backend-ts/src/routes/    运行时无关的路由模块，每个领域一个文件；只解析参数、调 core、回 JSON
backend-ts/src/routes/companion/
                          只在 Node 伴侣上有的适配器和路由（磁盘文件、Playwright、poppler、BOSS CLI、Agent 看板、配置文件）
backend-ts/src/server.ts  Node 伴侣入口（@hono/node-server，127.0.0.1:8767），组装 SQLite + companion 适配器
backend-ts/src/cli.ts     offeru-ts CLI（doctor / tool / recipe / serve / start），外置 Agent 唯一入口
backend-ts/src/worker.ts  Cloudflare Worker 入口：静态资源 + 无状态模型转发，不碰数据
backend-ts/wrangler.toml  Worker 配置（assets 指向 frontend/dist）
frontend/src/lib/local/   网页版的页面内后端：把 backend-ts 的 createApp 跑在浏览器里（IndexedDB 适配器）
frontend/src/lib/demo/    展示站 demo 的 BrowserDemoStore（网页版复用它，库名不同）和 keyVault
```

## 3. 三种运行形态

```text
 网页版（local-web）                     Cloudflare Worker（免费额度）          桌面版 / 开发
 ┌───────────────────────────┐          ┌──────────────────────────┐         ┌──────────────────────────┐
 │ React 页面                 │ 静态资源  │ ASSETS → frontend/dist   │         │ Tauri / Vite 页面          │
 │  fetch('/api/…') ─┐        │◀─────────│ /api/health              │         │  fetch(127.0.0.1:8766/…)   │
 │  页面内 Hono app ◀┘        │          │ /api/* 其余 → 501         │         └────────────┬─────────────┘
 │  core + IndexedDB 适配器   │ 模型调用  │ POST /llm-proxy（只转发    │                      ▼
 │  直连模型 / 失败走转发 ────┼─────────▶│  白名单内的模型服务商）    │         Node 伴侣 backend-ts（桌面 8766）
 └───────────────────────────┘          └──────────────────────────┘
                                                                              core + SQLite + 本机能力
```

- **网页版**：`VITE_OFFERU_MODE=local-web` 构建（`npm run build:web`）。`main.tsx` 在渲染前调用 `installLocalBackend()`，把同源 `/api/*` 的 `fetch` 交给页面内的 `createApp`，适配器是 IndexedDB（记录、上传、附件、命名备份、Agent 运行、模型设置）。模型 Key 用浏览器不可导出的设备密钥 AES-GCM 加密后存 IndexedDB。
- **Worker**：只发静态文件和转发模型请求。`/llm-proxy` 同源才收，目标必须是 https 且在内置服务商白名单里（`LLM_PROXY_EXTRA_HOSTS` 可加自建网关，`LLM_PROXY=off` 关掉），只转发 Authorization / x-api-key 等少数头，不记录不落盘。页面先直连模型，某个服务商没有 CORS 时才改走转发。
- **桌面伴侣**：`backend-ts` 的 Node 入口，SQLite `records / changes` 表（沿用 Python 版的表结构，旧库直接可读），外加本机能力。桌面版（Tauri）带一个 Node 可执行文件和打包好的 `backend-ts/server.mjs`，在 8766 起伴侣；`offeru start`（lite 包）同理。Tauri 和普通 `npm run build` 不带页面内后端，照常连本机服务。

## 4. 能力矩阵

| 能力 | 网页版（页面内） | Worker | 桌面伴侣（Node） | 说明 |
| --- | --- | --- | --- | --- |
| 记录读写、撤销、搜索（`/api/tools/*`） | ✅ IndexedDB | ❌ 501 | ✅ SQLite | 工具表同一份（core） |
| 数据导出 / 导入（`/api/data/*`） | ✅ | ❌ | ✅ | |
| 命名备份 / 恢复 | ✅ IndexedDB | ❌ | ✅ `<data>/backups` | |
| 模型设置（`/api/config`） | ✅ 加密存 IndexedDB | ❌ | ✅ `<data>/offeru-ts-config.json`（0600） | 一键导入未迁，501；不接系统钥匙串。从 Python 桌面版升级后模型列表会从 `<data>/config.json` 导入，但 Key 在系统钥匙串里读不到，需要重填 |
| 内置 Agent（运行、流式、恢复） | ✅ 运行记录存 IndexedDB | ❌ | ✅ SQLite | 关页面会中断运行，重开后标记可恢复 |
| 模型调用 | 直连，失败走 `/llm-proxy` | 转发 | 直连 | 本地模型（localhost）始终直连 |
| 联网搜索（Bocha / Tavily / Serper） | 未配置时不可用 | ❌ | 环境变量（临时） | 搜索 Key 还没进 `/api/config` |
| 抓网页 / 按链接存岗位 | 受 CORS 限制，多数站点失败 | ❌ | ✅ | Worker 不做通用代理（刻意） |
| 简历渲染 HTML、模板、校徽 | ✅ 校徽按需取静态文件 | 静态文件 | ✅ | |
| 简历 PDF / PNG | 浏览器打印 | ❌ | ✅ Playwright | |
| 上传文件、Agent 附件 | ✅ IndexedDB | ❌ | ✅ 磁盘 | PDF 转文字只在伴侣（poppler） |
| 本机文件工具（read_file / find_files） | ❌ 501 | ❌ | ✅ | |
| BOSS 扫码登录 | ❌ 501 | ❌ | ✅ 需本机自装 boss CLI | 安装包不再附带 boss 可执行文件 |
| Agent 看板（外置 Agent） | ❌ 501 | ❌ | ✅ | |
| 外置 Agent 命令行（`offeru tool`） | ❌ | ❌ | ✅ | MCP 已于 2026-11-24 移除 |
| 邮箱同步（IMAP） | ❌ | ❌ | ❌ 未迁 | Python 版有，删除时未迁移 |

## 5. 加工具 / 加路由

1. **规则进 core**：在 `packages/core/src/<领域>/` 写纯函数或工具 handler，依赖（store、llm、fetch、files……）从参数注入。不 import `node:*`、DOM、React。
2. **工具**：在 core 的工具表（`tools/index.ts` 的 `ALL_TOOL_SPECS`）登记 schema；`/api/tools/:name`、CLI、内置 Agent 自动可用。
3. **路由**：`backend-ts/src/routes/<领域>.ts` 导出 `registerX(app)`，在 `routes/index.ts` 加一行。只解析输入、调 core、回 JSON；预期错误抛 `CoreError(message, code)`。依赖从 `c.get("deps")` 取，缺了就 501。
4. **只在本机能做的**：适配器和路由放 `routes/companion/`，在 `server.ts` 注入、在 `routes/companion/index.ts` 注册。Worker 和浏览器永远不 import 这里。
5. **新依赖**：给 `AppDeps` 加可选字段，并分别在 `server.ts`（Node）和 `frontend/src/lib/local/backend.ts`（浏览器）里接上或明确不接。
6. **契约用例**：每个工具 / 路由至少一条契约用例（`backend-ts/test/*.contract.test.ts`；`fixtures/` 里已有的期望由旧 Python 版生成，改行为时直接更新夹具），新行为至少一条走真实 HTTP（`app.request`）的测试。新增前端 `/api` 调用必须有 TS 路由，`test/route-coverage.test.ts` 会拦。
7. **浏览器包检查**：`npm run build:web` 末尾的 `scripts/check-browser-bundle.mjs` 会拦住进了浏览器包的 Node 内置模块。

## 6. Python 后端（已删除）

`backend/`（FastAPI）和只给它用的 `agent-runtime/`（外置 Claude 执行器）已删除，最后一版在 tag `python-backend-final`。157 条旧路由中 135 条由 TS 提供，其余 22 条（`/api/research/*`、`/api/bridge/proposals/*`、`/api/agent/runtime/skill`）按决定不迁，见 [route-coverage](./route-coverage.md)。没迁的能力：邮箱同步（IMAP）、系统钥匙串。MCP 已于 2026-11-24 移除，外置 Agent 只走 CLI。
