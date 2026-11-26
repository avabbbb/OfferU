# 已知问题

当前（TS 后端 / 网页版 / 伴侣拆分之后）的已知缺口。2026-09 的发布台账在 [archive/2026-11](./archive/2026-11/KNOWN_ISSUES-2026-09.md)。修好一条就删一条。

## 网页版（local-web）

- **抓网页、按链接存岗位**受浏览器 CORS 限制，多数招聘站会失败；Worker 刻意不做通用代理。粘贴 JD 文本可用。
- **联网搜索**：Bocha / Tavily / Serper 的 Key 还没进 `/api/config`，网页版没有搜索。
- **一键导入模型服务商**（`/api/config/llm-providers/import`）未迁，回 501；在模型设置里手动添加。
- **Agent 运行跟着页面走**：关掉标签页会中断正在跑的运行，重开后标记为可恢复。
- `vite dev --mode local-web` 下没有 Worker，不允许浏览器跨域的模型服务商测试连接会失败；用 `npm run worker:dev` 验证转发。

## 伴侣（backend-ts Node）

- 模型 Key 存在 `<data>/offeru-ts-config.json`（0600），不接系统钥匙串。从 Python 桌面版升级的用户：首次启动会从旧 `<data>/config.json` 导入模型列表，但 Key 在系统钥匙串里，**需要重填一次**。
- 不能自动读邮箱（IMAP 未迁）：邀约邮件需贴给 Agent，由它更新岗位状态并记带链接的事项。`/api/bridge/proposals/*`、`/api/agent/runtime/skill`、`/api/research/*` 按决定不迁（见 [route-coverage](./route-coverage.md)）。
- BOSS 扫码登录要本机自装 boss CLI；安装包不再附带。
- `node:sqlite` 在 Node 24 上仍是 experimental。

## 发布

- 安装包签名、上一版本升级路径、Tauri 自动更新、干净机器人工验收仍未完成（详见归档的发布台账）。
- 桌面安装包改为打包 Node + TS 伴侣（`backend-ts/scripts/build_sidecar.mjs`），Rust 侧（`src-tauri/src/lib.rs`）只在 CI 编译验证过。
- 发布前浏览器冒烟收窄为 `scripts/e2e/smoke.mjs`（伴侣 + 工作台主路径）；旧 Python 版的多场景 e2e（空状态矩阵、面试回放、CareerTask 并发 / 恢复）已随 Python 删除。

## 工程

- `npm run design:audit` 对比 `main` 报出 `DemoAgentPanel.tsx` / `DemoDataDialog.tsx` / `DemoModeBar.tsx` 等 test 分支 demo 组件的历史违规（非本轮新增），需在合回 `main` 前清理。
