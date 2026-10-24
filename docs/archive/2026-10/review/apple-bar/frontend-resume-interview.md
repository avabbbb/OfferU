> 已归档（2026-10-21）：本文不再是当前权威，只用于考古。当前文档：09-quality-and-release.md（位于 docs/）。2026-09-19 对抗评审的历史证据，评分与缺陷只属于当时代码。

# Resume / Interview / Email / Profile / Calendar 对抗评审 — 2026-09-19

## 结论（对照 Apple 上线水准一句话定性）

核心三栏编辑器骨架（autosave+undo+版本+proposal 审核）是真的，但外层体验未打磨到发布水准：**Letter 纸型是死开关、简历列表的「编辑」按钮可以把用户带进永久无法进入的门、面试中心页没有任何通往 AI 模拟面试/姿态训练的入口、日历页「AI 自动填充」是一个点击无任何反应的假按钮**——四处都是「看起来像完成了、其实走不通」的 Apple-bar 硬伤。

## Findings

| ID | Sev | Type | 位置 | 证据 | 问题 | 建议修法 |
| --- | --- | --- | --- | --- | --- | --- |
| RI-01 | P1 | bug | `frontend/src/app/resume/[id]/page.tsx:342` + `backend/app/services/resume_workspace.py:288-296` + `resume/page.tsx:406` | `GET /api/resume/workspace/70` → `{"detail":"只有用户确认投或有条件投并生成简历提案后才能进入 Resume Workspace"}`；简历列表对每张卡都渲染「编辑」按钮 | **简历列表→编辑=死胡同**。只要 `resume.target_job_id` 绑定的岗位 pre-application stage 已离开 `resume_proposal_ready`（用户已投、退回调研、或推进了管道），这份**已存在的、可能有用户编辑过的定制简历**就永远无法再打开工作区——后端门 + 前端列表无提示。手动简历（71）可开、per_job 简历（70）被拒，行为不一致。 | 门应该只挡「进入生成态」不挡「查看/编辑已有简历」：`get_resume_workspace` 对已存在 resume 去掉 stage 检查，或至少返回 `job` 上下文 + 降级只读模式；列表卡片对不可编辑的 resume 标注状态而不是给活的「编辑」按钮。 |
| RI-02 | P1 | ux | `frontend/src/app/interview/page.tsx`（全文无 `router.push`/`Link` 到 `/interview/ai` 或 `/interview/pose`）+ `components/workbench/WorkbenchShell.tsx:44-45` | live aria snapshot `#/interview`：整页只有「粘贴面经」+ 题库/面经两个 tab，无任何指向 AI 模拟面试/姿态训练的入口；而 `/interview/ai`、`/interview/pose` 都有「返回面试」链接指回 `/interview` | **AI 模拟面试（核心卖点）在产品内不可发现**。只能从 Job 详情的 RoleIntelligencePanel CTA 进入，或直接输 URL。`interview_1` 一面/HR面打完了都不知道去哪练。姿态页 `/interview/pose` 完全孤儿（全仓 0 处 UI 链接）。 | 在 `/interview` hero 或 tab 区加「AI 模拟面试」「姿态训练」入口卡；`/interview/pose` 若是 PoC 应下线或合并进 AI 面试的 InterviewStage，不要作为隐藏路由留在发布包里。 |
| RI-03 | P1 | bug | `frontend/src/app/calendar/page.tsx:149` | `<Button startContent={<Sparkles/>} className="bauhaus-button bauhaus-button-yellow">AI 自动填充</Button>` —— 无 `onPress`、无 `isDisabled`；live 点击后 DOM 无任何变化 | **假按钮**。对照 `email/page.tsx:210-213` 有真实 `handleAutoFill` → `autoFillCalendar()` 的实现，日历页这颗按钮是抄袭了外观没接行为。点击无反馈 = 用户认为功能坏了。 | 接 `autoFillCalendar`（同 email 页）并显示 `已补建 N 个日历事件`，或删掉按钮。 |
| RI-04 | P1 | bug | `frontend/src/app/resume/components/templates/resumeTemplate.css:21-23,568-571` + `templates/templateSettings.ts:285-304` + `[id]/page.tsx` Design 面板 | `.resume-body { width: 210mm; min-height: 297mm }`、`@page { size: A4 }` 硬编码；`settingsToCssVars` 输出 12 个 var 无一与 pageSize 相关；Design 面板却有 `<select>` A4/Letter + 预览徽标 `style.pageSize === "LETTER" ? "Letter" : "A4"` | **Letter 纸型是死开关**。选择 Letter 后徽标变「Letter」但预览仍渲染 210×297mm，PDF `@page size: A4` 也不变——README:111 宣称的「live A4 / Letter preview」对 Letter 是假的。 | 新增 `--resume-page-w/h` var + `@page size` 按 style 输出（需要把 `@page` 挪出静态 CSS 或用 print CSS 变量替代方案）；或在 UI 下线 Letter 选项。 |
| RI-05 | P1 | ux | `frontend/src/app/resume/[id]/page.tsx` 全文 | grep 无 `ledger`/`profile`/「写回档案」链接；右侧栏只有「AI Proposal / Design / Versions」三个 tab + Application Packet 只读摘要 | KNOWN_ISSUES:48 承诺「Resume 手动编辑不回写 Profile，应通过 Candidate/Evidence review 回流」，但工作区**没有任何指向 Candidate review 的入口/提示**。用户在简历里改了公司名/项目数字，产品静默接受了这个漂移，连一条「已检测到新事实，去档案审核」的 hint 都没有。 | 在 header 或 aside 加一条静态提示「本页编辑不写回职业档案；新事实请在 Profile → Ledger 审核」+ 链接 `/profile?view=ledger`；理想态是检测 diff 出 fact 时给入口。 |
| RI-06 | P2 | bug | `frontend/src/app/resume/page.tsx:80,344` | `const { data: resumes, mutate } = useResumes()` —— 不解构 `error`/`isLoading`；加载失败时 `resumes===undefined` → 网格 `(resumes||[]).map` 渲染空、`resumes?.length ?? 0` 显示 0、且不进入 `resumes && length===0` 的空态分支 | **三态缺 error**。后端挂掉时页面显示「简历数量 0」+ 无任何列表内容也无错误提示——和「真的没有简历」不可区分，静默假空。 | 解构 `error, isLoading`：loading 出骨架，error 出 `role=alert` 横幅 + 重试。 |
| RI-07 | P2 | ux | `frontend/src/app/resume/[id]/page.tsx:159-168` | diff 渲染仅 `before`/`after` 两个色块 + 「Before ·」「After ·」文字标签 + change_type 小注，无行内字符级 diff、无 section_key 分组、无折叠 | 对照 GitHub/Linear 水准，**proposal diff 可读性不及格**：一段长 bullet 改一个词时，整段红/绿文本要人工逐字比对。`displayText` 还把 HTML 标签全 strip 成单行，丢失结构。 | 用 `diff`/`diff-match-patch` 做词级 highlight（绿底插入、红删除线），before/after 并排或统一 diff 视图；按 `section_key` 分组。 |
| RI-08 | P2 | bug | `frontend/src/app/calendar/page.tsx:75-86,182-211` | `handleCreate` 无 try/catch，`await createCalendarEvent` 失败 → unhandled rejection；列表态事件无任何编辑/删除按钮，FullCalendar 无 `eventClick` handler | 日历**只能新增、不能编辑/删除**，且创建失败静默。用户录错时间只能看着它一直挂着；email 页补建的事件也无法在日历里清理。 | 列表行加删除/编辑（或至少删除）；`handleCreate` 包 try/catch + 错误提示；FullCalendar 加 `eventClick` → 详情/删除弹窗。 |
| RI-09 | P2 | ux | `frontend/src/app/resume/[id]/page.tsx:343,352` | `staleProposal` 触发时 banner 文案「请重新生成建议或继续手动编辑」+ 唯一按钮「刷新」（`loadWorkspace`）；`resumeApi` 无任何 regenerate-proposal 方法 | **stale 保护有提示无出口**。README:112 宣称 stale-proposal protection，前端确实检测了 stale，但提示让用户「重新生成」却不给入口——刷新只会再拿到同一份 stale。 | banner 加「重新生成提案」按钮（后端需对应 API 或链回 job 详情触发 optimize），或改文案为可执行的指引（「回到岗位详情重新生成」+ deep link）。 |
| RI-10 | P2 | bug | `frontend/src/app/resume/[id]/page.tsx:253-254` | `updateDraft`/`updateSection` 在 `setDraft` 的 **updater 函数内**调用 `recordUndo(current)` —— React StrictMode 开发态 updater 双调用会推入两条相同快照 | 撤销栈被重复快照污染（每次编辑产生 2 条相同 undo），用户按一次「撤销」看似无反应（回滚到相同内容），需要按两次才回退——dev 体验差，且掩盖真实 undo 深度。 | `recordUndo` 移出 updater：先读 `draftRef.current`/`draft` 记录快照，再 `setDraft`；或用 reducer。 |
| RI-11 | P2 | ux | `frontend/src/app/interview/page.tsx:101-126` | `handleCollect` 成功后 `setExtractingId(result.id)` → `await extractQuestions` 用 `try{}catch{}` **吞掉所有提炼错误**，然后照常 `onCollectClose()` + 清空表单 | 面经提交成功但 AI 提炼失败时**静默假成功**：弹窗关掉、表单清空、面经列表多一条，但用户不知道题没提出来，也不会重试。和 KNOWN_ISSUES「界面应保持失败可见，不应回退成伪造成功」直接冲突。 | 提炼失败时 `setInterviewError` + 不关弹窗或至少提示「面经已保存，但提炼失败可在面经列表重试」。 |
| RI-12 | P2 | ux | `frontend/src/app/interview/ai/page.tsx:332-339` | Ctrl/⌘+Enter 提交快捷键只在 `<Textarea onKeyDown>` 里绑；提交按钮无 `aria-keyshortcuts`；「退出本场」无确认，直接 `reset()` 丢全部进度 | 键盘可达但不**可发现**；退出无确认 = 误点丢一场已答的题。 | 按钮加 `title="Ctrl+Enter"`/`aria-keyshortcuts`；「退出本场」加确认 dialog（保留 report 已生成的除外）。 |
| RI-13 | P2 | arch | `frontend/src/app/resume/` | grep 证实以下组件在 `app/` 外零引用：`AiGenerateDrawer.tsx`(358 行)、`AiOptimizeDrawer.tsx`(460)、`MatchScorePanel.tsx`、`StylePanel.tsx`、`StyleToolbar.tsx`、`ThemePickerAria.tsx`、`themePresets.ts`、`puckComponents.tsx`、`hooks/useHistory.ts`、`interview/nailong/`（空目录） | **~1500+ 行死代码**随发布包分发，含一套完整的旧样式系统和两套 AI drawer——既增加包体积也让「哪个才是活的」对新维护者不可判。`useHistory` 与工作区自己手写的 `undoStackRef` 并存，是两套 undo 实现的证据。 | 删除未被引用的组件；若为未来保留则移到 `archive/` 并在 README 标注；空 `nailong/` 目录删掉。 |
| RI-14 | P3 | ux | `frontend/src/app/resume/[id]/page.tsx:354` | `xl:grid-cols-[300px_480px_300px]` 三栏只在 ≥1280px 出现；KNOWN_ISSUES:46 自认「小窗口压缩布局」；预览固定 `scale-[0.78]` | 中栏预览硬缩放 0.78，A4 796px→621px 视觉偏小，且 1280 以下变单列时三栏顺序为 Content→Preview→Aside，预览被夹在中间需大量滚动；无「专注预览」模式。 | 预览区加缩放档位（适应宽度/0.78/1.0 切换）；中屏把 Preview 提到第一列或支持 sticky。 |
| RI-15 | P3 | ux | `frontend/src/app/email/page.tsx:178` | `handleRevoke` 用 `window.confirm` 撤销邮箱授权 | 全应用都用 NextUI Modal 做确认（resume 删除有专门 Modal），唯独撤销授权用原生 `confirm` —— 风格断裂且文字不可复制。 | 换成 `useDisclosure` + Modal，与删除简历确认框同款。 |
| RI-16 | P3 | ux | `frontend/src/app/interview/ai/page.tsx:147` + `:292` | `progress = (currentQuestionIndex + (report?1:0))/len*100`；但 session 中若服务器插入 follow_up 题，`session.questions` 会变长，分子分母同时变 | 题目被追问插入时进度条会**倒退**（`current` 不变、`total` +1），用户看到「第3/5题」变「第3/6题」可以理解，但若在多题 session 中会更迷惑——当前 UI 没解释「为什么变多了」。 | 进度文案补一句「Interviewer 可能追加追问」或在插入时 toast「已追加 1 道追问」。 |
| RI-17 | P3 | design | `frontend/src/app/interview/ai/page.tsx:323-341` | 回答用 `<Textarea>` 纯文本，无字数/时间统计、无 STAR 结构提示占位（placeholder 仅一句）；练习页缺「草稿暂存」 | 对照真实面试练习工具（Pramp/ interviewing.io），缺少最基本的「作答计时」与「每题字数」反馈——debrief 里 per_question 事件已按题分，作答本身却没有元数据。 | textarea 下方加「已用时长 + 字数」显示（本地计时器即可）。 |

