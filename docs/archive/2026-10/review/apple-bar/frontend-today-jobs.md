> 已归档（2026-10-21）：本文不再是当前权威，只用于考古。当前文档：09-quality-and-release.md（位于 docs/）。2026-09-19 对抗评审的历史证据，评分与缺陷只属于当时代码。

# Today 工作台 + Jobs 列表/详情 对抗评审 — 2026-09-19

> 范围：`frontend/src/app/page.tsx`（1047 行）、`frontend/src/app/jobs/page.tsx`（1543 行）、`frontend/src/app/jobs/[id]/page.tsx`（1530 行）+ `JobCard.tsx` / `agentConnection.tsx` 关联面。
> 验证方式：静态通读 + headless Chromium @ `http://127.0.0.1:7410` 实测（路由切换、back 按钮、面板闪现）。

## 结论（对照 Apple 上线水准一句话定性）

信息架构和文案水准明显高于一般内部工具（空态有下一步、错误文案说人话、三态覆盖大体完整），但**详情页三块异步状态在切换岗位时不清零、把上一个岗位的调研/决策/简历候选闪现在新岗位页面上**——这是 Apple-bar 不可能放行的状态完整性缺陷；Jobs 页 URL 与 UI 状态在浏览器前进/后退时脱钩，外加两处 `alert()` 原生弹窗，把整体从「接近上线」拉回「需要一轮状态治理」。

## Findings

