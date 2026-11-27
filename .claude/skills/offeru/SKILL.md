---
name: offeru
description: OfferU 本机求职工作台：岗位、简历、档案、日程、网申和邮件草稿都存在用户电脑上。用户谈求职、实习、JD、简历、网申、笔试面试、offer 时用。
version: 2026-11-26
---

# OfferU

工作台、内置助手和命令行用的是同一张工具表。外置 Agent 只走命令行，不用注册 MCP。写入直接生效，用户可在「最近改动」撤销，不用先问。对外的事（网申、邮件、联系 HR）只写草稿，发出去永远要用户本人确认。

## 调用

全部走命令行，输出 JSON：

- `<offeru> tool`：工具清单，每个一行（`--json` 给机器读的版本）。开场先看一次，不用背。
- `<offeru> tool <名字> [<名字>…] --help`：完整说明和参数 schema。参数不确定时先查，只查要用的。
- `<offeru> recipe <id>`：常用流程（调研、证据对照、改简历、面试准备）该按什么顺序调哪些工具。
- `<offeru> tool overview`、`<offeru> tool get '{"type":"job","id":3}'`：调用。参数含中文或在 PowerShell 里，先写成 UTF-8 的 JSON 文件，再 `<offeru> tool save @args.json`（或 `-` 走标准输入）。
- 输出是 JSON，可以接 `jq` 或写文件；失败时打印 `{"error": …, "code": …}` 并以 1 退出。code 是固定的英文错误类型（参数不对、找不到、有冲突、只能用户本人做、这个环境做不了、缺配置、外部服务出错），按它决定改参数、先查 id、照实告诉用户还是稍后重试一次。命令不通看文末。
- 会调模型的工具（evaluate_jobs、tailor_resume、split_resume、apply_answer 等）用工作台「设置 → 模型」里存的模型。没配模型时不报错，而是返回 `{"handoff": {how, pending}}`：你就是模型。按每条 pending 的 messages 自己作答（json=true 只回严格 JSON），把 `{"<id>": "<回答>"}` 累积进 answers.json，同样的命令加 `--answers @answers.json` 再跑，直到返回正常结果（可能要两三轮）。不要自己找 key。

## 连接网页版数据

- **本机直连网页版（无需 S3 / R2）**：运行 `<offeru> start --web` 会在本机 127.0.0.1:8766 启动伴侣并打开 `https://offeru.avabbbb.com/#/pair/<配对码>`；配对后网页版与命令行直接共享同一份本机数据库，改动实时同步，本机 Agent 看板也会在网页版里生效。
- **通过 S3 / R2 同步连接网页版数据（纯浏览器 / 跨设备）**：用户用的是纯网页版（https://offeru.avabbbb.com，数据在用户浏览器里）时，本机命令行看不到那份数据；`<offeru> start` 起的是另一份空数据，不要拿它当数据源。桥是用户自己的 S3 / R2 存储桶上的端到端加密同步。用户只需要做登录 / 两步验证和输入口令，其余由你做：

1. 存储桶：没有就自己操作浏览器在 Cloudflare 建 R2 存储桶和只限这个桶的「Object Read & Write」令牌，并加 CORS（来源填网页版地址，方法 GET / PUT / HEAD / DELETE，暴露 ETag，请求头见仓库 docs/sync.md）。只在登录、验证码、两步验证时请用户动手。
2. 生成至少 20 位的随机同步口令，只告诉用户一次，请他记好（丢了数据就解不开）。`<offeru> sync configure --endpoint <Endpoint> --bucket <桶> --region auto --access-key-id <ID> --path-style`，Secret 和口令放环境变量 `OFFERU_SYNC_SECRET_ACCESS_KEY`、`OFFERU_SYNC_PASSPHRASE`（或标准输入传 JSON：`<offeru> sync configure -`），不要写进命令行参数或文件。用户已经在网页版设置里开了同步时，用同一个桶、前缀和口令。
3. `<offeru> sync pair`（网页版不在默认地址时加 `--web-origin <地址>`）：把输出的链接原样发给用户，30 分钟有效，过期重跑。用户打开链接、输入口令，网页版就连上并先同步一次。
4. 用户说连好后：`<offeru> sync now`，再 `<offeru> tool overview` 确认读到的是网页版的数据。
5. 之后开工前先 `<offeru> sync now`，每次改动数据之后再跑一次 `<offeru> sync now`，网页版打开或切回页面时就能看到。`<offeru> sync` 看状态（是否设置、待推送条数、上次结果）。

