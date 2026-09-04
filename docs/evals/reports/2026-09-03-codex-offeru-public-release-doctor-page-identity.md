# OfferU Public Release — Doctor page/runtime identity

日期：2026-09-03  
状态：静态实现完成，本机 Doctor/发布 runner 证据待重验

## 目标

让本地 Doctor 在给出 `CORE_READY` 前确认它连到的确实是当前 OfferU 网页和匹配版本/build mode 的 OfferU Python 后端，而不是只看端口或 HTTP 200。

## 变更

- 8765 health 必须匹配 `status=ok`、`service=OfferU`、`runtime=python`、当前 `APP_VERSION` 以及当前运行模式对应的 `build_mode`；
- 7410 必须返回 2xx 且响应正文包含 OfferU 标识，否则返回 `frontend_payload_invalid`；正文不会进入诊断结果；
- 8080、错误端口、重定向、错误服务只会形成 fail-closed 诊断结果，不会创建浏览器窗口；
- 新增后端版本/build mode 漂移和错误网页响应契约。

## 验收映射

- GOAL：10–12、47、50–52、84、96、103–104；
- Release Checklist：R10–R12、R47、R50–R52、R84、R96、R103–R104；
- 支持路径：Doctor → fixed loopback identity → readable failure / `CORE_READY`。

## 尚未执行

按 `AGENTS.md`，本轮没有运行测试、构建、安装包、远程 runner 或浏览器流程。当前 7410/8765 的历史 HTTP 只读证据需在本变更后由用户执行 Doctor/前端启动门/安装 smoke 重验。

该切片不提升 Public Release Gate；签名、升级、clean-machine、远程 CI、完整隐私决策和真实 Provider 仍未完成。
