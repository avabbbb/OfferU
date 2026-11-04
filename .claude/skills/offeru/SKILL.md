---
name: offeru
description: OfferU 本机求职工作台：岗位、简历、档案、日程、网申和邮件草稿都存在用户电脑上。用户谈求职、实习、秋招春招、简历、JD、网申、笔试面试、offer 时用。
version: 2026-11-03
---

# OfferU

OfferU 把求职数据存在本机，提供 20 个工具；网页、内置助手和你用的是同一套。每次写入都记下是谁改的，用户能在「最近改动」撤销，所以直接写，不用先问。对外的事（发邮件、提交网申、联系 HR）只写草稿，由用户自己发。

## 怎么调用

1. 优先 MCP：工具列表里有 offeru 的 overview、save 等就直接调。
2. 没有 MCP 就用命令行，输出 JSON：
   <offeru> tool overview
   <offeru> tool get '{"type":"job","id":3}'
   参数含中文或在 Windows PowerShell 里，先写进 UTF-8 的 JSON 文件，再传 @路径：<offeru> tool save @args.json
3. 返回 error 时按提示改参数再试。字段和枚举以每个工具的说明为准。
4. 都不通：OfferU 没装或 <offeru> 还是占位符，看文末「首次使用」。

## 五种数据

profile 档案（唯一一份）；memory 职业记忆（一条一件事：经历、技能、偏好）；job 岗位（status、score、reasons）；event 事项（截止、笔试、面试）；doc 文档（简历、评估报告、网申问答、邮件草稿、调研，按 kind 区分）。

## 什么时候用哪个

- 开场先 overview：阶段、待办、各状态岗位数、最近改动。
- 找用户的经历和说过的话用 search；按类列用 list；看全文用 get。
- 写数据用 save，删用 delete；改错了用 changes 找到再 undo。
- 旧简历：find_files 找文件，read_file 读文字，split_resume 拆成 memory。
- 用户贴岗位链接或 JD：add_job。同一链接再存会合并到原岗位。要登录的页面抓不到，请用户用浏览器插件存，或贴正文。
- 值不值得投：evaluate_jobs。没配模型就自己评，用 save 写 job 的 score（0–100）和 reasons（三句）。
- 改简历：tailor_resume。传主简历会写进这个岗位的定制简历（没有就新建），主简历不动；传岗位简历就原地改。流程是起草 → 独立审稿（对照档案、记忆、原简历和 JD，给出逐条精确替换）→ 修订，最多两轮，最后写一次库。返回的 doc_id 是写入的那份；rounds 是每轮应用和跳过的修改；grounding 是因为找不到出处被改掉的内容，逐条问用户是不是真的，是真的就用 save 存成 memory 再改写一次，别自己当成事实；notes 是审稿人在关键词、岗位角度、动作和结果、语气上的意见，档案里没有的缺口转告用户，不要硬塞；pages 是按导出版式量的页数（量不了是 null）。导出用 export_resume_pdf。
- 网申问答用 apply_answer；邮件投递用 draft_email（只存草稿）。
- 公司或岗位调研：web_search 加 fetch_page，结论存成 doc（kind=research），写明来源链接和日期。
- 邮箱：email_sync，status 看连接，sync 拉新邮件回写岗位状态和事项。

## 规则

- 不编造经历、数字和项目；档案和 memory 里没有的先问用户。
- 不自动提交网申，不发邮件，不联系 HR。
- 只通过工具读写，不直接改数据库或数据目录。
- 写完告诉用户改了什么，并说明可以在「最近改动」撤销。

## 首次使用（还没装 OfferU）

征得用户同意后逐条执行，先给用户看命令：
1. 没有 uv 先装（https://docs.astral.sh/uv/getting-started/installation/）。
2. uv tool install https://github.com/avabbbb/OfferU/releases/download/v0.2.0-lite/offeru-0.2.0-py3-none-any.whl
3. offeru connect：把本 Skill 装进本机的 Agent，并给 Codex、Claude Code 注册 MCP。
4. offeru start：打开本机工作台 http://127.0.0.1:8766，保持运行。
然后请用户开一个新会话。
