# OfferU Public Release — Migration Health Identity

日期：2026-09-03  
状态：静态实现切片，未提升 Public Release Gate

## 目标

收紧 previous-release migration browser smoke 的后端就绪判断，避免只要 8765 返回类似 `OfferU/Python` 的 JSON 就把旧服务、错误版本或错误运行模式当成迁移目标。

## 已完成

- `backend/scripts/e2e/release_endpoints.py` 增加从当前 checkout `frontend/package.json` 读取发布版本的 helper；健康谓词支持要求精确版本与 build mode；
- 共享健康谓词默认拒绝缺少或为空的 `version`/`build_mode`，调用方还可以继续要求精确值；
- `backend/scripts/e2e/test_public_release_migration.py` 的 isolated backend 显式设置 `local-development/local`；
- migration 的 7410 frontend wait 要求 2xx 且正文包含 OfferU，避免错误网页继续进入浏览器验收；
- 共享 release endpoint 模块还提供 pre-browser frontend/backend readiness helper，smoke、Interview、Empty State 在创建 managed Chromium 前会拒绝错误身份；
- 扩展 HTTP Adapter 的 `probe()` 也拒绝缺少版本/build mode 的部分 health payload，且 8080 仍只会归一化到 8765 API，不会作为网页导航地址；
- migration API wait 现在要求当前版本、`OfferU`、`python` 和 `local-development`，同时继续使用固定 `127.0.0.1:8765`、无代理、无重定向边界；
- 增加 endpoint/architecture contract source assertions。

## 未执行与边界

按项目 `AGENTS.md`，本切片未运行测试、构建、语法检查、migration runner 或浏览器；没有启动 Edge、打开可见窗口、访问 `8080` 或修改真实用户数据库。

因此不能把 migration browser smoke、R72、R88 或 Public Release 声明为 PASS。远程 runner、Playwright managed Chromium、previous-release installer upgrade 和 clean-machine 证据仍待执行。
