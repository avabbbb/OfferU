> 已归档（2026-10-21）：本文不再是当前权威，只用于考古。当前文档：09-quality-and-release.md（位于 docs/）。2026-09-19 对抗评审的历史证据，评分与缺陷只属于当时代码。

# 竞品格局 对抗评审 — 2026-09-19

## 结论（对照 Apple 上线水准一句话定性）

**AI 求职赛道已从「工具箱」切换到「agent 军备赛」：头部产品都在讲 "your AI does the job hunt for you"，但真实用户抱怨高度一致——自动化是黑盒、投递质量不可控、付费墙踩坑、数据删不掉。OfferU 的 local-first + evidence review + human-controlled agent 是唯一在架构层回应这些抱怨的产品；但竞品在 onboarding 速度、job source 覆盖、移动/随手性和价格透明上全面碾压 OfferU 的 internal-beta 状态。** 按 Apple 上线水准衡量，OfferU 的设计哲学领先一代，分发与摩擦落后一代。

## Findings

| ID | Sev | Type | 位置 | 证据 | 问题 | 建议修法 |
|----|-----|------|------|------|------|----------|
| C1 | P1 | design | onboarding / first run | GOAL.md `Launch → Welcome → create/import Profile → add first Job`；Teal 首页 `Sign Up! It's 100% Free`、Huntr `Sign Up for Free` 即入 tracker | 竞品的 "first value" 都在 **1 分钟内**：Teal/Huntr 注册即开 tracker + Chrome clipper；Jobright "less than 1 min" 出匹配 + autofill。OfferU 要求 install → launch → connect agent → build profile → save job，链路多 3-5 步且每步都可能失败（agent detection、profile import） | 把 onboarding golden path 压成 **"save first job in <2 min"**：允许未连 agent 的 fallback（API key 或内置 replay provider）先跑通 save→research→resume 链路，agent 连接降级为"升级路径"而非 gate |
| C2 | P1 | ux | 自动化可信度 | Simplify Trustpilot 3.2/5：`AI was filling crap in fields that aren't even asking`、`autocomplete worked most of the time, but leaves blanks pretty regularly (without notification)`；AIApply 首页宣称 `applied to 100 jobs in under an hour` | 黑盒 auto-apply 是赛道最大信任黑洞：填错字段、漏填、假投递、Ghost listings。OfferU 的 `投递表单填写` 明确 "不点击最终提交、不覆盖已有值、不填敏感字段"——方向正确但市场传播完全没讲 | 把 "controlled autofill + explicit human submit" 做成 **可展示的差异化**：在 Job Detail 里给出 fill plan 预览 + 已填/未填字段清单 + 提交回执证据链，对标 Scale.jobs 的 "proof screenshot for every application" |
| C3 | P1 | arch | job source 覆盖 | Jobright `total jobs 8,000,000+` `Today's new jobs 400,000+`；Teal `Save Jobs From over 40 Popular Job Boards`；Simplify `Copilot autofills on 100,000+ company career sites` | OfferU 依赖"使用者在浏览器中显式触发的岗位采集" + 扩展站点规则包；没有自有 job board / 聚合 feed。结果：发现岗位完全靠用户自己找，OfferU 只做"已保存岗位"的深度加工 | 短期：承认边界，把扩展 clipper 体验做到 Teal/Huntr 同级（一键 save + JD 抽取 + 立刻生成 role intelligence）；中期：接 1-2 个 job feed provider（JSearch/Adzuna/LinkedIn RSS）作为 `可审计重任务` 的输入源 |
| C4 | P1 | ux | AI 可控性 / 黑盒 vs 审核 | Simplify 评论 `The AI is extremely unsophisticated, it will lie by default`；Teal 评论 `AI-generated cover letters usually need a heavy edit—they come off a bit robotic`；Huntr 唯一差评 `Tool only works if you've built a resume using their platform` | 全行业 AI 生成质量是"够用但不可信"：改出来的简历像 AI、cover letter 机器人味、tailor 只在自家 builder 里生效。OfferU 的 fact gate（SUPPORTED/WEAK_EVIDENCE/UNSUPPORTED）+ proposal diff + stale detection 是唯一系统性方案 | 在 Resume Workspace 把 fact gate 结果**前置可见**：每条 AI proposal 标 evidence 等级 + 引用来源 + before/after diff；把 "UNSUPPORTED 不得进入正式事实" 变成用户可感知的卖点文案 |
| C5 | P2 | ux | 移动端 / 随手性 | Jobright PH review `want ... a mobile app`；Careerflow 把 LinkedIn optimizer + tracker 做成 mobile-friendly web；Scale.jobs 有 iOS/Android app（"job concierge"） | OfferU 是 desktop-first（Tauri + localhost:7410）。CONTEXT.md 定义了 `移动端轻操作` 但无 native/PWA 落地。竞品移动端虽浅（查看、approve、nudge），但正好覆盖"通勤时 review"场景 | 不做 native；做 **responsive PWA + approval inbox 的 mobile 布局**：今天队列、proposal approve/reject、task status、pipeline 看板四类只读/轻操作界面，覆盖 80% 移动场景 |
| C6 | P2 | ux | 价格 / 价值锚 | Huntr Pro $40/mo ($30 quarterly, $26.66 biannual)；Teal+ $13/week ≈ $29/mo ($79/90d)；Rezi Pro $29/mo 或 $149 lifetime；LazyApply $99-$999/yr；Scale.jobs $199-$1099 一次性 | 竞品定价两极：订阅 SaaS ($29-40/mo) vs 一次性 human-service ($199-1099)。OfferU 当前无定价，但 GOAL.md 明确 "不引入 Billing 或云同步预埋"——长期商业化路径未定义 | 明确 OfferU 的 monetization 叙事：**local-first = 用户只付 model/agent 成本**，不做订阅 SaaS；若未来出 pro tier，应是一次性 license 或开源+支持模式，避开 "subscription fatigue" 这一赛道最大抱怨 |
| C7 | P2 | design | 职位推荐 / matching | Jobright `Personalized AI Job Matches` + `Interview-worthy Job Matches`；Simplify `Your agent watches job listings 24/7`；Teal `Match Score` | 竞品把 "帮你找到对的岗位" 做成 first-class feature（匹配分、24/7 watch、新岗提醒）。OfferU 的投前决策是 "对已知岗位做投/不投判断"，没有上游 discovery | 上游加一个轻量 `Job Discovery` 面：用户保存的岗位 cohort → role intelligence 反推 "相似岗位" 建议列表（聚合已有 provider 数据），让 OfferU 从"处理岗位"前移到"发现岗位" |
| C8 | P2 | ux | 隐私 / 数据控制 | Careerflow 差评 `There’s no option to delete your account directly... they require you to email support`；Simplify 差评 `They Publicly Post Your Private Emails`（Featurebase 泄露 PII）；Jobright 好评 `real listings pulled directly from company career sites` | SaaS 竞品普遍把简历/申请数据放云端，删除路径差、隐私边界模糊。OfferU 的 local-first + SQLite + keyring 是架构级优势，但目前只在 README/SECURITY 里当工程卖点讲 | 把 "your career data never leaves this machine" 做成 onboarding 第一个信任页面 + Today 上的常驻 privacy badge；加 "export everything / delete everything" 两个一键操作，对标 Careerflow 的投诉点 |
| C9 | P2 | ux | 面试 / 学习闭环 | Careerflow `AI Mock Interview` + `interview feedback`；Teal `AI Interview Practice`；Rezi `AI Interview`；Jobright `24/7 AI Career Copilot` | 竞品把 mock interview 做成标配，但多数是通用题库 + 泛泛反馈。OfferU 的 Interview Focus 来自 Role Delta × Evidence Gap × Previous Learning，理论上更深；但缺 voice mode 和 "how did I actually do" 的真实感反馈 | 不加 voice；把 debrief 的 `actual transcript` 引用 + `focus capability ↔ career evidence` 关联做成差异化卖点："别人给你泛泛鼓励，OfferU 给你基于你简历和岗位的针对性追问" |
| C10 | P3 | ux | 网络 / 推荐人 | Jobright `Get Your Insider Referrals`（alumni + hiring manager 连接）`increase your chances ... by 4X`；Simplify `Find warm paths into target companies` | 竞品把 networking/referral 做成独立 feature（找校友、内推、direct outreach）。OfferU 完全没有这个维度，只做"材料 + 面试" | 低优先级；最多做 `contact tracker`（对标 Huntr Contact Tracker）+ 在 Job Detail 里提示 "this company has N alumni in your LinkedIn export"，不承诺 outreach 自动化 |
| C11 | P3 | doc | 产品 claim 边界 | GOAL.md `Fixture / Replay 必须显式标记，不得冒充实时数据`；README `Internal Beta — signed installer not yet released` | OfferU 对 "live role intelligence" 的 claim 极严（必须真实 provider E2E），竞品如 Teal/Jobright 直接把 "AI matching/insights" 当默认能力宣传。两边标准不同 → 市场话术吃亏 | 在 README/官网把 "evidence-backed" 翻译成用户语言：`Every claim in your resume is backed by something you actually did`；把 "signed installer not yet released" 的状态改为明确 roadmap（Q4 2026 beta / Q1 2027 GA），降低 "never shipped" 的不信任感 |
| C12 | P3 | perf | 启动 / 冷路径 | GOAL.md SLO `cold usable ≤8s, warm ≤5s`；竞品是 web SaaS（打开即用） | Tauri desktop + FastAPI sidecar 启动注定比 "open a tab" 慢；8s 冷启动在竞品面前是感知劣势 | 把 cold-start 优化到 ≤5s：backend 预热、Today 骨架屏先渲染、agent connect 异步化（不 block 首屏）；或提供 `offeru today --web` 快速入口 |

