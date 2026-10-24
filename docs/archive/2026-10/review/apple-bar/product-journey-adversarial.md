> 已归档（2026-10-21）：本文不再是当前权威，只用于考古。当前文档：09-quality-and-release.md（位于 docs/）。2026-09-19 对抗评审的历史证据，评分与缺陷只属于当时代码。

# 端到端产品旅程对抗评审 — 2026-09-19

## 结论（对照 Apple 上线水准一句话定性）

骨架是对的（BackendReadyGate、OnboardingChecklist、空状态引导、本地 Replay 降级都在），但**核心智能链路在真实环境里是断的**：本机当前配置下 LLM key 失效（test-llm 实返 `401 Invalid API key`）、7 个 Agent Provider 无一 verified、Role Intelligence 上游模型 `model unavailable`——新用户走完引导后撞上的第一个「智能」功能就会失败，而 silent-fallback 设计（LLM 改写失败静默用原文）会让用户拿到一份**看似成功实则没有定制化的简历**，这比报错更伤产品。

## 实测环境快照（2026-09-19，本机 live）

- Backend `http://127.0.0.1:8766` UP（`/api/health` 200，version 0.4.0）；Frontend `http://127.0.0.1:7410` UP（200）。
- `POST /api/config/test-llm` → `{"success":false,"message":"API 返回错误 (401): Invalid API key"}`（active config `deepseek / nemotron-3.5-lightning-free`，key=`env:OFFERU_LLM_KEY` 未解析/失效）。
- `GET /api/agent/runtime/providers/health` → `pi/codex/deepseek-harness` 全 `unprobed/available:false`，仅内建 `replay` ready。
- `GET /api/agent/runtime/connections` → codex/claude/gemini/opencode/pi/omp/codebuddy 7 项 `connection_verified:false`。
- `POST /api/interview/extract {experience_id:1}` → **502 `LLM 提炼失败，请稍后重试`**（9.9s 才返回，无重试引导、无去设置链接）。
- 错误响应质量尚可：统一 `{"detail": ..., "error_id": "err_..."}`；但 `POST /api/jobs`（无尾斜杠）返回 **307→405 Method Not Allowed** 而非 422/404，trailing-slash 分叉是 API 粗糙点。

## Journey 摩擦表

| 阶段 | 文件:位置 | 用户视角 | 摩擦/断点 | Sev |
|---|---|---|---|---|
| 启动 | `providers.tsx:74-114` | 后端未起时看到红色方块+「正在启动 Python 工作台」，45s 后才给「无法连接」 | 45s 内无区分「后端在启动」vs「后端根本没装/端口被占」；重试按钮 8s 才出现；**无限轮询无退避**（250ms 固定间隔打 45s） | P2 |
| 启动 | `providers.tsx:89` | 版本不匹配时（`payload.version !== APP_VERSION`）静默继续轮询直到超时 | 用户看到的是「无法连接」而不是「版本不匹配，请升级后端」——**错误归因错误** | P1 |
| Onboarding | `OnboardingWizard.tsx:742-749` | 步骤 1（职业画像 5 道 MBTI 题）→ 步骤 2（连接模型）→ 步骤 3（档案底稿）→ 步骤 4（进入岗位） | 「暂不设置」可跳过每一步——**跳过后没有任何「你跳过了什么、之后在哪补」的交接**；skip 标记只记 `wizardSkipped`，不记跳过了哪步 | P2 |
| AI 连接 | `OnboardingWizard.tsx:905-917` + 实测 | 「连接本机 Agent」步只展示 AgentConnectionPanel；本机实测 7 provider 全未 verified | **步骤可无条件「继续」**：用户 0 provider 也能走完向导，下一步就是依赖 provider 的实时研究——引导没有警告「你现在只能走本地 Replay」 | P1 |
| Profile | `resume/page.tsx:162-220` | 上传简历走「AI 解析审核」流 | LLM 死时解析失败；但页面同时提供手动新建——**分叉没有显式降级提示**，用户要靠自己理解「AI 不行就手动」 | P2 |
| 存第一个 job | `AddJobModal.tsx:53-85,142-173` | 手动保存岗位，必填 title/company/JD；「准备方式」二选一：本地准备（replay）/ 实时研究（auto） | 「本地准备（推荐）」是诚实降级，加分；但 **live 模式选在 0-provider 环境下没有前置阻断/警告**，任务创建后才会在 career-tasks 里失败——把失败推迟到了用户看不见的页面 | P1 |
| Job Detail / Role Intelligence | `jobs/[id]/page.tsx:867-871` | Fixture 结果有 amber 警告条「不代表真实市场研究」 | 标注诚实（达标）；但 **fixture 与真实结果混排在同一进度链路**，stage 3「同类岗位基准分析完成」done 态不区分 fixture vs live——用户看进度条无法分辨这次是真研究还是回放 | P2 |
| Resume tailoring | `optimize.py:454-509` `_llm_rewrite_sections` | 生成定制化简历 | **LLM 调用失败 → `return rows, False` 静默用未改写原文**，只在日志 warning；`fallback_to_simple_rewrite` 只写进 `pipeline_result` dict，**无任何 SSE/前端字段透出**——用户收到「成功」简历但没有 JD 定制。这是最严重的假成功路径 | P0（产品诚信） |
| Pipeline | `applications/page.tsx` + 实测 progress-board | 421 条记录/336 公司（大量 T7 测试数据混入） | 真实工作区里 synthetic/fixture 数据与真实数据同库同看板，无「这是测试数据」过滤视图——新用户 cold start 看到的 Pipeline 若残留 demo 数据会严重误导 | P1 |
| Interview prep | `interview/ai/page.tsx:164-215` | 创建 AI 面试需 `runtime.provider` | 实测 `/api/agent/runtime` 报 `provider_id:"pi" status:"ready"`——**但 pi 在 connections 里 `status:"missing"`、providers/health 里 `available:false`**。两处状态自相矛盾，前端按 runtime 放行后创建会在后端失败 | P1 |
| Interview debrief/学习 | `interview/page.tsx` + `KNOWN_ISSUES.md:30` | 面经 collect（手动粘贴）→ extract（LLM 提炼题目） | 实测 collect 200 成功、extract **502**——**collect 的乐观成功把 extract 的硬依赖藏到第二步**；库中残留 3 条来源不明的历史 email_body（文档已承认） | P2 |
| 全局降级 | 全链路 | 所有 provider/LLM 不可用时 app 是否降级为纯手动？ | **部分降级**：jobs 手动保存、resume 手动新建、面经手动 collect、progress-board 手动移动都可用；但 optimize/interview-extract/interview-ai/role-research-live 四处无降级 UI，只在中途报错。**没有「当前为离线手动模式」的全局状态条**——用户在每个功能点上重新发现一次坏掉 | P1 |

