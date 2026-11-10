---
name: statemachine-tailor-run-asks
description: 改按岗位改写简历（tailor.run、review_only、_running、pick_asks、doc.pending_asks、TailorBar 追问）前读。运行状态机和 pending_asks 生命周期、已知问题、怎么验证。
---

# tailor.run 和 doc.pending_asks

## 运行：idle / running（每份 doc 一个）

- 守卫：doc 不存在或不是 resume 报错（backend/app/core/tailor.py:297-299）；缺岗位、缺 JD 报错（301-306）；doc 在 _running 里报「这份简历正在改写」（308-310）；review_only 要求这个岗位已有定制简历（311-319）。
- idle -> running：_running.add（333）；running -> idle：finally discard（415-416），成功、超时、错误、取消都释放。
- 事件流：start -> delta…（只审稿没有 delta）-> review(round) -> done，或 error（335-414）。
- 只在 done 写一次库：{body, pending_asks}，一条改动（405）。起草超时/取消/出错不动简历；审稿某一轮出错或超时只停在那轮，done 照常保存已改的部分（377-386）。
- 触发：用户（TailorBar）或 Agent（tailor_resume 工具）。

## doc.pending_asks

- 值：null 或最多 3 项 {old, why, question}（tools.py:149-158；写入时校验在 tools.py:193-194）。MAX_ASKS=3 在 tailor.py:31。
- 写：tailor done，asks 只取第 1 轮审稿（tailor.py:387-388），再过 pick_asks（398）；只审稿写 null（405）。
- 清：前端 clearPending 存 null（frontend/src/components/resume/TailorBar.tsx:58），在「先不答」（121-125）和 storeAll 之后（153）。

## 不变式

- pick_asks：输出的 old 在终稿里正好出现一次、去重、保序、最多 MAX_ASKS，且通过 check_asks（tailor.py:199-208）。
- 运行结束 doc 不在 _running 里。
- review_only 不产生新的 pending_asks：只审稿保存时显式写 null（tailor.py:405）。

## 已知问题

1. tailor-run-asks#1 已修：只审稿重跑不再把第 1 轮 asks 写进 pending_asks。tailor.py:405 在 review_only 时写 None；测试 test_review_only_does_not_write_pending_asks（backend/tests/test_statemachine_models.py:204）通过，不再是 xfail。前端 reviewOnly 仍然丢弃 done.asks（TailorBar.tsx:90），只是双保险。
2. tailor-run-asks#2 TailorBar 显示用的 asks 来自模块级 results Map（TailorBar.tsx:25,39），不是 doc.pending_asks；刷新页面后持久化的追问不显示。目前没有任何组件读 doc.pending_asks，只有 clearPending 写 null（TailorBar.tsx:58）。
3. _running 是进程内 set（tailor.py:84），多进程或重启不共享。

## 验证

```
cd backend
.venv/Scripts/python.exe -m pytest tests/test_statemachine_models.py -q -k "tailor or pick_asks"
```

覆盖：运行守卫与释放、完整跑一遍写 pending_asks、只审稿不写 pending_asks、pick_asks 穷举（test_statemachine_models.py:183-231）。完整流程另见 tests/test_resume_tailor.py；前端 TailorBar.test.tsx、TailorBar.asks.test.tsx。
