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
| `primary` | 墨黑胶囊、白字 | 这一屏唯一的主操作（添加岗位、保存、下载 PDF） |
| `secondary` | 白胶囊 + 极淡阴影（`--ou-capsule-shadow`），悬停阴影变大，无描边 | 并列的次要操作 |
| `ghost` | 无底，悬停半透明墨底 | 工具栏图标、行内操作 |

高 32px（`sm` 28px），v3 全部是胶囊（`--ou-radius-button`），13px / 550。图标按钮 `.ou-icon-button` 是 32px 圆形；一串图标按钮放进 `.ou-button-group`（磨砂胶囊轨道，悬停的那颗变白胶囊），对应 Bleep 的 ‹ › / 搜索 / 「…」。禁止彩色按钮；破坏性操作用 `secondary` + 二次确认，不用红底。

## Field / Input

标签（13px / 500）→ 控件 → 一行提示或错误（12px）。输入框实白 + 白胶囊阴影、12px 圆角、无描边，悬停阴影加深，聚焦是焦点环。正文字体，不用等宽。说明超过一行就放「了解更多」。文档里的字段（简历编辑器）不用输入框外观，见下面「文档视图」。

## Select（Radix Select）

替代所有原生 `<select>`。触发器同 Input；选项面板是 L3 浮层，至少与触发器同宽；选项可带图标和一行描述（例如模型预设：图标 + 名称 + 「Base URL 自动填好」）。

## Switch（开关）

`<Switch checked onCheckedChange aria-label>`：`role="switch"` 的原生按钮（空格 / 回车切换），胶囊轨道 + 白圆钮；开 = 墨黑轨道（同主按钮那支墨，不用彩色），关 = 半透明墨（`--ou-line-control`）；圆钮弹簧滑动，reduced-motion 下不动画；禁用 45% 透明（如简历「基础信息」锁定常开）。只表示「显示 / 启用」这类即时生效的二元状态；要提交的选项用勾选。必须有 `aria-label` 或可见文字。

看：`#/resume` 左栏「我的模块 / 更多模块」。

## DatePicker（`components/ui/DatePicker.tsx`，Radix Popover）

替代原生 `<input type="date">` / `type="datetime-local"`（系统弹层不跟玻璃风格、深色下发白、中文格式不统一）。值的格式与原生一致：`YYYY-MM-DD`，`withTime` 时 `YYYY-MM-DDTHH:mm`，空串 = 未填，可直接替换。

- 触发器同 Input（`size="sm"` 是 28px 胶囊，同 Select）：日历图标 + 「11月16日 周一 14:00」，不是今年才带年份；未填显示占位（默认「选日期」/「选日期和时间」）。
- 浮层同 Popover 的浅色玻璃：「2026 年 11 月」+ ‹ ›（`.ou-button-group`）→ 周一开头的 6×7 日期格（`.ou-date-day`，圆形；非本月浅色；**今天橙字**、选中墨黑实心，今天又被选中时橙底墨字——与周日历一致）→ `withTime` 时「时间」一行两个 `Select`（时 00–23、分 00/15/30/45）→ 底部「清除」「今天」（ghost），`withTime` 再加「完成」。
- 只选日期时点一下就关；带时间时选日期不关，接着调时间。键盘：打开后焦点在当前日期，←→ 一天、↑↓ 一周、PageUp / PageDown 换月，回车选中，Esc 关并把焦点还给触发器。
- 纯逻辑 `parseDateValue / monthGrid / formatDateValue` 有 vitest（`ui.test.ts`）。
- 表格单元格就地编辑：`defaultOpen` 挂载即打开，`onOpenChange(false)`（选完、清除、Esc、点别处都会触发）时退出编辑态；值在 `onChange` 里即存，不等失焦。
- 放进自己处理 Esc 的容器（抽屉、行内表单）时，容器先看 `event.defaultPrevented`：Radix 关浮层时会 `preventDefault`，这样 Esc 只关浮层。行内表单「失焦即关」要放过焦点进出 `[data-radix-popper-content-wrapper]`（浮层 portal 在 body 上，但 React 事件仍冒泡回表单）。

