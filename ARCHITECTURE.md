# OfferU 架构边界

```text
TypeScript React UI / Client Interaction
              │ typed HTTP API
              ▼
Python FastAPI Career Runtime
  Profile · Job · Application · Artifact
  Event · Candidate · CareerTask
              │ Operation Registry
              ▼
External Agent Runtime
  Pi · Replay · Codex · DSH adapter

Tauri / Rust = desktop shell and process lifecycle only
```

## Truth flow

```text
Observe
  ↓
Event / Candidate
  ↓
Career Runtime understands state
  ↓
CareerTask plans work
  ↓
Operation executes or proposes
  ↓
verified state / artifact is committed
  ↓
Today and Pipeline project the same state
```

Agent 负责 reasoning、planning、tool selection 和研究编排；不能直接拥有职业事实。Operation Registry 负责 capability、权限、dry-run、确认和审计。Python Domain Runtime 是 Career Truth 的唯一来源。自然语言“我已更新”不是成功证明，只有成功提交的 Operation 才能改变正式状态。

## 领域对象

优先围绕 `Profile`、`Job`、`Application`、`Artifact`、`Event`、`Candidate`、`CareerTask` 表达需求。Today、Pipeline 和 Agent UI 是 projection 或执行界面，不复制同一业务状态。

## 自动化

```text
Event → Rule → CareerTask → Agent / deterministic runtime → Operation
```

低风险读取、研究、计算和候选生成可以自动执行；正式 Career Truth 变更仍经过事实门和用户确认；外部不可逆动作始终需要明确用户操作。

## Provider 与数据来源

Replay/Fixture 是显式的合成数据模式，必须在 UI 和产物中标记，不能冒充实时市场数据。Live Provider 失败时保留失败或 blocked 状态，允许用户改用 Fixture 验证本地产品链，但不能静默降级成成功。
