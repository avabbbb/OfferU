# OfferU 组件规范

> 配合 [visual-system.md](visual-system.md)。代码在 `frontend/src/components/ui/`，样式在 `frontend/src/styles/components.css`，只用 `--ou-*` Token。

## 为什么要有组件层

此前规范只有「颜色和禁令」，没有现成组件，所以每次写界面（无论人还是 AI）都在用 Tailwind 从零拼一个下拉、菜单、表单，细节全靠即兴：两层标题、灰底里套白卡、原生下拉框、等宽字体的输入框、大段说明堆在正文。组件层把这些决定一次做对：

- **行为层：Radix Primitives**（无样式，React 18 可用）。键盘导航、焦点锁定与归还、碰撞翻转、屏幕阅读器语义这些最容易做差的部分交给它。shadcn 和 Motif 都建在 Radix 上，所以以后从它们拷组件只需换样式。
- **样式层：`components/ui`**，每个组件只有少数几个变体。
- **Agent 层：`components/ui/agent`**，从 [Motif](https://motif.sweetretry.com)（MIT，© SweetRetry）拷源码后改用 OfferU Token；不运行 `shadcn init`，避免引入第二套颜色变量。

规则：**新 UI 只组合 `components/ui`；缺组件就先在这里加组件、写进本文件，再在页面里用。** `design:audit` 的 `raw-control` 规则拦截裸 `<select>`、手写 `role="menu"` / `role="listbox"`。

## Button

| 变体 | 外观 | 何时用 |
| --- | --- | --- |
| `primary` | 墨黑实心、白字 | 这一屏唯一的主操作（添加岗位、保存、下载 PDF） |
| `secondary` | 白底 + L2 | 并列的次要操作 |
| `ghost` | 无底，悬停 N4 | 工具栏图标、行内操作 |

高 32px（`sm` 28px），圆角 6px，13px / 550。禁止彩色按钮；破坏性操作用 `secondary` + 二次确认，不用红底。

## Field / Input

标签（13px / 500）→ 控件 → 一行提示或错误（12px）。输入框白底 + L1，悬停描边加深一级，聚焦是 N8 描边 + 3px N5 光晕。正文字体，不用等宽。说明超过一行就放「了解更多」。

## Select（Radix Select）

替代所有原生 `<select>`。触发器同 Input；选项面板是 L3 浮层，至少与触发器同宽；选项可带图标和一行描述（例如模型预设：图标 + 名称 + 「Base URL 自动填好」）。

## Menu（Radix DropdownMenu）

「更多」、行操作、状态切换。每项 = 16px 图标 + 文字 + 可选快捷键；高亮是 N4 圆角底，不加描边；危险项放最后、红字（`--ou-tone-red-text`），中间用分隔线。

## Popover（Radix Popover）

筛选、排序、字段、行高、上下文用量。L3，内边距 12px，最小宽 16rem，贴边自动翻转。

## Dialog（Radix Dialog）

L4 + 遮罩。宽 min(32rem, 视口 − 两侧留白)。标题一行 → 描述 → 内容 → 底部右对齐操作（主按钮在最右）。Esc 和点遮罩关闭，焦点锁定与归还由 Radix 负责。

## Panel（侧栏面板：Agent 栏、详情抽屉）

- **一个标题行**：图标 + 标题 + 一行副标题 + 右侧图标按钮。不要「应用名标题 + 面板标题」两层叠着。
- 分节直接铺在面板底色上，节与节之间 1px 分隔线；**不在灰底里再套白卡**。
- 示例（Agent 模型配置）：标题「OfferU Agent · 未配置模型」→ 预设（Select，带 Provider 图标）→ API Key（Input + 显示 / 隐藏）→ 「高级」折叠里放 Base URL 和模型名（选了预设自动填）→ 一行安全提示 +「了解更多」→ 主按钮「保存并开始」。

## Pill（状态 / 标签胶囊）

浅底 + 深字 + 同色 1px 内描边 + 6px 圆点，12.5px / 500，全圆角。`<Pill tone={toneOf(text)}>`；状态用 `STATUS_TONE`。胶囊里的字必须能单独说明含义。

## Card（`.ou-card`）

L2：白底、1px N6、0 1 2 / 6% 阴影、10px 圆角；悬停描边加深一级、阴影 0 4 12 / 9%、上移 1px。

## 看板（JobBoard）

- 列：N3 底、14px 圆角、8px 内边距，宽 `--ou-kanban-column`（16–22rem 流动），列头「状态胶囊 + 灰色数量」。
- 卡片：`.ou-card`，内边距 12 / 10px；标题 14px / 600，岗位 13px 次要色，元数据 12px 三级色（分数、下一件事、标签）。
- 列底「+ 新建」：无描边灰字，悬停 N4 底。
- 拖拽悬停列：焦点环（N8 描边 + N5 光晕），不再用蓝色。
- 轨道横向滚动、按列吸附，左右出血到页面边缘。

## 表格（JobsTable）

Notion 式：白底、无外框、无竖线，只有 N6 横线；表头 13px 三级色 + 字段类型小图标；行悬停 N4。状态 / 标签用 Pill。勾选列 + 主字段冻结。筛选 / 排序 / 字段 / 行高用 Popover（迁移中）。

## ⌘K 命令面板

L4 外壳 + 毛玻璃（`--ou-glass-*`），14px 圆角，遮罩 `--ou-scrim`，层级 `--ou-layer-command`。行为见 `docs/DESIGN.md` §11.2。

## Agent 运行（参考 Inspora · Jessy Barret「agent dashboard」，Minimal / Rounded）

- **一行步骤就地替换**：运行中的任务标题下只有一行动名词短句（「正在读岗位 JD」→「对比你的经历」→「写打招呼」），200ms 淡入淡出替换；结果也写进这一行（「找到 3 个匹配岗位」）。完整步骤时间线折叠在后面。
- **运行胶囊**：输入框上方一个小胶囊：「OfferU 正在想 ···」→「2/4 正在改简历」→「已完成 ✓」。
- **进度靠收起和计数**，不用进度条：完成的行打勾、变淡、收起，标题旁的计数递减。
- **一个饱和色**：橙色只给「交给 OfferU」这一个委托动作；蓝色只表示完成 / 选中；其余黑白灰。
- **悬停不加描边**：行悬停是一块稍深的圆角底。
- **任务与 Agent 对得上**：同一个小图标同时出现在岗位卡和 Agent 运行里。

### 已实现（2026-11-13）

- `AgentRunPill`（`AgentPanel.tsx`）：运行中的那一行变成浮起胶囊：呼吸紫点 + 扫光文字（换字时 `.ou-swap` 就地淡入）+ 「N 步 · 秒数」。
- 完成后的工具调用默认折叠成「› 已处理 · N 次工具调用」（参考 Motif agent-activity），展开后逐行错开进场。

### Context Meter 数据（2026-11-13）

后端 `embedded_agent_worker` 在每轮 `kernel.turn_end` 事件里带 `context_usage: { used, window, compact_at, estimated }`（窗口 64k，56k 起压缩）。模型回传 usage 就用真实值，网关不回传时按消息估算并标 `estimated`。前端 `lib/agentContextUsage.ts` 解析，拿到才在发送键左边显示环，56k 起转琥珀。字段名避开 `token`，否则会被脱敏抹掉。

## ContextUsageRing（改编自 Motif context-usage）

放在 Agent 输入框角落：20px 圆环 + 百分比；80% 起琥珀、100% 红，颜色之外始终有百分比文字。点开是 L3 Popover：「已用 / 上限」「百分比」、一条用量条、「还剩 N tokens」。数据需要后端在 run 事件里给 token 用量，接上之前不在界面显示。
