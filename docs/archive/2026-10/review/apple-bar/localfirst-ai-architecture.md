> 已归档（2026-10-21）：本文不再是当前权威，只用于考古。当前文档：09-quality-and-release.md（位于 docs/）。2026-09-19 对抗评审的历史证据，评分与缺陷只属于当时代码。

# Local-First AI / BYOK 架构 对抗评审 — 2026-09-19

## 结论（对照 Apple 上线水准一句话定性）

OfferU 的「本地 SQLite 唯一事实源 + Operation Registry 收口所有副作用 + 外部 agent 只是 reasoning engine」这条主轴，**恰好踩在 2026 年 local-first 与 host-exposes-operations-to-agent 两个趋势的正确交叉点上**——在「方向」维度是超前而非落后；真正的落差在**生态对齐层**：自建 stdio bridge / 私有 worker 协议替代了已在 2026 标准化的 MCP 传输与 Tasks/Elicitation 原语，而 approval UX 仍是「提案-确认」的二元模型，没有跟上 Codex/Claude Code 已确立的「分级权限模式 + 就地 diff review + 可降级自动审批」三连范式。

---

## 调研基线（带来源）

### A. Local-first 2025–2026 现状

- Ink & Switch 2019 论文的种子已长成完整生态：Automerge 3.0（2025 末，列式存储 + 亚毫秒 merge）、Yjs（Notion/Tiptap 在生产）、cr-sqlite、PowerSync、ElectricSQL v0.9（shape-based 部分复制）、Rocicorp **Zero**（replicate *query results* 而非表，服务端做权限判定）。来源： https://verity.salient.community/research/local-first-software-in-2026.html
- 社区共识（LoFi 社区 / Local-First Conf 2026 Berlin / lofi.so 目录）：**「本地 SQLite 当应用数据库、UI 读本地、写本地、同步引擎异步上行」已成为标准骨架**；最难的不是 sync 而是 authorization——Zero 的答案是「写操作客户端乐观执行、服务端做权威裁决」。来源： https://lofi.so/ , https://stepto.net/blog/local-first-sync-engine-architecture-decision-2026
- 2026 关键判词：「同步引擎已 stable；真正区分架构的是权限与事实源归属。」来源： https://trybuildpilot.com/648-electric-sql-vs-powersync-vs-zero-2026

### B. 外部 agent 作为 reasoning engine（BYOK / 自带 agent）

- 2026 已固化为三种宿主形态：①内嵌 SDK/子进程（Claude Agent SDK、pi-coding-agent、OpenCode 可嵌）；②stdio JSONL worker 协议（Codex app-server / DSH 适配器同型）；③MCP server 反向暴露 operations 给任意外部 agent。OfferU **三种全做了**：`agent-runtime/` 嵌 `@earendil-works/pi-coding-agent` + `@anthropic-ai/claude-agent-sdk`（agent-runtime/README.md:3），`agent_bridge/server.py` 是私有 stdio JSONL 协议，`mcp_server.py` 用 FastMCP 暴露同一 Registry。
- 行业一致做法（Claude Code/OpenCode 一致）：宿主禁用 agent 的文件系统/shell 等原生工具，只给宿主授权的工具面——OfferU 完全一致（Pi worker `active_tools != {"offeru_operation"}` 即 dispose，pi_agent_worker.py:112-113；Claude worker 仅放行 granted public-web tools，agent-runtime/README.md:13）。**这是架构上最正确的一笔。**
- BYOK 主流形态是「用户自带 provider key，宿主注入内存凭据仓库、不落盘」——OfferU 一致（agent-runtime/README.md:11，credentials 注入 in-memory Pi credential store，不写 Pi 全局 auth 目录）。

### C. MCP 2026 现状（`2026-07-28` RC，2026-07-28 定稿）

来源： https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/ , https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture

- **协议层无状态化**：`initialize` 握手、`Mcp-Session-Id` 全删；每请求自带 `_meta` 里的 protocolVersion/clientInfo/capabilities；新增 `server/discover`。
- **服务端 → 客户端中途请求**走 Multi Round-Trip Request：`tools/call` 返回 `InputRequiredResult`（含 `requestState` opaque handle），客户端收齐输入后带原 `requestState` 重发——这正是「服务端向 agent 中途要确认/输入」的标准形状。
- **Tasks extension**（长任务）：`tools/call` 返回 task handle，客户端 `tasks/get`/`update`/`cancel` 驱动。
- **Elicitation**：server 可 `elicitation/create` 向用户要确认/补充信息——即 MCP 原生的 approval 通道。
- **MCP Apps**：server 可附带 sandboxed iframe 渲染的 UI，把 approval 表单也标准化了。
- **Tools 升到完整 JSON Schema 2020-12**（oneOf/$ref 可用）；`Roots`/`Sampling`/`Logging` 正式 deprecated。

