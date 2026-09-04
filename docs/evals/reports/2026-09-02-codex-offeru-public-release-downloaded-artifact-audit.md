# OfferU Downloaded Release Artifact Audit

日期：2026-09-02

状态：`CONFIGURED_NOT_EXECUTED`

## Scope

本切片只收紧 artifact 传递到安装 smoke 和 Draft Release 后的安全检查，不启动浏览器、不访问 Edge、不把 `8080` 当网页，也不修改真实用户数据。

## CI contract

下载的 `offeru-windows-x64` 在两个消费者中都执行：

```text
verify_release_artifacts.py
↓
audit_artifacts.py --json
↓
install smoke or Draft Release
```

其中完整性校验验证 manifest、bytes、SHA-256、版本、平台、NSIS/MSI 集合和签名标记；secret audit 检查 canary、Bearer/API key、private key、token 和敏感文件名，且不输出命中值。

## Verification boundary

本轮仅完成 CI 配置和文档，按 `AGENTS.md` 未运行测试、语法检查、构建或远程 GitHub Actions。真实签名 artifact、Windows runner 和 Draft Release 仍需在后续 Gate 中验证，因此不产生 `PASS` 结论。
