---
name: statemachine-agent-run
description: 改 Agent Run 生命周期（services/agent_run_state.py、续跑、启动恢复、bridge run.finish、AgentPanel 停放标签）前读。状态机、守卫、已知问题、怎么验证。
---

# Agent Run

状态：活跃 created / planning / executing / interrupted；终态 completed / cancelled / failed（backend/app/services/agent_run_state.py:25-26）。

| 事件 | 谁触发 | 转移 | 代码 |
|---|---|---|---|
| 创建 | 用户发消息、外部 Agent | 无 -> planning / executing | agent_run_state.py:262 |
| 启动恢复 | 启动时后台 | 活跃 -> interrupted | agent_run_state.py:539 |
| 强制中断 | main_agent | -> interrupted | routes/main_agent.py:991-995 |
| 续跑 | 用户 | 只允许 interrupted -> 活跃 | services/agent_runtime.py:414-415 |
| run.finish | 外部 Agent（bridge） | -> completed / failed / cancelled，取自外部 payload | agent_bridge/server.py:539-553；protocol.py:246 |

守卫：save 对 status、steps、event_sequence 做 CAS（agent_run_state.py:388-392）。

## 不变式

- 终态不再变；只有 interrupted 能续跑。
- event_sequence 单调递增。
- 内置 Agent 运行中的写入直接进 core store（live，可撤销），不经过 ActionGate。

## 已知问题

1. agent-run#1 前端 PARKED_RUN_LABELS 有 waiting_input（frontend/src/components/AgentPanel.tsx:87-90），后端状态集合没有，要么不可达要么有没找到的写入方。
2. agent-run#2 run.finish 的终态完全信外部 payload。

## 验证

```
cd backend
.venv/Scripts/python.exe -m pytest tests/test_agent_run_event_sequence.py tests/test_terminal_state.py -q
```
