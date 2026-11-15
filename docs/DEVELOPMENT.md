# 开发指南

面向源码开发。架构见 [ARCHITECTURE](./ARCHITECTURE.md)，部署见 [DEPLOY-CLOUDFLARE](./DEPLOY-CLOUDFLARE.md)。旧的 Python 开发指南在 [archive/2026-11](./archive/2026-11/DEVELOPMENT-python-2026-09.md)。

## 环境

- Node.js 24+（伴侣用 `node:sqlite`），npm。
- 只有跑桌面壳时需要 Rust / Tauri；只有跑 Python 回滚后端或生成契约夹具时需要 Python 3.12（`backend/.venv`）。

```bash
npm --prefix backend-ts install
npm --prefix frontend install
```

`packages/core` 没有自己的依赖，两边通过 `file:../packages/core` 引用源码。前端的网页版构建会编译 `backend-ts/src`，所以两个目录都要装依赖。

## 常用命令

| 目的 | 命令 |
| --- | --- |
| 网页版开发（页面内后端，数据在浏览器） | `cd frontend && npx vite --mode local-web --port 7410` |
| 连本机后端开发 | `cd backend-ts && OFFERU_TS_PORT=8766 npm run dev`（先停掉 Python 后端），另开 `cd frontend && npm run dev` |
| 网页版构建 | `cd frontend && npm run build:web`（产物 `frontend/dist`，自带 Node 内置模块检查） |
| 桌面 / 普通构建 | `cd frontend && npm run build`；桌面壳 `npm run tauri -- dev` |
| 本地跑 Worker | `cd backend-ts && npm run build:web && npm run worker:dev` |
| 部署检查 | `cd backend-ts && npm run worker:dry-run` |
| CLI / MCP | `cd backend-ts && npm run cli -- doctor`、`npm run cli -- tool overview`、`npm run cli -- mcp` |
| Python 回滚后端 | `cd backend && .venv/bin/python run_server.py`（8766） |

非网页版构建的前端固定连 `127.0.0.1:8766`（`frontend/src/lib/apiBase.ts`，刻意不允许指向别的地址），所以本机开发时让 TS 伴侣监听 8766；它默认 8767 是为了能和 Python 后端并排跑对照。网页版开发模式下没有 Worker，所以模型服务商不允许浏览器跨域时，「测试连接」会失败；要完整验证转发，用 `npm run worker:dev`。

伴侣的数据目录：`OFFERU_DATA_DIR`（默认 `backend-ts/.data`），数据库 `OFFERU_DB_PATH`。开发和测试不要指向真实数据。

## 测试

```bash
cd backend-ts && npm test && npm run typecheck      # 路由、工具、契约、Worker
cd frontend   && npm test && npm run typecheck      # 组件、lib、页面内后端
cd frontend   && npm run design:audit               # 只拦新增的视觉违规
```

- **契约测试**：`backend-ts/test/*.contract.test.ts`、`*-parity.test.ts` 用 `backend-ts/test/fixtures/` 里 Python 生成的期望（`gen_*.py` 是生成脚本）比对 TS 的输出。改了 Python 行为或迁新工具时，重新生成夹具并提交。
- **HTTP 测试**：路由测试用 `createApp(deps).request(...)` 走完整 Hono 管线；伴侣端到端测试（`server.test.ts`）起真实 HTTP 服务。
- **页面内后端**：`frontend/src/lib/local/backend.test.ts` 在 jsdom 里把 `createApp` 跑在浏览器适配器上。
- 不写只为覆盖率的测试；每个新工具 / 路由至少一条走 HTTP 的测试和一条契约用例。

## 数据和密钥

- 网页版的数据库名：`offeru-local`（记录）、`offeru-local-files` / `-attachments` / `-backups`、`offeru-local-agent`、`offeru-local-config`。展示站 demo 用 `offeru-demo`，互不影响。
- 网页版的模型 Key 加密后存 IndexedDB，设备密钥不可导出；这只防磁盘上的明文，同源脚本仍能使用 Key。
- 伴侣的模型设置在 `<data>/offeru-ts-config.json`（0600）。不要提交 `.data/`、`backend/.env`、`backend/config.json`。
