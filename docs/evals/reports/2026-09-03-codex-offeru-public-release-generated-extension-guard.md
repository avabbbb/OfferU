# OfferU Public Release — Generated Extension Guard

日期：2026-09-03

## 结论

扩展根目录的 tracked bundle 现在进入 Public Release 架构审计。扩展构建完成后，发布链必须拒绝未由受保护 WXT 构建生成的旧产物，避免用户加载旧入口后再次打开错误或无法连接的本地页面。

当前审计对象：

- `extension/background.js`
- `extension/popup.html`
- `extension/manifest.json`

## 规则

- background bundle 必须包含固定 `127.0.0.1:8765`、`/api/health`、`OfferU` 和 redirect fail-closed 标记；
- popup 不得直接加载 `src/popup.ts`，必须引用构建后的 `chunks/*.js`；
- 缺少任一根目录 artifact 时直接报告 finding；
- 旧 bundle 只允许在重新运行 `extension` 的受保护 build/sync 链后替换，不能手工绕过审计。

该检查通过 `audit_architecture.py --generated-extension-artifacts` 显式运行，并安排在 CI 的 `npm run build` 之后；普通 backend architecture audit 不在扩展生成前读取这些 tracked output。

## 当前状态

当前工作树的根目录 background/popup 仍是旧或未完成同步的 artifact，因此该审计会保持 finding，Public Release 不能宣称通过。正式 WXT build、typecheck、测试和扩展运行验收仍待用户按 `AGENTS.md` 执行。

本切片未启动 Edge、未创建浏览器窗口、未访问 8080，也未修改真实用户数据库。