`<offeru>` 是装好的 `offeru` 命令；从源码运行时是 `npm --prefix <仓库>/backend-ts run --silent cli --`。

## 数据

profile 档案；memory 职业记忆（一条一件事）；job 岗位；event 截止、笔试、面试；doc 文档（kind：resume、evaluation、research、apply_chat、email、review、note）。

## 主线：岗位收集到投递

1. 开场 overview。查经历和用户说过的话用 search；list 列表，get 看全文；save、delete 写删；改错用 changes + undo；记忆前后对不上用 reconcile_memory（只读，用户在档案页采纳）。
2. 旧简历：find_files → read_file → split_resume。
3. 用户贴链接、JD 或「公司 岗位」：add_job；贴的是文字又知道出处，把出处链接传 source_url（只记录不抓取）。抓不到（要登录、在图片里）就让用户贴正文或用插件存，不存空壳。add_job 会自动打标签（招聘类型、城市、方向、公司属性），用户要加或去标签就 save 改 tags。
4. 存完马上 evaluate_jobs：分数、三句理由、打招呼语。打招呼语里每个事实都要在档案里找得到。
5. 改简历：tailor_resume。asks 逐句问用户；用户确认的回答 save 成 memory（带原话和日期），再 review_only=true 改一次。导出 export_resume_pdf。
6. 网申 apply_answer；邮件 draft_email。用户在桌面版「设置 → 邮箱」用授权码连了邮箱时：
   - 读邀约：`mail` 的 list（最近几天或上次的 cursor 之后，query 按公司或「笔试 面试」筛）、read（正文和链接）。没连邮箱就让用户把回执或邀约邮件贴进来。
   - 回写看板：按公司 search 找到岗位，save 改 status（applied / test / interview，只前进），再 save 一条 event（kind=test / interview，at 写时间，url 写笔试或面试链接，job_id 挂岗位）；改期就改已有事项。
   - 存草稿：`mail` 的 draft（doc_id 给 draft_email 写好的文档，或直接给 to / subject / body）存进邮箱草稿箱。
   - 发送：`mail` 的 send 不会替你发出，只会返回待确认；告诉用户去岗位详情「投递邮件」卡片核对后点「确认发送」。不要说「已发送」。

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

先征得用户同意，给用户看命令再执行。OfferU 现在是 TypeScript（Node）运行时，需要 Node 22.19 以上；旧的 Python 安装包已停用，不要再装。

1. 已经装了 OfferU 桌面版或 lite 包（有 `offeru` 命令）：跳到第 3 步。
2. 从源码装（目前唯一可用的命令行安装方式）：
   - `git clone https://github.com/avabbbb/OfferU.git`，进入仓库目录；
   - `npm --prefix backend-ts install` 和 `npm --prefix frontend install`；
   - `npm --prefix frontend run build`（打包工作台页面）。
   发布了 `v*-lite` 版本后也可以 `npm install -g <Release 里的 offeru-lite-*.tgz 链接>`，得到 `offeru` 命令。
3. 启动工作台：`<offeru> start`（http://127.0.0.1:8766，保持运行，首次会打开一个配对链接）。`<offeru> doctor` 检查数据库和工具表。
4. 接入 Agent：在工作台「设置 → 我的 Agent」（Agent 看板）点「连接」，会把这份 SKILL.md 装进对应 Agent 的 Skill 目录，命令里带好 `--data-dir` 和 `--actor`；也可以手动复制 `backend-ts/skill/SKILL.md`，把 `<offeru>` 换成本机命令。然后开新会话，跑一次 `<offeru> tool overview` 确认能读到数据。
