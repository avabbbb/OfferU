---
name: statemachine-agent-run
description: 改 Agent Run 生命周期（services/agent_run_state.py、续跑、启动恢复、bridge run.finish、AgentPanel 停放标签）前读。状态机、守卫、已知问题、怎么验证。
---

# Agent Run

状态：活跃 created / planning / executing / interrupted；终态 completed / cancelled / failed（backend/app/services/agent_run_state.py:25-26）。created 只是列默认值和 _clean_run 兜底（backend/app/models/models.py:1021；agent_run_state.py:101），创建路径都显式写 planning 或 executing（262）。

| 事件 | 谁触发 | 转移 | 代码 |
|---|---|---|---|
| 创建 | 用户发消息、外部 Agent | 无 -> planning（没有计划步骤）/ executing（有计划步骤） | agent_run_state.py:240-331，状态在 262 |
| 开跑 | 内置 Agent host | planning -> executing | embedded_agent_host.py:372-373 |
| 启动恢复 | 启动时后台 | planning / executing -> interrupted | agent_run_state.py:507-557，写状态 539；只扫 515 |
| SSE 断开 | 前端关页面、网络断 | 非终态 -> interrupted | routes/main_agent.py:979-999 |
| 用户取消 | 用户（abort 路由） | 非终态 -> cancelled | routes/main_agent.py:1072-1076 → embedded_agent_host.py:899-944 |
| 续跑 | 用户 | 只允许 interrupted -> 执行；回答提问触发的续跑（continuation=True）还允许 completed / failed | embedded_agent_host.py:195-206；路由 main_agent.py:1008-1030；Replay provider 守卫 agent_runtime.py:414-415 |
| run.finish | 外部 Agent（bridge） | -> completed / failed / cancelled，取自外部 payload | agent_bridge/server.py:537-561；合法值 protocol.py:245-247 |

守卫：save 对 status、steps、event_sequence 做 CAS（agent_run_state.py:388-392），冲突重试 3 次后报「changed concurrently」（340, 413-415）。recover 只改 planning / executing，不碰终态（515）。

## 不变式

- 终态不会被启动恢复改动；但 save_agent_run 本身没有状态白名单，不拦终态覆盖（331-416）。
- event_sequence 单调递增；并发追加用原子 UPDATE 分配序号（agent_run_state.py:560-578），有测试 test_agent_run_event_sequence.py。
- 一个 Run 同时最多一个待答提问（agent_run_state.py:793-821）；终态 Run 不能再提问（789-792）。
- 内置 Agent 运行中的写入直接进 core store（live，可撤销），不经过 ActionGate（core/agent.py:29-33）。
- waiting_input 不是后端状态：前端停放条在 runNeedsUser（已中断 Run 或待答问题数 > 0）时写这个本地标签（AgentPanel.tsx:87-90,282,396-409）。
- Agent 提问后本轮结束：Run status=completed、final_result.terminal_state=waiting_user、requires_input=true（embedded_agent_host.py:592-622），不是 executing。

## 已知问题

1. agent-run#1 已澄清，不是缺写入方：前端 PARKED_RUN_LABELS 的 waiting_input 是「等你回答」的停放标签，只写进本地 state（frontend/src/components/workbench/AgentPanel.tsx:87-90，parkActiveRun 396-409，条件 runNeedsUser 在 282）；后端没有这个 status。等 Ask 时后端是 completed + terminal_state=waiting_user（embedded_agent_host.py:592-622），问题本身在 agent_input_requests.status=pending（agent_run_state.py:793-821）。
2. agent-run#2 run.finish 的终态取自外部 payload：合法值由 protocol.RunFinishPayload 的 Literal 限制（agent_bridge/protocol.py:245-247），但 server._finish 537-561 不校验当前状态，可以对已完成 / 已取消的 Run 再 finish 一次；save_agent_run 也不拦终态改写（agent_run_state.py:331-416）。
3. 续跑规则有两份：embedded 的守卫在 embedded_agent_host.py:195-206，Replay provider 在 agent_runtime.py:414-415，改规则要一起改。

## 验证

```
cd backend
.venv/Scripts/python.exe -m pytest tests/test_agent_run_event_sequence.py -q
```

只覆盖事件序号（并发追加、Run 不存在）。生命周期本身没有模型测试；backend/tests/test_terminal_state.py 测的是回复正文（_dangling_reference），和 Run 状态机无关，别当成覆盖。