看：今天页「要做的事」底部「加一件事」的时间胶囊；`#/jobs?view=calendar` 右上 + →「时间」；面试复盘页的「面试日期」；岗位表格「投递日」双击；岗位详情抽屉「投递日」。

## Menu（Radix DropdownMenu）

「更多」、行操作、状态切换。v3.1 是**浅色玻璃**（参考 Inspora · Mona「feature menu」改成浅色）：面板 `--ou-glass-menu`（白 70%）+ `--ou-glass-blur-heavy`（40px）模糊、`--ou-radius-menu`（22px）、`--ou-elev-menu`。每项是一行 `--ou-menu-row`（40px）胶囊 = 16px 图标 + 文字 + 可选 `description`（第二行小字）+ 可选快捷键；层级只靠同一支墨色的透明度（`--ou-alpha-*`），不靠字重。悬停 / 键盘高亮 = 白胶囊浮起 + 文字右挪 `--ou-nudge` + 右侧小箭头淡入（`--ou-ease-spring-soft`）。`{ heading }` 项是分组小标题；危险项放最后、红字（`--ou-tone-red-text`），中间用 `"separator"`。可选 `label` 作为浮层的 `aria-label`。

看：`#/jobs` 任一行的「…」、日历色块右上「…」、Agent 头部「…」。

可选 `checked`：单选组（Agent 输入框的模型 / 思考强度 / 模式）里当前那一项，行尾一个对勾，读屏读作 `menuitemradio`；带 `description` 的两行项上下各留 4px。

可选 `side`，以及受控的 `open / onOpenChange`：调用方自己决定何时打开。例：简历要点的「⋮⋮」把手——按下后移动是拖动排序，没移动松手才开菜单；触发器的 `onPointerDown` 里 `preventDefault()` 就能跳过 Radix 默认的「按下即开」，键盘 Enter / Space 仍由 Radix 打开。可选 `onCloseAutoFocus`：某一项要把焦点放到别处（如「在下面加一条」后的新块）时在这里 `preventDefault()`，否则关菜单会把焦点还给触发器。

## Popover（Radix Popover）

筛选、排序、字段、行高、上下文用量、日历「新建事项」。和 Menu 同一块浅色玻璃（22px 圆角、白 70% + 40px 模糊、`--ou-elev-menu`），内边距 12px，最小宽 16rem，贴边自动翻转（`collisionPadding` 12）。可选 `side`、`style`、`label`（`aria-label`）。

## LabelPicker / Tag / BrailleLoader（`components/ui/LabelPicker.tsx`）

参考 Inspora · kian bazza「Morphing braille loader」。

- **LabelPicker**：标签（多选）或状态（`multiple={false}`，点一下选中并关闭）选择器。浅色玻璃浮层，顶上一行搜索（`placeholder` 默认「搜索或创建标签…」）；下面一行一个「色点 + 名字」（`.ou-label-row`），悬停 / 方向键高亮是浅灰圆角底；勾选框（`--ou-check-size` 18px、`--ou-radius-check`）只在悬停或已选时出现，已选 = 墨黑实心 + 白勾。传了 `onCreate` 才出现「创建标签：xxx」行；返回的 Promise 结束前整块浮层变淡（`data-busy`）。选项颜色走 `toneOf()`，与表格 / 看板 / 甘特同色。
- 列表放不下时底部渐隐（`.ou-scroll-fade-y`，`--ou-scroll-fade-y` 2rem），滚到底渐隐消失，不再硬切半行。
- **Tag**：`<Tag tone>` = 色点（`--ou-tag-dot` 8px）+ 名字的 chip（`.ou-tag`），和选择器里的行一个样子；传 `onClick` 时是按钮。
- **BrailleLoader**：`state = idle | creating | created`，同一个字形位置上 标签图标 → 2×4 盲文点阵轮流亮 → 对勾画出；头部动词同步「创建 → 创建中 → 已创建」。`prefers-reduced-motion` 下不轮播。

看：`#/jobs` 表格视图，点状态胶囊（`button[title="改状态"]`）或标签格（`button[title="改标签"]`），输入一个不存在的名字回车看创建动画。

## Dialog（Radix Dialog）