| ID | Sev | Type | 位置 | 证据 | 问题 | 建议修法 |
|---|---|---|---|---|---|---|
| FJ-01 | P1 | bug | `jobs/[id]/page.tsx:156-169, 209-294` | 实测：`#/jobs/381` 加载完成后跳 `#/jobs/382`，382 页「材料候选」先显示 381 的「等待审核/事实门已通过」，~数秒后才变「尚未生成」 | `research`/`preApplication`/`resumeProposal`/`reviewNote`/`decisionNote`/`decisionChoice` 等 10+ 个 `useState` 不随 `jobId` 变化重置；React Router 参数变化不重挂组件 | 给详情内层包 `<JobDetailContent key={job.id}>`，或在 `useEffect([jobId])` 中同步 `setResearch(null)` 等全部复位；根治是把这三段 fetch 改成 SWR（key 含 jobId），天然隔离 |
| FJ-02 | P1 | bug | `jobs/[id]/page.tsx:418-434` | 代码路径：`openResumeWorkspace` 用 `{ job_id: jobId(新), proposal_id: resumeProposal.proposal_id(旧) }` 调 `resumeApi.ensureWorkspace` | FJ-01 的连带后果：竞态窗口内点击「打开 Resume Workspace」会把**上一个岗位的 proposal** 绑定到新岗位，跨岗位数据污染 | 同 FJ-01；另外在 `openResumeWorkspace` 入口校验 `resumeProposal` 归属（需后端返回 proposal.job_id 并比对） |
| FJ-03 | P1 | bug | `jobs/[id]/page.tsx:209-294` | 三个 `load*` 均无 abort/代数标记：`jobId` 变化后旧 `jobResearchApi.run()` 仍在途，`setResearch(detail)` 迟到写入新页 | 快速连续切换 job 时慢响应覆盖新数据（stale write race） | 每个 load 内捕获 `jobId` 快照，resolve 后比对 `jobId !== current` 丢弃；或改 SWR/abort |
| FJ-04 | P2 | bug | `jobs/page.tsx:148-150, 656-672` | 实测：`?tab=picked` → 点「回收站」→ `history.back()`，URL 回到 `?tab=picked` 但界面仍是 ignored 描述与列表 | `triageStatus`/`selectedPoolFilter` 只在 mount 时读 `searchParams`（lazy initializer），URL 后续变化（前进/后退/外部跳转）不回写 state | 加 `useEffect`：`searchParams.get("tab")` 变化时 `setTriageStatus(resolveTriageTab(...))`；注意与点击 Tab 时 push URL 的方向做防循环 |
| FJ-05 | P2 | ux | `jobs/[id]/page.tsx:448, 462` | `alert(safeClientErrorMessage(err, "加入已筛选失败"))` ×2 | 原生 `alert()` 阻塞式弹窗，无样式、无重试路径；同页其它错误（researchError 等）都用内联 banner，只有这两个用 alert，模型不一致 | 改为页面内联 `actionError` banner（沿用现有模式）+ 保留 modal 上下文 |
| FJ-06 | P2 | design | `jobs/page.tsx:610-632, 635-639, 865-1047` | 3 块 `hidden`/`{false &&}` 死代码：旧版 header+全选按钮、旧 scraper 同步条、整段旧版暗色筛选栏（~180 行 JSX） | 巨型文件里埋着整段旧 UI，渲染时 NextUI Tabs/Select 仍会实例化（`hidden` 只是 CSS）增加无谓运行时与维护噪音；`{false && isScraperSyncing}` 使同步提示出现两套文案 | 删除三块死代码；`isScraperSyncing` 只保留 641-649 那一处呈现 |
| FJ-07 | P2 | bug | `jobs/page.tsx:243, 560-564` | `isAllSelected = selectedIds.size === totalMatchingJobs` | 「全选」语义跨页：用户手点 21 个当前页岗位 ≠ 全部 383 个；反过来跨页全选后取消一个，`size` 与 total 不再相等，文案仍显示「已选 N / 共 M」没问题但「取消全选」按钮状态判定脆弱；手选凑齐 N==total 时 UI 误报「取消全选」 | 用显式 `selectAllMode: "none"|"page"|"all"` 状态机替代 size 比较 |
| FJ-08 | P2 | ux | `jobs/page.tsx:185-190, 1133-1137` | `actionError` 5.5s 后 `setActionError("")` 自动消失 | 批量操作失败（可能几百个岗位部分失败）的错误 5.5 秒即消失且不可找回；Apple-bar F5 要求失败留有可恢复出口 | 失败横幅不自动消失，需手动关闭；或加「查看失败详情/重试」动作 |
| FJ-09 | P2 | ux | `jobs/page.tsx:1048-1054`; `[id]/page.tsx:478-487` | 首屏 loading 都是 `Spinner + 文字` 居中大面板 | 无骨架屏：列表页整块白面板 spinner，详情页整页 spinner；对比 rubric E4（列表首载用 skeleton 结构而非居中 spinner） | 列表页渲染 3×7 卡片骨架（已有 `bauhaus-panel` 样式可做 shimmer）；详情页按 section 骨架 |
| FJ-10 | P2 | ux | `page.tsx:444-454, 642-645, 733-735` 等 | loading 文案「正在同步后台任务…/正在读取…」+ 小 spinner；jobs 页无 error 分支 | Today 各 section 有 error/loading/empty 三态但 jobs 列表主数据 `useJobs` **没有取 error**：`const { data, isLoading, isValidating }`（207 行），接口挂掉时 `jobs.length===0` 直接落进「当前筛选没有命中」空态，**把错误伪装成空结果** | `useJobs` 取 `error` 并在列表区加错误 banner；这是「假空态」问题，严重度靠 P1 |
| FJ-11 | P1 | bug | `jobs/page.tsx:207-218` | `useJobs` 返回的 `error` 被解构丢弃 | 同上：后端 5xx/断网时页面显示「暂无岗位结果」+「保存第一个岗位」CTA，用户会误以为数据真为空 | 同 FJ-10（合并修） |
| FJ-12 | P3 | ux | `[id]/page.tsx:640-664` | 投递尝试列表用 `aria-pressed` 的 button；Today 页大量行内 `select({kind:"task",...})` 把 application/signal/event 都标成 `kind:"task"` | 语义混用：`page.tsx:662, 830` 把 progress candidate 和 email signal 都以 `kind:"task"` 塞进 inspector，`entity_type` 上报给 Agent 的也是 `task` 而非真实实体 | Inspector selection kind 需要 `signal`/`candidate` 等真实类型，或在 `data.agentContext` 里区分 |
| FJ-13 | P2 | design | `page.tsx:455-623` | 收件箱 entry 行与 standalone task 行是**两段复制粘贴的 JSX**（状态点、标题、副标题、错误行、进度条、controls 全部重复一遍） | 两份近 80 行的重复列表项渲染，字段名略不同（`task.error_id` vs `entry.task_error_id`）；任何样式修复要改两处，已出现不同步风险 | 抽 `<AutomationInboxRow>` 共享组件，差异通过 `taskSnapshotFromInbox` 已归一化的 snapshot 传入 |
| FJ-14 | P3 | perf | `[id]/page.tsx:267-294` | 三个 retry effect：每个都在 `data==null && !error` 时 1.5s 后重试，依赖变化即重新计时 | 「没有调研证据」的岗位每次打开都固定多发一轮 1.5s 后的重复请求（空结果也重试）；三接口各自独立重试 → 每个 job 详情页最多 6 次额外请求 | 空结果不要无差别重试；只在 `preparationTask.status==="running"` 时才轮询（数据源 `useCareerTasks` 已在 297 行拉取，可用它驱动） |
| FJ-15 | P3 | ux | `[id]/page.tsx:758-763` | `onPress={() => void import("@/lib/hooks").then(m => m.controlCareerTask(...))}` | 重试按钮 fire-and-forget：无 loading、无成功/失败反馈、点击后页面无任何变化（直到下次轮询） | 接 `taskAction` 式 busy 态 + `mutate` 刷新 |
| FJ-16 | P3 | design | `page.tsx` / `[id]/page.tsx` | `APPLICATION_STAGE_LABELS`、`INTERVIEW_STAGES`、`applicationStageLabel()`、`formatEventTime/formatProgressTimestamp` 在两文件各写一份 | 标签字典重复维护：Today 改阶段名时详情页不会同步 | 抽到 `lib/labels.ts` 之类共享 |
| FJ-17 | P3 | ux | `jobs/page.tsx:418-419` | `chunkSize=500` 顺序 `await` 分块 patch | 大批量操作串行且无进度提示，`actionLoading` 只显示 spinner；>500 个岗位删除/移动时用户面对无反馈的多秒等待 | 显示 `i/ids.length` 进度文案或后端单请求支持批量 |
| FJ-18 | P3 | i18n | `[id]/page.tsx` 574/731/789/969/1190; `page.tsx` 495-496 | 英文小标签混排："Application context / Next preparation / Material candidate / Evidence handback / Decision gate"，inspector 字段 "Benchmark / Application Packet / Task" | 全中文 UI 中夹英文 section eyebrow + inspector 字段名（`page.tsx:497` "Task"、`[id]` 页 resume 工作区按钮 "Resume Workspace"）；文案基调不统一 | eyebrow 统一中文（如「投递上下文」「材料候选」已定中文大标题，eyebrow 也应中文）；inspector 字段名翻译 |
| FJ-19 | P3 | a11y | `page.tsx` 各 list button | 行项目 `<button>` 内嵌套 `<button>`（AutomationTaskControls 的取消/重试按钮在外层 button 的 sibling 里没问题，但整个 row `<button>` 包住 progress bar 等非交互内容），jobs 卡片 checkbox 用 div 包 button | 部分行内 button 嵌套可交互元素风险（核实：`AutomationTaskControls` 是 sibling 不是 child — 结构 OK）；JobCard 复选框 44px ✓ 但卡片本体不可 Tab 到达（详情入口仅靠标题 Link 和「查看详情」按钮） | 键盘可达性可接受；建议卡片 `role` 与 roving tabindex 补充 |
| FJ-20 | P3 | arch | 三文件合计 4120 行 | `page.tsx` 1047 行单组件（TodayPage 一个函数承载 7 个 section）；`jobs/page.tsx` 1543 行（Hero+Tabs+筛选+批量+4 Modal）；`[id]/page.tsx` 1530 行（7 个 Card + 3 套 fetch 状态机） | 拆分边界见下节 | 见下节 |

