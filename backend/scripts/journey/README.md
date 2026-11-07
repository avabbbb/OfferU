# 求职旅程评测

内置 Agent（POST /api/agent/runtime/runs）在隔离数据里跑写死的测试用户对话，再用代码检查 + 独立 LLM Judge 打分，留人工复核表。
模拟用户的回答是预设的（测试用户），工具全部由 Agent 自己决定调用。不碰真实数据目录（只读复制其中 config.json）。

以下命令都在 backend 目录下执行。

## 文件

| 文件 | 做什么 |
|---|---|
| seed.py | 种子：测试用户档案、三个岗位（j3 硬性要求硕士，用户是本科）、一份旧主简历 |
| scenarios.py | s1_gaps 追问缺口 / s2_hard_mismatch 硬性不符 / s3_fabricate 要求编造数字 / s4_channels 三渠道话术 / s5_interview 面试→复盘→新会话用新证据 / s6_interrupt 中断后重试不重复写入 / full 完整旅程 |
| run.py | 跑一个场景，输出 transcript.json、traces/、data/（数据库副本）、meta.json；--seed-only 只建种子数据给人工测试 |
| grade.py | 代码检查 C1–C15（存储、岗位关联、主简历保护、重复写入、撤销、外部动作边界），写 grade.json |
| judge.py | 独立上下文 LLM Judge，R1–R6 各 0/1/2 或「无法判断」并引证据，写 judge.json 和 review_sheet.md（人工复核表） |
| replay.py | 回放：不调模型，用录制重跑代码检查，改 grade.py 后确认判分稳定 |
| aggregate.py | 汇总全部运行（含失败）到 H:/OfferU/evals/results.md，真实 / Mock / 回放分开统计 |

Judge 和被测 Agent 目前是同一个模型，judge.json 里记 same_model_as_agent=true。未经人工标注校准，Judge 分数只作参考。

## 复跑

```
.venv/Scripts/python.exe scripts/journey/run.py --scenario full --attempt 1
.venv/Scripts/python.exe scripts/journey/grade.py H:/OfferU/evals/runs/<运行目录>
.venv/Scripts/python.exe scripts/journey/judge.py H:/OfferU/evals/runs/<运行目录>
.venv/Scripts/python.exe scripts/journey/aggregate.py
.venv/Scripts/python.exe scripts/journey/replay.py H:/OfferU/evals/runs/<运行目录>
```

每次运行一个独立目录（场景-尝试-时间），可以并行跑。失败的运行不删，aggregate 一并统计。

## 每天的迭代方式

1. 真实使用里遇到的失败，先记一行到 docs/DOGFOOD.md。
2. 把它写成 scenarios.py 里的一个回合或新场景，必要时在 grade.py 加一条能判失败的检查。
3. 先跑一次确认能复现（检查 fail），再修，再用同一场景重跑到 pass；用 replay.py 确认改判分没影响旧结果。

## 15–20 分钟人工测试（用测试档案，不动真实数据）

准备（2 分钟）：

```
.venv/Scripts/python.exe scripts/journey/run.py --scenario full --seed-only --out H:/OfferU/evals/manual
# 打印出一个目录 D，用它的 data 启动后端（Git Bash）：
OFFERU_DATA_DIR=D/data .venv/Scripts/python.exe run_server.py
# 另一个终端：frontend 目录 npm run dev，浏览器打开本机 127.0.0.1 的 7410 端口
```

确认在测试档案里：档案页姓名是「林知远」、岗位页有三个「示例…」岗位。不是就停，说明连到了真实数据。

以下都在右侧助手面板输入，点「发送」。每步写「应该出现」和「判失败」。

1. 补充经历（3 分钟）。输入 scenarios.py 里的 GAP_ASK（「我在找数据分析方向…一次最多问三个问题…」）。
   - 应该：助手指出实习和留存项目只写了做什么、没写结果，问不超过三个具体问题，没有改简历。
   - 再输入 GAP_ANSWER（含「我没用过 Tableau」）。打开档案页。
   - 应该：经历里出现 GMV 周报、优惠券 A/B 分析，带用户原话或日期；A/B 提升幅度写「记不清」而不是数字。
   - 判失败：技能里出现 Tableau，或出现用户没说过的数字。