## Top-5 修复优先级

1. **RI-01**：工作区门把已存在的简历挡在外面——数据可达性 P1，直接违反「用户的简历永远可以打开」。
2. **RI-02**：面试中心页不给 AI 模拟面试入口——核心功能不可发现，等于没有。
3. **RI-04**：Letter 纸型是死开关——README 宣称的能力是假的，发布前要么实现要么下选项。
4. **RI-03**：日历页 AI 自动填充假按钮——零成本的「点了没反应」，Apple bar 下不可容忍。
5. **RI-05 + RI-09**：stale-proposal 与简历→Profile 回流都没有出口——README/KNOWN_ISSUES 承诺的引导在 UI 层不存在，至少给 deep link。

## 已达标的点（简短）

- 工作区 autosave（800ms debounce + signature 去重 + 失败保留草稿 + 重试入口）+ 40 步 undo + 版本快照/恢复，是真实现且有测试覆盖（`page.test.tsx` 含失败不回滚草稿的回归断言）。
- AI Proposal 审核有 fact-gate 前置（blocked 时禁用接受并给出 tooltip 解释）、逐条 accept/reject + 可改写后再接受，不是一键 apply。
- AI 面试 turn-based 流程完整：Interviewer Mode（训练中不评分/不给答案）与 Coach Mode debrief（按 focus capability 引用实际回答、标注 evidence gap）分层清晰，边界声明到处可见。
- InterviewStage 隐私边界做得实：视频帧不出本机、只上传派生行为事件、事件带 detector 版本，UI 明确告知。
- Email 页有授权 URL 白名单校验（`isTrustedGmailAuthUrl`）、授权前 consent 勾选、同步运行账本（pending/running/failed 可见，失败不伪装成完成）。
- 简历列表对上传解析给了置信度/页码来源/低置信警示，不是黑盒导入。

## UX 评分（对照 Apple 上线水准，10 分制）

| 页面 | 分数 | 主要扣分 |
| --- | --- | --- |
| `/resume`（列表） | 5.5 | 无加载/错误态（RI-06）；卡片「编辑」可能死胡同（RI-01） |
| `/resume/[id]`（工作区） | 5.0 | Letter 死开关（RI-04）；diff 可读性低（RI-07）；stale 无出口（RI-09）；无 Profile 回流引导（RI-05） |
| `/interview`（题库） | 5.5 | 无 AI 面试入口（RI-02）；提炼静默失败（RI-11） |
| `/interview/ai`（模拟面试） | 7.0 | 本身完成度高，但只能从外部进入；退出无确认（RI-12） |
| `/interview/pose` | 3.0 | 孤儿 PoC 路由，应下线或合并 |
| `/email` | 7.0 | consent+授权校验完整；扣在 revoke 用原生 confirm（RI-15） |
| `/calendar` | 4.0 | 假按钮（RI-03）；只能增不能改删（RI-08） |
| `/profile` | 6.5 | onboarding+candidate review+ledger 完整；扣在与简历编辑的回流断层（RI-05） |
