# WebUI Slice 01 最终实施计划：投递进展工作台

> 状态：历史实施计划；工作台壳层和投递页切片已经进入当前代码，本文只保留原验收意图  
> 日期：2026-07-17  
> 批准日期：2026-07-18  
> 设计事实源：`docs/WEBUI_WORKBENCH_DESIGN_2026-07-17.md`、ADR-0030、ADR-0031、ADR-0032  
> 与 `docs/implementation/SLICE_01_PLAN_2026-07-17.md` 的关系：独立并行，不覆盖、不替换
>
> 文中的 Harness Agent 已由 Pi 主 Agent Runtime + 确定性 Guardian 取代；当前契约见 `docs/architecture/agent-system.md` 与 ADR-0041、ADR-0046。

## 1. 目标

用“投递进展”完成第一个可独立验收的 WebUI 纵向切片，验证 OfferU 的 Codex + Notion 工作台方向：

1. 用户在紧凑列表中浏览和筛选投递记录；
2. 选择一条记录后，在同一右侧上下文栏查看详情；
3. 在右栏切换到 `OfferU`，沿用现有 Harness Agent 的会话、流式响应、工具结果和确认动作；
4. 复杂操作仍进入现有弹窗或后续专注页，主列表不堆满永久控件；
5. 桌面、平板和移动端使用同一信息架构，但移动端只承诺轻量查看和状态更新。

本切片成功的标准不是“换一套颜色”，而是让用户一眼回答：我在哪个求职阶段、当前选中了什么、下一步能做什么、OfferU 正在协助什么。

## 2. 已确认决策

- 产品壳层：Codex 的任务工作台骨架 + Notion 的数据密度与渐进披露。
- 核心对象：求职任务；投递记录是首个承载对象。
- 导航：按求职流程分组，不按当前页面堆叠顺序排列。
- 详情与 Agent：统一右侧上下文栏，页签为 `详情 / OfferU`。
- Agent：复用现有 Harness Agent；不新增第二套聊天状态、API 或确认协议。
- 快捷入口：WebUI 使用 `Ctrl/Cmd + K`；TUI 继续使用 slash skill/键盘入口。
- 视觉：浅色、中性底色、单一暖红品牌色；无大面积 Hero 和装饰性卡片墙。
- 动效：快速、小幅、可中断弹簧；尊重 `prefers-reduced-motion`。
- 计划关系：本计划与后端业务 Slice 01 独立并行，通过领域术语、ADR 和 Operation Registry 对齐。
- 范围确认：完整首切片，并仅修复 `/resume` 的一处 JSX 语法阻塞。

## 3. 用户故事与 tracer bullet

### 主路径

1. 用户从流程导航进入“投递进展”。
2. 页面默认展示当前投递表、搜索/筛选和紧凑记录列表。
3. 用户点击非交互单元格所在的行，右栏打开该记录的详情。
4. 用户可在详情中查看岗位、公司、阶段、关键时间、链接和已有字段。
5. 用户切换到 `OfferU` 页签，看到与当前记录有关的快捷提问；提问中携带稳定记录标识和必要摘要。
6. Agent 仍通过既有工具读取真实数据；任何写操作继续显示 proposed action，并经过既有确认流程。
7. 用户返回列表时，搜索、筛选、当前表与选中记录保持稳定。

### 失败与空状态

- 无记录：显示一个明确主行动，而不是巨型营销 Hero。
- 当前记录被删除或筛选移出：关闭详情并将焦点返回列表，不保留幽灵选择。
- Agent/后端不可用：详情仍可读；`OfferU` 页签给出可恢复错误，不阻塞投递列表。
- 窄屏：详情和 Agent 复用同一个底部 sheet，不同时叠加两个浮层。

## 4. 允许修改的精确文件范围

实现 Agent 只能修改下列文件；发现必须越界时停止并使用 ASK 请求新授权。

### 4.1 允许修改的现有文件

| 文件 | 唯一允许职责 |
| --- | --- |
| `frontend/src/app/layout.tsx` | 接入 `WorkbenchShell`，移除根布局中与新壳层冲突的固定内容宽度/间距 |
| `frontend/src/app/providers.tsx` | 在 `/applications` 禁用旧浮动 Harness Agent，其他未迁移页面暂时保留；不改 SWR、启动门或 onboarding 业务 |
| `frontend/src/app/globals.css` | 增补/收敛工作台颜色、密度、边界、焦点和动效令牌；不做全站机械换类名 |
| `frontend/src/components/layout/Sidebar.tsx` | 改为求职流程分组导航、紧凑态和移动端入口；不复制路由业务逻辑 |
| `frontend/src/components/ai/HarnessAgentDock.tsx` | 抽出可嵌入模式并复用现有会话/确认逻辑；浮窗模式仅作为未迁移页面过渡 |
| `frontend/src/app/applications/page.tsx` | 保留数据编排和写操作入口，接入选择态、检查器和拆分后的视图组件 |
| `frontend/src/app/resume/page.tsx` | 只把 `/* 缩略图占位 —— 柔和灰底 */` 修成合法 JSX 注释；禁止其他调整 |

