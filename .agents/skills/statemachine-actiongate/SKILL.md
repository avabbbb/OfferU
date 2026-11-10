---
name: statemachine-actiongate
description: 改外部 Agent（bridge、CLI）的写入确认、拒绝、撤销（services/action_gate.py、agent_actions 表）前读。状态机、已知竞态、怎么验证。
---

# agent_actions.status（旧 ops 路径）

状态：pending / done / failed / rejected / undone，另有 delivered 标志（backend/app/models/models.py:1068-1086，状态说明在 1071）。只包 backend/app/ops.py:1898 的 OPERATIONS，给外部 Agent（bridge / CLI）用；撤销走 change_capture.restore（action_gate.py:25,186-194）。

| 事件 | 谁触发 | 转移 | 代码 |
|---|---|---|---|
| 建动作 | 外部 Agent | 变更操作、有 run_id 或 cli 表面 -> done（有可撤销改动才带 undo_json，lossy 时标 not_undoable） | services/action_gate.py:104-116 |
| 建动作 | 外部 Agent | 不可逆（needs_confirmation）或 approval_mode=ask -> pending | 84-102，pending 行在 93-94 |
| 建动作 | 外部 Agent | 读操作，或无 run_id 且非 cli -> 不记录 | 106-107 |
| confirm | 用户（POST /api/agent/runtime/actions/{id}/confirm，仅桌面） | pending -> done / failed | confirm_action 152-161；路由 routes/main_agent.py:368-376 |
| reject | 用户（仅桌面） | pending -> rejected | reject_action 164-169；路由 379-386 |
| undo 预览 | 用户 | 只读：报告目标在 Agent 写完之后有没有被改过 | undo_preview 172-183；路由 390-397 |
| undo | 用户（桌面和 web 都行） | done -> undone | undo_action 186-194；路由 400-408 |
| 送达 | Agent 下一轮 take_decisions_for_agent | delivered false -> true | 196-223 |

守卫：confirm / reject 要求 pending（155,167）；undo 要求 done 且有 undo_json（189）；_approved_before（62-67）让同参数的本地读免确认。不可逆的判定在 services/operation_tiers.py:116-121（tier=confirm、工作区外的文件读、带状态字段的操作）。

## 已知问题

1. actiongate#1 状态检查和执行不在一个事务（confirm 152-161，undo 186-194），没有 CAS：双击或并发 confirm 会执行两次，双重 undo 恢复两次。
2. actiongate#2 不记录的可逆写（无 run_id 且非 cli）没法撤销（106-107）。
3. actiongate#3 _approved_before（62-67）让同一参数的 LOCAL_FILE_READS 永久免确认：只看有没有同参数的 done 行，不看 run、不看时限。
4. actiongate#4 failed 是终态，不能重试（confirm / reject 都要求 pending）。
5. actiongate#5 内置 Agent 不走这里：core/agent.py:29-33 直接 tools.call，「不可逆要确认」对内置 Agent 不成立，只有事后撤销。
6. actiongate#6 undo_action 不拦「Agent 改完之后又被改过」：undo_preview 只是提示（172-183），已确认操作的撤销照样覆盖后续修改；core store.undo 已经改成拒绝（store.py:183-185），两边不一致。

## 验证

还没有模型测试（异步 DB 会话）。修 #1 时用两个并发 confirm_action 证明只执行一次；撤销恢复另见 backend/tests/test_change_capture.py：

```
cd backend
.venv/Scripts/python.exe -m pytest tests/test_change_capture.py -q
```