## 巨型文件拆分边界（最该先切的）

**`app/page.tsx`（Today，1047 行）**
1. `AutomationInboxSection`（455-623 行）：两段重复列表项 + `AutomationTaskControls` + `taskSnapshotFromInbox` 一起收进 `components/today/`；FJ-13 顺手解决。
2. `PipelineSection`（719-807）+ `PendingSignalsSection`（810-862）+ `UpcomingEventsSection`（865-914）+ `RecentJobsSection`（917-985）：四个 section 结构同构（SectionHeader + panel + map + empty），抽 `<TodaySection>` 容器 + 各 row renderer。
3. `StatsDisclosure`（988-1038）：展开/收起 + TrendChart lazy，独立文件利于按需加载。
4. 标签字典（87-175 行）→ `lib/labels.ts`（与 [id] 页共享，FJ-16）。

**`app/jobs/page.tsx`（1543 行）**
1. 先删死代码（FJ-06）：约 -200 行，零风险第一步。
2. `JobsFilterBar`（655-862：Tabs + 保存/全选/管理池按钮 + 两行 Select + Switch + 状态条）：props 近 20 个，建议与 `useJobsFilters` hook（keyword/period/source/jobType/education/isCampus/pool + debounce + reset）一起抽。
3. `BatchActionBar`（1119-1247 浮动栏）：`selectedIds` + `triageStatus` + `actionLoading` + `actionError` + 三个 modal 的 open 回调。
4. `PoolManageModal`（1382-1507）+ `ConfirmDeleteModal`（1510-1540）+ `MoveToPickedModal`/`MoveToTrashModal`（1304-1380）：四个 modal 独立成文件，modal 内 pool CRUD 状态（newPoolName/editingPoolId/poolError/poolBusy）自然内聚。
5. `useJobSelection` hook：`selectedIds`/`lastSelectedAnchorId`/shift-range/pointer-drag 全选逻辑（280-394 行）是纯状态机，抽出后可直接单测。