### D. HITL approval UX 业界范式（2025–2026）

来源： https://code.claude.com/docs/en/permission-modes , https://opencode.ai/docs/

- **Claude Code 权限模式六档**：`default`（每步问）/ `acceptEdits`（文件编辑自动放）/ `plan`（只读探索 + 出计划，批准后才动手）/ `auto`（分类器模型代审，只拦越权）/ `dontAsk`（白名单外全拒）/ `bypassPermissions`（全放，仅容器）。**Plan mode 是 2026 最重要的交互范式**：先只读勘察、产出 plan、用户批注/编辑（Ctrl+G 在编辑器里改）、批准才执行——`plan` 与 OfferU 的「CareerTask 先 plan、Operation 后 execute」结构同构。
- **OpenCode**：`Tab` 在 Build/Plan 两档间切，概念同 Claude Code，但只两档——证明「分级权限」已被简化成用户能记住的一档切换。
- **关键 UX 迁移**：从「每个 action 一次 yes/no」→「先定模式（我亲自看 / 看计划 / 你自动干但别越界），模式内该问的才问」。**逐条 accept/reject 已下沉到 diff 级**（代码 diff 逐行接受），而不是操作级。
- Codex（OpenAI）的等价物是 `approval_policy`（untrusted/on-failure/on-request/never）+ sandbox 分级（read-only / workspace-write / danger-full-access）——同样是「策略 + 沙箱」而非「逐条确认」。

---

## Findings

