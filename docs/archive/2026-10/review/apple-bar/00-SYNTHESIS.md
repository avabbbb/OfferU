> 已归档（2026-10-21）：本文不再是当前权威，只用于考古。当前文档：09-quality-and-release.md（位于 docs/）。2026-09-19 对抗评审的历史证据，评分与缺陷只属于当时代码。

# OfferU × Apple-Bar 对抗评审汇总 — 2026-09-19

> 20 个并行评审 agent（4 联网调研 + 13 模块审查 + 3 跨切面拷打），19 份领域报告已落盘 `docs/review/apple-bar/`。
> 本文件是跨报告交叉验证后的统一结论与修复路线图。评测标尺：`apple-bar-rubric.md`（36 条可机械验证项，达标线 ≥0.85 且 A/C/D 类无 0 分）。

## 一、总体定性

**骨架是对的，细节是漏的，信任是断的。**

架构主轴（SQLite 单一事实源 + Operation Registry 收口副作用 + 外部 agent 仅作 reasoning engine + human-controlled）方向正确且在 local-first AI 赛道局部超前。但对照 Apple 上线水准，当前不是「打磨不足」，而是存在**多处「看似成功实则没生效」的产品诚信缺陷** —— 这类问题在 App Store 评审语义里比 crash 更严重：用户不知道它坏了。

综合 Apple-bar 评分约 **0.55–0.62**（达标线 0.85）。差距集中在三簇：

| 簇 | 占比 | 本质 |
|---|---|---|
| 假成功 / 静默降级 | ~30% | 后端 fallback 不透出、前端不查 res.ok、provider 双真相 |
| 键盘可达 / a11y / 设计系统 | ~25% | focus-visible 仅 4 处、双 :root 死 token、13 档 magic 字号 |
| Onboarding / 降级叙事 | ~20% | 0-provider 可走完引导、无全局手动模式状态条、卖点零 UI 命中 |

## 二、P0 —— 上线前必须修（产品诚信 / 安全）

| ID | 位置 | 问题 | 修法 |
|---|---|---|---|
| **P0-a** | `routes/optimize.py:489` `_llm_rewrite_sections` | LLM 改写失败 `return rows, False` 静默用原文；`fallback_to_simple_rewrite` 只进 `pipeline_result` dict，**无 SSE/前端字段透出**。用户拿到「成功」简历但零 JD 定制。同样模式在 `services/resume_optimize_support.py:546` | fallback 时在响应透出 `rewrite_degraded:true`+原因，前端提案卡显示「AI 改写未生效，已保留原文」横幅 |
| **P0-b** | `tests/` 7 文件（test_slice_01/test_job_ingest/test_career_memory/test_work_source_memory/test_resume_optimization/test_agent_control_plane/test_slice1_server） | 全局 `async_session`+`init_db()` 直写 `backend/djm.db`（118MB 真实库），0 清理、无 `OFFERU_DATA_DIR` 隔离 —— 每次跑测试永久污染用户数据 | 全部改走 `runtime_env_file`/隔离 data dir，或加 fixture 级 rollback |
| **P0-c** | `studio/page.tsx:167` iframe 无 `sandbox` + `routes/studio.py:68` 原样吐 LLM 生成 `html_content` | iframe 位于 8766 origin，框内 `<script>` 可同源调用全部未鉴权 API → JD prompt-injection → 写 `/api/config` 外泄链成立 | iframe 加 `sandbox="allow-same-origin"`（或不加 same-origin），preview 响应加 `Content-Security-Policy: script-src 'none'` |
| **P0-d** | `routes/agent.py:24` 内存 `_PROPOSALS` + `surface=web_agent_confirm` | web agent 通道绕过 OperationAuthorization/幂等/持久化，且 TOOL_REGISTRY 暴露全部 261 op（含 `reset_local_business_data`）；bridge 通道反而有 grant 白名单 —— **最弱通道权限最大** | web agent 提案也走持久化授权路径，或至少把危险 op 从 TOOL_REGISTRY 剔除 |

## 三、P1 —— 严重功能/体验缺陷（按主题归并，跨报告去重后）

### 主题 1：双真相 / 状态不自洽
- **provider 双真相**：`/api/agent/runtime` 报 pi `ready`，`/providers/health` 报 `unavailable`、`/connections` 报 `missing`。前端按前者放行后任务才失败（product-journey F-P1、agent-runtime）。
- **pipeline 双真相**：表格改 `apply_status` 只写 workspace 事件，看板 `current_stage` 只读 stage events —— README「progress is events」宣称被打破（frontend-pipeline F1）。
- **applications legacy 轨**：`create_legacy_application` 双写 `applications`+`application_records`，与 `application_attempts` 并存三轨（backend-data-layer DL-03）。

