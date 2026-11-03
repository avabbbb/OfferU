# 迭代报告 2026-11-04

分支 feat/resume-editor。本轮目标：把「按岗位改写简历」做到能直接拿去面试用，同时收尾上一轮的 Skill 重构和岗位去重。简历要体现技术深度：技术类经历写出方案选型、难点、量化结果，不堆技能词，也不编档案里没有的东西。

## 提交

| 提交 | 内容 |
| --- | --- |
| d7122dd refactor(skill) | 外部 Agent 的 Skill 收成一份 backend/skill/SKILL.md，.agents / .claude / .codex / .copilot 投影由 scripts/generate_agent_skill_projections.py 生成，test_skill_projection_sync 检查漂移；删掉三个子 Skill。岗位按链接去重，再存合并到原记录，岗位页和插件给提示。offeru tool 参数支持 @文件 和 -（标准输入），避开 PowerShell 吞引号。 |
| d624200 feat(tailor) | 后端改写主线（下文第 1–7 步）。 |
| 8366d0b feat(resume) | 前端：改写进行中表单只读；改写完成后展示提醒。 |

计划原本是「重构 / tailor 1–3 步 / 本轮 4–7 步」三批。tailor.py、tools.py、test_resume_tailor.py 两轮改动交织在同一批 hunk 里，硬拆会出现中间提交跑不通的状态，所以改成「重构 / 后端 tailor 全部 / 前端」三批。add_job 去重的后端改动在 tools.py 里，随第二批提交，所以只检出第一批时 test_job_dedup.py 不一定通过；三批合起来的测试结果见下文。

## 改写主线做了什么

1. 写到哪里：传主简历时，结果写进这个岗位的定制简历（没有就新建），主简历不动；传岗位简历就原地改。都是一条 change，可撤销，定制简历在编辑器里可以继续手改（自动保存）。
2. Prompt：要求技术类经历按「做了什么方案、为什么这么选、难点、量化结果」来写；明确禁止补档案里没有的做法和数字。
3. 事实核对（core/fact_check.py）：新简历里的机构名、日期、数字、英文词，在档案、记忆、原简历里逐个找出处，找不到的作为 unsupported 返回。
4. JD 关键词覆盖（core/tailor_report.py 的 keywords / coverage）：JD 要求的技术词和能力词，分成命中和缺失。缺失只提醒，不往简历里硬塞。
5. 页数（core/resume.py 的 page_count）：用 Playwright 按导出版式（A4 宽）量 main.resume 高度，按 1123px 一页折算；超一页时 over_page=true。Chromium 不可用时返回 null，不报错。
6. 审稿（review）：空泛动词（负责、参与这类）、没有结果的条目、技术类经历看不出做法、单条过长。
7. JD 清洗（clean_jd）：去掉公司介绍、福利待遇、投递方式等段落再进 prompt，减少噪声和 token。

第 3–6 步都只是提醒，不挡写库。改写本身可撤销，挡住反而让用户拿不到结果；把问题摆出来让人判断更合适。

tailor_resume 工具和 SSE done 事件新增字段：unsupported、coverage、pages、over_page、review。SKILL.md 和 docs/DESIGN.md 已同步，投影已重生成。

## 前端

- 改写进行中左侧表单 inert 只读（含 contentEditable），changeResume 直接返回，避免改写结果和手动输入互相覆盖。
- TailorBar 完成后分行展示：写到了哪份简历、JD 关键词命中数和缺失词、超一页提示、审稿问题（最多列 4 条）、需要核对出处的内容。

## 测试

| 范围 | 结果 |
| --- | --- |
| 后端 pytest tests（不含真模型） | 205 通过，1 跳过 |
| 前端 npx tsc --noEmit | 无错误 |
| 插件 npx vitest run | 195 通过，7 跳过（28 个文件） |

新增测试：test_fact_check.py、test_tailor_report.py（清洗、覆盖、审稿、build 与超页）、test_job_dedup.py；test_resume_tailor.py 加了免浏览器 fixture（页数固定为 1.0）和 test_tailor_done_carries_report。

测试中发现并修复：

- backend/skill/SKILL.md 改了说明但没重生成投影，test_checked_in_projections_match_generator 失败；用生成脚本 --write 重生成后通过。
- 直接跑 pytest（不带 tests）会收集 backend/scripts/ 下的旧手工脚本，它们引用已删除的 app.routes.profile 等模块，或需要起服务。不属于测试集，本轮没动；建议在 pytest.ini 里设 testpaths = tests。
- .claude 在 .gitignore 里但有已跟踪文件，提交时要用 git add -u -- .claude。

## 已知局限

- 事实核对是字符串比对，会误报（例如档案写「三成」、简历写「30%」），也查不出语义上的夸大。它的作用是把可疑处摆出来，不是证明简历没问题。
- 关键词抽取基于词表和规则，中文能力词覆盖不全；缺失列表只作参考。
- 页数依赖本机 Chromium，量不了时前端不显示页数提示。
- 没跑真模型端到端（需要 API Key）；scripts/smoke/tailor_mainline.py 已更新为读新的 doc_id，可手动跑。

## 下一步建议

- 把审稿和覆盖的结果作为第二轮改写的输入（只针对问题条目），而不是只提醒。
- 事实核对加数字归一（中文数字、百分比、倍数）减少误报。
- pytest.ini 加 testpaths，清理 scripts/ 下失效的旧脚本。
