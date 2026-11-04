# 迭代报告 2026-11-04

分支 feat/resume-editor。本轮目标：把「按岗位改写简历」做到能直接拿去面试用，同时收尾上一轮的 Skill 重构和岗位去重。简历要体现技术深度：技术类经历写出方案选型、难点、量化结果，不堆技能词，也不编档案里没有的东西。

本轮中途改了方向：第一版用规则做判断（字符串比对查出处、词表算 JD 覆盖、正则挑空泛动词），太原始，误报多，也查不出语义上的问题。第二版把判断全部交给模型，代码只量页数、做精确替换。规则式清洗只留给大批量 JD 的场景，改写链路里不再用。

## 提交

| 提交 | 内容 |
| --- | --- |
| d7122dd refactor(skill) | 外部 Agent 的 Skill 收成一份 backend/skill/SKILL.md，.agents / .claude / .codex / .copilot 投影由 scripts/generate_agent_skill_projections.py 生成，test_skill_projection_sync 检查漂移；删掉三个子 Skill。岗位按链接去重，再存合并到原记录，岗位页和插件给提示。offeru tool 参数支持 @文件 和 -（标准输入），避开 PowerShell 吞引号。 |
| d624200 feat(tailor) | 改写第一版（规则判断，已被下一批替换）。 |
| 8366d0b feat(resume) | 前端：改写进行中表单只读；改写完成后展示提醒。 |
| （本批）refactor(tailor) | 删掉规则判断，改成起草 → 独立审稿 → 精确修订的循环；前端展示审稿结果；SKILL / DESIGN / 投影同步。 |

## 改写主线（第二版）

参考了 ai-job-search 的做法（.claude/commands/apply.md、05-cv-templates.md）：判断都由 Agent 做，脚本只量页数；审稿是独立的一次调用，只输出 old/new 修改；新事实当轮写回档案。

1. 写到哪里：传主简历时，结果写进这个岗位的定制简历（没有就新建），主简历不动；传岗位简历就原地改。整个流程只在最后写一次库，记成一条 Agent 改动，可撤销。
2. 起草：流式调用，边写边推给前端。JD 原文直接进 prompt，公司介绍、福利这类噪声由模型自己忽略。Prompt 要求技术类经历按「方案、为什么这么选、难点、量化结果」写，禁止补档案里没有的做法和数字。
3. 审稿：另一次独立的 chat_completion（json_mode）。输入 JD、档案和记忆、原简历、初稿，以及按导出版式量出的页数。审稿人只输出修改清单 {old, new, reason, category} 和四类意见（关键词、岗位角度、动作和结果、语气），不重写全文。category 是 grounding / keyword / depth / length / tone。
4. 修订：按 old 精确替换。old 找不到或出现不止一次就跳过，写明原因；替换后不像简历（没有「# 名字」或 ## 分节）就整轮作废。
5. 循环：最多 2 轮；某一轮没有可用修改就停；审稿超时、返回不是 JSON 只停在那一轮，初稿和已修订部分照常保存。
6. 页数：resume.page_count 用 Playwright 按导出 HTML 量，作为审稿的输入（超一页由审稿人按 JD 相关度删整条要点），不再直接触发提醒。Chromium 不可用时告诉审稿人量不了。

为什么这样拆：起草和审稿用同一个模型，但审稿是新的上下文、新的角色，只拿事实来源对照初稿，比让起草者自查更容易发现编造。修改用精确替换而不是让审稿人重写，改了什么、为什么改都可以逐条展示和追溯，改坏了也能整轮丢掉。

tailor_resume 工具和 SSE 事件：新增 review 事件（每轮开始，带页数）；done 带 pages、rounds（每轮 applied / skipped / error）、notes、grounding（因为找不到出处被改掉的内容）。去掉了 unsupported、coverage、over_page、review 字段。

删除的文件：backend/app/core/fact_check.py、backend/app/core/tailor_report.py 和它们的测试。

## 前端

- 改写进行中左侧表单只读，避免改写结果和手动输入互相覆盖（上一批）。
- TailorBar：起草时显示字数，审稿时显示「审稿第 N 轮（预计 X 页）」；完成后分行列出每轮改了什么、跳过了什么和原因、最终页数、审稿意见里的缺口。
- grounding 类修改逐条列出，带「是真的，存进档案」按钮：存成一条 memory（kind=note，显示为「其他」），下次改写就有出处。

## 测试

