# Python → TypeScript 后端迁移

状态（2026-11-15，`test` 分支）：TS 后端是主线。网页版完全跑在 TS 上（页面内后端 + Cloudflare Worker）；桌面伴侣的 TS 版覆盖记录、工具、简历、Agent、数据备份、模型设置，剩余领域仍由 Python 提供。Python 保留为回滚路径。架构见 [ARCHITECTURE](./ARCHITECTURE.md)。

## 阶段

| 阶段 | 范围 | 状态 | 证据 |
| --- | --- | --- | --- |
| 0 | `packages/core`：共享规则，无 React / DOM / Node | ✅ | 前端、Node 伴侣、Worker 用同一个包 |
| 1 | Node SQLite 适配器 + `/api/tools/*` | ✅ | 与 Python 同一 `records / changes` 表；互读测试；工具表 parity 夹具 |
| 2 | MCP stdio + CLI + 配对 token + HTTP 对齐 | ✅（HTTP `/mcp` 未迁） | MCP list/call、CLI JSON、bridge 预检、无 token 403 |
| 3 | 领域路由：研究 / 岗位评估、数据导出导入与备份、Agent 看板、附件 | ✅ | Python 生成的契约夹具（`backend-ts/test/fixtures/`） |
| 4 | 简历渲染 / PDF / 校徽、文件；邮箱 IMAP；岗位来源 | 🟡 简历、文件完成；IMAP、岗位来源未迁 | `resume.contract.test.ts`、`resume.browser.test.ts` |
| 5 | 内置 Agent 运行时、工具注册、流式、恢复 | ✅（技能 / 评测面未迁） | `agent.test.ts`；浏览器与伴侣共用 `createAgentRuntime` |
| 6 | 网页版：页面内后端 + 无状态 Worker + `/api/config` | ✅ | `npm run build:web`、`wrangler deploy --dry-run`、`frontend/src/lib/local/backend.test.ts`、`backend-ts/test/worker.test.ts`、`config.test.ts` |
| 7 | 切换桌面版到 TS 伴侣，删除退役的 Python 路径 | ⏳ | 需要：剩余领域迁完、备份往返、回滚演练、打包方案 |

## 规则

- `packages/core` 管领域规则；adapter 管持久化和传输。
- `server.ts`、`cli.ts`、`worker.ts` 里不写业务逻辑。
- 每个迁移的工具 / 路由都有一条和 Python 共享的契约用例。
- Python 的替代品没有同样的数据、错误、恢复行为之前，不删 Python；保留回滚路径。
- 迁移期间以同一个 SQLite 表结构作为兼容接缝。
- 网页版和 Worker 不引入服务器端存储（D1 / KV / DO / R2）。

## 还没迁的

- 邮箱同步（IMAP）、面试 / 复盘路由、连接管理、consent、bridge 的其余接口。
- HTTP `/mcp`（Streamable）。
- 模型设置：系统钥匙串、一键导入；搜索 Key 进配置。
- 设置页数据导出改接 `/api/data/export`（见 [KNOWN_ISSUES](./KNOWN_ISSUES.md)）。
- TS 伴侣的生产打包（目前经 `tsx` 运行）。
