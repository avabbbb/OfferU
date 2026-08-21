# OfferU Agent Bridge 协议

> 状态：v1 target contract；尚未实现  
> 传输：CLI stdio + JSONL  
> 决策：[ADR-0051](../adr/README.md#adr-0051)、[ADR-0053](../adr/README.md#adr-0053)

## 目的

Agent Bridge 让任意受支持 Harness 以同一方式附着 OfferU Agent Run、取得最小上下文、调用 Operations、等待 OfferU 人类界面决定并写入标准事件。协议不承载模型推理，也不包含宿主专属 argv。

v1 明确不是 MCP、ACP 或通用 HTTP API。它是由本机 `offeru` 可执行程序启动的私有 stdio 协议。

## DSH rc8 双面拓扑

DSH `dsh-v0.1.0-rc.8` 的接入包同时包含 host 与 browser client 两面，但 Bridge 仍只有一个调用者：

```text
DSH browser client
  OfferU launcher / task view / overlay
             │ DSH 内部类型化 host/client 通道
             ▼
DSH host plugin
             │ child process stdio JSONL
             ▼
offeru bridge --stdio
             ▼
OfferU control plane
```

client half 不建立第二条 Bridge 连接，不直接调用 FastAPI、SQLite 或 CLI，也不持有 bootstrap token。host plugin 追随 `event.follow` 后，只向 client 投影最小 UI 状态和脱敏提案；用户手势经 host half 回到控制面。具体 rc8 host/client remote seam 必须由 adapter tracer 证明，不能在协议里臆造为长期稳定 DSH API。

## CLI 表面

目标命令：

```text
offeru bridge --stdio
offeru bridge probe --json
offeru bridge schema --json
```

- `--stdio`：持久双向 JSONL，供 DSH plugin、Codex adapter 等原生接入包使用；
- `probe`：只读检查协议版本、后端/数据库可达性和运行约束；
- `schema`：输出当前二进制对应的完整 JSON Schema bundle，供 conformance test 使用。

业务调用只能在 `--stdio` 会话内发生。v1 不继续扩展现有 `offeru run/confirm` 作为主控协议；迁移完成后，模型可调用 CLI 中必须移除 `confirm`。

## 线路规则

- stdin 与 stdout 均为 UTF-8，每行恰好一个 JSON object；
- stdout 不得输出 banner、日志、进度条或 ANSI；
- stderr 只写运行诊断，且不得包含参数原文、职业事实或凭据；
- 每个请求都有 `id`，响应复用该 `id`；异步事件没有请求 `id`，但有 Run 内 `seq`；
- 未完成 `hello` 前的其他请求一律拒绝；
- 未绑定 Run 前只能调用 probe、pairing 和 attach 相关消息；
- 协议解析失败不猜测、不降级到普通文本。

## 通用 envelope

请求：

```json
{
  "v": 1,
  "id": "req_01J...",
  "type": "operation.invoke",
  "runId": "run_01J...",
  "payload": {}
}
```

成功响应：

```json
{
  "v": 1,
  "id": "req_01J...",
  "ok": true,
  "result": {}
}
```

失败响应：

```json
{
  "v": 1,
  "id": "req_01J...",
  "ok": false,
  "error": {
    "code": "grant_denied",
    "message": "Operation is not granted for this Run",
    "retryable": false,
    "details": {"operation": "update_application_status"}
  }
}
```

服务端事件：

```json
{
  "v": 1,
  "type": "approval.decided",
  "runId": "run_01J...",
  "seq": 42,
  "payload": {"proposalId": "prop_01J...", "decision": "approved"}
}
```

未知字段按 schema 策略处理：顶层允许后续兼容性 metadata；每种 `payload` 默认拒绝未知业务字段。破坏性变化升级 `v`。

## 握手与配对

### `hello`

Harness 接入包必须首先声明真实能力，不允许写死“全部支持”：

```json
{
  "v": 1,
  "id": "req_hello",
  "type": "hello",
  "payload": {
    "adapter": {"name": "@offeru/dsh-plugin", "version": "0.1.0"},
    "harness": {
      "name": "deepseek-harness",
      "version": "0.1.0-rc.8",
      "profile": "offeru",
      "preset": "offeru-readonly",
      "compositionHash": "sha256:..."
    },
    "protocols": [1],
    "capabilities": {
      "sessionResume": true,
      "steer": false,
      "interrupt": true,
      "toolSuspendResume": true,
      "eventStream": true,
      "workspaceIsolation": "native_tools_disabled",
      "nativeClient": true
    }
  }
}
```

Bridge 返回选定版本、服务版本、配对状态和约束。版本或必需能力不符时以 `capability_mismatch` 结束，不静默切换宿主。

### 两种启动方式

**OfferU 专注窗口启动**：OfferU 先创建 Run 和短期 bootstrap token，再以环境变量注入接入包。token 不进入 argv、日志、browser client 或模型上下文，只能绑定一个 Run，用后即失效。

**Harness 原生界面启动**：例如精确版本的 `dsh --profile offeru` 打开 DSH Web。host plugin 必须先用 `dsh --version` 和 composed profile 证明是目标 rc8 配置，再发起 `pairing.request`；Bridge 通过 host/client 投影在 OfferU 全局浮层显示宿主、adapter、版本、profile/preset、composition hash 和 cwd 指纹。使用者选择 Task/Skill 并批准附着后，Bridge 创建 Run。配对完成前没有业务 grant。

本地同一 OS 用户不是自动业务授权；配对只证明“这个进程可以附着这个 Run”，不批准任何副作用 Operation。

## v1 请求

| Type | 作用 | 是否要求 Run |
| --- | --- | --- |
| `hello` | 协商版本与能力 | 否 |
| `pairing.request` | 请求工作台配对 | 否 |
| `pairing.status` | 查询配对结果 | 否 |
| `run.attach` | 绑定已创建 Run 和原生 session | 是 |
| `run.lease.renew` | 续期单写入租约 | 是 |
| `context.snapshot` | 读取版本化最小上下文 | 是 |
| `skill.snapshot` | 读取当前 Skill 和 grant | 是 |
| `operation.list` | 列出当前 Run 获准 Operations | 是 |
| `operation.schema` | 读取一个 Operation schema | 是 |
| `operation.invoke` | 执行读取或创建副作用提案 | 是 |
| `proposal.get` | 查询提案和决定状态 | 是 |
| `event.append` | 上报标准化进度/消息/工件 | 是 |
| `event.follow` | 从游标追随控制面事件 | 是 |
| `run.finish` | 报告 completed/failed/cancelled | 是 |

`run.create` 不向模型工具公开。它只能由工作台或配对流程创建，防止模型批量制造 Run 和 grant。

## Operation 调用

```json
{
  "v": 1,
  "id": "req_op_7",
  "type": "operation.invoke",
  "runId": "run_01J...",
  "payload": {
    "operation": "get_pre_application_state",
    "arguments": {"job_id": 42},
    "idempotencyKey": "run_01J.../call/7",
    "contextVersion": 12
  }
}
```

Bridge 必须同时校验实时 schema、Skill grant、数据范围和 `contextVersion`。过期上下文可能安全重读时返回 `context_stale`；不得在未知状态下继续写入。

读取响应包含 `completed` 和类型化值。副作用响应只包含：

```json
{
  "status": "proposal_pending",
  "proposalId": "prop_01J...",
  "impactSummary": "...",
  "expiresAt": "..."
}
```

Harness 不会收到确认 token，也不能通过另一个 CLI 命令批准。它可保持工具调用暂停，或返回 pending 后通过 `proposal.get`/`event.follow` 恢复。DSH client half 看到的 pending/decided 状态来自 host plugin 的最小投影，不是 client 自己订阅 Bridge。重复 `operation.invoke` 使用相同幂等键必须得到同一提案或同一结果。

## 标准事件

v1 标准事件至少包含：

- `run.attached`、`run.resumed`、`run.interrupt_requested`、`run.finished`；
- `agent.message.delta`、`agent.message.completed`；
- `operation.started`、`operation.proposed`、`operation.completed`、`operation.failed`；
- `approval.requested`、`approval.decided`；
- `artifact.declared`、`artifact.accepted`、`artifact.rejected`；
- `executor.started`、`executor.progress`、`executor.finished`；
- `control.followup`（预留，首个 tracer 不启用）。

Bridge 为持久化事件分配 `seq`；接入包提供的宿主 event ID 只作为去重 metadata。UI 不消费 provider 原始事件名。

## 中断、重连与背压

- OfferU 嵌入工作区或专注窗口发送 `run.interrupt_requested` 后，adapter 必须调用宿主原生 interrupt，并在限时内上报终态或 `interrupt_failed`；
- Bridge 断开不会自动重放正在执行的副作用；恢复先读取提案/审计状态并对账；
- adapter 重连必须携带同一 Harness session ID、上次 event cursor 和租约；租约过期后只能请求恢复，不能继续写事件或调用 Operation；
- 读取调用可有限并发，副作用提案与 Run 终态串行提交；
- 服务端输出队列满时返回 `backpressure`，adapter 退避并从游标续读，不丢弃终态和确认事件。

## 错误码

| Code | Retry | 含义 |
| --- | --- | --- |
| `protocol_mismatch` | 否 | 无共同协议版本 |
| `capability_mismatch` | 否 | Harness 缺少必需能力 |
| `pairing_required` | 是 | 尚未由工作台附着 |
| `run_not_found` | 否 | Run 不存在或不属于当前配对 |
| `lease_lost` | 条件 | 已失去单写入租约 |
| `grant_denied` | 否 | Operation/数据不在授权内 |
| `schema_invalid` | 否 | 参数不符合实时 schema |
| `context_stale` | 是 | 使用了过期上下文版本 |
| `proposal_pending` | 是 | 等待工作台决定，不是失败 |
| `proposal_rejected` | 否 | 使用者拒绝或提案过期 |
| `reconciliation_required` | 条件 | 副作用结果未知，必须对账 |
| `backpressure` | 是 | 队列已满，按建议退避 |
| `internal_error` | 条件 | 已记录 trace 的控制面错误 |

`message` 面向人类，模型逻辑只能依赖 `code`、`retryable` 和结构化 details。

## 首个 tracer 的裁剪

DeepSeek Harness 首个纵向切片只实现：精确 rc8 probe、host/client plugin 启动、三个可加式 UI 表面、`hello`、原生浮层配对、`run.attach`、只读 `context.snapshot`、一个真实只读 Operation、事件镜像、`run.finish`。第二个切片再加入副作用提案和 OfferU 全局确认浮层。

OfferU 任务视图向运行中 Harness 发送自由文本 follow-up 属于后续控制权设计。首个 tracer 中，DSH Chat 是唯一提示输入端，OfferU UI 只观察、配对和中断，避免在协议未验证前引入双写输入。

## 验收

- stdout 每行均通过 schema，任意诊断只出现在 stderr；
- 未握手、未配对、失租约和越权请求均失败关闭；
- 同一幂等键重放不产生第二提案或第二副作用；
- OfferU 人类界面离线、拒绝、超时和迟到批准都不能执行；
- Bridge 进程崩溃后可从事件游标恢复，未知副作用进入对账；
- DSH browser client 不能直接建立 Bridge/HTTP/CLI 业务连接，host/client 断开时配对和确认失败关闭；
- 协议中不存在 `confirm`、raw SQL、raw HTTP、MCP 或 shell 字符串执行消息。
