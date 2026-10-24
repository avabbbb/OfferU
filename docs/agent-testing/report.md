# 一份真实简历，三种 Agent，十二个问题

OfferU Agent 测试复盘 · 2026-10-25 · 测试版本 `feat/core` @ `b9464a5`

## 一句话结论

共享工具层站住了，接缝没有。Codex 经 MCP 写进去的东西，CLI 读出来一条不差，撤销也干净；但这次碰到的三个高优先级问题，都是「失败了却不出声」。

- 工具层：MCP 与 CLI 一致（memory 15 / doc 1 / profile 1），撤销两次写入后正确回退，重复撤销被清楚拒绝。
- 内置 Agent：模型 key 失效返回 401，界面却说「Skill 自动路由无响应」。
- 外部 Agent：Codex 默认配置下所有工具调用被取消，任务 exit 0；打开工具批准后 204 秒完成建档。
- Hybrid：外部半边可用，自动交接和 Ctrl+K 自然语言入口都还没做。

## 我们在测什么

OfferU 的设计是「一套工具，多个 Agent」：

```
网页        内置 Agent        Codex / Claude Code
  │             │                    │
  └── HTTP ─────┴──── MCP / CLI ─────┘
                │
        11 个共享工具（overview … undo … export_resume_pdf）
                │
        SQLite + 「最近改动」（每次写入都可撤销）
```

小任务交给内置 Agent（最多约 6 步），大任务交给 Codex。这是 [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) 里的 routing：先分类，再交给最合适的执行者。

## 怎么测

用一份真实的 1 页中文 PDF 简历（约 2300 字），不用合成数据。合成简历太干净，测不出全角符号、两栏排版、数字和单位粘在一起这些真实情况。

三条规矩：

1. 每个 Agent 一份独立数据目录，互不污染。
2. 不信 Agent 自己的总结。每次跑完都用 CLI 回读数据库核对，对应 [Claude Agent SDK](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk) 里的 verify work。
3. 真实简历、数据库、日志不出本机；公开的截图全部换成虚构数据重拍。

| # | 场景 | 入口 | 耗时 | 结果 |
|---|---|---|---|---|
| T1 | overview / read_file | CLI | 0.5s | 通过 |
| T2 | 内置 Agent 建档 | HTTP | 5s | 失败：key 401，错误被改写 |
| T3a | Codex 建档 | MCP 默认 | 144s | 失败：工具调用全被取消 |
| T3b | Codex 建档 | MCP + approve | 204s | 通过：profile 1 / memory 15 / resume 1 |
| T3c | Claude Code 建档 | MCP | 4s | 环境阻断：未登录 |
| T4 | MCP 握手 | stdio | 1.4s | 通过，11 个工具 |
| T6 | 导出 PDF | CLI | 11s | 修依赖后通过；1 页变 2 页 |
| T7 | undo / 一致性 | CLI | 4.6s | 通过 |
| T8 | Hybrid 自动交接 | — | — | 未实现 |
| T9 | 网页 7 个页面 | Playwright | 约 1.6s/页 | 通过 |

## 发现一：最危险的失败是不出声的失败

一个 401，三层之后变成了另一句话。内置 Agent 5 秒内返回「Skill 自动路由无响应，请显式选择技能后重试」。服务端日志里写得很清楚：网关返回 401 Invalid API key。路由层把「模型没回答」和「模型拒绝认证」当成了一件事，用户会去重选技能，而不是去换 key。之前只验证了 key 能从系统钥匙串读出来，没有真的请求一次网关。修法：认证类错误原样透传到界面；设置页加「测试连接」。

Codex 说「我被拦住了」，进程却说「成功」。第一次后台跑 Codex，144 秒后 exit 0。只有读完它最后一段话才知道，每一次 OfferU 工具调用都因为「需要批准但批准策略为 never」被取消了，写入 0 条。这是上游已知行为：无人值守时没人点弹窗，就当作拒绝。对 hybrid 来说，这是卡脖子的问题：如果后台任务只看退出码，用户会看到「任务完成」却什么都没变。修法：`offeru connect` 写配置时自带 `default_tools_approval_mode = "approve"`；handoff 的成功判定改为「最近改动里多了条目」，而不是退出码。

缺一个包，到最后一步才报错。Codex 建完档、写完简历，导 PDF 时才收到 `No module named 'markdown_it'`。这个依赖在 requirements 里写着，只是环境切分支后没重装。Agent 做了 3 分钟的活，最后一步才知道做不完。修法：启动和 `overview` 时自检可选依赖，缺什么说什么。

三件事的共同点：错误在某一层被「整理」成了更温和、也更没用的话。[Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) 里说要把有意义的上下文返回给 Agent，错误信息本身就是最重要的上下文。

