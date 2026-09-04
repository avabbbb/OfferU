# OfferU Public Release Artifact Verification

日期：2026-09-02

状态：`CONFIGURED_NOT_EXECUTED`

## Scope

本切片只验证发布 artifact 的元数据和内容完整性边界，不启动浏览器，不访问 Edge，不把 `8080` 当网页，也不修改用户数据库。

## Implemented contract

`backend/scripts/release/verify_release_artifacts.py` 对发布目录执行 fail-closed 检查：

- `artifacts.json` 必须列出非空的根目录 installer 文件；
- 每个文件的大小和 SHA-256 必须同时匹配 manifest 与 `SHA256SUMS.txt`；
- 路径不得穿越 artifact 根目录，符号链接和缺失文件拒绝；
- `version.json` 必须声明 `OfferU`、`windows-x64`、有效版本和与 manifest 一致的 installer 集合；
- tag 发布必须声明 `signed=true`；
- NSIS `*-setup.exe` 与 MSI 必须同时存在。

新增 contract tests 覆盖：

```text
valid manifest/checksum/version/signature
changed installer bytes
unsigned tag artifact
manifest path traversal
```

## CI placement

Windows package 在上传前执行校验；installed smoke 和 Draft Release 下载 artifact 后也执行校验，Draft Release 以 tag 去掉 `v` 的版本再次执行并要求签名。这样安装端和发布端不会只依赖上传端的文件存在检查。

## Verification boundary

本轮按仓库 `AGENTS.md` 未运行测试、语法检查、构建或远程 GitHub Actions。真实签名证书、Windows runner、下载后的 artifact 和最终 release 仍需在后续 Release Gate 中验证；因此本报告不产生 `PASS` 结论。
