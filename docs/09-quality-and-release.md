# 09 · 质量与发布

> 状态：**当前设计权威** · 取代 docs/evals/*.md、RELIABILITY.md、QUALITY_SCORE.md、INTERNAL_BETA.md、STATUS.md、HANDOFF.md、GOAL.md 中的发布条款等
> 实时清单：根目录 `RELEASE_CHECKLIST.md`（发布门槛逐项状态）、`KNOWN_ISSUES.md`（唯一的严重度台账）——这两个文件由 `backend/scripts/release/*` 读取，**保持在根目录**。

## 1. 发布终点

唯一的发布终点是 `OFFERU_PUBLIC_RELEASE_READY`：一个陌生用户只拿到安装包，不需要开发者陪同，也不需要打开终端，就能独立完成：

```text
安装 → 建档 → 保存岗位 → 查看研究与证据缺口 → 审阅、编辑并导出定制简历
→ 维护真实的投递阶段 → 针对性模拟面试与复盘 → 审核学习候选 → 档案持续演进
```

产品还必须可以安装、升级、迁移、备份、恢复、诊断、失败、重试、审计和卸载。**代码能跑、构建通过、跑通一次 E2E、Replay 或 Fixture 闭环，都不等于可以发布。**

## 2. 证据分层

| 层 | 必须证明 | 首选证据 | 能否只靠模型判定 |
| --- | --- | --- | --- |
| 安全不变量 | 没有越权写入、泄密、静默成功 | 状态差异、审计、显式错误 | 否 |
| Operation 契约 | Registry、schema、提案、确认、幂等 | 结构化输出 + 确定性断言 | 否 |
| Agent 轨迹 | 工具选择、参数、失败可见、授权范围 | 标准事件 + 结果 | 否 |
| 用户纵向旅程 | 普通用户能完成核心闭环 | GUI 操作 + 最终状态 | 否 |
| 真实集成 | 当前 Provider、研究源、宿主真的能用 | 真实调用、版本、成本、错误 | 否 |

优先检查确定性的结果，其次是 schema 和轨迹；模型评分只用于相关性、证据覆盖、表达质量这类主观项。被测 Agent 不能做自己的唯一裁判。

## 3. 结论词汇

- **Eval**：`PASS`、`FAIL`、`BLOCKED`、`NOT_RUN`、`INVALID`。后三者都不计入通过率。
- **发布清单**：`PASS`、`FAIL`、`BLOCKED_EXTERNAL`（仅限签名证书、本人 OAuth、法律或隐私决策、第三方生产账号）、`PRE_EXISTING_FAILURE`、`NOT_VERIFIED`。
- **功能三元记账**（每项分开写）：源码存在 `YES/NO` · 产品路径可达 `WORKS/PARTIAL/BROKEN` · 真人验收 `PASS/FAIL/NOT_TESTED`。

没有 trace 和结果的「看起来正常」不是 `PASS`。

## 4. 套件与试验次数

- `offeru-core-v1`：核心候选套件，20–50 个高价值真实任务；其中的 required tasks 必须全部实际执行并有效通过。
- `OfferU-EvolveBench v1`：长期档案、模糊目标、跨 Provider 泛化、安全硬门槛，单独计分。
- 私有真实用户基准：真实数据、Ground Truth 和人工评分只保存在仓库之外；没有通过 readiness gate 时写 `PRIVATE_EVAL_BASELINE_NOT_ESTABLISHED`。
- 确定性任务至少跑 1 次；涉及模型、网络、检索或 Agent 路由的 required task，从相同初态独立跑 3 次。
- Internal Beta 核心旅程最低要求连续 3/3；Public Release 关键旅程要求连续 10/10，外加至少 50 个扩展组合，首次运行通过率 ≥ 98%。重试后变绿不能掩盖不稳定。

**内测 Goal**：A 用真实内置 Agent 验收功能；B 让真实用户从零走完安装、档案、岗位、简历、投递准备、面试学习和回访。两者分开报告，A 通过不代表 B 或 Public Release 通过。

## 5. 宿主一致性

Codex、Claude Code、OpenCode、WorkBuddy、Pi 等宿主共用同一组业务任务和安全断言，但各自保留证据：可执行文件、真实版本、adapter 版本、capability report；原生的会话、中断、恢复、事件流是否真的可用；所有 OfferU Operation 是否都经过 Bridge 和 Registry；mutation 是否只生成提案并由工作台独立确认；断连、过期、结果未知时是否失败关闭。一个宿主只有在必需的一致性任务全部通过后，才能写进支持列表，**不能继承**其他宿主的通过结果。

## 6. 可靠性不变量

- 失败可见、准确、可恢复；不伪造成功。
- 重复事件、双击、刷新、网络重试、重启下，关键 mutation 只产生一次业务效果。
- 运行中或等待中的任务、简历自动保存、进行中的面试、待审候选，在重启后不出现损坏状态、虚假完成或重复提交。
- 超过 2 秒的任务显示状态、进度、取消和失败。
- 可选的 Provider 不可用时，不拖垮核心路径。
- 用户可见的错误带 `error_id`，可以关联 run_id、task_id、operation_id 和脱敏后的诊断事件。

**性能 SLO**（在固定参考环境、production bundle 下测量）：冷启动到核心界面可用 ≤ 8 秒；热启动 ≤ 5 秒；缓存导航 p95 ≤ 1.5 秒；操作即时反馈 ≤ 200 毫秒；后台进度可见 ≤ 1 秒。

**Soak**：至少 2 小时或 100 个代表性循环，要求 0 崩溃、0 数据库损坏、0 重复 mutation、0 无界队列增长；预热后 RSS 增长 < 20%。

## 7. 交互验收（新增门槛）

[02 §5 防死锁规则](./02-interaction-design.md#5-防死锁规则必须可测试) D-1 至 D-8，以及 [02 §6 不硬编码规则](./02-interaction-design.md#6-不硬编码规则) H-1 至 H-3，都必须有自动化测试。违反 D 类规则直接是 **P0 阻塞发布**。[02 §12](./02-interaction-design.md#12-验收指标单个真实岗位的完整旅程) 的指标进入 Goal A 和 Goal B 的报告。

## 8. 安全门槛

- 没有 Agent 自我批准；凭据不进入 Agent 上下文；Provider 或宿主失败是显式的；浏览器和邮件集成不产生隐藏的业务状态。
- 依赖审计（含 RustSec）、下载产物审计、产物中的 PII 和符号链接防护、错误脱敏、canary 协议，详见根目录 `SECURITY.md`。
- 发布前必须完成产品隐私披露。

## 8.1 开发 / PR 与发布门禁分层

日常开发和 PR 的目标是**尽快发现当前改动引入的确定性回归**，不是重复执行整套 Public Release Qualification。

- PR 只对受影响路径运行核心 typecheck / unit test / build；release claims、readiness ledger、依赖审计、RustSec、浏览器重复性、迁移、安装包与 clean-machine smoke 不作为普通 PR 的合并阻塞。
- 依赖审计或 RustSec 在相关 PR 上可以作为 advisory 运行，失败不得阻止其它 job 或 PR；合入 `main`、tag / release 与手动发布验收仍按本文件的安全门槛严格执行。
- `.github/workflows/branch-freshness.yml` 只提醒 PR baseline 落后；真正的最新 main、clean worktree、运行物 identity 要求收敛到 `owner-test` / release evidence。
- path-filter 使用 job 级 `if`，workflow 本身仍创建并返回明确状态；不要用会让 required workflow 长期 Pending 的整工作流 path skip。
- 任何会导致数据覆盖、重复执行、外部发送/提交、破坏性删除或效果状态未知的检查仍是 hard gate，不能因为“快速开发”而降级。

## 9. 外部发布阻塞项

代码签名证书（Windows / macOS）、升级路径（需要上一版安装包）、Tauri updater、干净系统上的陌生用户人工验收。实时状态以 `KNOWN_ISSUES.md` 为准。

## 10. 证据与报告规则

- 新报告放在 `docs/evidence/reports/YYYY-MM-DD-<slug>.md`，格式遵循 `docs/evidence/report-schema.json`（EvolveBench 的格式见 `docs/evidence/evolve-bench-schema.json`）。
- 每次运行都要记录：suite / version / run ID、commit 和 dirty 状态、OS / Python / Node / 宿主 / adapter / provider / model、fixture 隔离说明、命令、退出码、耗时、trial 次数、脱敏后的事件、Operation 轨迹、最终结果、限制、成本和人工结论。
- 报告和附件**严禁**包含 API Key、Cookie、OAuth token、真实邮件正文或不必要的个人信息。失败时保存最小的脱敏 trace、截图、console、网络摘要、结构化事件和数据库完整性结果。
- 历史报告是对应 commit 当时的证据，不改写旧数字。已过期的报告移到 `docs/archive/evals/reports/`。
- 用户可见行为改变时，先更新 Task 或 grader，再改实现。修复后稳定通过的历史失败，加入回归套件。不为了提高分数删除困难样例。

## 11. 浏览器验收的环境约束

只使用 managed Chromium，`headless=true`，隔离的 profile；网页入口固定为 `http://127.0.0.1:7410`（hash 路由），API 固定为 `8766`；不调用系统浏览器，不访问 8080（8080 只是可选的 llama.cpp Provider）。