L4 磨砂（20px 圆角）+ 带 6px 模糊的遮罩。宽 min(32rem, 视口 − 两侧留白)。标题一行 → 描述 → 内容 → 底部右对齐操作（主按钮在最右）。Esc 和点遮罩关闭，焦点锁定与归还由 Radix 负责。

## Panel（侧栏面板：Agent 栏、详情抽屉）

- **一个标题行**：磨砂小方块里的图标 + 标题 + 一行副标题 + 右侧图标按钮。不要「应用名标题 + 面板标题」两层叠着。v3 标题行下面不画分隔线。
- 分节直接铺在面板底色上，节与节之间靠留白分开（v3 不画分隔线）；**不在灰底里再套白卡**。
- 示例（Agent 模型配置）：标题「OfferU Agent · 未配置模型」→ 预设（Select，带 Provider 图标）→ API Key（Input + 显示 / 隐藏）→ 「高级」折叠里放 Base URL 和模型名（选了预设自动填）→ 一行安全提示 +「了解更多」→ 主按钮「保存并开始」。

## Pill（状态 / 标签胶囊）

浅底 + 深字 + 同色极淡 1px 内描边 + 6px 圆点，12.5px / 500，全圆角。`<Pill tone={toneOf(text)}>`；状态用 `STATUS_TONE`。胶囊里的字必须能单独说明含义。

## Card（`.ou-card`）

L2：白 84%、**无描边**、`--ou-elev-2`（0 12 32 / 10%）、18px 圆角；悬停 `--ou-elev-2-hover`、上移 2px。

## 玻璃材质类（v3，`components.css`）

| 类 | 是什么 | 用在 |
| --- | --- | --- |
| `.ou-glass` | 磨砂窗格：`--ou-glass-bg` + 模糊 + 顶部一道高光 + `--ou-elev-pane` | 侧栏（`.offeru-sidebar`）、右上角 Agent 开关 |
| `.ou-sheet` | 半透明白纸：`--ou-bg-surface` + `--ou-elev-2` + 20px 圆角 | 今天页「要做的事 / 最近改动」、面板 |
| `.ou-tile` | 28px 磨砂图标方块（`--ou-radius-tile`） | 侧栏导航、面板标题图标 |
| `.ou-capsule-row` | 玻璃上的列表行：悬停半白、`aria-current` / `data-selected` 是实白胶囊 | 侧栏导航 |
| `.ou-segment` + `.ou-segment-item` | 玻璃轨道 + 白胶囊选中段（认 `aria-current` / `aria-checked` / `aria-selected`） | 二级标签、视图切换、岗位视图 tab |
| `.ou-button-group` | 一串圆形 ghost 钮的磨砂胶囊 | 岗位工具条 |
| `.ou-chip` + `.ou-chip-check` | 筛选 chip，空心圆勾选，`aria-pressed` 时填墨黑 | 筛选（待接入） |
| `.ou-fade-bottom` | 底部渐隐遮罩 | 卡片放不下的文字 |
| `.ou-scroll-fade-x` / `-y` + `useScrollEdges()`（`lib/scrollEdges.ts`） | 滚动容器边缘渐隐：只在那一侧还有内容时出现（`data-more-start / -end`），滚到头消失；横向尾部宽 `--ou-scroll-fade-x`（5rem），一眼看出还能横滚 | 看板轨道、LabelPicker 列表 |
| `.ou-jobs-sheet` | 岗位表格的大圆角实白纸 | JobsTable |

## 简历编辑器三栏（v3.1，2026-11-14，参考 offershow）

左栏 `ModuleList`（`.rm-*`：把手 · 名字 · … · Switch，选中白胶囊）· 中 `ResumePreview` · 右栏 `.ou-segment` 标签 + `ModuleEditor`（`.re-item`：条目头「名称 N · 删除 · 虚线 · ↓ ↑」+ `.re-fields` 两列 `Field / Input / Select` + 带常驻格式条的 `RichText toolbar`）/ `StyleTab` / `TemplateTab`；顶栏 `ResumeActions`（保存 · 导出 ▾ 主按钮 · 分享 ▾，菜单都是 `Menu`）。样式在 `styles/resume-editor.css`，规格见 DESIGN.md「简历编辑器」。

## 文档视图（简历编辑器，v3）

