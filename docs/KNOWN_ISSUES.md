# 已知问题

当前（TS 后端 / 网页版 / 伴侣拆分之后）的已知缺口。2026-09 的发布台账在 [archive/2026-11](./archive/2026-11/KNOWN_ISSUES-2026-09.md)。修好一条就删一条。

## 网页版（local-web）

- **设置页的「导出数据」还连着 `/api/agent/data/export`**（Python 的 UserDataExport 形状），TS 后端只有 `/api/data/export`（offeru-data v1 快照），网页版点导出会 404。命名备份 / 恢复可用。
- **抓网页、按链接存岗位**受浏览器 CORS 限制，多数招聘站会失败；Worker 刻意不做通用代理。粘贴 JD 文本可用。
- **联网搜索**：Bocha / Tavily / Serper 的 Key 还没进 `/api/config`，网页版没有搜索。
- **一键导入模型服务商**（`/api/config/llm-providers/import`）未迁，回 501；在模型设置里手动添加。
- **Agent 运行跟着页面走**：关掉标签页会中断正在跑的运行，重开后标记为可恢复。
- `vite dev --mode local-web` 下没有 Worker，不允许浏览器跨域的模型服务商测试连接会失败；用 `npm run worker:dev` 验证转发。

## 伴侣（backend-ts Node）

- 模型 Key 存在 `<data>/offeru-ts-config.json`（0600），还没接系统钥匙串（Python 版有）；不读 Python 的 `config.json`，两边各配各的。
- `/mcp` 只有 stdio，HTTP（Streamable）未迁。
- 邮箱同步（IMAP）、面试（`/api/interview*`）、连接管理、consent、bridge 等仍只在 Python 后端。
- `node:sqlite` 在 Node 24 上仍是 experimental。

## 发布

- 安装包签名、上一版本升级路径、Tauri 自动更新、干净机器人工验收仍未完成（详见归档的发布台账）。
- 桌面安装包仍打包 Python sidecar；切到 TS 伴侣的打包方案未定。

## 工程

- `npm run design:audit` 对比 `main` 报出 `DemoAgentPanel.tsx` / `DemoDataDialog.tsx` / `DemoModeBar.tsx` 等 test 分支 demo 组件的历史违规（非本轮新增），需在合回 `main` 前清理。