| ID | Sev | Type | 位置 | 证据 | 问题 | 建议修法 |
|----|-----|------|------|------|------|---------|
| LFA-01 | P1 | design/arch | `agent-runtime/README.md:3`、`backend/app/services/agent_bridge/server.py:1-14` | OfferU 同时维护：私有 stdio Bridge 协议（`offeru.pi-worker.v1`、hosted-executor 另一套、bridge 第三套）+ 一个 FastMCP server。三套私有协议 + 一套 MCP，MCP 反而是「可选/默认关」（`config.py:54 offeru_enable_mcp=False`）。 | 2026 年宿主↔agent 的标准传输是 MCP stdio/Streamable-HTTP + Tasks/Elicitation。OfferU 把大部分精力投在三条私有线上，而把已成为生态标准的 MCP 当 optional sidecar——**方向上对了（都把 Registry 当唯一事实源），但把宝押在了私有协议而非标准协议上**。外部 agent（用户自己的 Claude Code/Codex/Cursor）要操作 OfferU，得先学私有 bridge 协议而不是插上 MCP 就完事。 | 收敛为「MCP 为唯一对外协议」：把 bridge 的 run.attach/lease/proposal/confirm 语义映射成 MCP Tasks + Elicitation + 自定义 tool 三件套；私有 stdio worker 只保留进程内 hot-path（Pi session 管理），不再承担跨 agent 协议职责。`offeru_enable_mcp` 默认翻成 true。 |
| LFA-02 | P1 | ux/design | `ops.py:1559-1560`、`operation_projection.py:13-84` | `is_mutation` 单比特 → 任何 write/llm/external 副作用都走同一条「创建 Agent Run 提案 → confirm_operation_proposal」路径；没有分级。 | 业界已迁移到**权限模式**（Claude 六档 / Codex approval_policy 四档 / OpenCode 两档）：低风险写（如改本地草稿）在「acceptEdits/auto」档自动放行，只有外部不可逆动作才必问。OfferU 把「更新一条本地投递备注」和「发一封外联邮件」放在同一个「要提案」的桶里——approval fatigue 风险高，与 `ARCHITECTURE.md:66`「低风险读取/研究/候选生成可自动」原则部分相悖（写操作没有低风险档）。 | 引入 `risk_tier ∈ {read, draft_local, commit_truth, external_irreversible}`：① `draft_local`（改本地简历草稿/笔记）在用户设定的「accept local edits」模式下自动执行、事后 audit；② `commit_truth`（写 Career Truth）维持提案-确认；③ `external_irreversible`（发邮件、提交表单）永远必问 + 显示 diff/payload。映射到 MCP 时用 `elicitation/create` 承载后两档。 |
| LFA-03 | P2 | arch | `ops.py` 全文 5346 行、260 个 Operation、`agent_operations.py` 等 N 个 `*_operations.py` | `OPERATIONS` 单字典注册 260 个操作，`group` 字段是开放字符串（"core"/"governance"/"profile"/"memory"/"jobs"/"applications"/"resume"/"interview"/"email"/"research"/"agent_runtime"/"plugins"/"automation"/"pre_application"/"calendar"/"context"/"artifacts"…） | 对照 MCP `tools/list` + namespacing 惯例（`server/tool` 两层），260 个扁平 name 的目录已超出 agent 可合理检索的规模；`operation_catalog(group=...)` 的 group 过滤是弱类型字符串，agent 只能靠 prompt 记忆 group 名。这是「在一个文件里塞下整个领域」的可维护性警讯。 | ① 把 `group` 提为 `Enum`，并加二级 `namespace`（`applications.progress.review` 式 dotted name）便于 agent 检索与分页；② 按 group 拆 `ops_*.py` 模块，`ops.py` 只留 Registry/授权/审计骨架；③ 给 `operation_catalog` 加 `prefix=` 过滤与 `ttlMs`（对齐 MCP 2026 cacheable discovery）。 |
| LFA-04 | P2 | design | `ops.py:1550` `side_effects: tuple[str,...]`，值域 `{"read","write","llm","external","external_read"}` | 用 side-effect 集合推断 `is_mutation`（line 1560），但没有区分「可逆写」与「不可逆外部写」；`external` 一个标签同时覆盖「抓取公开网页」与「发 Gmail」。 | 对照 Codex sandbox 分级（read-only / workspace-write / danger-full-access）与 Zero「服务端权威裁决」理念，`external` 内部应再分「external_read（出网读，幂等）」vs「external_write（出网写/发信，不可幂等）」。现在两类混在一桶，导致权限策略只能一刀切。 | 拆 `external` → `external_read` / `external_write` / `external_irreversible`；`is_mutation` 与授权分级直接读这个新轴，与 LFA-02 的 risk_tier 合并实现。 |
| LFA-05 | P2 | arch/design | `mcp_server.py:98-125` `offeru_operation` + `confirm_operation` | MCP 面上把「读操作」与「副作用提案」都塞在单一 `offeru_operation(operation, args, dry_run)` 工具里，外加 `confirm_operation(run_id, action_id)`。 | 对照 MCP 2026 惯例：每个 capability 应该是一个命名 tool（`tools/list` 可发现、可独立 schema、可挂 MCP Apps UI）。OfferU 的「一个万能 tool + 字符串 operation 名」等价于把 Registry 又包了一层 RPC-in-RPC——外部 agent 的 `tools/list` 看不到「有哪些能力」，只看到「有一个万能入口」，丧失了 MCP 的可发现性意义，也让权限审批粒度退回到 tool 级而非 operation 级。 | 用 FastMCP 的动态 tool 注册：启动时按 `OPERATIONS` 把**每个 operation 暴露成一个命名 tool**（`offeru__review_resume_proposal`），mutation 类 tool 自动注入 `dry_run`/`_meta.confirmation` 语义；`confirm_operation` 保留为独立 tool 或用 MCP Tasks 的 `tasks/update` 承载。`operation_catalog`/`operation_schema` 退化为调试辅助。 |
| LFA-06 | P2 | ux | `ops.py:4831-4836`、`operation_projection.py` 返回结构 | 副作用提案返回 `{"executed": False, "requires_confirmation": True, ...}` + `run_id`/`action_id`；确认走 `confirm_operation(run_id)`。无内嵌 diff/预览 payload。 | 对照 Claude Code 的 edit approval（就地 diff、逐行 accept/reject）和 MCP `elicitation/create`（服务端把确认表单 schema 一起发下来），OfferU 的提案没有**带 preview 的确认载体**——UI 只能渲染「要不要执行 X」，看不到「X 会改成什么样」。Resume workspace 有 `workspace_snapshot_hash` 乐观锁（ARCHITECTURE.md:56）是好事，但 hash 不是用户能 review 的 diff。 | 提案 payload 增加 `preview`（结构化 diff/before-after/proposed_patch）+ `expires_at`；UI 渲染就地 diff；MCP 面用 `elicitation/create` 的 schema 把 preview+confirm 一次发给宿主。 |
| LFA-07 | P3 | arch | `agent_bridge/server.py:59-`、`coding_agent_runtime.py` | bridge/coding-agent/hosted-executor 三套会话各自实现 lease/attach/run.finish；`LeaseLostError`/`RunCoordinator` 在 bridge 内又造一份。 | 对照 MCP Tasks extension 与「一个 Run 一条 lease」的普遍做法，三套自研并发原语重复造轮子，且语义略异（bridge 是 single-writer lease；hosted Claude 是 task-scoped grant；Pi worker 是 in-memory session 绑定）。 | 抽出统一的 `RunLease`/`SessionGrant` 领域对象，三套 worker 共享；长期可把 lease 语义换成 MCP Tasks handle。 |
| LFA-08 | P3 | doc/design | `ARCHITECTURE.md:60-66`、`ops.py:1210-1216` | 自动化规则写「低风险读取、研究、计算和候选生成可以自动执行；正式 Career Truth 变更仍经过事实门和用户确认」；代码里有 `preference_confirmation`（ADR-0048 偏好门）。 | 文档把「自动 vs 确认」二分，但代码已出现第三种「preference/自我声明需直接确认」的亚类——文档与实现有轻微 drift；对照业界，缺「用户在什么模式下信任什么」的显式 permission-mode 设定。 | 文档与实现同步：把 ADR-0048 preference gate、LFA-02 的 risk_tier、用户可切换的 permission mode 画进同一张「Trust Model」图，进 ARCHITECTURE.md。 |
| LFA-09 | P3 | perf/design | `ops.py` 单文件 5346 行、`from app.services.agent_operations import …` 200+ 个符号 | 文件头 300 行全是 `from … import (…)`；`OPERATIONS` 字典横跨 1700-3900 行。 | 对照「深模块、浅接口」：单文件已远超人/agent 一次能读的范围，且 import 表与实际 Operation 注册解耦（要改两处）。 | 同 LFA-03 拆分；import 改为注册装饰器 `@operation(name=…)` 让 handler 与注册同址。 |
| LFA-10 | P3 | security/design | `mcp_server.py:99` `offeru_operation`、`ops.py:1509-1517` `_PROTECTED_AGENT_SURFACES` | `surface` 字段是自由字符串，保护名单硬编码 `{"agent","bridge","cli","mcp","pi","web_agent","optimize_agent"}`。新增 surface 若忘加进集合，副作用将**绕过**提案-确认。 | 白名单-漏配即失守的设计；对照 Claude Code `deny rules block in every mode` 的 fail-closed 取向，这里应默认 fail-closed：surface 必须在注册表显式声明「是 agent 面」否则拒绝 mutation。 | 把 `surface` 提为枚举/注册表项，默认 `protected=True`，显式声明 `protected=False` 才跳过授权；新增表面不改授权表也安全。 |

