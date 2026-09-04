# OfferU Public Release Architecture Drift Audit — 2026-09-01

## Scope

本轮对当前工作树执行静态边界审计，目标是检查 Release Goal 中的 Registry、Provider seam 和分层约束。正式脚本为
`backend/scripts/release/audit_architecture.py`，并已接入 backend CI。该报告是静态审计，
不替代运行时授权/审计路径和最终代码 review。

## Operation / database boundary

使用正式审计脚本扫描 `backend/app/routes/**/*.py`、Python lower layers、CLI/MCP/plugin
control surfaces，以及非配置型前端 Provider execution branch：

```text
route files inspected: 21
route mutation functions inspected: 151
direct SQLAlchemy mutation calls in routes (add/commit/delete/flush): 0
db.execute calls containing update/delete/insert expressions: 0
mutation routes without Registry/runtime boundary: 0
direct mutating service calls from routes: 0
optional startup services outside observable recovery boundary: 0
```

路由中的 `db.execute` 结果均属于读取或统计边界；业务写入继续进入 Service/Operation 路径。扫描中特意排除了 `router.delete(...)` 路由装饰器的误报。

本轮又将 Registry contract 固化到全量 `OPERATIONS`：250 个操作现在都发布闭合的
`input_schema` object；显式 Pydantic model 继续使用 model schema，仍采用旧函数签名
校验的操作则从运行时签名派生 required/properties，保持 `additionalProperties=false`。
`tests/test_cli_ops.py` 的全量 contract test 同时校验 output envelope、side effects、
dry-run/confirmation 对齐和版本字段。

## Agent Provider seam

运行时引用审计结果：

```text
Main Agent route → get_agent_run_provider(provider_id)
Provider implementations → agent_runtime.py
Pi adapter → pi_agent_host.py
```

没有发现 React 主 Agent 执行路径按 Pi/Codex/DSH 分支；前端命中的 Provider 条件只位于邮箱展示、Settings/Onboarding 的 URL/key normalization 和 health/experimental label，不负责执行 Agent 或写 Career Truth。

入口边界 contract test 还确认：CLI 的 run/confirm 只调用
`execute_or_propose_operation` / `confirm_operation_proposal`，MCP 的 operation/resource
入口只调用同一 projection，Capability Plugin service 不导入 SQLAlchemy、数据库或
Career model。Bridge 的数据库访问仅用于 read-only reachability probe。

## Dependency direction

正式脚本与 `tests/test_control_plane_global.py` 的分层 import contract 均扫描
`app/models`、`app/agents` 和 `app/services` 的全部 Python 文件：

~~~text
lower-layer → app.routes imports: 0
app.models → app.routes/services/agents/ops imports: 0
CLI/MCP/plugin control-surface escape hatches: 0
non-config frontend Provider execution branches: 0
~~~

扫描保持了必要的控制面方向：Service 可以通过 `app.ops` 进入 Registry，Agent
可以使用 domain service；只禁止向上回到 FastAPI route。历史的优化、Profile
Agent、Resume export 和 scraper 反向 import 已改为 route-independent service seams。

自动化模型审计还确认只有一个 durable Event → Rule → CareerTask dispatcher：
`automation._process_automation_event`。它通过原子 claim、rule dispatch 和
`start_career_task` 进入任务层，不创建私有 provider loop。邮箱同步、Memory distill
和工作源自动同步的可选启动同样经过 `run_startup_recovery`，启动异常会进入 health
和诊断包，而不是阻塞核心应用或静默丢失。
和诊断包，而不是阻塞核心应用或静默丢失。

## Canary artifact scan

对当前任务生成的 `.tmp`、release reports 和运行产物执行 canary 字符串扫描，排除源码测试定义、`GOAL.md`、`backend/config.json`、`backend/.env`、依赖和 build target：

```text
OFFERU_RELEASE_CANARY_SECRET leaked artifact files: 0
sk-canary leaked artifact files: 0
canary-secret leaked artifact files: 0
```

该扫描不声称已经覆盖用户机器上所有历史 logs、第三方 Provider 日志或未来生成的文件；这些仍由 Security/Privacy residual gate 管理。

## Verdict

```text
PARTIAL
```

当前扫描未发现新的 route-level direct DB mutation、Registry bypass、分层反向依赖或主
Agent Provider coupling，也未发现自动化重复 dispatcher 或可选启动恢复旁路。仍需：

- 运行时全 surface Operation audit（CLI/MCP/plugin/browser/legacy endpoint）继续维持 0 known bypass；
- 其它非 Python surface 的完整 cross-layer/import 审计；
- 在远程 CI runner 上执行正式 drift gate，并补齐动态 browser/legacy runtime audit；
- 发布前完成历史 artifact/PII/retention 审计和代码签名。

## Release mapping

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| R37 AgentRuntimeProvider UI seam | `PARTIAL` | 主 Agent 只经 provider factory；Settings/Onboarding 的 provider 条件是配置/展示用途 |
| R33 Single Automation model | `PASS` | 正式审计确认唯一 `automation._process_automation_event`，Event→Rule→CareerTask 经过原子 claim/dispatcher；无 automation 私有 async loop 或 provider bypass |
| R39 Operation Registry Audit | `PARTIAL` | 正式 architecture audit 与 `test_control_plane_global.py`：route direct mutation、Registry bypass、CLI/MCP/plugin escape hatch 均为 0；完整 browser/legacy runtime audit 仍需 |
| R52 Canary Secret Test | `PARTIAL` | 当前任务 artifact scan 为 0 leak；完整 signed/release artifact matrix 仍缺 |
| R96 Architecture Drift Scan | `PARTIAL` | 正式脚本已覆盖 route mutation、Registry boundary、Provider branch、CLI/MCP/plugin boundary、Python lower-layer import、唯一 Automation dispatcher 和 startup recovery boundary，并接入 CI；远程 runner、动态 browser/legacy audit 和所有运行时 drift 类别仍缺 |
| R97 Dependency Direction | `PASS` | `test_control_plane_global.py` 扫描 app/models、app/agents、app/services：无回到 `app.routes` 的 lower-layer import，ORM models 无 application/control-plane import |
| R66 Operation Contract Tests | `PASS` | 全量 250 operations 均发布 closed input schema；explicit model 与 signature-derived schema 均由 `tests/test_cli_ops.py` 校验 |

## Machine-readable summary

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-public-release",
  "run_id": "public-release-architecture-audit-2026-09-01",
  "verdict": "PARTIAL",
  "operation_count": 250,
  "closed_operation_input_schemas": 250,
  "route_files": 21,
  "route_mutation_functions": 151,
  "route_direct_mutation_calls": 0,
  "route_sql_mutation_expressions": 0,
  "route_registry_bypasses": 0,
  "route_mutating_service_bypasses": 0,
  "main_agent_provider_coupling": "not_found",
  "frontend_provider_execution_branches": 0,
  "control_surface_bypasses": 0,
  "automation_model_bypasses": 0,
  "startup_recovery_bypasses": 0,
  "canary_artifact_leak_files": 0,
  "public_release": "NOT_READY",
  "lower_layer_route_imports": 0,
  "model_application_imports": 0,
  "residual": ["browser_legacy_runtime_audit", "dynamic_runtime_drift", "remote_ci_execution", "historical_artifact_scrub"]
}
```