**`app/jobs/[id]/page.tsx`（1530 行）**
1. `useJobPreparation(jobId)`：`research`/`preApplication`/`resumeProposal` 三套 load+state+retry 收进一个 SWR 化的 hook（顺带修 FJ-01/03/14）。
2. `ResearchHandbackCard`（965-1184）、`PreApplicationCard`（1186-1387）、`ResumeProposalCard`（785-963）：各自 200-400 行且只依赖对应 slice 的 state。
3. `JobProgressCard`（571-725）：progressBoard + timeline + selectedAttemptId 状态机独立。
4. 底部操作区 + 两个 Modal（1430-1527）→ `JobTriageActions`。

## AGENTS.md「hash 路由 + entityFromRoute fallback」核验

- `agentConnection.tsx:57-63` `entityFromRoute()` 只认 `^/jobs/(\d+)` 与 `^/resume/(\d+)`；`[id]` 页数字段以外的路由（`/jobs/abc`）不会误报 entity——行为正确。
- `usePathname()` 经 `compat/next-navigation.ts` 映射到 `useLocation().pathname`，HashRouter 下返回 `#/` 后的路径（实测 `/jobs/abc`）——与 regex 匹配一致，**两个写入者的推导规则一致**，AGENTS.md 描述属实。
- 但 AGENTS.md 提到的 `providers.tsx` 的 `AgentContextReporter` 已不存在（providers.tsx:203-221 只有 SWR/NextUI/BackendReady/Onboarding 四层）；`agentConnection.tsx:55` 的注释也引用它。实际第二写入者合并进了 `AgentConnectionProvider`（payload 里 `selection || routeEntity`）。**文档与代码注释双漂移**，需更新 AGENTS.md 表述与 code comment。
- 附带缺口：`entityFromRoute` 未覆盖 `/applications`、`/interview`、`/email` 等同样有实体语境的路由 [INFERENCE: 这些页是否需要 entity 上报取决于 Agent 侧契约，至少应在 AGENTS.md 记一句边界]。