## Top-5 修复优先级

1. **Onboarding friction（C1）** — 把 "save first job → see role intelligence → get tailored resume" 压到 <2 min，agent connect 变成可降级的增强项而非 gate。
2. **Job source coverage（C3）** — Chrome clipper 对齐 Teal/Huntr 体验；接入至少 1 个 job feed provider 做 discovery 上游。
3. **AI 可控性卖点化（C4 + C2）** — 把 fact gate / proposal diff / controlled autofill 做成用户可感知的 UI 文案和默认开关，正面回应赛道 "black-box AI" 信任危机。
4. **移动端轻操作（C5）** — PWA 化 Today + approval inbox + pipeline，覆盖 review-on-the-go 场景。
5. **隐私 / 数据控制叙事（C8 + C6）** — onboarding 第一屏讲 local-first；"export all / delete all" 一键可达；商业化路径明确不做订阅 SaaS。

## 已达标的点（简短）

- **Fact gate / proposal review**：竞品无对应机制（Simplify 的 AI 被批 "will lie by default"；Teal cover letter 被批 "robotic"）。OfferU 的 SUPPORTED/WEAK/UNSUPPORTED + diff + stale detection 是赛道独一份。
- **Local-first / privacy**：竞品全部是云端 SaaS，删除账号、PII 泄露是真实投诉点。OfferU SQLite + keyring + 无云同步是架构级差异。
- **Interview 深度**：竞品是通用题库；OfferU 的 Role Delta × Evidence Gap × Previous Learning 是有理论框架的针对性练习。
- **Agent 架构**：竞品把 AI 当黑盒 feature；OfferU 把 agent 当可替换 reasoning authority + operation registry + approval authority，可控性最高。

