# OfferU Public Release — external database startup boundary

日期：2026-09-03  
状态：静态实现完成，contract/Docker runner 待执行

## 目标

修复 Docker Compose PostgreSQL 与本地 SQLite Data Safety 恢复逻辑之间的启动边界，避免容器在导入 `app.main` 时因不存在 SQLite 恢复目标而失败。

## 变更

- `backend/app/main.py` 仅在数据库 URL 为 SQLite 时调用 staged restore；
- 外部数据库返回明确的 `external_database_data_safety_not_applicable` 启动结果，不伪造本地备份/恢复已完成；
- `DEVELOPMENT.md` 说明 Docker PostgreSQL 是开发编排，外部数据库应使用自身备份运维边界；
- 新增 release architecture contract，检查该分支不会无条件进入 SQLite restore。

## 端口与浏览器边界

该切片不启动 Edge、没有创建浏览器窗口，也不访问 8080。OfferU 网页入口仍为 `http://127.0.0.1:7410`，后端仍为 `http://127.0.0.1:8765`；8080 仍只表示可选本地模型端点。

## 尚未执行

按 `AGENTS.md` 本轮没有运行测试、语法检查、构建或 Docker runner。需要后续在隔离容器环境验证 PostgreSQL 启动、迁移和外部数据库的独立备份策略；Public Release 仍为 `NOT_READY`。
