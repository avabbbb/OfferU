# Skill / Agent 调优记录

按时间顺序记录每一次「改了什么 → 为什么 → 结果」。时间为 2026-10-25 北京时间。所有输入简历、数据库和 Agent 事件日志留在本机，不进仓库。

## 内置 Agent

| 轮次 | 改了什么 | 为什么 | 结果 |
|---|---|---|---|
| A1 | 用 `POST /api/agent/runtime/runs` 发「读简历 → 存档案 → 拆记忆」 | 最接近用户在网页里说的话 | 5s 返回「Skill 自动路由无响应」 |
| A2 | 翻服务端日志 | 界面信息和现象对不上 | 日志里是网关 401 Invalid API key |
| A3 | 直接请求网关 `/models` 和 `/chat/completions` | 排除 OfferU 自身 | 两个接口都 401；默认 UA 还会被 CDN 拦成 403，换 SDK 风格 UA 后才拿到真实状态码 |
| A4 | 不替用户换 key，记为阻断 | 用户在睡觉，不能替用户做凭证决定 | 内置 Agent 端到端未验证，用工具层确定性路径验证非 LLM 部分 |

教训：「key 读得到」不等于「key 能用」。以后测试前先做一次最小的端到端请求。

## 外部 Agent：Codex

| 轮次 | 改了什么 | 为什么 | 结果 |
|---|---|---|---|
| C0 | 先用 stdio 手发 `initialize` + `tools/list` | 确认 MCP 服务本身没问题，再把 Agent 接上来 | 1.4s，11 个工具 |
| C1 | `codex exec` + `-c mcp_servers.offeru.*`，不改全局配置 | 不碰用户自己的 Codex 配置 | 144s exit 0，但工具调用全部被取消，写入 0 条；用户全局配置里另一个 MCP 认证失败，刷了一堆错误 |
| C2 | 加 `default_tools_approval_mode="approve"` 和 `--ignore-user-config`；每个 Agent 一份数据拷贝 | 无人值守时没人点批准；隔离全局配置噪声；避免并行写同一个库 | 204s，0 次取消，profile 1 / memory 15 / resume 1 |
| C3 | 导出失败后只装缺的 `markdown-it-py`，用 CLI 重导 | requirements 里已声明，是环境漂移 | 11s，2 页，中文正常 |

Prompt 调优：两轮用的是同一份 prompt。C1 里 Codex 坦白「读技能说明时用了非 OfferU 的只读命令」，说明「只用 OfferU 工具」这种约束对它是软约束。真正的边界要靠沙箱（`-s workspace-write` + 独立工作目录），不靠措辞。prompt 里最有用的一句是「最后告诉我存了哪些记录（类型和数量）、PDF 路径、哪一步不顺」：它把 Agent 的总结变成了可核对的数字。

推理强度：用 `model_reasoning_effort="medium"`。建档是抽取 + 写入，不需要长推理；204s 里大部分是工具往返。

## Claude Code

| 轮次 | 改了什么 | 结果 |
|---|---|---|
| L1 | `claude -p --strict-mcp-config --allowedTools 'mcp__offeru__*'` | 4s，未登录；不替用户登录，留给用户醒来后复测 |

## Skill

现状：`.agents/skills/offeru/SKILL.md` 16566 字节，设计目标 ≤ 4 KB。一个 Skill 同时在讲「怎么跑」和「怎么写简历」，Agent 每次都要把两件事一起读进上下文。

做法（按渐进式披露）：

1. 把运行、连接、核对、隐私红线拆成 `offeru-run`，2577 字节。内容全部来自这次实测踩到的坑：切分支重装依赖、先停旧实例、Codex 批准模式、跑完必须回读。
2. `offeru` 本身下一步只留「何时用哪个工具、写入规则、何时要确认」，简历写法和模板细节移到 `skills/` 子目录，按需读取。
3. 验收标准：用同一份 prompt 重跑 C2，记录条数、耗时和工具调用数，不能比现在差。

## 录屏与截图

| 轮次 | 做法 | 结果 |
|---|---|---|
| M1 | `scripts/seed_demo.py` 写虚构数据到新数据目录 | 6s，档案 1 / 记忆 7 / 岗位 3 / 事项 2 / 简历 1，PDF 导出成功 |
| M2 | 换数据目录重启，却看到旧数据 | start 发现 8766 已有实例就直接退出（问题 #11）；停掉旧实例后正常 |
| M3 | `scripts/capture.py`：Playwright 用一次性配对链接登录，逐页截图 + 录屏 | 7 页，每页约 1.6s；ffmpeg 转 GIF（1.4 MB）和 MP4（418 KB） |
| M4 | 逐张看图，确认没有真实姓名、电话、邮箱 | 通过；`scripts/pii_scan.sh` 再扫一遍 diff |