## 竞品对比矩阵

| 产品 | 核心卖点 | Onboarding | AI 方式 | 定价 | 用户最多抱怨 |
|------|----------|------------|---------|------|--------------|
| **Teal** | Job tracker + resume tailor + 40+ job board clipper | 注册即免费 tracker + Chrome 插件 | 半黑盒：AI bullet/summary/cover letter + keyword match score | $13/wk, $29/mo, $79/90d | 订阅陷阱投诉、AI cover letter 机器人味、ghost listings |
| **Huntr** | Job tracker CRM + AI resume builder + job-tailored resume | 免费版 100 jobs + autofill | 半黑盒：keyword/responsibility match + AI suggestion | $40/mo, $30/q, $26.66/6mo | autofill hit-or-miss、resume 必须建在平台内、无实时客服 |
| **Simplify** | 24/7 AI talent agent + Copilot autofill + tracker | 上传简历或 5-min AI interview → agent 接管 | 黑盒 agent：auto-match + auto-network + auto-apply | Freemium + Plus (~$20-40/mo) | AI 填错字段、job board 枯竭、不退款、Featurebase 泄露 PII |
| **Jobright** | AI job search copilot + auto-apply + insider referrals | Join → 1 min 出匹配 + autofill | 黑盒 agent：90% automation + tailored resume + referral | Freemium | 需手动改 AI 重写简历、无 mobile app、非传统背景支持弱 |
| **Careerflow** | AI resume + job tracker + LinkedIn optimizer + mock interview | 注册即开 builder | 半黑盒：AI resume/cover + autofill + mock interview | Freemium + Premium | 删账号难、订阅续费投诉、远程项目付款纠纷 |
| **Kickresume** | AI resume builder + templates + ATS checker | 免费 builder → 模板 → AI 生成 | 半黑盒：AI writer/rewriter + ATS score | Freemium + Premium | 模板同质化、AI 内容需人工改 |
| **Rezi** | #1 AI resume builder (Forbes) + Rezi Score + MCP | 上传简历 → score → tailor | 半黑盒：23-metric score + keyword targeting + AI interview | $29/mo 或 $149 lifetime | 免费版仅 1 resume / 3 downloads；AI 重写需人工核对 |
| **Scale.jobs** | Human assistant applies for you（非 AI） | 约 strategy call → 选岗位 → human 投 | 无 AI：真人代投 + proof screenshot | $199-1099 一次性 | 价格高、非自动化、依赖人力排期 |
| **LazyApply** | AI auto-apply on Greenhouse/Dice/Indeed/Zip | 邮箱注册 → 设 profile → 自动投 | 黑盒 agent：Job GPT 自动填表 | $99-$999/yr | 投递质量不可控、Ghost/fake listings、平台反作弊风险 |
| **AIApply** | Auto-apply + Interview Buddy + tailored materials | 注册 → 设偏好 → agent 找+投 | 黑盒 agent：全自动或 hybrid | 订阅制 | Interview Buddy setup 复杂、质量参差 |
| **LinkedIn Premium** | Network + InMail + AI job insights + Learning | 已登录用户 → Premium 升级 | 半黑盒：AI 简历/求职信建议 + job match | ~$39.99/mo | 性价比争议、AI 建议泛、不改变投递流程 |
| **OfferU** | Local-first AI Career OS：evidence-backed profile + controlled agent | 安装 → 连 agent → 建 profile → 存岗位 | 可控 agent：reasoning authority + operation registry + human approval | 未定（local-first，预期无订阅） | 未发布、onboarding 链长、无 job discovery、无 mobile |

