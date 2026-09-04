# OfferU Public Release — Artifact Verifier Symlink Guard

日期：2026-09-02  
状态：静态实现完成，运行证据待执行

## 目标

让发布物 manifest/hash/version 校验器在遇到符号链接时 fail-closed，避免发布目录通过 `resolve()` 意外读取目录外内容。

## 变更

- `verify_release_artifacts()` 拒绝 symlink release root；
- `artifacts.json`、`SHA256SUMS.txt`、`version.json` 通过受限 metadata-file 边界读取；
- metadata symlink、缺失文件和解析后越界都会返回明确的校验失败；
- 新增 symlink root 和 symlink metadata 隔离 contract tests；
- 未删除任何文件，未触碰真实 `offeru.db`，未启动 Edge 或任何浏览器，也未访问 8080。

## 验收映射

- GOAL：43–46、50–52、91–92；
- Release Checklist：R51、R91、R92；
- Security：release artifact / metadata path boundary。

## 尚未执行

按 `AGENTS.md`，本轮没有运行测试、构建、语法检查、扩展构建、远程 runner 或 tag release。

因此不能把该静态控制提升为 Public Release PASS；签名 artifact、远程下载复验、clean-machine 安装和升级仍待后续真实验收。