## 发现二：工具层这个赌注是对的

- 一致性：Codex 通过 MCP 写入后，CLI `list` 得到的条数与它自报的一致。网页「最近改动」也能看到并撤销。
- 撤销：撤掉简历和一条记忆后 doc 0 / memory 14；再撤一次返回「这条改动已经撤销过了」。「写入默认生效、靠撤销兜底」的策略成立。
- 工具少而合并：11 个通用工具（save 一个管五种记录），Codex 第一次就用对了。只在一个地方我自己调错了：`list` 需要 `type` 而不是 `kind`，报错很清楚，改一个字就好。

要改的小地方：同一次写入，`changes` 里 actor 是 codex-mcp-client，`undo` 里变成了 agent；导出的 PDF 不告诉 Agent 页数，所以它发现不了 1 页变 2 页。

## 发现三：多 Agent 的接缝在哪里

[How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) 里有一句很关键的话：需要共享上下文、强依赖的任务，不适合拆成多个 Agent。简历建档正是这种任务：读、拆、写、导出每一步都依赖上一步。所以 OfferU 的 hybrid 不应该是「一群 Agent 并行干活」，而是一次干净的交接：内置 Agent 判断任务大小，大任务整块交给 Codex，结果落在数据库里。

这次测试里，交接的外半边已经跑通：用 `run_codex.sh` 把任务交给 Codex，结果出现在网页「最近改动」里。还缺三样：

1. 内置 Agent 里「这是大任务」的判断和发起交接的工具（PR5）。
2. Ctrl+K 接上内置 Agent。现在输入「把星河科技改成已投递」只会得到「没有匹配的页面或操作」（PR3）。
3. 交接任务的状态和结果判定：按写入的改动条数判断，不按退出码。

[Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) 里的做法可以直接拿来用：交接物写在外部状态里，而不是写在对话里。OfferU 的「最近改动」就是这个外部状态。

## Skill 太长

原 `offeru` Skill 16.5 KB，设计目标是 4 KB。按 [Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) 的渐进式披露，这次先把「怎么跑起来」拆成独立的 `offeru-run`（2.6 KB），过程见 [tuning-log.md](tuning-log.md)。

## 对照 Anthropic 工程博客

| 原则 | 出处 | OfferU 现状 | 下一步 |
|---|---|---|---|
| 简单可组合的模式优先 | Building effective agents | 11 个工具 + routing，没有引入框架 | 保持 |
| 工具合并、返回有意义的上下文 | Writing tools for agents | 合并做到了；错误被改写、PDF 不回传页数 | 透传错误，导出返回页数 |
| 最小高信号上下文 | Context engineering | Skill 16.5 KB | 拆分 + 按需加载 |
| 强依赖任务别拆多 Agent | Multi-agent research | 建档是单线任务 | hybrid 做一次性交接 |
| 跨窗口状态放在外部 | Long-running harnesses | 「最近改动」可作交接物 | 用它判定交接成败 |
| gather → act → verify | Claude Agent SDK | 验证靠人工回读 | 给 Agent 一个 verify 步骤 |

## 面试复盘

如果把这次测试当成一道面试题来讲：

- 情境：一个让网页、内置 Agent、外部 coding agent 共享同一份数据的求职工作台，要在合并到 main 前用真实数据验证三条路径。
- 任务：用一份真实简历跑通建档到导出 PDF，记录问题，修复并复测，产出不含任何个人信息的文档。
- 行动：每个 Agent 独立数据目录；不信 Agent 自报，回读数据库核对；失败先查到根因（直接请求网关拿到真实 401，对照上游 issue 确认 Codex 批准行为）；截图全部用虚构数据重拍，提交前扫敏感词。
- 结果：10 组场景、十二个问题（高 6 / 中 2 / 低 4），Codex 建档从 0 条到 17 条写入，PDF 从报错到 11 秒导出。

可能被追问：

- 「为什么不直接信 Agent 的总结？」— 第一次 Codex 就是反例：exit 0，写入 0 条。Agent 的话是线索，数据库才是证据。
- 「为什么用真实简历，隐私怎么办？」— 真实数据只在本机跑；公开产物用虚构数据重拍；扫描脚本的私有关键词从本机档案生成，自己也不进仓库。
- 「为什么 hybrid 不做成多 Agent 并行？」— 建档是强依赖的单线任务，并行只会多花 token、多出冲突。交接一次，结果落库，可撤销。
- 「最大的教训？」— 只验证「key 读得到」不等于验证「key 能用」。测试前要先端到端打一个最小请求。
- 「如果重做？」— 先写好核对脚本再跑 Agent；一开始就让每个 Agent 各用一份数据目录；端口写死的问题先修，再并行测。