### 主题 2：前端假成功（写操作不查 res.ok）
- `hooks.ts` 4 处写操作不查 `res.ok`：`updateApplication:1531`、`generateCoverLetter:1541`、`reorderSections:1313`、`uploadResumePhoto/Logo:1323/1334` —— HTTP 失败被当成功（frontend-data-layer P1）。
- `interview/page.tsx:111-113` 面经提炼失败 `catch{}` 吞掉，模态关闭字段清空 —— 用户以为已收录但题库永远为空（silent-failures SF-1，唯一严格意义假成功）。

### 主题 3：错误归因 / 降级不可见
- `api.ts` `request()`/`readEventStream` 用 `redirect:'error'`；FastAPI `redirect_slashes` 默认开 + 尾斜杠混用 → 任一 307 被翻译成「无法连接本地后端」（frontend-data-layer P1）。
- `providers.tsx:89` 版本不匹配静默继续轮询 45s → 用户看到「无法连接」而非「请升级后端」（product-journey P1）。
- `_probe` 吞 `OSError/TimeoutError` 且无 `probe_error` 字段 —— CLI 挂掉与「未安装」不可区分（silent-failures SF-6，已核实 `coding_agent_runtime.py:462-463`）。

### 主题 4：Onboarding 断链
- wizard 第 0 步是 `isDisabled={!quizComplete}` 的 7 题性格测试才解锁（onboarding OB-01）。
- 卖点「无需 API key」全 UI grep 零命中，wizard 步骤卡还写「密钥接口地址接好」自相矛盾（onboarding OB-02）。
- checklist `agentConnected` 要求 `checked_at` 在 120s 内 → 永远 0/3 卡死（onboarding OB-03 + product-journey）。

### 主题 5：数据层硬伤
- `journal_mode=delete`、无 `busy_timeout` → 并发写直接 `database is locked`（backend-data-layer DL-02，实测 PRAGMA 证实）。
- `delete_jobs_batch` 对有 `application_attempt/interview/calendar_event` 等子表的岗位 100% `IntegrityError` —— 7 个 FK 缺 `ondelete`（DL-01）。
- 「清空回收站」对历史岗位必炸。

### 主题 6：授权/状态机漏洞
- 提案→confirm 路径把 secret 参数重放为字面量 `[redacted]`：`create_resume_share_record`/`access_resume_share_record` 会生成「密码=[redacted]」的假成功分享链接（ops-registry OPS-01）。
- `reject_agent_run` 不终态化 step，`confirm_operation_proposal` 不查 `run.status` → 已拒绝提案仍可确认执行（OPS-02）。

### 主题 7：状态泄漏 / 死链
- `jobs/[id]` 页切岗位时 10+ `useState` 不重置 → 旧岗位「材料候选·等待审核」闪现 + 跨岗位 proposal 绑定污染（frontend-today-jobs FJ-01/02/03，实测复现）。
- `useJobs` 丢弃 error → 后端 5xx 显示为「没有命中」假空态（FJ-10）。
- `emailApi.auth()` → `POST /api/email/auth` 是死链（后端只有 `GET /api/email/auth-url`），实测 404（backend-routes P1）。
- `resume/[id]` 「编辑」死胡同：job stage 离开 `resume_proposal_ready` 后 `get_resume_workspace` 抛错，已存在定制简历永远无法再打开（resume-interview RI-01）。

### 主题 8：扩展 save-job 断链
- `background.ts` 所有消息 handler `.then(sendResponse)` 无 `.catch` → storage 写失败时按钮永久卡死（EXT-01）。
- `collectViaPageAgent` 注入 `page-agent.js` 但该文件不在 `SYNC_TARGETS` 且根目录缺失 → 新采集链路 100% 静默回退（EXT-02）。
- `/api/feedback` 与 `/api/extension/version` 后端不存在 → 反馈写 `offlineFeedbackQueueV1` 但无 flush = 假成功（EXT-04）。

## 四、P2 —— 设计/工艺差距（对照 rubric）