---

## Top-5 修复优先级

1. **LFA-02 分级风险轴**：引入 `risk_tier`（read / draft_local / commit_truth / external_irreversible），把「改本地草稿」从「提案-确认」里解放出来，只在 commit_truth 与 external_irreversible 两档强制确认 —— 这是把 approval UX 拉到 2026 范式、同时不松安全的最关键一步。
2. **LFA-05 + LFA-01 合并**：把 MCP server 从「一个万能 `offeru_operation` tool」改成「Registry 逐 operation 动态注册命名 tool + `elicitation`/`Tasks` 承载确认与长任务」，并默认 `offeru_enable_mcp=True`——让任意外部 agent（Claude Code/Codex/Cursor）插 MCP 即得全能力面与可发现 schema。
3. **LFA-04 拆 `external`**：`external_read`（出网拉数据，可幂等重试）与 `external_write`/`external_irreversible`（发信、提交、不可逆）分轴，驱动 LFA-02 分级与审计差异化。
4. **LFA-06 提案带 preview**：`requires_confirmation` 返回必须含结构化 `preview`（diff/before-after）+ `expires_at`，UI 渲染就地 diff——对齐 Claude Code 的就地 review 交互。
5. **LFA-10 fail-closed surface**：`surface` 注册表化、默认 protected，新增 surface 不忘加白名单也不破安全 —— 一行防御性重构，消除一整类「漏配即失守」。

---

## 已达标的点（简短）

- **事实源单一**：Python Domain Runtime 是唯一 Career Truth，agent 只是 reasoning engine —— 完全符合 2026「本地数据库为事实源、agent 只是工具调用者」范式（`ARCHITECTURE.md:36`）。
- **最小工具面**：Pi worker 只暴露 `offeru_operation`，Claude worker 按 grant 放行 —— 与 Claude Code「deny-by-default + allowlist」同型（`pi_agent_worker.py:112`、`agent-runtime/README.md:9-13`）。
- **凭据不落盘**：provider key 注入 in-memory credential store —— 符合 BYOK 安全基线（`agent-runtime/README.md:11`）。
- **提案-确认 + 幂等 + 审计**：`OperationAuthorization` + `_claim_authorized_execution` + `OperationAuditLog` 已是教科书级的 confirmed-execution 实现（`ops.py:1493-1540, 5010-5107`）。
- **乐观锁**：`workspace_snapshot_hash` 阻止过期提案覆盖用户新编辑（`ARCHITECTURE.md:56`）。
- **MCP 已存在**且被架构测试约束为「薄投影、无 DB/业务依赖」（`test_agent_control_plane.py:49-53`）——基础扎实，差的只是默认开启 + 工具粒度。
