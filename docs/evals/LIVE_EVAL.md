# Live Agent Eval（Ava 版）

> 目标：把「我感觉这个 Agent 挺聪明」变成
> 「在固定 OfferU Career World 的 20 个真实求职任务上，这个 Runtime 的 pass@1 是多少、
> 连续多次成功率是多少、有没有越权、失败到底属于模型 / Harness / Provider / 产品代码」。

- 被测对象：**外部 Coding Agent**（WorkBuddy / Codex / Claude / Pi），它通过 OfferU Operation Registry 干活
- 判分依据：**数据库最终状态 + 工具轨迹**，不看 Agent 自称完成
- 关键前提：模型能力由外部 Harness 自带，因此 **Eval 不需要单独的 LLM 凭据**

Reference implementation: **https://github.com/luyishui/OfferU**

---

## 5 分钟上手

```bash
cd backend

# 1) 列出题库（不需要任何凭据）
python scripts/live_eval/runner.py --list-cases

# 2) 校验 seed 源库可用
python scripts/live_eval/runner.py --seed-check

# 3) 跑一道最轻的题（约 2 分钟）
python scripts/live_eval/runner.py --case E16 --timeout 420

# 4) 跑 smoke 套件
python scripts/live_eval/runner.py --suite smoke

# 5) 跑稳定性：同一批题重复 3 次，报告 pass@1 / pass^k
python scripts/live_eval/runner.py --suite smoke --repeat 3

# 6) 找产物（每次 run 一个目录）
ls -t H:/tmp/offeru/live-eval-runs/ | head -1
```

### 产物怎么看

```
H:/tmp/offeru/live-eval-runs/<YYYYMMDD-HHMMSS>/
    summary.md        ← 先看这个：pass@1 / pass^k / hard-gate 命中
    summary.json
    metrics.json
    issues.md         ← 只看失败项

    <case-slug>/
        case.json         题目与期望（含 target_job_id / context_seeded）
        runtime.json      被测 Harness 与工具白名单
        seed_state.json   seed 结果（current view 是否预置成功）
        db_before.json    执行前各表行数
        db_after.json     执行后各表行数
        db_diff.json      真正的增删改
        events.ndjson     Harness 原始事件流
        trace.json        trace 结构化摘要
        trace.md          ★ 人类可读全过程（输入、工具序列、最终答复、DB 变化）
        tool_calls.json   工具调用明细
        proposals.json    提案与（能力模式下的）确认记录
        operations.json   提取出的 Operation 与轮次信息
        audit.json        operation_audit_logs 新增行
        grader.json       判分输入快照
        verdict.md        ★ 判定与理由
        verdict.json      判定结构化结果
```

> **不要只看 PASS / FAIL。一定要读几个 `trace.md`。**
> 否则你无法区分「Agent 真错了」和「Grader 写错了」。

### repeat 模式

`--repeat N` 时产物按 `repeat-01/ repeat-02/ …` 分目录，`summary.json` 会给出：

- `pass_at_1`：单次通过率
- `pass_power_k`：同一 case 的 N 次 trial **全部**通过的比率（稳定性）
- `provider_failure_rate`、`hard_gate_rate`、`avg_latency_s`

---

## 两种模式

| 模式 | 含义 | 用途 |
| --- | --- | --- |
| `--mode real-user`（默认） | 不自动确认 | 测 Agent 会不会乱问、越权、在危险操作前正确停下 |
| `--mode capability` | runner 扮演配合的用户：自动确认提案 + 补「请继续执行，我同意。Go on.」 | 测最终任务完成能力 |

**能力模式的确认由 runner 侧执行**（`app.cli confirm`），被测 Agent 的 allowlist 里显式
`deny` 了 confirm —— **Agent 永远不能自批**。

---

## Run 冻结（硬规则）

> **正式 Eval Run 开始后，该 Run 使用的 Case / Grader / Seed / Isolation / Runner 必须 immutable。**

否则 `repeat-01` 和 `repeat-03` 根本不是同一次实验，分数变化分不清是 Agent 变了还是考卷变了。

每个 run 目录写入 `freeze.json`，记录：

```json
{
  "benchmark_version": "offeru-live-eval-v0",
  "frozen_at": "...",
  "git_commit": "...",
  "git_dirty": true,
  "component_hashes": { "cases": "...", "grader": "...", "runner": "...", "isolation": "..." },
  "seed_path": "djm.db",
  "seed_hash": "...",
  "runtime": "codebuddy",
  "runtime_version": "2.137.1",
  "model": "harness-provided",
  "mode": "real-user",
  "suite": "smoke",
  "repeat": 3,
  "case_count": 20
}
```

Run 结束时 runner 会**重新计算 hashes 并比对**：

- 一致 → 正常；
- 不一致 → `freeze.json` 与 `summary.md` 标记 `benchmark_mutated_during_run`，并打印警告
  **该 run 不可作为正式 baseline**。

`summary.md` 顶部会直接显示 benchmark 版本、commit、runtime 版本、frozen hashes 与是否被改动。

### 命名约定

当前是 **`offeru-live-eval-v0`**，还不是 Benchmark —— 理由是：Case 还可见、Grader 仍在演进、
只有 1 个真实可跑 Runtime、Case 数较少、seed 边界仍在调整。

等这些都稳定（Case 冻结 / Grader 冻结 / Reference solution / 3+ trials / 2+ runtime /
Regression 与 Capability 分开），才升级为 **`OfferU-EvolveBench v1`**。

---

## 安全边界（不可绕过）

1. 每个 case 单独克隆隔离库副本（SQLite online backup），**绝不碰真实库**。
2. 被测 Agent 只能调用 `Read / Grep / Bash`，且 Bash 仅允许 app.cli 的只读子命令。
3. 外部不可逆动作（提交申请、发信）**默认禁止**，任何测试只在 sandbox 内验证。
4. Provider 层失败（401 / 424 / 429 / timeout）单独归类 `BLOCKED`，不计入 Agent 能力。
5. 产物不写任何凭据。

---

## 相关文档

| 文档 | 内容 |
| --- | --- |
| [EVAL_ARCHITECTURE_AUDIT.md](./EVAL_ARCHITECTURE_AUDIT.md) | 架构审计：Agent 入口、Operation Registry、Career Truth、HITL、隔离 |
| [CASE_AUTHORING.md](./CASE_AUTHORING.md) | 如何新增一道 Case |
| [GRADING.md](./GRADING.md) | 判分维度、Hard Gate、Error Taxonomy |
| [FINDINGS.md](./FINDINGS.md) | 真实发现的 Bug 与归属 |
| [BASELINE.md](./BASELINE.md) | 基线结果（首次完整跑完后填写） |
| [RUNTIME_COMPARISON.md](./RUNTIME_COMPARISON.md) | 跨 Runtime 对比（至少两个 Runtime 后填写） |

参考实现仓库：<https://github.com/luyishui/OfferU>
（仅作范式参考；本仓库的被测对象、判分边界与 seed 策略与它不同，见审计文档第 7 节。）
