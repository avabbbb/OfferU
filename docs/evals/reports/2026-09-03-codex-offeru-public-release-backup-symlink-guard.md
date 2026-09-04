# OfferU Public Release — backup archive symlink guard

日期：2026-09-03  
状态：静态实现完成，运行证据待执行

## 目标

让本地备份/恢复路径在读取归档前拒绝符号链接，避免备份目录中的链接把哈希、manifest 或 SQLite 快照解析到受管目录之外。

## 变更

- `_validated_archive()` 在读取 ZIP 前拒绝 symlink；
- `stage_restore()` 和启动恢复在计算归档哈希前拒绝 symlink；
- Data Safety 的 `data/data_safety`、`backups`、`restore_staging` 与 pending marker 路径现在在读写前检查整条父目录链，目录组件或 marker 是符号链接时拒绝继续；
- 无效 pending marker 的隔离目录 `cancelled_restore_markers` 也在移动前做父链/目录类型检查，符号链接目标不会接收被隔离的 marker；
- `test_data_safety.py` 增加符号链接归档隔离契约，验证列表只报告 invalid，不把链接目标列为有效备份；
- 扩展根目录同步脚本现在同时校验 popup 和 background 的固定 `7410/8765`、OfferU/Python health 与 redirect guard，旧 bundle 不会被同步为正式入口；
- 本轮没有删除任何用户数据，没有打开 Edge，没有访问 8080，也没有调用浏览器。

## 验收映射

- GOAL：43–46、50–52、84、91–92、96；
- Release Checklist：R44、R46、R51、R52、R84、R91、R92、R96；
- Data Safety：备份归档路径边界与恢复前 fail-closed 校验；
- Extension：WXT 生成物同步前的固定网页/API 入口完整性检查。

## 尚未执行

按 `AGENTS.md`，本轮没有运行测试、构建、语法检查、扩展构建、远程 runner 或浏览器流程。现有 `.output` 仍可能是旧构建物，必须在用户明确执行扩展构建后重新生成；这不改变当前网页入口只为 `http://127.0.0.1:7410` 的约束。

因此不能把该静态控制提升为 Public Release PASS；R44/R46 的恢复矩阵、签名 artifact、clean-machine、远程 CI 和最终隐私/安全 Gate 仍未完成。