## 修复与复测

修复在测试分支 fix/agent-test-findings（基于 b9464a5），尚未提交、未合并。改了 4 个文件：entry.py、agents/llm.py、services/agent_skill_registry.py、mcp_server.py；git diff --check 与 py_compile 通过。

| # | 改了什么 | 怎么验证 | 结果 |
|---|---|---|---|
| 4 | chat_completion 失败时记下脱敏后的原因；路由层按 401 / 403 / 超时给出对应提示 | 用失效 key 重发 T2 | 5s 返回「模型 API key 无效或已过期（网关返回 401）…」，不再说「自动路由无响应」 |
| 5 | offeru connect 注册 MCP 时带上 OFFERU_DATA_DIR，并给 Codex 的 offeru 服务写入 default_tools_approval_mode = "approve"（幂等） | 对一份假的 Codex 配置连续调用两次 | 第一次写入、第二次不重复，原有配置保留；未在真实 Codex 上复测 |
| 7 | MCP 写入的 actor 可用 OFFERU_ACTOR 指定 | 仅代码审查 | 部分：undo 侧的 actor 未统一 |
| 11 | start 先读运行中实例的 data_root，不同就退出；健康检查 3s 重试一次；端口被占但不响应时也退出 | 8766 上跑一份数据，分别用同目录、不同目录、模拟健康检查无响应启动 | exit 0 复用 / exit 2 / exit 2；原实例健康检查保持 200 |

复测中的新发现：第一次同目录启动时，1 秒健康检查偶发超时，start 去绑已占用的端口，失败前还对同一份数据跑了启动流程（日志出现 SQLAlchemy 错误）。#11 的重试和端口检查就是为它补的。

仍然阻断或未做：

- 内置 Agent 端到端：真实网关 key 仍返回 401，修复只改善了提示，没有跑通。
- Claude Code：未登录，未复测。
- Hybrid 自动交接（PR5）与 Ctrl+K 自然语言入口（PR3）：未实现。
- #10 控制台乱码：未改代码，设 PYTHONIOENCODING=utf-8 可绕过。
- 测试环境：pytest 全量收集会撞上 app/scripts/test_semantic_search.py，因本机未装 qdrant_client 报错。这是测试环境依赖，不是本次改动的回归；相关模块没有专门的单元测试，以上验证都是定向脚本和接口复测。

## 问题清单

| # | 严重度 | 问题 | 状态 |
|---|---|---|---|
| 1 | 高 | 档案/简历/PDF（#137）与文档（#135）只在 feat/core，main 没有 | 待合并 |
| 2 | 中 | offeru Skill 16.5 KB，目标 4 KB | 部分：拆出 offeru-run |
| 3 | 低 | 端口写死 8766，无法并行跑两份数据 | 开放 |
| 4 | 高 | key 401 被说成「Skill 自动路由无响应」 | 已修复并复测（待合并） |
| 5 | 高 | Codex exec 默认配置下 MCP 调用全被取消，仍 exit 0 | 已修：connect 自动写 approve（未在真实 Codex 复测） |
| 6 | 高 | 导出 PDF 缺 markdown-it-py，无自检 | 环境已修；待自检 |
| 7 | 低 | 同一次写入，changes 与 undo 的 actor 不一致 | 部分：MCP 支持 OFFERU_ACTOR |
| 8 | 低 | 重写后简历 1 页变 2 页，导出不回传页数 | 开放 |
| 9 | 高 | Hybrid 自动交接未实现 | PR5 |
| 10 | 低 | Windows 控制台 --help 中文乱码 | 开放；PYTHONIOENCODING=utf-8 可绕过 |
| 11 | 中 | start 忽略数据目录差异，复用旧实例 | 已修复并复测（待合并） |
| 12 | 高 | Ctrl+K 不接自然语言 | PR3 |

备注：本机访问 `/api/tools` 不需要配对。如果这是有意信任 localhost，应在 SECURITY 里写明。

## 参考

- [Building effective agents (2024-12)](https://www.anthropic.com/engineering/building-effective-agents)
- [How we built our multi-agent research system (2025-06)](https://www.anthropic.com/engineering/multi-agent-research-system)
- [Writing effective tools for agents (2025-09)](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [Effective context engineering for AI agents (2025-09)](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Building agents with the Claude Agent SDK (2025-09)](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk)
- [Equipping agents for the real world with Agent Skills (2025-10)](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [Effective harnesses for long-running agents (2025-11)](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- openai/codex issue #24135、#29857（codex exec 下 MCP 批准）
