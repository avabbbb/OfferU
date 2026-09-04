# Public Release Provider Health Matrix

日期：2026-09-02  
结论：`PASS_DETERMINISTIC_PROVIDER_HEALTH_MATRIX`

## Scope

本轮验证 Optional Integration Rule 的本地、确定性部分：所有内置 Provider 的健康投影必须能区分未探测、可用、需要认证、被阻断和不可用；Provider 健康错误不能通过历史数据库行或直接恢复路径泄露 token。

## Implementation

- `provider_health_view()` 统一输出五种状态：`unprobed`、`ready`、`auth_required`、`blocked`、`unavailable`；
- `list_provider_health()` 对 `pi`、`replay`、`codex`、`deepseek-harness` 输出稳定的 known-provider 集合；
- 健康错误在写入和读取两侧都经过 bounded credential redaction，避免旧数据绕过当前 writer；
- `replay` 仍作为内置、可用的本地 fallback；其它 Provider 的真实可用性不会因为矩阵测试而被伪造为 ready。

## Verification

```text
backend\.venv312\Scripts\python.exe -m pytest tests\test_release_provider_health.py -q -p no:cacheprovider
4 passed in 4.75s
```

隔离数据库还验证了：`pi=blocked`、`codex=unavailable`、`replay=ready`、`deepseek-harness=unprobed`；含 canary token 的历史 `last_error` 读取结果为 `provider authentication failed`，原始值未出现在投影中。

## Release mapping

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| R107 Optional Integration Rule | `PASS` for deterministic health contract | 五状态投影、known-provider 集合、read-side redaction 和隔离 DB matrix 通过 |
| R38 Minimum Live Agent Gate | `PARTIAL` | staged packaged Pi Run 仍有证据；真实 provider/network availability 仍按现有 live reports 单独判定 |
| R52 Canary Secret Test | `PARTIAL` | provider-health legacy-row redaction 纳入当前 contract；完整历史 artifact/PII/retention matrix 仍缺 |

## Remaining limits

本报告不代表 Codex OAuth、DSH、Gmail 或 live Role Intelligence 已可用，也不替代真实 Provider/network/restart 矩阵、clean-machine 验收、签名或隐私所有者决定。Optional Provider 仍必须在 UI 和公开文档中显示 `auth_required`、`blocked`、`unavailable` 或 `experimental`，不能伪造成功。

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-public-release",
  "run_id": "provider-health-2026-09-02",
  "verdict": "PASS_DETERMINISTIC_PROVIDER_HEALTH_MATRIX",
  "tested_statuses": ["unprobed", "ready", "auth_required", "blocked", "unavailable"],
  "known_provider_count": 4,
  "tests_passed": 4,
  "public_release": "NOT_READY"
}
```
