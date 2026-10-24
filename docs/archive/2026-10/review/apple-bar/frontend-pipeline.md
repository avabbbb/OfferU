> 已归档（2026-10-21）：本文不再是当前权威，只用于考古。当前文档：09-quality-and-release.md（位于 docs/）。2026-09-19 对抗评审的历史证据，评分与缺陷只属于当时代码。

# Pipeline（投递看板 + 投递表）对抗评审 — 2026-09-19

## 结论（对照 Apple 上线水准一句话定性）

**不到上线水准**：Pipeline 的"事件投影"叙事在 board 端成立（只读 `application_stage_events`），但同页签的投递表维护着第二套互不通气的 `apply_status` 状态系统；看板没有任何人工登记阶段的入口（无 attempt 的 saved→ready 只能靠后台任务），待归属队列存在 12 条无法操作的死卡，设置弹窗草稿会被窗口聚焦静默清空，多个异步操作失败后无任何反馈——离"一个真相源"的产品承诺和 Apple 级可靠性都还有明显差距。

## Findings

| ID | Sev | Type | 位置 | 证据 | 问题 | 建议修法 |
|----|-----|------|------|------|------|----------|
| F1 | P1 | bug / design | `backend/app/services/application_workspace.py:861-874` vs `backend/app/services/application_progress.py:1342-1430`；前端 `frontend/src/app/applications/page.tsx:598-608` | 表格里编辑 `apply_status` 走 `update_record_value` → 写 `application_event_store`（workspace 事件），**不写 `ApplicationStageEvent`**；看板 `current_stage` 只读 stage events / `attempt.status` 回退 | **双真相源**：用户在投递表把状态改成"已投递"，Pipeline 看板仍显示 `saved`；README 宣称的"progress is events, not independent UI state"在 apply_status 上被打破 | 把 apply_status 变更桥接为 `ApplicationStageEvent`（含映射表 待投递→ready、已投递→applied、面试中→interview_*、已拒绝→rejected、已录用→offer），或让看板行把 apply_status 作为投影输入之一 |
| F2 | P1 | design / ux | `frontend/src/components/progress-board.tsx` 整个组件；`scripts/live_eval/FINDINGS.md:30-33` 已独立记录 | 看板唯一的阶段推进手段是 `reviewProgressCandidate`（需真实邮件信号派生的 candidate）；实测 421 条记录中 285 条 `saved` 无处可点，无手动 stage 入口 | **用户无法登记"我进二面了"这类人工进展**——投递追踪产品的核心动词缺失；saved→ready 只能等 CareerTask | 在 RecordRow/时间线层加"登记进展"入口（写 `ApplicationStageEvent`，source=manual），与 review 路径共用同一事件模型 |
| F3 | P1 | ux | `frontend/src/components/progress-board.tsx:118-120, 261-265`；实测 `GET /api/applications/progress-board` 返回 12 条 unlinked，全部 `can_create_record=false && match_candidates=[]` | 无公司名的候选：`canAccept` 恒为 false → "确认关联"永久禁用；提示"请先手动创建投递记录后再关联"，但手动建档后 `_unlinked_progress_candidates`（application_progress.py:1462-1484）依赖 `extracted.company` 精确匹配，公司为空永远不会匹配 | **死卡队列**：唯一可用动作是"忽略"，卡片告诉用户去解决但路径走不通 | (a) 允许手动选择任意 attempt 关联（不限 match_candidates）；(b) 允许从候选手动补录公司名后建档；(c) 至少把"忽略"做成批量 |
| F4 | P1 | bug | `frontend/src/app/applications/page.tsx:398-413` | `useEffect` deps `[workspace, currentTableId, importTargetTableId]` 每次 workspace 对象变化就 `setSettingsDraft`/`setTemplateDraft` 重置；SWR 默认 focus revalidate | **设置弹窗开着时切一下窗口再回来，未保存的模板/开关编辑被静默清空**（用户输入数据丢失） | 仅在 modal 打开时初始化草稿（open 时刻 snapshot），或给 effect 加"modal 关闭才同步"守卫 |
| F5 | P2 | bug | `frontend/src/app/applications/page.tsx:137-143` | `formatDateOnly` 对非纯日期串走 `new Date(value).toISOString().slice(0,10)` → 转 UTC；UTC+8 下 `"2026-09-19 02:00"` 显示为 `2026-09-18` | **日期显示偏差一天**（时间显示 bug） | 本地时区取 `getFullYear/getMonth/getDate`，不要 toISOString |
| F6 | P2 | bug | `frontend/src/app/applications/page.tsx:636-671, 825-836, 514-520, 915-925, 767-779` | `handleCreateTable`/`handleRenameTable`/`handleDeleteTable`/`handleDeleteRecords`/`saveSettingsAndTemplate`/`handleSchemaPatch`/`handleCreateManualRecord` 全部只有 `try/finally` 无 `catch` | **静默失败**：删表失败→弹窗已关、loading 停了、页面没变、无 toast；列宽/schema patch 失败无任何提示（unhandled rejection） | 统一走 `operationFeedback`（已有机制），至少 error toast |
| F7 | P2 | ux | `frontend/src/components/progress-board.tsx:35-49` | `STAGE_LABELS`：`ready`→"待投递" 且 `prepared`→"待投递"；实测 summary pills 显示 "待投递 74 / 待投递 62" 两个同名标签 | **两个不同阶段渲染成同名胶囊**，summary 区出现重复条目，用户无法区分 | 给 prepared 单独标签（如"材料就绪"）或后端合并 stage |
| F8 | P2 | perf | `frontend/src/components/progress-board.tsx:685-693`；实测 active 视图渲染 336 个 CompanyGroup / 5422 DOM 节点 | 无虚拟化、无分页；后端 `limit(500)`（application_progress.py:1351, 1550） | 大库下首屏渲染全部公司组+候选卡，滚动卡顿；表视图（page.tsx:1161-1397）同样全量 `<tr>` | 公司组层虚拟化/分页（如 react-virtual），或后端分页参数 |
| F9 | P2 | ux | `frontend/src/components/progress-board.tsx:141,146,325,330` | 审核失败/事件告警用 `window.alert`；同页 applications/page.tsx 用 `operationFeedback` toast | 反馈系统不一致；alert 阻塞且样式与 Bauhaus 设计系统违和 | 换成与页面一致的 toast |
| F10 | P2 | ux | `frontend/src/app/applications/page.tsx:563-596` | `inspectRecord` 给检查器造的 `timeline` 只有"创建记录/最近更新"两条合成项，**不是** `/progress-board/:id/timeline` 的真实 stage events | 检查器展示的是**伪造时间线**，与 README"同一 event 源"叙事矛盾；真实事件已存在但没接 | 行点击后拉 `useProgressTimeline(attemptId)` 或把真实 timeline 注入 inspector data |
| F11 | P3 | bug | `frontend/src/components/progress-board.tsx:90-97` vs `frontend/src/app/page.tsx:66-75` | board 用裸 `toLocaleString()`（浏览器 locale），Today 用 `toLocaleString("zh-CN", {...})` | 同一事件在两个表面时间格式不同（i18n 不一致） | 统一走共享 formatter（zh-CN，月日时分） |
| F12 | P3 | ux | `frontend/src/components/progress-board.tsx:558` | `useState(group.pending_candidates > 0)` 只在挂载时取初值 | pending 清零/新增后公司组展开状态不更新，需要手动开合 | 受控展开或 effect 同步 |
| F13 | P3 | ux | `frontend/src/components/progress-board.tsx:512-521` | `isOpportunity` 行整体是 `<Link>` 跳 `/jobs/:id`，无法展开看 saved 事件（timeline_count 可达 1） | 机会行隐藏了它唯一的事件证据（JOB_SAVED），也无处确认"为什么它在 saved" | 行内可展开只读时间线，或 subtitle 显示 last_event_at |
| F14 | P3 | ux | `frontend/src/components/progress-board.tsx:668-678` | 空态文案"从「岗位」页挑选岗位创建投递，或连接邮箱自动捕获进展"为纯文本 | 教学价值及格但没有可点击的下一步入口（无 `<Link>` 到 /jobs 或 /settings） | 加两个真实按钮 |
| F15 | P3 | bug | `frontend/src/components/progress-board.tsx:594-598` | `key={record.application_attempt_id}`；实测一个公司组内 49 条记录全部 `application_attempt_id=null` → `key=null` | React 把 null key 退回 index 键；目前不崩但列表内混入 attempt 行后重排可能错挂展开状态；也是 lint/TS 异味 | `key={record.application_attempt_id ?? `job-${record.job_id}`}`（Today 页 page.tsx:745 已这么做，不一致） |
| F16 | P3 | ux | `frontend/src/app/applications/page.tsx:730,753` | 文案"已从插件购物车{batchId}导入"当 batchId="最近批次"时读作"插件购物车最近批次导入"；"面试通知已写入看板"实际写的是 candidates | 文案生硬/轻度误导 | 调整措辞 |
| F17 | P3 | ux | `frontend/src/app/applications/page.tsx:334-336, 943-963` | 切换 数据表/看板 不写回 URL；`/applications?view=board` 仅初始读取 | 刷新或分享链接丢失视图状态 | view 变更时 replace query param |

