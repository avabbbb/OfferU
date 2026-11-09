---
name: statemachine-change-undo
description: 改 core store 的写入、改动合并、撤销（最近改动、Agent undo 工具）前读。changes 表 live/undone 状态机、不变式、已知问题、怎么验证。
---

# changes.undone_at

状态：live（undone_at 为空）/ undone。表结构 backend/app/core/store.py:28-30。

## 事件

| 事件 | 谁触发 | 转移 | 代码 |
|---|---|---|---|
| save / delete | 所有写入（用户、Agent、邮件、TailorBar、tailor） | 无 -> live | store.py:111-139,142-152 → _log 95-108 |
| 合并 | 同上 | 上一条 live 改动被续写（after 更新） | store.py:92-103：同 actor + summary + type + record，600 秒内 |
| undo | 用户（最近改动）、Agent（undo 工具 tools.py:420-421） | live -> undone，记录写回 before；before 为空就删记录 | store.py:172-196 |
| 再次 undo | 任何人 | 拒绝「这条改动已经撤销过了」 | store.py:179-180 |

## 不变式

- 每条改动最多撤销一次；undone 是终态，没有 redo。
- 新建记录不复用出现过的 id（store.py:125-127），撤销删除时按原 id 插回不会撞车。
- 不同 actor 的改动从不合并，所以 Agent 的写入不会混进用户的改动。

## 已知问题

1. change-undo#1 撤销旧改动直接写回 before，盖掉之后别人的改动（store.py:185-190）。ActionGate 有 undo_preview，core 没有。
2. change-undo#2 撤销「新建」直接删记录，之后的修改一起没了（store.py:183-184）。
3. 没有 redo。

## 验证

```
cd backend
.venv/Scripts/python.exe -m pytest tests/test_statemachine_models.py -q -k "undo or merge"
```

#1、#2 是 strict xfail。并发写入另见 tests/test_store_concurrency.py。
