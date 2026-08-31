# OfferU Public Release Checklist

更新时间：2026-08-31

状态只允许：`PASS`、`FAIL`、`BLOCKED_EXTERNAL`、`PRE_EXISTING_FAILURE`、`NOT_VERIFIED`。`BLOCKED_EXTERNAL` 仅限签名证书、本人 OAuth、法律/隐私决策或第三方生产账号；未运行与证据不足统一为 `NOT_VERIFIED`，不能计入通过率。

本清单逐项映射 `GOAL.md` 的原始 0–113 条 Release 契约。Internal Beta、Replay、Fixture、历史聊天和临时脚本证据不能自动继承为 Public Release PASS。

| ID | Release requirement | Status | Current evidence / proof still required |
| ---: | --- | --- | --- |
| 0 | Final Goal / local-first public Career OS | NOT_VERIFIED | Goal 已落盘；完整产品 outcome 未证明 |
| 1 | Product North Star / 减少手工维护成本 | NOT_VERIFIED | 需要 Golden Path 主动时间与返工证据 |
| 2 | Stable Product Model | NOT_VERIFIED | 架构文档对齐；需全页面 state projection matrix |
| 3 | Stable Technical Boundary | PASS | `ARCHITECTURE.md` 保持 React/Python/Tauri/Provider seam，无第二 Node backend |
| 4 | Stable Authority Model | NOT_VERIFIED | Registry 设计存在；需全 surface bypass scan |
| 5 | Repository as System of Record | PASS | GOAL/STATUS/SCORE/CHECKLIST/HANDOFF/ISSUES/ARCHITECTURE/SECURITY/RELIABILITY 均由仓库维护 |
| 6 | Autonomous Execution Mode | PASS | 当前 Phase 与 update loop 已记录 |
| 7 | Hard Stop Conditions | PASS | `GOAL.md` 已限定真实人工阻塞 |
| 8 | Two-Failure Rule | PASS | `GOAL.md` 已记录；后续每个假设按此执行 |
| 9 | Release Scope Freeze | PASS | `GOAL.md` 已冻结非核心新功能 |
| 10 | First Run Journey | NOT_VERIFIED | Internal Beta UI 有线索；无安装包/clean-machine 证据 |
| 11 | First Run Metrics | NOT_VERIFIED | 无当前 RC 100% onboarding report |
| 12 | Empty States | NOT_VERIFIED | 需 Today/Pipeline/Profile/Job/Resume 实际 UI matrix |
| 13 | Today projection | NOT_VERIFIED | Internal Beta only；需全 source projection outcome |
| 14 | Today State Consistency | NOT_VERIFIED | 无 `INTERVIEW_INVITED` 全页面一致性正式报告 |
| 15 | Pipeline | NOT_VERIFIED | Internal Beta only；stage/source/next action matrix 缺失 |
| 16 | Job Detail | NOT_VERIFIED | 聚合结构存在；需真实新用户 outcome |
| 17 | Resume Workspace | NOT_VERIFIED | 当前未提交实现与历史内测证据；Public stress/E2E 未跑 |
| 18 | Resume Truth Model | NOT_VERIFIED | 模型关系存在；需 original no-overwrite outcome |
| 19 | Resume Proposal | NOT_VERIFIED | Before/After 等存在；需全部交互 repeatability |
| 20 | Fact Gate | NOT_VERIFIED | 历史 blocked path；需 100% unsupported enforcement suite |
| 21 | Stale Proposal | NOT_VERIFIED | 历史路径通过；需当前 commit conflict E2E |
| 22 | Resume Metrics | NOT_VERIFIED | 缺 99.9% autosave stress、0 lost edit 与语言 PDF matrix |
| 23 | Role Intelligence authority split | NOT_VERIFIED | 设计对齐；需统计 provenance audit |
| 24 | Fixture vs Live labels | NOT_VERIFIED | 部分标识存在；需全 UI/README claim scan |
| 25 | Live Provider Gate | NOT_VERIFIED | 无 live external research E2E；否则必须降级 claim |
| 26 | 10-role Live Acceptance | NOT_VERIFIED | 无 10-role raw→dedupe→cohort→Delta matrix |
| 27 | Interview Focus | NOT_VERIFIED | 需证明 Delta × Gap × Learning，而非 generic bank |
| 28 | Interviewer Behavior | NOT_VERIFIED | 缺 no-praise/no-completion/no-premature-coaching tests |
| 29 | Interview Debrief | NOT_VERIFIED | 历史 UI path；需 transcript citation coverage |
| 30 | Interview Learning | NOT_VERIFIED | Candidate path 有线索；需不直写 verified Profile 证明 |
| 31 | Memory Lifecycle | NOT_VERIFIED | 需六态、source/evidence/confidence/history matrix |
| 32 | PotentialHypothesis isolation | NOT_VERIFIED | 需永不自动变 Career Fact 的 deterministic test |
| 33 | Single Automation model | NOT_VERIFIED | 架构对齐；需 duplicate loop/drift scan |
| 34 | Automation Reliability | PARTIAL | Reliability-02 真实进程重启验证 queued AutomationEvent 恢复；provider timeout 与全部业务 mutation exactly-once 仍缺 |
| 35 | CareerTask lifecycle | PARTIAL | Reliability-02 真实进程验证 running/queued/waiting 状态边界；完整 UI/provider/approval lifecycle 仍缺 |
| 36 | Restart Recovery | PARTIAL | Reliability-02 覆盖真实 Python force-stop/restart、durable state 和浏览器启动 overlay/core UI recovery；五场景矩阵仍缺 |
| 37 | AgentRuntimeProvider UI seam | NOT_VERIFIED | provider-neutral 设计存在；需 UI branch scan |
| 38 | Minimum Live Agent Gate | NOT_VERIFIED | Replay only；至少一个真实 Provider `LIVE_PASS` 缺失 |
| 39 | Operation Registry Audit | NOT_VERIFIED | 历史称 0 bypass；无当前 commit 全 surface report |
| 40 | Application Pipeline stages | NOT_VERIFIED | 需所有正式 stage 与 timeline outcome |
| 41 | External Signals as Candidate | NOT_VERIFIED | 需 email/browser/calendar 未授权不改 Truth 的 tests |
| 42 | Browser Autofill boundary | NOT_VERIFIED | 若保留 claim，需 Fill≠Submit E2E；否则 Experimental |
| 43 | Database Migration | PASS | `docs/evals/reports/2026-08-31-codex-offeru-core-v1-data-safety-02.md`：v1/v2 编号迁移、old-schema A/B fixtures、future version fail-closed |
| 44 | Migration Safety | PASS | 同一报告：migration 前 verified backup、migration 后 integrity/smoke、强制失败恢复旧快照并停止启动 |
| 45 | Consistent Backup | PASS | `docs/evals/reports/2026-08-31-codex-offeru-core-v1-data-safety-01.md`：SQLite Online Backup API、managed assets、manifest/hash、integrity 验证 |
| 46 | Restore 3 cycles | PASS | 同一报告：隔离数据库完成 3 次 create→backup→mutate→stage→restart→verify，含数据库、资产与 pre-restore 备份 |
| 47 | Structured Data Export | PASS | `docs/evals/reports/2026-08-31-codex-offeru-core-v1-data-safety-03.md`：Profile/Job/Application/Resume/Interview/CareerArtifact 结构化集合、counts、可读性、嵌套敏感字段排除和 Settings 下载 |
| 48 | Reset Demo vs Delete Data | PASS | 同一报告：明确 `source=offeru-demo` + `batch_id=offeru-demo-v1` scope、确认门、子记录清理、真实 Profile/未标记 Job 保留和隔离浏览器 E2E |
| 49 | SQLite Integrity | PASS | 同一报告：Doctor 与每次恢复后的 `PRAGMA integrity_check=ok`，foreign-key violations 为 0 |
| 50 | Security Baseline | NOT_VERIFIED | `security-01`/`security-02` 已有当前子项报告；错误关联、诊断包和 Python/npm dependency 已补证，完整 canary、Rust dependency、全量 PII/logging、权限 diff 和 privacy/consent 仍缺 |
| 51 | Secrets exclusion | PARTIAL | `security-02` 覆盖 API validation/error、diagnostic、browser feedback、config/Run/export 路径；历史行、Temp、trace、log 和完整 artifact scan 未完成 |
| 52 | Canary Secret Test | PARTIAL | durable Agent/Audit/export、API validation/error、diagnostic 和 browser feedback canary 通过；完整 release artifact matrix 未签署 |
| 53 | PII Logging | NOT_VERIFIED | 已收口确认的原始异常/远端响应路径；全部 logger、历史持久化行和 data-flow inventory 尚未完成 |
| 54 | Tauri Security | PASS | `docs/evals/reports/2026-08-31-codex-offeru-core-v1-security-01.md`：capability 仅 `core:default`、shell plugin 已移除、CSP 非 `null`，`cargo check` 通过；broad HTTPS limitation 已记录 |
| 55 | Dependency Gate | PARTIAL | Agent-runtime、frontend、extension npm production audit 与 Python `pip-audit` 为 0 vulnerabilities；RustSec advisory DB 在当前环境不可用 |
| 56 | Structured Observability | PARTIAL | `security-02` 已覆盖 bounded error metadata 与 error ID；完整 Run/Task/Audit schema/correlation 矩阵仍缺 |
| 57 | Error Correlation | PARTIAL | HTTP、Starlette 404、validation、frontend request/SSE 与浏览器 feedback 路径已有 `error_id`；全部 provider/stream/audit surface 未完成 |
| 58 | Diagnostic Bundle | PARTIAL | Registry-backed bundle、provider/DB/error 摘要与浏览器下载 canary 通过；完整 artifact/PII review 与 retention policy 仍缺 |
| 59 | Performance Baseline | NOT_VERIFIED | 无固定 Reference Environment 报告 |
| 60 | UI Performance SLO | NOT_VERIFIED | 五项 production measurements 缺失 |
| 61 | Long Task UX | NOT_VERIFIED | 需所有 >2s 路径 status/progress/cancel/failure audit |
| 62 | Soak Test | NOT_VERIFIED | Reliability-01 已完成 100 个 Replay CareerTask cycles，Reliability-02 增加真实进程恢复；混合用户工作负载和 Public soak 仍缺 |
| 63 | Memory / Resource Leak | NOT_VERIFIED | 100-cycle task 计数通过；未记录 warm-up 后 RSS growth |
| 64 | Testing Pyramid | NOT_VERIFIED | 有多类 tests；Migration/Packaging/Failure 完整覆盖未证明 |
| 65 | Unit / Deterministic Tests | NOT_VERIFIED | 需七类核心规则 coverage mapping |
| 66 | Operation Contract Tests | NOT_VERIFIED | 需 manifest/schema/side effects/permission/dry-run/output 全量 |
| 67 | Agent Contract Tests | NOT_VERIFIED | 需 stream/tool/approval/cancel/failure/resume 全矩阵 |
| 68 | Browser E2E Philosophy | NOT_VERIFIED | 历史脚本不在仓库；需用户可见行为审计 |
| 69 | Playwright Isolation | NOT_VERIFIED | 无每测 isolated DB/workspace/browser 的正式配置证明 |
| 70 | Playwright Failure Artifacts | NOT_VERIFIED | 无 CI failure-only artifact retention 证明 |
| 71 | Golden Path A — New User | NOT_VERIFIED | Internal Beta partial evidence；完整链与 installer 缺失 |
| 72 | Golden Path B — Existing User | NOT_VERIFIED | 无旧版本 DB migration journey |
| 73 | Golden Path C — Failure | NOT_VERIFIED | 部分 Provider 失败；六类可恢复 E2E 未齐 |
| 74 | Golden Path D — Duplicate | NOT_VERIFIED | Job save 有线索；全部关键 mutation 未齐 |
| 75 | Golden Path E — Resume Conflict | NOT_VERIFIED | 历史路径有线索；当前 RC 重复性未证明 |
| 76 | Golden Path F — Data Recovery | PASS | 同一报告：隔离 Settings UI 暂存/取消、真实重启恢复和恢复后健康检查通过；不继承其他 Public E2E 结论 |
| 77 | Critical Repeatability 10/10 | NOT_VERIFIED | 无连续 10 次证据 |
| 78 | Extended Stability 50 runs ≥98% | NOT_VERIFIED | 无 50-run report |
| 79 | Full Test Gate | NOT_VERIFIED | 当前 commit 后端 `297 passed, 10 warnings, 1 subtest passed`；前端/桌面/浏览器全栈 Release gate 仍未完成 |
| 80 | Pre-existing Failure policy | PASS | 当前 Status 不把历史失败排除出 Release |
| 81 | Release Severity | PASS | P0–P3 已在 `KNOWN_ISSUES.md` 使用 |
| 82 | Release Bug Gate | NOT_VERIFIED | 未完成全产品 P0/P1 triage 与 0/0 证明 |
| 83 | Production Packaging | FAIL | 当前 Tauri launcher 仍是 dev-mode repository launcher |
| 84 | Clean Machine | FAIL | Quickstart 要求 Python/Node/repo/terminal |
| 85 | Python Sidecar | FAIL | `externalBin` 未配置；release 生命周期未实现 |
| 86 | Installer lifecycle | NOT_VERIFIED | fresh install/launch/uninstall/reinstall 未跑 |
| 87 | Unified Versioning | FAIL | backend 0.4.0、frontend/Tauri/Rust 0.1.0 不一致 |
| 88 | Upgrade | NOT_VERIFIED | previous installer→current→migration→Golden Path 未跑 |
| 89 | Update Signing | NOT_VERIFIED | updater 未启用；启用时签名不可关闭 |
| 90 | Code Signing | BLOCKED_EXTERNAL | 代码/installer 尚未 ready；最终证书需要所有者 |
| 91 | Release Artifact set | NOT_VERIFIED | installer/checksum/metadata/notes/notices 缺失 |
| 92 | CI Release Pipeline | FAIL | 无 release tag 全 Gate 自动 pipeline 证明 |
| 93 | Release Candidate | NOT_VERIFIED | 尚未产生 `vX.Y.Z-rc.1` |
| 94 | RC Iteration Loop | NOT_VERIFIED | 无每 RC 全量重验报告 |
| 95 | Three-perspective Self Review | NOT_VERIFIED | 当前 Workstream 完成后需三轮记录 |
| 96 | Architecture Drift Scan | NOT_VERIFIED | 需自动检查六类 drift 并留证据 |
| 97 | Dependency Direction | NOT_VERIFIED | 架构声明存在；需 cross-layer import audit |
| 98 | Privacy Disclosure | NOT_VERIFIED | Public UI disclosure 未完成 |
| 99 | Consent | NOT_VERIFIED | 四类 consent outcome matrix 缺失 |
| 100 | Product Claims Gate | NOT_VERIFIED | 需 README/UI/site 对照 live evidence 全量扫描 |
| 101 | README Update only after Final Gate | PASS | 当前仍明确为 Internal Beta，未提前宣称 Public Release |
| 102 | Public QUICKSTART / DEVELOPMENT split | FAIL | 当前 QUICKSTART 是开发者双终端流程，无 DEVELOPMENT.md |
| 103 | Support Diagnostics | NOT_VERIFIED | 基础诊断下载存在；Doctor/error_id 定位矩阵缺失 |
| 104 | Doctor Release Gate | FAIL | Doctor 已检查 DB integrity、backup count 和 pending restore；desktop bridge、storage、version consistency 仍未完整覆盖，未返回 CORE_READY |
| 105 | Release Dashboard | PASS | `STATUS.md` 已建立七域 dashboard，但各域尚未通过 |
| 106 | Release Blocker Rule | PASS | 当前 FAIL/NOT_VERIFIED 已阻止发布 |
| 107 | Optional Integration Rule | NOT_VERIFIED | 文档对齐；需 UI label 与真实 core provider outcome |
| 108 | Final Human Acceptance | NOT_VERIFIED | 未在陌生用户 clean machine 执行 |
| 109 | Production Definition of Done | NOT_VERIFIED | 多项硬 Gate FAIL/NOT_VERIFIED |
| 110 | Final Status Rule | PASS | 当前保持 active，不因技术问题停止 |
| 111 | Completion Report | NOT_VERIFIED | 只在最终两种合法 verdict 产生 |
| 112 | Continuous Autonomous Instruction | PASS | STATUS/SCORE/next blocker 循环已开始 |
| 113 | Final Principle / user control | NOT_VERIFIED | 需最终人类验收、恢复与升级证据 |

## Current highest-priority blocker

```text
Security residual baseline: full release artifact canary, Rust advisory, permission diff, complete logging/PII and privacy/consent
```

`DATA_SAFETY_01` 已通过 R45/R46/R49/R76，`DATA_SAFETY_02` 已通过 R43/R44，`DATA_SAFETY_03` 已通过 R47/R48。Data Safety 已完整通过，但 Security 及其他硬 Gate 未通过前不得宣称 Public Release PASS。

当前 Security 证据：[Security 01](docs/evals/reports/2026-08-31-codex-offeru-core-v1-security-01.md) 与 [Security 02](docs/evals/reports/2026-08-31-codex-offeru-core-v1-security-02.md)。Security 02 已将错误关联、脱敏诊断包、Python/npm dependency 和若干 canary 推进到 PARTIAL，但两个 domain 仍未完整通过；下一执行顺序回到 Reliability 真实进程/浏览器恢复与资源测量，同时保留 Security residual。
