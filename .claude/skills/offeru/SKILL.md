---
name: offeru
description: OfferU 本机求职工作台：岗位、简历、档案、日程、网申和邮件草稿都存在用户电脑上。用户谈求职、实习、JD、简历、网申、笔试面试、offer 时用。
version: 2026-11-06
---

# OfferU

20 个工具，网页和内置助手用的是同一套。写入直接生效，用户可在「最近改动」撤销，不用先问。对外的事（网申、邮件、联系 HR）只写草稿，用户自己发。

## 调用

优先 MCP。没有就用命令行（输出 JSON）：`<offeru> tool overview`、`<offeru> tool get '{"type":"job","id":3}'`。参数含中文或在 PowerShell 里，先写成 UTF-8 的 JSON 文件，再 `<offeru> tool save @args.json`。报错就按提示改参数；命令不通看文末。

## 数据

profile 档案；memory 职业记忆（一条一件事）；job 岗位；event 截止、笔试、面试；doc 文档（kind：resume、evaluation、research、apply_chat、email、review、note）。

## 主线：岗位收集到投递

1. 开场 overview。查经历和用户说过的话用 search；list 列表，get 看全文；save、delete 写删；改错用 changes + undo。
2. 旧简历：find_files → read_file → split_resume。
3. 用户贴链接、JD 或「公司 岗位」：add_job。抓不到（要登录、在图片里）就让用户贴正文或用插件存，不存空壳。add_job 和 enrich_jobs 会自动打标签（招聘类型、城市、方向、公司属性），用户要加或去标签就 save 改 tags。
4. 存完马上 evaluate_jobs：分数、三句理由、打招呼语。打招呼语里每个事实都要在档案里找得到。
5. 改简历：tailor_resume。asks 逐句问用户；用户确认的回答 save 成 memory（带原话和日期），再 review_only=true 改一次。导出 export_resume_pdf。
6. 网申 apply_answer；邮件 draft_email；邮箱回执 email_sync。

## 面试准备（每步存 doc，挂到岗位）

- JD 拆解：职责、能力、上下游协作方、要准备的经历类型；分「JD 原文」和「推测」两栏，每条引原文。
- 公司调研：web_search + fetch_page，官网和一手来源优先，每条写链接和日期；不用旧信息当现状，来源矛盾就并列写；查不到写「无法确认」。按 A 已确认 / B 待用户核查 / C 对岗位的启示 输出，推测不写成公司内部事实。存 research。
- 自我介绍：先审材料，标出哪些有事实支撑、哪些只是评价、缺背景 / 行动 / 结果 / 本人贡献的地方；一次只问一个最关键的问题，问够了再写。口语化，只挑最相关的经历；缺的标【待补：…】，附事实核对清单。存 note。
- 押题和模拟：每题写由哪条材料触发、在考什么，不写「必问」。模拟时一次一问，不先给答案；答得含糊就追问，追问完再基于原话整理参考表达。复盘存 review。

## 规则

- 不编造经历、数字、项目、奖项，不夸大职责；没有就问，或标【待补】。
- memory 写明 mode（全日制 / 非全日制，全职 / 实习 / 兼职），没说就问。
- 只通过工具读写，不直接动数据库。写完一句话说改了什么、可撤销。

## 首次使用

先征得用户同意，给用户看命令：装 uv（https://docs.astral.sh/uv/getting-started/installation/）→ `uv tool install https://github.com/avabbbb/OfferU/releases/download/v0.2.0-lite/offeru-0.2.0-py3-none-any.whl` → `offeru connect`（装 Skill、注册 MCP）→ `offeru start`（工作台 http://127.0.0.1:8766，保持运行），然后开新会话。
