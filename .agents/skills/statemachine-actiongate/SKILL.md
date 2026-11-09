---
name: statemachine-actiongate
description: 改外部 Agent（bridge、CLI）的写入确认、拒绝、撤销（services/action_gate.py、agent_actions 表）前读。状态机、已知竞态、怎么验证。
---

# agent_actions.status（旧 ops 路径）

状态：pending / done / failed / rejected / undone，另有 delivered 标志（backend/app/models.py:1071）。只包 app/ops.py 的 OPERATIONS，给外部 Agent 用；撤销走 change_capture.restore。

| 事件 | 谁触发 | 转移 | 代码 |
|---|---|---|---|
| 建动作 | 外部 Agent | 可逆写且有 run_id 或 cli 表面 -> done | services/action_gate.py:108-115 |
| 建动作 | 外部 Agent | needs_confirmation 或 approval_mode=ask -> pending | 86-101 |
| 建动作 | 外部 Agent | 可逆写、无 run_id、非 cli -> 不记录 | 106-107 |
| confirm | 用户（POST /api/agent/runtime/actions/{id}/confirm，仅桌面 main_agent.py:369） | pending -> done / failed | 152-161 |
| reject | 用户 | pending -> rejected | 164-169 |
| undo | 用户（web 也行，main_agent.py:400-406） | done -> undone | 186-193 |
| 送达 | Agent 下一轮 take_decisions_for_agent | delivered false -> true | 196-222 |

守卫：confirm/reject 要求 pending；undo 要求 done 且有 undo_json。_approved_before（62-67）让同参数的读操作免确认。

## 已知问题

1. actiongate#1 状态检查和执行不在一个事务（confirm 153-160，undo 187-193），没有 CAS：双击或并发 confirm 执行两次，双重 undo 恢复两次。
2. actiongate#2 不记录的可逆写没法撤销。
3. actiongate#3 _approved_before 让 LOCAL_FILE_READS 同参数永久免确认。
4. actiongate#4 failed 是终态，不能重试。
5. actiongate#5 内置 Agent 不走这里：core/agent.py:25-31 直接 tools.call，「不可逆要确认」对内置 Agent 不成立，只有事后撤销。

## 验证

还没有模型测试（异步 DB 会话）。修 #1 时用两个并发 confirm_action 证明只执行一次；撤销恢复另见 backend/tests/test_change_capture.py。