| 范围 | 结果 |
| --- | --- |
| 后端 pytest tests（不含真模型） | 205 通过，1 跳过（11:40 后追加岗位闸门和审稿重试的测试；此前为 198 通过）（删掉了 fact_check 和 tailor_report 的测试，按新流程重写了 test_resume_tailor.py） |
| 前端 npx tsc --noEmit | 无错误 |
| 插件 npx vitest run | 195 通过，7 跳过（28 个文件通过，1 个跳过） |

test_resume_tailor.py 用审稿替身（按轮返回预设 JSON）覆盖：精确修订、old 不唯一或找不到时跳过、改坏格式整轮作废、审稿返回非 JSON、轮次上限、第二轮审的是修订后的稿子、JD 原样进 prompt、grounding 和 notes 透传；原有的写入位置、超时、取消、并发、缺 JD、SSE 路由测试保留。

测试中发现并修复：

- backend/skill/SKILL.md 改了说明后必须重生成投影，否则 test_checked_in_projections_match_generator 失败；已用 --write 重生成。
- 直接跑 pytest（不带 tests）会收集 backend/scripts/ 下的旧手工脚本并报错，不属于测试集，本轮没动；建议在 pytest.ini 里设 testpaths = tests。
- .claude 在 .gitignore 里但有已跟踪文件，提交时要用 git add -u -- .claude；docs 也被忽略，要 git add -f。

## 真模型实测

自定义 OpenAI 兼容端点、model hark。探针复制本机 ~/.offeru/offeru.db 和 config.json 到临时目录，用 scripts/smoke 的样例 JD（后端实习）建岗位，跑 tailor.run，不动真实数据。

| 指标 | 第 1 次 | 第 2 次（加重试后） |
|---|---|---|
| 第 1 轮审稿 | 1 条修改，命中 1/1，无跳过 | 同左 |
| 第 2 轮审稿 | 出错：chat_completion 返回 None（约 33 秒，未到 60 秒超时，网关报错或空回复） | 正常完成，无修改 |
| 页数 | 1.0（Chromium 可用） | 1.0 |
| 总耗时 | 122.8 秒 | 38.0 秒 |

- 唯一的修改是 grounding：起草去掉了「曾」，审稿按档案改回。
- notes 有用：列出 JD 要求但档案无依据、因而没补的关键词（Python/Go、MySQL、Redis、RESTful），指出届别不符（2025-07 毕业 vs 2026 届）和实习时长未提及。
- 据此加了审稿重试（25618df）：没返回或不是 JSON 时带原回复再要一次，两种原因分开写。探针看不出第 2 次是否触发了重试。

## 本轮追加：借鉴 ai-job-search

- 70e50c6 岗位入库闸门 backend/app/core/posting_guard.py，借鉴 MadsLorentzen/ai-job-search tools/posting_guard.py（MIT）。fetch_page / add_job 入库前去掉隐藏 HTML 和不可见字符（含 Unicode tag 走私），扫描中英文像指令的行；只提醒不拦截，只存计数，提醒写进岗位 notes。原来 fetch_page 只用正则剥标签，display:none 等隐藏文字会原样进 JD，再进评估和改写 prompt。
- 已对齐、不用再做：审稿人不写文件只返回 old/new；岗位按不可信数据声明（services 下已普遍有）。
- 待选：导出 PDF 文本层检查（verify_pdf.py）、新确认事实当轮写回档案、公司调研缓存 TTL。

## 已知局限

- 真模型只跑了两次、一个样例岗位（见「真模型实测」）：每次只有 1 条修改，命中率 1/1 说明不了 old 精确匹配在修改多时是否可靠。
- 起草和审稿是同一个模型：两次起草都把「曾获月度最高档绩效」写成「获…」，都被审稿改回；这次抓到了，但同源盲点仍是主要风险。
- 没用 Playwright 在真界面上点一遍改写主线（DESIGN.md 要求每个 PR 做），这是欠的。
- 审稿和起草是同一个模型，独立的只是上下文和角色；同一模型的盲点可能两边都有。
- 「存进档案」存的是被改掉的原句，没有拆成结构化的经历字段；kind 用的是 note。
- 页数依赖本机 Chromium。

## 下一步建议

- 配好模型后跑一次真改写，统计审稿修改的命中率（被跳过的比例），按结果调 prompt。
- Playwright 走一遍：选岗位 → 改写 → 看审稿结果 → 存进档案 → 再改写。
- 「存进档案」改成让用户选归到哪段经历。
- pytest.ini 加 testpaths，清理 scripts/ 下失效的旧脚本。