- **设计系统双 :root**：`globals.css` 同文件两套 token 体系，第一套 46 变量全是死代码 + 111 个 `!important`（DS-01）。
- **a11y 焦点系统缺失**：focus-visible 全组件仅 4 处、8+ 处裸 `outline-none`、命令面板无 listbox 语义/无 focus trap、JobCard 用 span 模拟禁用按钮（DS-03/05/06/07）—— **rubric D 类全项亮红灯**。
- **字号失控**：13 档 magic number（9.5–22px，451 个 arbitrary value 分布 37 文件），无 `--text-*` token（DS-02）。
- **Letter 纸型死开关**：`resumeTemplate.css` 硬编码 210mm/297mm + `@page size:A4`，选 Letter 只改徽标不改预览/PDF（resume-interview RI-04）—— README 宣称的 A4/Letter 对 Letter 是假的。
- **SSE 六份手写解析互不兼容**：`batchOptimizeResume` 用 `'\n\n'`+split 且 `event:/data:` 带空格解析，无空格事件被静默丢弃（frontend-data-layer P2）。
- **AI 面试不可发现**：`/interview` 页 0 处链接到 `/interview/ai` 或 `/interview/pose`（live aria 验证，RI-02）。
- **CORS 端口不卡**：`_is_allowed_cors_origin` 只卡 host 不卡端口，localhost:3000/5140 实测通过 preflight 并泄漏进 CSP frame-ancestors（backend-routes P2）。

## 五、调研结论（4 份联网报告）

- **竞品格局**（competitor-landscape）：2026 已进入 agent 军备赛（Simplify/Jobright「your AI does the job hunt」），但用户抱怨高度一致 = 黑盒自动投递质量差 + AI 生成需重改 + 数据删不掉。**OfferU 的 evidence fact-gate + proposal diff + human-controlled 是赛道独一份差异化，但完全没当卖点传播**。落后项：onboarding 链长（竞品 <1min first value vs 我们 3-5 步）、job source 覆盖（竞品 8M+/40+ boards vs 我们纯手动 clip）、移动端、分发状态。
- **Apple-bar 标尺**（apple-bar-rubric）：36 条量化标准，给 OfferU 提供了可 grep 的硬阈值（>400ms 动画、linear timing、缺 prefers-reduced-motion、focus-visible、24px 目标）。
- **local-first 架构**（localfirst-ai-architecture）：方向正确但生态对齐层押错 —— 自建三条私有 stdio 协议 vs 默认关闭的 MCP sidecar；单一 `is_mutation` 比特无风险分级，落后 Claude Code 六档/Codex approval_policy 范式。
- **Onboarding 对标**（onboarding-connection-ux）：Connect→Auto→Ready 骨架正确且优于多数开发工具，但旗舰卖点「不需要 API key」在产品 UI 里零命中。

## 六、修复路线图（建议执行顺序）

**第 0 步 · 先修诚信（半天内可做完，全是透出字段+前端横幅）**
1. P0-a `_llm_rewrite_sections` 透出 `rewrite_degraded` + 前端横幅
2. P0-d web agent 提案走授权路径或剔除危险 op
3. P0-c iframe sandbox + preview CSP
4. 前端 4 处写操作补 `res.ok` 检查 + interview catch{} 补错误提示

**第 1 步 · 数据安全**
5. P0-b 测试隔离 `djm.db`（OFFERU_DATA_DIR fixture）
6. DL-02 WAL + busy_timeout；DL-01 补 FK ondelete 或 delete_jobs_batch 先清子表

**第 2 步 · 状态收敛**
7. provider 真相合并为单一状态源；前端「实时研究/AI 面试」提交前前置 gate
8. pipeline `apply_status` 与 stage events 统一写路径
9. jobs/[id] useState 按 jobId key 重置（或用 `key={jobId}` 整页 remount）

**第 3 步 · Onboarding + 降级叙事**
10. 全局「离线手动模式」状态条；wizard 每步 skip 记录 + 完成页交接
11. checklist 去掉 120s 窗口或显示「点击重新检查」；把「无需 API key」做成 UI 卖点

**第 4 步 · 设计系统收敛**
12. 合并双 :root、token 化字号/spacing/motion；全局 focus-visible + focus trap
13. Letter 纸型真实现；统一 SSE 解析为单一 helper

## 七、已达标的点（不该动的）
- Operation envelope 主链路无假成功；audit fail-closed；幂等 claim 真实。
- career_memory promote 唯一主路径（两阶段 applying + fact gate + 失效回滚）；vault 三入口全部 VaultUnavailableError fail-closed。
- BackendReadyGate 有慢提示/重试/startup_recovery 降级横幅。
- AddJobModal「本地准备（推荐，标记为本地）」诚实降级；fixture 结果有 amber 警告条。
- API 错误统一 `error_id` 可溯源；agentConnection 单写入者队列经得起对抗审查（AGENTS.md 双写问题已闭环）。

## 八、报告索引
全部领域报告：`docs/review/apple-bar/` 下 19 份。缺 `agent-runtime.md`（ReviewAgentRuntime 两次 wake 均死于上游 deadline，其核心 finding「`dsh-home` 断链」「`_probe` 无 probe_error」已由本人与 silent-failures SF-6 独立核实并入本汇总）。
