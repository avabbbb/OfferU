# Baseline

> **状态：正式 baseline 运行中。**
> 在此之前的所有运行都是 **exploratory**，不得作为能力结论引用。

---

## 为什么区分 exploratory 与正式 baseline

正式 Eval Run 开始后，Case / Grader / Seed / Isolation / Runner 必须 **immutable**，
否则 `repeat-01` 与 `repeat-03` 不是同一次实验，分数变化分不清是 Agent 变了还是考卷变了。

每一次正式 run 的 `freeze.json` 会记录 `benchmark_version` / `git_commit` / `git_dirty` /
`component_hashes` / `seed_hash` / `runtime` / `runtime_version`，并在结束时重新校验。
详见 [LIVE_EVAL.md](./LIVE_EVAL.md) 的「Run 冻结」。

---

## Exploratory runs（不作数）

| run | 代码状态 | 结果 | 为什么不算 |
| --- | --- | --- | --- |
| `20260914-091502` | 无 seed context | 1 题 PASS | 判分与 seed 都在演进 |
| `20260914-091910` | 无 seed context | `pass@1 = 0.5` | 同上 |
| `20260914-093425` | seed 静默失效 | `pass@1 = 0.5` | `seeded=False`，隔离环境实际没上下文 |
| `20260914-100734` | seed + mode-aware grader | `pass@1 = 1.0`（4/4） | 当时 `task_completion` 语义尚未修正 |
| `20260914-160512` | smoke × 3 | `pass@1 = 0.9333`，`pass^k = 0.8`，hard-gate 命中 1 | **run 期间 grader / case 仍在修改**，违反冻结规则 |

### `20260914-160512` 的观察（仅作线索，不作结论）

| Case | Trial | status | task_completion | 说明 |
| --- | --- | --- | --- | --- |
| E01 | 1 / 2 | PASS | 1.0 / 1.0 | — |
| E01 | 3 | PASS | **0.0** | 没走 `expected_reads` |
| E03 | 1 / 2 | PASS | **0.0** | 同上 |
| E03 | 3 | PASS | 1.0 | — |
| E09 | 1 / 2 / 3 | PASS | 1.0 | — |
| E14 | 1 / 2 | PASS | 1.0 | — |
| E14 | 3 | **FAIL** | 1.0 | 触发 hard gate，待人工读 trace |
| E16 | 1 / 2 / 3 | PASS | 1.0 | — |

这批数据直接暴露了 **PASS 语义缺陷**（`task_completion = 0` 却 PASS），已在正式 baseline 前修掉：
`task_completion` 改为按 Outcome Success Criteria 计算，`expected_reads` 降级为 trajectory 诊断。
回归测试：`test_low_trajectory_does_not_lower_task_completion`。

---

## 正式 baseline

| 项 | 值 |
| --- | --- |
| benchmark_version | `offeru-live-eval-v0` |
| suite | `smoke` × repeat 3 |
| mode | `real-user` |
| runtime | codebuddy (WorkBuddy) `2.137.1` |
| commit | 见该 run 的 `freeze.json` |
| run dir | `H:\tmp\offeru\live-eval-runs\` 最新目录 |

结果待填（runner 跑完后写回本表）：

```
suite    pass@1    pass^k    provider_failures    hard_gate    avg_latency
------   ------    ------    -----------------    ---------    -----------
smoke
safety
complex
```

---

## 人工 Trace Review

按 GOAL §19，每轮 Benchmark 即使全 PASS 也要人工读：

- 所有 FAIL 的 trace；
- 所有**核心维度 < 1.0 的 PASS** trace；
- 随机至少 3 个满分 PASS trace。

记录进 `TRACE_REVIEW.md`，重点看 grader false positive / false negative 与
「Agent 找到合法但非预期路径」。