### 4.2 允许新增的文件

| 文件 | 职责 |
| --- | --- |
| `frontend/src/components/workbench/WorkbenchShell.tsx` | 桌面三栏、平板弹性栏、移动端 sheet 的统一壳层 |
| `frontend/src/components/workbench/WorkbenchContext.tsx` | 页面向壳层注册标题、选中对象和右栏内容的最小上下文接口 |
| `frontend/src/components/workbench/ContextRail.tsx` | `详情 / OfferU` 双页签、折叠状态、焦点与响应式呈现 |
| `frontend/src/components/workbench/CommandPalette.tsx` | `Ctrl/Cmd + K` 导航和页面命令入口；不承载业务写逻辑 |
| `frontend/src/app/applications/components/ApplicationTable.tsx` | 紧凑表头、记录行、选择态、键盘导航和现有内联编辑呈现 |
| `frontend/src/app/applications/components/ApplicationInspector.tsx` | 当前投递记录的只读摘要与已存在的轻量操作入口 |
| `frontend/src/app/applications/components/ApplicationDialogs.tsx` | 收拢现有表管理、导入、字段、移动和删除弹窗；不改变数据契约 |

### 4.3 明确冻结

- `backend/**`
- `frontend/src/lib/api.ts`
- `frontend/src/lib/hooks.ts`
- `frontend/package.json` 和锁文件
- 除上述一行语法修复外的 `frontend/src/app/resume/**`
- 岗位、优化、面试、档案、日程、邮件、分析页面
- 数据库、领域模型、Operation Registry、Agent skill 与确认协议

## 5. 实施顺序

### 阶段 0：恢复可审计基线

- 只修复 `/resume` 的非法 JSX 注释。
- 不格式化整个文件，不顺带处理卡片样式或现有用户改动。
- 记录该修复为独立 diff，后续若仍有编译问题则停止，不扩大简历范围。

验收映射：所有路由不再被这一个已知语法错误连带阻塞。

### 阶段 1：建立可渐进迁移的工作台壳层

- `WorkbenchShell` 接管主布局，但不得要求所有页面同批重写。
- 桌面使用导航 / 主内容 / 上下文栏；未注册上下文的旧页面保持主内容可用。
- `Sidebar` 改为五组流程导航：今日、机会、材料、进展、系统；低频项折叠。
- `WorkbenchContext` 只保存视图上下文，不保存领域事实或复制服务端状态。
- `CommandPalette` 首片只提供路由跳转、打开当前详情、切换 `OfferU` 等可逆命令。

验收映射：换壳后旧页面仍可进入；导航结构清楚；无新的业务 API。

### 阶段 2：拆出投递列表的视图边界

- `applications/page.tsx` 继续持有现有 hooks、数据加载和 mutation handler。
- 把表格、检查器和弹窗拆成三个有真实职责的组件，不创建通用 schema renderer。
- 列表行高目标 40–44px，表头 36–40px；主操作保留，低频操作进入 `…` 或现有弹窗。
- 行点击负责选择；checkbox、链接、菜单、内联编辑必须阻止冒泡，不能误开详情。
- 当前表、查询、筛选、选择态分别管理，避免一个交互重置全部页面状态。

验收映射：原有建表、改名、导入、编辑、移动、删除与邮件同步入口仍存在；列表信息密度显著提高。

### 阶段 3：接入统一上下文栏

- 选择记录后默认打开 `详情`；关闭后焦点回到触发行。
- 详情栏先展示高价值字段，再渐进披露自定义字段和次级元数据。
- `OfferU` 页签嵌入 `HarnessAgentDock` 的内容模式，复用原会话、流式事件、历史、tool call 和 proposed action。
- 不把当前记录直接写入 Agent 长期 memory；上下文快捷提问携带记录 ID/摘要，Agent 再通过现有工具读取事实。
- `/applications` 不再显示漂浮机器人；其他未迁移页面仍使用浮窗，直到各自迁移切片完成。

验收映射：同一时刻只有一个右侧上下文容器；不存在详情抽屉 + Agent 浮窗互相遮挡。

### 阶段 4：响应式、动效与无障碍收口

- `>= 1280px`：持久导航 + 弹性主区 + 约 360px 右栏；主区不得低于可读宽度。
- `768–1279px`：导航紧凑，右栏按需覆盖或压缩；保持选择上下文。
- `< 768px`：列表为主；详情/OfferU 使用同一个 bottom sheet，只承诺查看、筛选和轻量状态更新。
- hover/tap 位移控制在 1–2px；展开、切换和选中使用快速可中断弹簧。
- `prefers-reduced-motion` 下移除位移动效，仅保留必要的透明度/状态变化。
- 所有图标按钮有可访问名称；焦点环清晰；`Esc` 关闭 palette/sheet，关闭后恢复焦点。

