---
name: statemachine-impact-asks
description: 改改写后的追问成果流程（回答 -> 整理成记忆草稿 -> 存进档案 -> 用新成果再改）前读。前端隐式状态机、已知问题、怎么验证。
---

# 追问成果（前端拥有）

状态藏在 TailorBar 的 useState 里：asks、answers、drafts、dropped、busy、stored（frontend/src/components/resume/TailorBar.tsx:39-44）。只有用户触发。

| 阶段 | 条件 | 出口 | 代码 |
|---|---|---|---|
| ASKING | asks 非空，drafts 为 null | organize() -> DRAFTS；先不答 -> CLEARED | TailorBar.tsx:208-227；organize 127-140 |
| DRAFTS | drafts 非空，stored 为 false | 编辑 -> ASKING（setDrafts(null)）；storeAll -> STORED | 228-253；storeAll 143-158 |
| STORED | stored 为 true | 用新成果再改一下 -> start(true) 只审稿 | 254-259；start 60-75 |
| 任意 | | start() -> resetAsks，丢掉模块里的结果 | 49-54,72,75 |

organize 调 POST /api/resume/impact（backend/app/main.py:630-646）→ backend/app/core/impact.py:115-158，无状态，不写库。

## 不变式

- 存进档案的记忆由用户本人保存：用户路径 source=user、confirmed=true（backend/app/core/tools.py:304-305）；只有用户能确认（297-301）。
- impact 的 flags 只提醒，不拦保存（impact.py:51-67；TailorBar 显示「留意」在第 236 行）。
- CLEARED 和 STORED 都会把 doc.pending_asks 清成 null（TailorBar.tsx:124,153）。
- 同一条记忆被几句回答补到时合成一条草稿（impact.py:145-157），所以草稿数 ≤ 回答数。

## 已知问题

1. impact-asks#1 storeAll 逐条 save，非原子（TailorBar.tsx:147-149）：中途失败时前面的已存，stored 仍为 false；重试会把 memory_id 为空的草稿再建一遍，记忆重复。
2. impact-asks#2 每条草稿一条改动，「存进档案」没有整体撤销。
3. 走 core memory，不经过 services/career_memory 的事实闸门（见 docs/design/statecharts.md 记忆两条路）。

## 验证

前端：TailorBar.asks.test.tsx（vitest，三条：提问→整理→一次存→只审稿、先不答清 pending_asks、flags 只提醒）；后端整理：backend/tests/test_impact.py。#1 修复时在 TailorBar.asks.test.tsx 加「第二条 save 失败后重试不重复建」的用例。
