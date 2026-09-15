# Runtime Comparison

目标（GOAL §16）：同一批 Case、同一 Seed、同一 Grader，横向比较不同外部 Coding Agent，
得到「到底变好了还是只是感觉变好了」。

> **禁止**把某个 Runtime 的 Provider 故障算成模型智力差距。
> Provider 层失败单独归 `BLOCKED`，不计入能力分。

---

## 当前状态

| 项 | 值 |
| --- | --- |
| 已实现 Adapter | **codebuddy（WorkBuddy / CodeBuddy Code）** —— 唯一 |
| 已识别但未实现 Adapter | codex、claude、gemini、opencode、pi、omp |
| Runner 的 `--runtime` 参数 | **尚未实现**（当前固定 codebuddy） |

本机探测到的 Runtime（`list_local_executors`）：

| id | version | 已声明能力 |
| --- | --- | --- |
| codex | codex-cli 0.154.0 | schema_mode / cancel / live_web_search / resume |
| claude | claude-agent-sdk 0.3.2 | 同上 |
| gemini | （未取到） | schema_mode / live_web_search |
| opencode | 1.17.11 | schema_mode / cancel / live_web_search / resume |
| pi | 0.74.0 | 同上 |
| omp | omp/18.0.4 | 同上 |
| **codebuddy** | **2.137.1** | 同上 |

⚠️ 上表是**本地探测到的版本**，不等于「可用于 Eval」：
- 本机 `codex` 处于 `BLOCKED_EXTERNAL_AUTH`
- 本机 `pi` 处于 `BLOCKED_AUTH`（opencode.ai 401 Insufficient balance）

因此**当前只能对 codebuddy 跑 Benchmark**。横向表待 Adapter 扩展后填写。

---

## 对比表（待填）

```
Runtime     pass@1   pass^3   Safety   Avg Turns   Tool Errors   Provider Failures
---------   ------   ------   ------   ---------   -----------   -----------------
codebuddy   ...      ...      ...      ...         ...           ...
codex       ...      ...      ...      ...         ...           ...
claude      ...      ...      ...      ...         ...           ...
pi          ...      ...      ...      ...         ...           ...
```

**必须同时保存 per-case 对比**，否则总分会掩盖能力差异：

```
Case    codebuddy   codex   claude   pi
E01     PASS        ...     ...      ...
E02     FAIL        ...     ...      ...
...
```

---

## 如何扩展一个 Adapter

在 `backend/scripts/live_eval/` 下新增 Runtime Adapter，实现与 `_run_harness_once` 相同的契约：

```python
async def run_turn(prompt: str, *, eval_db: Path, timeout: int) -> Trace
```

要求：
1. 必须把 `DATABASE_URL` 指向隔离副本（与 codebuddy adapter 一致）。
2. 必须让被测 Agent **只能走 CLI / Operation Registry**。
3. 必须显式禁止被测 Agent 自行 `app.cli confirm`。
4. 必须返回完整事件流（用于 trace 与 provider 归因）。

Case 与 Grader **不感知**底层 Runtime。

---

## 参考

- 判分口径见 [GRADING.md](./GRADING.md)
- 已确认问题见 [FINDINGS.md](./FINDINGS.md)
- 架构约束见 [EVAL_ARCHITECTURE_AUDIT.md](./EVAL_ARCHITECTURE_AUDIT.md)
- Reference implementation: <https://github.com/luyishui/OfferU>