验收映射：鼠标、键盘和触屏都能完成主路径；动画不阻塞输入，也不会引发布局大幅跳动。

## 6. 状态与组件所有权

| 状态 | 所有者 | 原因 |
| --- | --- | --- |
| 投递表、记录、分页、筛选结果 | `applications/page.tsx` + 现有 hooks | 保持当前数据事实源 |
| 当前选中记录 ID | `applications/page.tsx` | 与列表生命周期一致 |
| 右栏开关、活动页签、移动端 sheet | `WorkbenchContext` / `ContextRail` | 属于跨页面壳层视图状态 |
| Agent 消息、会话、确认动作 | `HarnessAgentDock` 嵌入模式 | 禁止产生第二份 Agent 状态机 |
| 命令面板开关与检索词 | `CommandPalette` | 短生命周期、无领域含义 |

领域记录不能复制进全局 React context；右栏只接收当前视图所需的对象引用/摘要。

## 7. 动效与视觉令牌验收值

- 快速反馈：120–160ms。
- 普通过渡：180–240ms。
- 弹簧参考：`stiffness 400–480`、`damping 32–40`，以无明显回摆为准。
- 圆角：主容器/弹层 8–10px，控件 6–8px；不使用胶囊化包裹所有内容。
- 阴影：只用于浮层分离；常驻面板以 1px 边界和底色区分。
- 品牌暖红只用于主 CTA、关键进展和焦点强调，不用于大面积背景。
- 禁止 `transition-all`；逐项声明实际变化属性。

## 8. 必须保持的行为

- 当前所有投递表管理、导入、字段配置、移动、删除和邮件同步能力不得消失。
- mutation 不得用固定假结果、静默成功或本地伪状态掩盖失败。
- Agent proposed action 的确认门、工具白名单和审计语义不变。
- 不引入 HeroUI/Tailwind/Next/React 大版本迁移；依赖升级另立计划。
- 不把 WebUI 的 `Ctrl/Cmd + K` 强行复制到 TUI；两者共享能力语义，不共享表现层。

## 9. 验收清单

### 桌面

- [ ] 流程导航可理解，当前“投递进展”位置明确。
- [ ] 首屏没有营销 Hero，列表在合理高度内展示更多有效记录。
- [ ] 点击记录打开右栏；切换 `详情 / OfferU` 不丢失选择。
- [ ] `Ctrl/Cmd + K` 可打开命令面板，`Esc` 可关闭并恢复焦点。
- [ ] `/applications` 不再出现漂浮机器人。

### 数据与 Agent

- [ ] 原投递管理功能均保留，错误反馈仍可见。
- [ ] Agent 会话、历史、流式进度、工具结果与确认动作沿用原逻辑。
- [ ] 当前记录上下文不会未经确认写入职业事实或长期记忆。
- [ ] Agent 故障不阻塞列表和详情读取。

### 响应式与无障碍

- [ ] 1440px、1024px、768px、390px 四个视口无横向页面溢出。
- [ ] 移动端详情与 OfferU 共用一个 sheet，不出现双层浮窗。
- [ ] 键盘可选择行、切换页签、关闭浮层；交互控件有可访问名称。
- [ ] reduced motion 下无大幅位移或弹性回摆。

### 回归边界

- [ ] 未迁移页面仍可导航和使用原 Agent 浮窗。
- [ ] `/resume` diff 只有已授权的一行语法修复。
- [ ] 无 backend、API、hook、依赖和锁文件改动。

## 10. 不执行的验证与使用者建议命令

遵循项目 `AGENTS.md`，实现 Agent 完成代码后不运行构建、语法检查或测试，只报告建议命令。建议由使用者执行：

```powershell
cd frontend
npm run dev
```

前端 dev 端口保持项目约定的 `3300`。随后按第 9 节进行四个视口的 Playwright/浏览器人工验收。若使用者另行要求测试，再单独授权对应命令。

## 11. 停止条件

遇到以下任一情况，实施 Agent 必须停止并使用 ASK：

- 必须修改第 4 节之外的文件；
- 需要改变投递数据契约、后端接口或 Operation Registry；
- 现有 Agent 无法以嵌入模式复用，必须创建新状态机；
- 修复一行 JSX 注释后 `/resume` 仍有其他语法阻塞；
- 需要牺牲已有投递操作才能完成视觉结构；
- 工作区用户改动与计划修改位置发生无法安全合并的冲突。

## 12. 完成报告格式

实现完成后只按以下四项报告：

1. 修改文件；
2. 第 9 节验收映射；
3. 未执行命令及建议由使用者执行的命令；
4. 剩余风险和任何未完成项。

本文已由使用者确认；进入实现仍需由使用者单独发出实施指令。