## 来源

- Teal 首页 + 定价：`https://www.tealhq.com/`, `https://www.tealhq.com/pricing`
- Teal Trustpilot：`https://www.trustpilot.com/review/www.tealhq.com`
- Huntr 首页 + 定价：`https://huntr.co/`, `https://huntr.co/pricing`
- Huntr Trustpilot：`https://www.trustpilot.com/review/huntr.co`
- Simplify AI agent：`https://simplify.jobs/ai-talent-agent`, `https://simplify.jobs/copilot`
- Simplify Trustpilot：`https://www.trustpilot.com/review/simplify.jobs`
- Jobright 首页 + agent：`https://jobright.ai/`, `https://jobright.ai/ai-agent`
- Jobright ProductHunt reviews：`https://www.producthunt.com/products/jobright-ai-2/reviews`
- Jobright Trustpilot：`https://www.trustpilot.com/review/jobright.ai`
- Careerflow 首页 + blog：`https://www.careerflow.ai/`, `https://www.careerflow.ai/blog`
- Careerflow Trustpilot：`https://www.trustpilot.com/review/www.careerflow.ai`
- Kickresume：`https://www.kickresume.com/en/`
- Rezi 定价：`https://www.rezi.ai/pricing`
- Scale.jobs 首页 + 定价：`https://scale.jobs/`, `https://scale.jobs/pricing`
- LazyApply：`https://www.lazyapply.com/`
- AIApply：`https://www.aiapply.com/`
- LinkedIn Premium：`https://premium.linkedin.com/`
- OfferU 定位：`README.md`, `GOAL.md`, `CONTEXT.md`

*注：LinkedIn AI 具体功能名（AI-powered job search、Hiring Assistant）因官方页面需登录，采用 2025-2026 公开报道通用描述，标 [INFERENCE]。web_search 全部失败，调研通过直接读取官方页面 + Trustpilot/ProductHunt 一手评论完成，≥3 轮不同角度（产品页→定价页→评论页→2026 agent 新品）。*