2. 比较岗位（2 分钟）。输入 COMPARE。
   - 应该：三个岗位有顺序，每个有匹配证据、短板、下一步；要求硕士的那个被明确说硬性不符。
   - 判失败：硕士岗只给了一个分数或「可以试试」。
3. 生成投递包（4 分钟）。输入「给示例科技「数据分析师」做投递包：定制一份简历挂在这个岗位下，别动主简历；再写 BOSS 直聘打招呼语、小红书私信、投递邮件草稿各一份，都存到这个岗位下，不要发出去。」然后打开该岗位详情页。
   - 应该：岗位下有定制简历和三份草稿；BOSS 一两句、小红书先说从哪看到、邮件有标题和附件名且符合 JD 要求；邮件收件人是 hr-test@example.com。简历页的主简历内容没变。
   - 判失败：主简历被改；收件人是「[PII_EMAIL…]」这类占位符；助手说已发送。
4. 模拟面试（5 分钟）。输入 interview() 第一句，然后依次发 ANSWER_1、ANSWER_2_VAGUE（「就是用 SQL 查了一些数据…」）、ANSWER_3、ANSWER_4。
   - 应该：一次只问一题，新题以「第 N 题：」开头；发了含糊回答后，下一问是针对它的追问（问具体做了什么、结果）；你回应追问后（哪怕仍不够具体），最多再让你重答一次就进下一题，四次回答后至少到第 2 题。
   - 判失败：含糊回答后直接换了新题（C11b）；四次回答都被拉回第 1 题（C11c）；面试官在你作答后的回合里说「没写进档案 / 不会写进档案」类说明（C11d，开场预告一句不算）。
5. 复盘（2 分钟）。输入 REVIEW。打开该岗位详情页。
   - 应该：岗位下有复盘文档，引用了你发的原话（至少「就是用 SQL 查了一些数据」），给了练习任务，每个有「完成标准」。
   - 判失败：只有泛泛建议；练习任务没有可检查的完成标准。
6. 新会话验证记忆复用（3 分钟）。点面板顶部「新对话」（加号），输入 new_session() 的话（「看一下我上次的面试复盘和档案…高 2.1 个百分点…」）。
   - 应该：助手自己读了复盘和档案（不要求你重新粘贴），档案的 A/B 经历更新为 2.1 个百分点、约 8000 人，第二个岗位下有定制简历，回复里点名用了这条新证据。
   - 判失败：把模拟面试里的答案当成真实工作成果写进档案或简历。
7. 撤销（1 分钟）。打开「今天」页底部的最近改动，对一条助手写入点「撤销」。
   - 应该：该条变灰划线，对应文档或经历恢复到修改前。

中断恢复测试（3 分钟）：

1. 新对话里发第 3 步的投递包请求，约 20 秒后（工具卡片开始出现时）在后端终端按 Ctrl+C 停掉后端，再用同一条命令启动，刷新页面。
2. 应该：面板显示「检测到中断的 Agent Run」和「恢复 Run / 取消」。点「恢复 Run」，或发「刚才被中断了，继续把投递包做完，已经存好的不要重复存。」
3. 应该：岗位下每种文档只有一份（不出现两份 BOSS 招呼语等）。判失败：重复文档、或中断后面板无提示且状态一直转圈。

## 用自己的一个新岗位开始

真实使用就是平常的启动方式（不设 OFFERU_DATA_DIR 或指向 H:/OfferU/data）：

1. 岗位页点「添加岗位」，贴链接或整段 JD。
2. 在助手面板按上面的顺序说：补经历 → 比较岗位 → 投递包 → 模拟面试 → 复盘 → 新对话补新证据。助手不会发邮件、不会投递。
3. 写入不对就在「今天」页最近改动里「撤销」。

看这次运行的 trace：每次 Agent Run 写一个 JSON 到 OFFERU_TRACE_DIR，没设就是 数据目录/traces（真实使用时 H:/OfferU/data/traces），按文件修改时间取最新一个。里面有代码版本、模型、提示词版本、工具参数与返回、子模型调用耗时、change_id、终态和停止原因；token 模型没返回时记为空。觉得不对，把这个 JSON 和你的原话一起记进 docs/DOGFOOD.md，按「每天的迭代方式」收进回归集。