## Top-5 修复优先级

1. **F1 双状态系统打通**：apply_status ↔ stage event 桥接，否则"同一事实源"是空话，且用户在表格里的每次状态编辑都在制造两页不一致。
2. **F2 手动登记进展入口**：看板加"登记进展"动作（写 stage event）——这是投递追踪产品的核心动词，当前完全缺失（live_eval 已独立撞出同一缺口）。
3. **F3 死卡队列**：给 unlinked 候选提供"手动选 attempt 关联"或"补公司名建档"通路；现在 12 条卡只能被忽略。
4. **F4 设置草稿被 focus revalidate 清空**：修 `useEffect` 守卫，避免用户输入静默丢失。
5. **F6 静默失败清零**：所有 mutation handler 补 catch → `operationFeedback` error toast（机制已存在，零新设计）。

## 已达标的点（简短）

- **事件投影为真**：board 前端确实不维护本地 stage 状态，`useProgressBoard`/`useProgressTimeline` 直接消费 `/api/applications/progress-board*`；Today 页（page.tsx:718 注释明示"不维护副本"）读同一投影——README 主张在 board 侧成立。
- **待确认即写原则落实**：候选必须显式 accept 才写 stage event，`classification_conflict` 时强制用户选阶段（progress-board.tsx:111-115），测试 `progress-board.test.tsx:135-158` 行为级覆盖了该护栏（禁断言实现细节，断言按钮 disabled + 冲突文案可见——合格）。
- **审核后双投影刷新**：`refreshProgressProjections` 用 SWR `mutate` predicate 同时刷新 board 与 candidates（progress-board.tsx:613-620），测试断言了该行为。
- **InlineCellEditor 失败处理正确**：commit 失败保留草稿+错误提示、不静默关闭（page.tsx:190-204）——这正是其他 handler 缺的标准。
- **空态不空白**：board 空态给下一步指引（虽无可点链接）；测试显式断言"不是空白"。
- **测试质量**：`progress-board.test.tsx` 3 个用例全是行为级（空态文案、accept 调用载荷、conflict 禁用），无实现断言——达标；缺 RecordRow/时间线/多记录组的覆盖（F15 场景可复现为用例）。

## 附：UX 评分（10 分制，对照 Apple 上线水准）

| 维度 | 分 | 依据 |
|------|----|------|
| 信息架构（三层渐进披露） | 7 | 公司→岗位→时间线层级清晰；但 285 条 saved 平铺让层级形同虚设 |
| 状态一致性 | 3 | F1 双真相源 + F7 同名双阶段 + F11 时间格式分裂 |
| 可操作性 | 4 | F2 无手动登记 + F3 死卡队列；核心动词缺失 |
| 反馈与容错 | 4 | F4 草稿清空 + F6 静默失败 + F9 alert 混用；InlineCellEditor 是唯一正面样本 |
| 性能余量 | 4 | F8 336 组/5422 节点无虚拟化，数据再涨 10× 必崩 |
| 文案与教学 | 6 | 空态/冲突文案清楚；F14/F16 扣分 |
| **综合** | **4.5/10** | 骨架对、血管断：投影模型正确但写入路径只有半条 |