参照 Bleep 文档视图 / Notion：一张半透明白纸，模块是 20px 粗体标题，正文 16px / 1.6 直接写在纸上（`RichText` 无框无聚焦环，空块只在聚焦时显示占位）；属性（公司 / 职位 / 城市 / 时间、联系方式）是「灰色小标签 + 纸上的值」，悬停浅底、聚焦浅灰底。要点一行一块，左侧留白里悬停出「+」和「⋮⋮」（拖动排序 / 单击开 `Menu`），绝对定位、不占正文宽度。低频操作悬停或键盘聚焦才出现。样式在 `globals.css` 的 `.resume-shell .rf-*` / `.rt-*`。

## 色块（`.ou-swatch`，参考 Inspora · sam「Event Swatch」）

粉彩面 = 语气色浅底与中间色按 `--ou-swatch-mix` 混合；内白边 `--ou-swatch-rim`；底边深一截 `--ou-swatch-edge`（3px，表示厚度）；`--ou-radius-swatch`（16px）；阴影 `--ou-swatch-shadow`。颜色用 `.ou-tone-{hue}` 指定。悬停 / 键盘聚焦：上浮 + 放大 `--ou-swatch-scale`（1.04，spring-soft）+ `--ou-swatch-shadow-hover`；拖动：`lib/dragLift.ts` 在屏幕外放一张已倾斜 `--ou-swatch-tilt`（-5°）+ `--ou-swatch-shadow-drag` 的副本当拖动图（光标保持箭头），原卡 `data-dragging` 变淡。子元素：`.ou-swatch-top`（左上类型图标）、`.ou-swatch-more`（右上「…」，开 Menu）、`.ou-swatch-meta`（时间 · 类型 · 公司）、`.ou-swatch-title`（粗体标题）、`.ou-swatch-hidden`（「+N 隐藏」胶囊）。

## 周日历（JobsCalendar，`#/jobs?view=calendar`）

- 岗位页视图分段「表格 / 看板 / 甘特 / 日历」的第四项；旧的 `#/calendar` 跳到这里。纯逻辑在 `lib/weekCalendar.ts`（周起止、ISO 周、按天叠摞、15 分钟吸附），有 vitest。
- 网格无框：只有 `--ou-line-faint` 整点线，周末列再淡一层；高度 `--ou-cal-hour`、时间列 `--ou-cal-gutter`、一天最窄 `--ou-cal-day-min`。
- 工具条（`.ou-cal-toolbar`）只有胶囊：「今天」白胶囊、‹ › `.ou-button-group`、「2026 年 11 月 · 第 46 周」、右侧白色 + 圆钮（`.ou-cal-plus`，开 Popover：标题 / 类型 Select / 时间）。
- 只有「今天 / 现在」用橙色：今天的日期是橙色实心圆（墨色字），现在是一条橙线 + 左侧时间胶囊。
- 事项是 `.ou-swatch`，按类型取色；同时段的叠成一摞（后面的下移、略小、只露底边），最上面一张带「+N 隐藏」，点开并排展开。拖到别的格子按 15 分钟吸附改 `at`（走现有 `save`，可撤销）。事项只有开始时间，按 110 分钟画高度。

## 看板（JobBoard）

- 今天页「投递看板」和岗位页看板是同一个组件。
- 轨道 `.ou-kanban-track`：横向滚动、按列吸附（proximity），左右出血到页面边缘。放不下时（开着 Agent 栏、窄窗口）右缘 5rem 渐隐（`.ou-scroll-fade-x`），滚过之后左缘也渐隐，滚到最右边右缘渐隐消失。
- 列 `.ou-kanban-column`：玻璃底（`--ou-glass-subtle`）、20px 圆角、8px 内边距；`flex: 1 0 0`，在 `--ou-kanban-column-min`（12.5rem）和 `--ou-kanban-column`（≤ 22rem）之间平分宽度——1440×900 下五列完整放下。列头「状态胶囊 + 灰色数量」。
- 卡片 `.ou-kanban-card` = `.ou-swatch` + 按状态取色（想投灰、已投递蓝、笔试黄、面试橙、offer 绿）；公司 600、岗位 / 元数据用 `--ou-pill-text`；标签是 `Tag`。悬停放大、拖动倾斜同色块。
- 标签筛选是分段胶囊（`.ou-segment`）；「已结束 N」收起钮在筛选那一行右端，不占轨道宽度。
- 列底「+ 新建」：无描边灰字，悬停白胶囊。拖拽悬停列：焦点环（`--ou-ring-focus`）。

