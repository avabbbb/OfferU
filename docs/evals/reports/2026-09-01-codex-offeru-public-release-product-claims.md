# OfferU Public Release — product claim audit

日期：2026-09-01  
范围：README / Quickstart / Release Notes / frontend user-facing TypeScript surfaces

## 目的

Public Release 不能把 Replay/Fixture、实验 Provider 或未授权的外部写入宣传成正式能力。本轮增加一个 fail-closed 的高风险声明扫描，并修正数据模式显示，使未知模式不会被 UI 默认显示为 Live。

## 执行

```text
python backend/scripts/release/audit_product_claims.py --repo-root . --json
```

扫描器只检查发布面，不遍历虚拟环境、打包产物或内部审计文档；当前阻止以下无上下文声明：

```text
automatic external write
unbounded live market claim
positive Public Release Ready claim
```

带有 `不会`、`未完成`、`fixture`、`experimental`、`blocked` 等明确边界的说明不会被当作正向宣传。

## 结果

```json
{
  "schema_version": "offeru.product_claim_audit.v1",
  "surface_file_count": 118,
  "findings": [],
  "status": "clear"
}
```

同时，前端 `dataModeLabel()` 现在只将明确的 `fixture`、`fixture_plugin`、`live`、`live_plugin` 显示为对应标签；未知值显示为“未验证数据模式”。Role Intelligence、Interview 和 Job Detail 不再把任意未知字符串或 fixture plugin 隐式显示为 Live。

## 发布映射

| Requirement | Status | Evidence |
| --- | --- | --- |
| R24 Fixture vs Live labels | PARTIAL | 118 个发布面完成高风险扫描；UI 数据模式统一标签；installer/网站人工 review 仍缺 |
| R25 Live Provider Gate | PARTIAL | 声明扫描不替代真实 live Role Intelligence E2E；当前 Pi/Codex 限制见 live role report |
| R100 Product Claims Gate | PARTIAL | 自动扫描为 clear 并接入 backend CI；真实 live claim、installer 和最终网站人工语义验收仍缺 |
| R101 README status | PASS | README 仍明确 `Public Release NOT READY`，没有提前宣传正式版 |

## 限制与非声明

该扫描器是发布防线，不是自然语言完整事实审查，也不证明任何外部 Provider、installer、签名或 Public Release Ready。最终公开文案仍需要在 Release Candidate 和目标安装包上由产品所有者复核。

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-public-release",
  "run_id": "product-claims",
  "target_scope": "release-facing-claims",
  "evidence_date": "2026-09-01",
  "verdict": "PARTIAL",
  "passed_subchecks": [
    "118_surface_files_scanned",
    "no_unqualified_automatic_external_write_claim",
    "no_unqualified_live_market_claim",
    "no_positive_public_release_ready_claim",
    "unknown_data_mode_is_not_live"
  ],
  "partial_subchecks": [
    "no_installer_surface_review",
    "no_external_website_review",
    "live_provider_claim_not_verified"
  ],
  "public_release": "NOT_READY"
}
```
