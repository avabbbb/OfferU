# OfferU Public Release — RustSec dependency audit

日期：2026-09-02  
观察 checkout：当前工作树  
结论：`NOT_VERIFIED`

## Scope

审计 `frontend/src-tauri/Cargo.lock` 的 Rust 依赖，并把同一安全边界接入 GitHub Actions。发布前必须同时知道：

- 当前 advisory database 是否能够更新；
- 是否存在已知漏洞；
- 是否存在 unsound 依赖；
- unmaintained warning 是否被明确记录，而不是被 `0 vulnerabilities` 掩盖。

## Local verification

本地使用 `cargo-audit 0.22.2`：

```text
RustSec advisory database fetch: PASS
Loaded advisories: 1239
Cargo.lock dependencies scanned: 441
cargo audit: exit 0
Known vulnerabilities: 0
Warnings: 17
```

严格 unsound policy：

```text
cargo audit --target-os windows --target-arch x86_64 --deny unsound
exit 1
denied finding: glib 0.18.5 / RUSTSEC-2024-0429
allowed warnings: 16 unmaintained findings
```

当前结果证明 advisory database 已经成功获取，不能再沿用“无法 fetch”的旧说明；但它也证明严格安全策略仍未通过。GTK/GLib 相关依赖是 Tauri/Wry 跨平台依赖图中的传递依赖，即使当前 Windows 目标不使用该 Linux 图，也不能在发布记录中静默忽略。

补充的目标图检查：`cargo tree --locked --target x86_64-pc-windows-msvc --invert glib@0.18.5` 没有输出，说明当前 Windows 目标图不包含该 `glib` 节点；`cargo tree --locked --target all --invert glib@0.18.5` 则显示它来自 GTK/WebKit 的跨平台 Linux 分支。这个结果支持“Windows 包不链接该节点”的范围判断，但不能替代全锁文件安全政策的处置或产品所有者批准的例外。

## CI control

`.github/workflows/build.yml` 新增 `rust-security-audit` job：

1. 固定安装 `cargo-audit 0.22.2`；
2. 用当前 RustSec 数据执行普通 JSON audit；
3. 单独执行 `cargo audit --deny unsound`，发现 unsound 时 fail closed；
4. tag release job 依赖该 job，严格审计失败不会创建 Draft Release。

## Release mapping

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| R50 Security baseline | `NOT_VERIFIED` | RustSec 当前数据已可更新，但严格 unsound policy 失败；PII、retention、签名等其它安全 Gate 仍未完成 |
| R55 Dependency Gate | `NOT_VERIFIED` | 0 known vulnerabilities，但 `glib` unsound advisory 与 16 条 unmaintained warning 尚未完成处置；CI 已加入 fail-closed audit |
| R92 CI release pipeline | `NOT_VERIFIED` | RustSec job 已接入 workflow，但远程 runner 尚未执行 |

## Next required action

在发布前二选一并留下明确证据：

1. 升级/替换实际受影响依赖并重新运行严格审计；或
2. 对当前目标平台和 Tauri/Wry 依赖链完成书面风险评估、范围证明和产品所有者批准的安全例外。

不能仅因为默认 `cargo audit` 返回 0 就把 R55 标成 PASS。

本切片没有启动 Edge、没有访问 `8080`、没有打开浏览器，也没有修改真实用户数据库。
