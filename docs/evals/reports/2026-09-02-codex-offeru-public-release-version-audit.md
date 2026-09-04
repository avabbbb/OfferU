# OfferU Public Release Version Audit

日期：2026-09-02

状态：`CONFIGURED_NOT_EXECUTED`

## Scope

本切片只核对随 Release 运行的四处版本声明，不启动浏览器、不访问 Edge、不把 `8080` 当网页，也不修改真实用户数据。

## Contract

`backend/scripts/release/audit_version_consistency.py` 读取并比较：

```text
frontend/package.json
frontend/src-tauri/tauri.conf.json
frontend/src-tauri/Cargo.toml
backend/app/cli.py
```

缺失文件、缺失版本字段、非法 SemVer 或声明漂移都会返回非零结果；输出只包含版本元数据和 bounded findings。

## CI placement

backend CI 在测试前置审计中执行；Windows 打包在构建 installer 前执行。这样版本漂移会在生成发布物前停止流水线。

## Verification boundary

本轮仅完成脚本、contract tests 和 CI 配置，按仓库 `AGENTS.md` 未运行测试、语法检查、构建或远程 GitHub Actions。当前代码声明为 `0.4.0` 的事实已由静态读取确认，但远程 runner 重验仍属于后续 Release Gate。
