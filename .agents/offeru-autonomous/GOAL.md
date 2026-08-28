# OfferU Release Convergence & Real Capability Ecosystem

Updated: 2026-08-28

## Outcome

推进上一轮已验证的 Agent Runtime / Plugin / Automation 架构，从 fixture-backed proof 收敛到可长期使用的本地 Career OS：全局业务写入只有 Operation Registry 一条稳定路径，Agent Runtime 保持 provider-neutral，并通过可安装的真实 Capability Plugin 驱动岗位研究与后续求职闭环。

```text
OfferU UI
  -> Career Control Plane
  -> AgentRuntimeProvider
  -> Pi | Replay | Codex | DSH
  -> Capability Plugin
  -> Operation Registry
  -> Career Runtime
```

上一轮 Goal 已关闭。本轮初始 baseline 是 R1、R3–R6 fixture/replay 路径通过、R2 为 `PASS_SCOPED`；当前 route mutation 审计已收敛为 C1 `PASS_GLOBAL`。Codex live auth 和 DSH 独立 Provider 仍分别按外部/可选状态处理。

## Autonomous operating rule

持续执行 inspect → implement → targeted/full verify → browser verify → diagnose → fix → re-test，不在普通 Phase/Gate 或工程选择处停下来询问。用户已授权本 Goal 范围内的安全本地修改、测试、typecheck、build、localhost 服务和 Playwright 验收。

只有凭据、真实外部不可逆写入、破坏真实用户数据或无法规避的外部服务阻塞才记录 `BLOCKED_EXTERNAL`；即使阻塞，也先完成所有独立工作。

## Required slices

1. 将 Profile、Resume、Job、Application、Calendar、Interview、Automation、Browser/Agent/CLI/MCP 与 legacy REST 的正式 mutation 收敛到 `Operation Gateway → Operation Registry → Domain Service → DB`；纯 read 可以保留直读。
2. Main Agent UI 继续只消费 provider-neutral `AgentRunEvent`，Pi/Codex/Replay/DSH 只能通过 Adapter 接入。
3. 对齐 README、CONTEXT 和现有架构文档，不把未验收的 live Provider/插件能力写成已完成；本轮不新建 ADR。
4. 将 `Capability Plugin = Manifest + Skill + executable` 冻结为稳定的 OfferU 契约，完成 Agent-friendly CLI contract tests。
5. 实现第一个真实、合法公开数据源的 `job-search` capability（`jobs.search/jobs.get/jobs.snapshot`），不绕过验证码、Cloudflare、登录墙或平台反自动化。
6. Role Intelligence 只消费 capability 输出；dedupe、cohort、frequency、ranking、Delta、Evidence Gap 与 persistence 仍由 OfferU Runtime 确定性完成。
7. 以真实数据或诚实的 `INSUFFICIENT_SAMPLE` 验证 live G2B，不降低样本阈值；Codex auth 不得阻塞其它 Provider。
8. 推进 Job Saved 自动链、Application Progress、Memory Evolution、Targeted Interview 与浏览器 E2E，保持 Candidate → Verify → Commit 和 Fill ≠ Submit。

## Definition of Done

- C1 `PASS_GLOBAL`：本轮审计范围内没有已知正式业务 mutation 绕过 Operation Registry。
- C2 Main Agent provider-neutral；Replay/Pi 通过，Codex/DSH 为 PASS 或明确 `BLOCKED_EXTERNAL`。
- C3 真实 Plugin Contract：install/discover/invoke/uninstall、坏插件隔离和 CLI/Skill/Manifest schema 通过。
- C4/C5 `jobs.search` 能驱动真实 Role Intelligence；样本不足必须明确报告，不得伪成功。
- C6 Automation、Application Progress、Memory、Interview 和现有 UI 的可用纵向链无重复写入、无静默事实写入。
- C7 受影响后端测试、全量后端测试、前端 typecheck/build、相关 lint 和真实浏览器 E2E 均通过，或有证据标注为 pre-existing / external blocked。
- C8 不自动提交申请、不发送消息、不改凭据；无本 Goal 引入的已知回归。

代码存在、未执行的测试、失败请求的截图、LLM 声称成功或 fixture 冒充 live 数据均不满足完成。
