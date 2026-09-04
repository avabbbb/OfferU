# OfferU Public Release — health version source audit

日期：2026-09-03  
状态：静态实现完成，版本审计与发布 runner 证据待执行

## 目标

让发布版本审计覆盖健康接口真正使用的版本声明，避免 CLI 版本与 FastAPI health 版本漂移后仍被静态审计放行。

## 变更

- `audit_version_consistency.py` 新增 `backend_health` 来源，读取 `backend/app/main.py` 的 FastAPI `version`；
- 前端 package、Tauri config、Rust package、CLI 和 health endpoint 五个版本声明必须同时是有效 semver 且完全一致；
- 新增缺失/漂移契约，并把 `backend/app/main.py` 纳入架构版本审计范围；
- 该切片只做源码一致性检查，不启动服务、不访问 8080、不打开 Edge 或其它浏览器。

## 验收映射

- GOAL：47、87、92、96、104；
- Release Checklist：R87、R92、R96、R104；
- Runtime identity：health version → frontend/Tauri/package release version。

## 尚未执行

按 `AGENTS.md`，本轮没有运行测试、构建、安装包或远程 runner。当前本机 7410/8765 的历史只读 health 证据仍需在版本审计变更后的正常启动、前端启动门、Tauri 和安装 smoke 中重验。

该切片不提升 Public Release Gate；签名、升级、clean-machine、远程 CI 和真实陌生用户验收仍未完成。