看：`#/`（今天）、`#/jobs` → 看板。

## 表格（JobsTable）

Notion 式：整张表放在 20px 圆角的实白纸上（`.ou-jobs-sheet`，L2 阴影）；只有极淡横线；表头 13px 三级色 + 字段类型小图标；行悬停半透明墨底。视图 tab 是分段胶囊，右侧工具是 `.ou-button-group`。状态 / 标签用 Pill。勾选列 + 主字段冻结。筛选 / 排序 / 字段 / 行高用 Popover（迁移中）。

## ⌘K 命令面板

浅色玻璃外壳（`--ou-glass-menu` + 重模糊、`--ou-radius-menu`、`--ou-elev-menu`），遮罩 `--ou-scrim`，层级 `--ou-layer-command`。v3.1 两栏：左边**索引**（顶上输入框 + 分组列表，行同 Menu：40px 白胶囊、悬停右挪 + 箭头）；右边**预览**（`.offeru-command-preview`：磨砂图标块——Agent 动作是紫色——+ 标题 + 一行说明 + 一张小卡「打开页面 · 路径」或「会交给右侧 OfferU · 提示词」+ 底部「↵ 打开 / 提问 / 执行」），随方向键高亮就地换。窄屏只留索引。行为见 `docs/DESIGN.md` §11.2。

看：任意页按 ⌘K / Ctrl K，方向键上下。

## Agent 窗格 + 输入框（`AgentPanel.tsx`，参考 Inspora · Seb Cornelius「composer mockup」）

- **窗格**：`ContextRail` / 专注模式的 `.offeru-focus-agent` 都是 `.ou-glass` 浮动窗格，和左侧侧栏对称（离边 `--ou-pane-inset`、`--ou-radius-panel`）；`xl` 以下是抽屉，层级 `--ou-layer-drawer`，遮罩 `.offeru-rail-scrim`（`--ou-layer-drawer-scrim` + `--ou-scrim`）。
- **头部一行**（`.agent-head`）：紫色身份小方块（`--ou-tone-purple-*`，紫色只属于 Agent）+「对话标题 ▾」胶囊（展开历史）+ 圆形 ghost 钮「…」（Menu：新对话 / 历史对话 / 外部执行器会话）和「×」收起。标题行下不画分隔线。
- **空状态**：只有欢迎语时画成问候「今天想让 OfferU 帮你做什么？」+ 一行说明 + 建议胶囊（量化实习、今天要做的事、整理面试邀约、先投哪个），点了直接发。
- **输入框**（`.agent-composer`，`data-testid="agent-composer"`）：一张 `--ou-radius-composer`（26px）浅色玻璃卡、`--ou-elev-composer`；从上到下 正文 → 附件 → 底栏（方形「+」附件钮、模型 / 模式胶囊——点开是 `Menu`（`side="top"`，模型 + 思考强度一张、模式一张，当前项打勾）、右侧墨黑「发送 ↑」胶囊，没东西可发时 32% 透明度）。聚焦是整卡 `--ou-ring-composer`；拖入文件是整卡紫环 `--ou-ring-agent` + 一行「松开即可添加…」，不用虚线框。回车发送（输入法选词时不发），Shift+Enter 换行。发送时整卡轻压（`data-sent`）；正在跑且没东西可发时，发送键收成 5×5 像素格加载（`.agent-pixel`，格子圆角 `--ou-radius-pixel`，`steps()`，reduced-motion 下静止）。
- **附件**（`AgentAttachmentTray`）：图片按 1 → 2 → 1+2 → 田字拼贴（`.agent-mosaic`，`--ou-radius-swatch`），悬停出删除钮，超过 4 张显示「+N」；文档是小胶囊，出错时红色内环 `--ou-ring-error`。

看：任意页点右上角 bot 钮（1440 宽约在 (1408, 32)），再在输入框里打字。

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
