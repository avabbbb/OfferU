---
name: statemachine-tailor-run-asks
description: 改按岗位改写简历（tailor.run、review_only、_running、pick_asks、doc.pending_asks、TailorBar 追问）前读。运行状态机和 pending_asks 生命周期、已知问题、怎么验证。
---

# tailor.run 和 doc.pending_asks

## 运行：idle / running（每份 doc 一个）

- 守卫：缺岗位、缺 JD 报错（backend/app/core/tailor.py:279-285）；doc 在 _running 里报「这份简历正在改写」（286-288）；review_only 要求岗位已有定制简历（289-294）。
- idle -> running：_running.add（311）；running -> idle：finally discard（391-392），成功、超时、错误、取消都释放。
- 事件流：start -> delta…（只审稿没有 delta）-> review(round) -> done，或 error（268-390）。
- 只在 done 写一次库：{body, pending_asks: pick_asks(asks)}，一条改动（376-381）。超时、取消、错误不动简历。
- 触发：用户（TailorBar）或 Agent（tailor_resume 工具）。

## doc.pending_asks

- 值：null 或最多 3 项 {old, why, question}（tools.py:149-158,191-192；tailor.py:31,177-186）。
- 写：tailor done，asks 只取第 1 轮审稿（tailor.py:365-366）。
- 清：前端 clearPending 存 null（frontend/src/components/resume/TailorBar.tsx:58），在「先不答」（121-125）和 storeAll 之后（153）。

## 不变式

- pick_asks：输出的 old 在终稿里正好出现一次、去重、保序、最多 MAX_ASKS，且通过 check_asks。
- 运行结束 doc 不在 _running 里。

## 已知问题

1. tailor-run-asks#1 只审稿重跑仍把第 1 轮 asks 写进 pending_asks（tailor.py:366,376,381），前端 reviewOnly 时丢掉（TailorBar.tsx:90），doc 上留着 UI 看不见也不清的追问。
2. tailor-run-asks#2 TailorBar 的 asks 来自模块级 results Map（TailorBar.tsx:22-25,39），不是 doc.pending_asks；刷新页面后持久化的追问不显示（未确认是否有别的组件读它）。
3. _running 是进程内 set，多进程或重启不共享。

## 验证

```
cd backend
.venv/Scripts/python.exe -m pytest tests/test_statemachine_models.py -q -k "tailor or pick_asks"
```

#1 是 strict xfail。完整流程另见 tests/test_resume_tailor.py；前端 TailorBar.test.tsx、TailorBar.asks.test.tsx。