## 杀死这个产品的 10 个理由

1. **「智能简历定制」在你 LLM 挂的时候照样返回成功。** `_llm_rewrite_sections` 静默 fallback 用原文（`optimize.py:489`），简历照常产出、用户照常被拒——竞品一句话："OfferU 的 AI 优化在你 API key 过期后从未告诉你它没工作过。"
2. **Provider 状态两个真相源自相矛盾。** `/api/agent/runtime` 说 pi ready，`/api/agent/runtime/providers/health` 说 pi unavailable——前端信哪个取决于页面，用户在同一会话里看到「已连接」和「未连接」并存。
3. **Onboarding 是装饰性的。** 每一步都可跳过、0 provider 也能「完成」引导；完成态（`agentConnected`）要求 2 分钟内 checked_at（`OnboardingChecklist.tsx:40`），checklist 永远勾不上第一格，快速开始卡死在 0/3。
4. **冷启动后第一动作的死概率极高。** 默认 LLM 配置即失效（test-llm 401），默认 provider `deepseek-v4-flash-free` 上游 model unavailable——新用户的首个「 wow moment 」（AI 生成）大概率是 9.9s 后的 502。
5. **错误延迟暴露。** AddJobModal 选「实时研究」不在提交前检查 provider 可用性；interview collect 先成功再让 extract 失败。失败发生在用户已经离开上下文之后——Apple 标准是在承诺之前验证能力。
6. **421 条记录的 progress-board 里混着 T7 synthetic 测试数据**，与真实投递同看板无过滤。竞品："它连自己的测试数据和你的职业生涯都分不清。"
7. **234 个 API 端点、307/405 trailing-slash 分叉、Next.js API 假扮层（compat/next-*）**——这是给维护者的复杂度债，用户侧表现为行为不一致：有的 404 有中文 detail，有的裸 `Not Found`。
8. **没有全局「手动模式」叙事。** Local-first 是卖点，但 LLM 挂时产品不宣布降级，让用户逐功能踩雷；对照 Competitor 的一句「works offline, upgrades when connected」我们连状态条都没有。
9. **面试闭环断在最值钱的一环。** collect 面经 → extract 题库（LLM 502）→ AI 模拟面试（provider missing）→ 复盘；前两环都断时，「Interview」页只剩一个无法解释的空题库。
10. **「暂不设置」引导完成后没有回收机制。** 用户跳过模型配置后，整个产品里没有任何持久 UI 提醒「你还差一步才解锁 AI」——OnboardingChecklist 有，但它只在 agent 2 分钟内 verified 才打勾，逻辑上永远显示未完成且不给「为什么」。

## Top-5 修复优先级

1. **把 silent-fallback 改成可见降级（P0）**：`_llm_rewrite_sections` 失败时在 proposal/pipeline_result 透出 `rewrite_degraded:true` + 原因，前端在简历提案卡片显示「AI 改写未生效，已保留原文」横幅。同法审计所有 `except → return rows/original` 路径。
2. **统一 provider 真相（P1）**：`/api/agent/runtime` 与 `/providers/health` 合并为单一状态源；前端所有「实时研究/AI 面试」入口在**提交前**用该状态做前置 gate + 禁用理由文案，禁止创建必然失败的任务。
3. **Onboarding 闭环（P1）**：每步跳过时记录 `skippedSteps[]`；完成页明确「你现在处于本地手动模式，解锁 AI 需 X」；checklist 的 agent 打勾条件去掉 120s 窗口或显示「上次检查 N 分钟前，点击重新检查」。
4. **启动错误归因（P1）**：BackendReadyGate 区分「连接失败」/「版本不匹配」/「非 OfferU 后端」三种终态，版本不匹配直接给升级指引而非 45s 后超时。
5. **测试数据隔离（P1）**：progress-board/jobs 列表默认过滤 `source=test|fixture|synthetic` 或提供「演示数据」分组视图；新工作区 cold start 不展示历史测试残留。

## 已达标的点（简短）

- BackendReadyGate 有慢提示、重试、startup_recovery 降级横幅（failed_checks 中文化映射）。
- AddJobModal 提供诚实的「本地准备（推荐，标记为本地）」选项，不伪造 live。
- Job detail 对 fixture 结果有 amber 警告「不代表真实市场研究」。
- API 错误统一带 `error_id` 可溯源；404/422 中文 detail 友好。
- OnboardingChecklist 用真实数据（resumes/jobs/agent verified）而非 localStorage 自证。
- 无 LLM 时手动路径完整可用：jobs/resume/面经 collect/pipeline 移动都纯本地。
