# OfferU Public Release — installed smoke runtime identity

日期：2026-09-03  
状态：静态实现完成，Windows runner 与安装包证据待执行

## 目标

避免 Windows 安装包 smoke 因复用旧进程、错误版本或开发模式后端而误报成功。该 smoke 只验证已安装的 OfferU sidecar，不打开网页或浏览器。

## 变更

- `desktop-installed-smoke` 从下载的 `release-assets/version.json` 读取期望版本，并拒绝缺失版本；
- 8765 health 必须同时满足 `status=ok`、`service=OfferU`、`runtime=python`、`build_mode=release` 和版本匹配；
- smoke 结果记录期望版本、实际版本和实际 build mode，便于诊断错误安装包或旧 sidecar；
- 保留启动前 8765 占用检查及端口 owner 必须来自临时安装目录的约束；
- health HTTP client 显式禁用系统代理和自动重定向，避免本机发布验证被代理或错误服务转发污染；
- Linux browser/migration CI 在启动源码服务后也会验证网页正文的 OfferU 标识、后端版本和 `local-development` 身份，不接受仅有 HTTP 200 的错误服务；
- smoke 明确使用 loopback HTTP，`browser=none`、`web_url=not_used`，不访问 8080，也不启动 Edge/Chrome。

## 验收映射

- GOAL：83–90、103–105；
- Release Checklist：R84、R87–R92、R103–R104；
- 安装边界：installer → installed OfferU.exe → owned Python sidecar → strict health identity → uninstall。

## 尚未执行

按 `AGENTS.md`，本轮没有运行测试、构建、安装包、远程 GitHub runner 或浏览器流程。该静态契约不能替代 Windows clean-machine 安装、sidecar 生命周期、签名和升级证据。

该切片不提升 Public Release Gate；签名、previous-release upgrade、真实 Windows runner 和陌生用户验收仍未完成。
