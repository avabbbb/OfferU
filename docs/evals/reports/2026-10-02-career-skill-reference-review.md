# 阿酥与其他 Skill 仓库：原始文件核对及 OfferU 验收映射

日期：2026-10-02。状态：**PUBLIC SOURCE REVIEW / NOT INSTALLED / NOT RUNTIME ACCEPTED**。

用户纠正了名称：**阿酥 Skill**，不是“阿苏”。通过公开网络检索找到 [Hisn00w/ASu-skills](https://github.com/Hisn00w/ASu-skills)，其求职 Skill 集合与用户描述高度吻合。另有 [Claycui828/ASu-resume-skills](https://github.com/Claycui828/ASu-resume-skills)，是不同仓库，应分别记录，不能混称同一项目。

本次实际读取下列原始 README、registry、SKILL.md 和 references。未安装、未执行竞品，也未读取任何候选人真实履历；网页文件为当前 main 快照，正式移植前应绑定具体 commit。聚合站只用于发现仓库，不作为技术结论依据。

## 1. ASu-skills 是一组功能 Skill

当前 [README](https://raw.githubusercontent.com/Hisn00w/ASu-skills/main/README.md) 和 [skills.registry.json](https://raw.githubusercontent.com/Hisn00w/ASu-skills/main/skills.registry.json) 列出九个入口：`contributor`、`evidence-recap`、`project-guide`、`great-resume`、`make-resume`、`job-match`、`job-apply`、`interview`、`offer`。registry 是入口单一事实源，文档/插件投影通过同步生成。

检索索引仍可找到旧 `/asu`、`/asu-resume` 名称，但对应 main 路径本次返回 404；当前流程以 `great-resume` 和 `make-resume` 为准。不能照抄旧目录数量、名字或安装示例。这里核对的是仓库声明，宿主安装支持仍需本机验证。

## 2. 将方法变成 OfferU 可验证行为

| 原始文件 | 本次确认的方法 | 对 OfferU 的验收要求 |
| --- | --- | --- |
| [evidence-recap](https://raw.githubusercontent.com/Hisn00w/ASu-skills/main/skills/evidence-recap/SKILL.md) | 从 AI 对话/交付记录区分决策、个人动作、交付状态、效果与边界 | 授权 Agent memory 后提取可追溯职业候选；必须区分本人、AI、团队动作及原型/上线，不能把助手声称成功写成个人成果 |
| [great-resume](https://raw.githubusercontent.com/Hisn00w/ASu-skills/main/skills/great-resume/SKILL.md) | 用事实、个人边界与证据审计改写，表达与事实分开 | Profile 保留原事实，岗位简历保存候选表达；定位取舍经 Ask，材料缺失形成补证清单 |
| [claim-evidence-ledger](https://raw.githubusercontent.com/Hisn00w/ASu-skills/main/skills/great-resume/references/claim-evidence-ledger.md) | 跨 Skill 保留来源、职责、确认状态、适用范围及可追问细节 | 使用现有 Career Evidence/Proposal/版本映射这条链，不新建另一份 Career Truth；失效、冲突、不采用内容不复活到最终材料 |
| [job-match](https://raw.githubusercontent.com/Hisn00w/ASu-skills/main/skills/job-match/SKILL.md) | 区分已匹配、表达缺口、证据不足、真实缺口和待确认，硬门槛单列 | 评分/排序必须能展开对应证据；缺一个词不等于缺能力，信息未知不等于不胜任；不制造匹配百分比 |
| [interview](https://raw.githubusercontent.com/Hisn00w/ASu-skills/main/skills/interview/SKILL.md) | 从简历/JD 主张生成问题，约定轮次和反馈，一次一问，以真实回答判断 | 追问本人职责、技术作用、数字口径及失败路径；保存问题、实际回答、依据和未覆盖范围，不提前替用户补经历 |
| [review-and-retry](https://raw.githubusercontent.com/Hisn00w/ASu-skills/main/skills/interview/references/review-and-retry.md) | 按证据复盘，用变体/故障/反事实复练，并比较新增证据 | 复盘→审核学习→下一次准备/复练可见关联；仅背出上次建议不算解决弱点，模拟掌握度不直接改写职业事实 |
| [job-apply](https://raw.githubusercontent.com/Hisn00w/ASu-skills/main/skills/job-apply/SKILL.md) | 浏览器就绪检查、字段—来源映射、填写后回读、验证码接管与提交闸门 | 分开验收连接、授权、填写、上传、提交、receipt；当前 OfferU 缺 connector 时报告缺口，不能用外部 Skill 绕开 Registry |
| [offer](https://raw.githubusercontent.com/Hisn00w/ASu-skills/main/skills/offer/SKILL.md) | 从招聘信号整理状态、来源与下一步；自动回执不是面试/Offer | 邮箱/BOSS 信息先形成关联候选，确认后进同一 Application/Timeline，不创建独立 tracker 状态 |

ASu 的浏览器协作说明包含用户当前浏览器的扩展/daemon。它不是“装 Playwright 后就自动拥有账号”。OfferU 自动验收继续遵守 managed Chromium、headless、隔离 profile；用户主动账号授权与产品 connector 路线必须单独验证，不照搬竞品自动打开现有 Chrome/Edge。

## 3. 同名风格项目与 Skill 生态参考

| 仓库 | 本次原始资料 | 参考用途 |
| --- | --- | --- |
| [Claycui828/ASu-resume-skills](https://github.com/Claycui828/ASu-resume-skills) | [asu-resume-skill](https://raw.githubusercontent.com/Claycui828/ASu-resume-skills/main/skills/asu-resume-skill/SKILL.md) | 每条表达的 source_note、来源性质、职责作用域及 HTML/PDF 校验；其展示型高密度风格只作用户可选参考，不替换本人原风格 |
| [career-ops-hq/career-ops](https://github.com/career-ops-hq/career-ops) | 前一轮已读 router、interview、master-profile、interview/debrief，见 [能力审计](./2026-10-02-owner-journey-capability-audit.md) | 渐进访谈、真实来源、逐题真实面试复盘和下轮准备；与同名 poferraz 项目分开 |
| [JimLiu/baoyu-skills](https://github.com/JimLiu/baoyu-skills) | [README](https://raw.githubusercontent.com/JimLiu/baoyu-skills/main/README.md) 的安装、按需选择、更新和插件组织部分 | 同一仓库管理多个 Skill，按实际需要启用与更新；只借鉴分发结构，不把它的 Node 前提带入 OfferU 普通用户安装 |

此前口述“JOme”经逐字和拼写变体检索仍未定位到唯一项目。JimLiu/baoyu-skills 是主动检索到的技能集合参考，**不认定它就是用户所指的 JOme**；这个名称歧义不阻塞其他已找到项目的研究。

## 4. 已写入两个 Goal 的补充断言

1. 同一条真实经历在 Profile、岗位简历、申请字段与面试题中能回指同一证据；改变的是表述，原事实不被覆写。
2. 授权 memory/工作记录导入必须显示本人、Agent、团队动作及交付阶段，不能“读到 memory 就算已验证”。
3. 岗位匹配区分表达、证据和真实能力缺口，硬条件单列；用户看得懂排序为何变化。
4. 上次 weak claim 在本次变体题复练中留下前后回答与新增证据，未覆盖不评为失败，背答案不评为通过。
5. 网页字段有来源映射和填写后回读，缺工具/未连接就绪、用户验证、最终提交与状态登记分别判定。

这些是新增验收断言，不是功能已实现声明。此次改动只更新引用、产品要求与测试任务；没有安装其他 Skill、启动浏览器、发送申请或修改真实数据。