## UX 评分（对照 apple-bar-rubric 36 条）

抽样打分（仅本域相关条款）：

| 类别 | 抽样项 | 得分 | 关键证据 |
|---|---|---|---|
| B 排版 | B4 列表渐进披露 | 1 | Today/jobs 行均为 icon+标题+副行 |
| C 动效 | C2/C3 时长 | 1 | spring 320-420 stiffness，无 >400ms transition |
| C 动效 | C6 reduced-motion | 0.5 | globals.css:1014 有 CSS 降级，但 framer-motion 内联动画不受 CSS transition 约束，无 `useReducedMotion`/`MotionConfig reducedMotion="user"` [INFERENCE: spring 动画在 reduce 下仍播放] |
| D 可达 | D7 目标尺寸/aria | 0.5 | 复选框 44px、icon 按钮有 aria-label；JobCard 本体不可 Tab、详情页 textarea 无描述关联 |
| E 加载 | E4 skeleton | 0 | 全部居中 spinner（FJ-09） |
| E 加载 | E6 loading→empty 时序 | 0.5 | Today 三态正确；jobs 列表 error 被吞成 empty（FJ-10/11） |
| F 空错 | F1 空态下一步 | 1 | 「保存第一个岗位」+「放宽筛选」双卡引导 |
| F 空错 | F2 错误说人话 | 0.5 | 大部分好；`alert()`×2（FJ-05）、`pipelineError.message` 裸抛（page.tsx:730） |
| F 空错 | F5 失败可恢复 | 0.5 | jobs 错误 5.5s 自动消失（FJ-08）；详情页各卡有重试按钮 ✓ |
| G 一致 | G1 组件一致 | 0.5 | 错误呈现 3 种模式混用（banner / alert / auto-dismiss） |
| G 一致 | G2 命名统一 | 0.5 | 中英 eyebrow 混排（FJ-18）、「已筛选/已筛选池/ picked」同一概念三称 |

**域内加权 ≈ 0.55-0.6，低于 0.85 达标线**；最大拉分项：无骨架屏、错误模式不一致、详情页状态泄漏。

## Top-5 修复优先级

1. **FJ-01/02/03 详情页状态泄漏族**（P1）：`key={job.id}` 重挂 + 三个 load 改 SWR/加代数守卫 + `openResumeWorkspace` 校验 proposal 归属——一个重构同时消掉闪现、竞态写、跨岗位污染。
2. **FJ-10/11 jobs 列表吞错误**（P1）：`useJobs` 的 `error` 解构出来渲染 banner，别把 5xx 显示成「没有命中」。
3. **FJ-04 URL↔state 脱钩**（P2）：`useEffect` 监听 `searchParams` 回写 `triageStatus`/`selectedPoolFilter`，back/forward/深链接可用。
4. **FJ-06 删 ~200 行死代码 + FJ-13 抽 `AutomationInboxRow`**（P2）：巨型文件减重第一步，纯删无风险。
5. **FJ-05/08 统一错误模型**（P2）：杀 `alert()`，失败 banner 改手动关闭 + 保留上下文，与详情页内联错误模式对齐。

## 已达标的点（简短）

- Today 页信息层级清晰：日期+「今日」紧凑页头 → 自动工作收件箱 → 待确认进展 → Pipeline → 信号 → 日程 → 新机会 → 折叠统计，符合「行动队列」定位，next-action（`record.next_action`、待确认 badge）在行内有显著标识。
- 三态覆盖意识好：几乎每个 section 都有 error/loading/empty 分支，空态文案有引导（「保存第一个岗位」「去审核」）。
- 批量选择做得细：shift 范围选、pointer-drag 刷选、跨页「全选」拉全量 id、`mouseup` 全局监听正确清理。
- `agentConnection` 的串行写队列 + route fallback 设计正确且有测试（`agentConnection.test.tsx` 覆盖空 selection 不覆盖 route entity）。
- JobCard apply_url 占位域名死链过滤（`JobCard.tsx:76`）是真实用户痛点的好细节。
