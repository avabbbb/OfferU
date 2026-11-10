---
name: statemachine-change-undo
description: 改 core store 的写入、改动合并、撤销（最近改动、Agent undo 工具）前读。changes 表 live/undone 状态机、不变式、已知问题、怎么验证。
---

# changes.undone_at

状态：live（undone_at 为空）/ undone。表结构 backend/app/core/store.py:28-30。

## 事件

| 事件 | 谁触发 | 转移 | 代码 |
|---|---|---|---|
| save / delete | 所有写入（用户、Agent、邮件、TailorBar、tailor） | 无 -> live | store.save 111-139、store.delete 142-152 → _log 95-108 |
| 合并 | 同上 | 上一条 live 改动被续写（after 更新） | store.py:92,99-103：同 actor + summary + type + record，600 秒内 |
| undo | 用户（最近改动）、Agent（undo 工具） | live -> undone，记录写回 before；before 为空就删记录 | store.undo 172-200；tools.undo 456-457 |
| 再次 undo | 任何人 | 拒绝「这条改动已经撤销过了」 | store.py:179-180 |
| undo 一条被后改过的改动 | 任何人 | 拒绝「这条记录在这次改动之后又被改过…」 | store.py:183-185 |

## 不变式

- 每条改动最多撤销一次；undone 是终态，没有 redo。
- 撤销必须从新到旧：撤销时比对当前记录和这条改动的 after，不一致就拒绝，要求先撤销更新的那条（store.py:183-185）。所以按时间正序批量撤销会被拦。
- 新建记录不复用出现过的 id（store.py:124-127），撤销删除时按原 id 插回不会撞车。
- 不同 actor 的改动从不合并，所以 Agent 的写入不会混进用户的改动。
- 撤销写回是整条记录覆盖（before 整份 JSON），不是字段级合并（store.py:186-197）；撤销「新建」仍然删记录（store.py:187-188）。

## 已知问题

1. change-undo#1 已修：撤销旧改动不再盖掉之后的改动。store.undo 先比对 current 和 after，不一致报错（store.py:183-185）；测试 test_undo_keeps_later_edits（backend/tests/test_statemachine_models.py:130），不再是 strict xfail。
2. change-undo#2 已修：撤销「新建」不会连带删掉之后的修改。同一条比对拦住了「记录已被改过」的情况（store.py:183-188）；测试 test_undo_create_keeps_record_updated_later（test_statemachine_models.py:139）。
3. 没有 redo。
4. 合并窗口内同 actor + 同 summary 的连续编辑只留一条改动（store.py:99-103），想单独撤其中一次编辑做不到，只能撤到这条改动之前。
5. ActionGate 那条撤销有 undo_preview 和「改完之后又被改过」提示（services/action_gate.py:172-183），core 这边只有报错文案。

## 验证

```
cd backend
.venv/Scripts/python.exe -m pytest tests/test_statemachine_models.py -q -k "undo or merge"
```

#1、#2 现在是普通测试（test_statemachine_models.py:130,139）。并发写入另见 tests/test_store_concurrency.py。
