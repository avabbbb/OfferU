# OfferU Core v1 Security 04 — Rust advisory and Tauri permission contract

日期：2026-08-31  
观察 checkout：当前工作树（Security-03 之后）  
实现 commit：待提交  
结论：`PARTIAL`

## Scope

本轮收口两个可以在当前 Windows 环境完成的 Security residual：

```text
Rust dependency advisory
Tauri capability / permission diff
```

不使用真实账号、OAuth、外部投递或用户职业数据。

## Rust dependency result

首次 `cargo audit` 尝试从 RustSec 拉取最新 advisory database，但 GitHub fetch 在当前环境失败；因此不能把该命令误报成最新数据库结论。随后使用本机已有 advisory database 执行 `cargo audit --no-fetch`，发现 Cargo.lock 中：

```text
quick-xml 0.39.4  → RUSTSEC-2026-0194 / RUSTSEC-2026-0195
rkyv 0.7.46       → RUSTSEC-2026-0235
```

通过 `cargo update` 清理未使用的 `rkyv`/`rust_decimal`/`byte-unit` 路径，并将 `plist`/`quick-xml` 更新到 `plist 1.10.0`/`quick-xml 0.41.0`。随后：

```text
cargo audit --no-fetch
→ 0 vulnerabilities; 17 allowed unmaintained/unsound warnings

cargo check
→ Finished `dev` profile successfully
```

剩余 warning 主要是 GTK3 bindings、`proc-macro-error` 和 `glib` 的维护/生态状态，不是当前 audit 判定的可利用漏洞；它们仍保留在 Release 风险记录中。

## Tauri permission diff

新增确定性 contract test，比较当前桌面配置和允许的最小权限基线：

```text
capabilities files: default.json only
windows: [main]
permissions: [core:default]
generic shell capability: absent
tauri_plugin_shell in Rust source: absent
frontendDist: ../dist
devUrl: http://localhost:7410
CSP: non-empty, object/frame denied, unsafe-eval absent
```

执行：

```text
backend\.venv312\Scripts\python.exe -m pytest tests\test_tauri_security_contract.py -q
1 passed in 0.08s
```

## Release mapping

| Requirement | Verdict | Reason |
| --- | --- | --- |
| R50 Security Baseline | NOT_VERIFIED | Rust 本地 advisory 与 Tauri 权限 contract 已收敛；完整 artifact、PII/logging、privacy/consent 仍缺 |
| R54 Tauri Security | PASS | capability/permission contract 通过，`cargo check` 通过；CSP broad HTTPS residual 仍按既有报告保留 |
| R55 Dependency Gate | PARTIAL | 本地 advisory database 对当前 lockfile 报告 0 vulnerabilities，cargo check 通过；最新 RustSec fetch 失败且 17 条 unmaintained/unsound warnings 仍需 Release 决策 |
| R89 Update Signing | NOT_VERIFIED | 没有 updater artifact |
| R90 Code Signing | BLOCKED_EXTERNAL | 需要所有者合法证书与签名凭据 |

## Explicit non-claims

本报告不证明：

- advisory database 已经与 RustSec 当日远端完全同步；
- 17 条维护/生态 warning 可以全部忽略；
- 全量 logger/PII、历史行 scrub、browser/Temp/trace artifact、privacy/consent、updater 或 Public Release 已通过。

## Machine-readable summary

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-core-v1",
  "suite_version": "1.0.0",
  "run_id": "security-04",
  "target_scope": "rust-advisory-tauri-permission-contract",
  "evidence_date": "2026-08-31",
  "implementation_commit": null,
  "verdict": "PARTIAL",
  "passed_security_subchecks": [
    "cargo_audit_no_fetch_zero_vulnerabilities",
    "cargo_check",
    "tauri_minimal_capability_contract"
  ],
  "residual": [
    "rustsec_remote_fetch_unavailable",
    "unmaintained_or_ecosystem_warnings",
    "logging_pii_inventory",
    "privacy_and_consent"
  ],
  "public_release": "NOT_READY",
  "recommended_decision": "continue-logging-pii-and-privacy-consent-gates"
}
```
