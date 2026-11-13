# OfferU Visual System · v2

> 状态：**有效规范**（2026-11-13 起）。取代 [v1](archive/visual-system-v1.md)。所有新增或迁移的界面以本文件为准；Token 在 `frontend/src/styles/design-tokens.css`，组件在 `frontend/src/components/ui/`，组件规格见 [components.md](components.md)。
>
> 参考：Apple HIG（Color / Layout / Materials / Accessibility）、Radix Colors 12 级色阶用途表、Figma 设计系统「原始色 → 语义 → 组件」三层 Token、Notion / 飞书的数据库视图、Inspora 上 Jessy Barret 的 *agent dashboard*（Minimal / Rounded）。只借思路，不声称与这些产品有设计关联。

## 中文速览（新 Agent 先读这一节）

1. **风格：Minimal。** 一条暖中性色阶撑起约 90% 的界面；墨黑做主按钮；橙色只表示「紧急 / 委托给 Agent」；紫色只属于 Agent；状态和标签一律「浅底 + 深字 + 同色描边 + 圆点」。
2. **按用途取色，不按深浅取色。** 页面里只写语义 Token（`--ou-bg-*`、`--ou-text-*`、`--ou-line-*`、`--ou-tone-*`），不直接写色阶编号，更不写 Hex。
3. **层级 L0–L4。** 画布 → 内容面 → 卡片 → 浮层 → 弹窗，每一级是一对固定的「描边 + 阴影」（`--ou-elev-*`）。同一视图最多一层带描边的容器。
4. **先有组件，再有页面。** 新 UI 只组合 `components/ui`；没有合适组件就先补组件。禁止裸 `<select>`、手写菜单 / 弹层 / 阴影（`design:audit` 会拦）。
5. **弹性布局。** 页面容器按类型取宽（reading / page / wide），留白 `--ou-gutter` 随视口从 390 流到 1920；二维数据（表格、看板、甘特）在自己的容器里横向滚动，不让整页滚。

![色卡 v2](assets/palette-v2.png)

## 0. 优先级

1. 产品行为：`docs/PRD.md`；架构：`docs/DESIGN.md`。
2. 视觉、交互、响应式：**本文件** + [components.md](components.md)。
3. 数值：`frontend/src/styles/design-tokens.css`（唯一允许写字面值的地方）。
4. `globals.css` 里的旧变量（`--foreground`、`--surface`、`--border`…）已全部用 `var()` 桥接到 `--ou-*`，旧页面自动跟随色卡 v2；新代码不要再引用旧变量。
5. 简历 PDF 模板是用户文档，配色独立于应用外壳，不随本规范改动。

## 1. 原则

- **内容优先**（HIG Deference）：界面退后，岗位、简历、Agent 的产出站前面。装饰性的色块、渐变、网格底、KPI 卡、徽章都不要。
- **一个颜色只表达一种意思**（HIG Color）：墨黑 = 主操作；橙 = 紧急 / 委托；紫 = Agent 来源；蓝 = 「已投递」状态；红 = 错误 / 截止 / 今天线。
- **层级靠字号、字重、颜色、留白**，边框和阴影只用于表达「浮起」。
- **渐进式披露**：当前状态 → 一个下一步 → 次要探索。长说明折进「了解更多」，表单里每个字段的提示不超过一行。
- **不只靠颜色**：每个状态色都配文字或图标。

## 2. 颜色

### 2.1 暖中性色阶 N1–N12（OKLCH 色相 55，低彩度）

| 级 | Token | 用途 | 语义别名 |
| --- | --- | --- | --- |
| 1 | `--ou-neutral-1` `#fffcf9` | 画布 L0 | `--ou-bg-canvas` |
| 2 | `--ou-neutral-2` `#fcf6f1` | 侧栏、Agent 栏 | `--ou-bg-sidebar` |
| 3 | `--ou-neutral-3` `#f6efeb` | 控件底、看板列底 | `--ou-bg-control` |
| 4 | `--ou-neutral-4` `#f1e9e4` | 悬停 | `--ou-bg-hover` |
| 5 | `--ou-neutral-5` `#ece3de` | 选中、按下 | `--ou-bg-selected` |
| 6 | `--ou-neutral-6` `#e3dad5` | 分隔线、非交互描边 | `--ou-line-separator` |
| 7 | `--ou-neutral-7` `#d7cec8` | 控件描边 | `--ou-line-control` |
| 8 | `--ou-neutral-8` `#c4bab4` | 强描边、焦点环 | `--ou-line-strong` / `--ou-focus-ring` |
| 9 | `--ou-neutral-9` `#928a85` | 占位符 | `--ou-text-placeholder` |
| 10 | `--ou-neutral-10` `#827a75` | 图标、三级文字 | `--ou-text-tertiary` |
| 11 | `--ou-neutral-11` `#69625d` | 次要文字（N2 上 5.6:1） | `--ou-text-secondary` |
| 12 | `--ou-neutral-12` `#231d19` | 主文字、主按钮（N2 上 15.5:1） | `--ou-text-primary` / `--ou-action-primary` |

内容面（表格、卡片、弹层、输入框）是纯白 `--ou-bg-surface`。侧栏 N2 与画布 N1 同一色相，只差一级，靠 1px N6 分隔线区分——不再出现「暖灰侧栏 + 冷白主区」两套颜色。

### 2.2 品牌角色

| 角色 | 值 | 只用于 |
| --- | --- | --- |
| Ink | `#201515` → 应用内用 N12 | 主按钮（一屏最多一个）、主文字 |
| Orange | `#FF4F00` | 今天线、截止临近、未读、「交给 OfferU」委托动作。不做普通按钮底色；橙底上用墨色字 |
| Agent Purple | `#2B2358` / Lilac `#C1B7FF` | Agent 面板身份、Agent 运行中高亮。表示「来源」，不表示成功或置信度 |
| Paper | `#FFF3E6` | 只用于官网和空状态插画，不做应用画布 |

v1 里「橙色主按钮」改为「墨黑主按钮」：Apple HIG 要求强调色只用在最需要的那一个控件上，而 OfferU 的主操作（添加岗位、保存、下载 PDF）出现频率高，用橙色会让每屏都有一块饱和色。橙色留给真正需要打断注意力的地方。

### 2.3 状态与标签色（`--ou-tone-{hue}-{bg|border|dot|text}`）

九个色相（灰、棕、橙、黄、绿、蓝、紫、粉、红），每个只取四级：浅底（3 级）、1px 描边（6 级）、圆点（9 级）、文字（11 级）。文字在底色上全部 ≥ 5.7:1（WCAG AA）。

- 投递状态六色：想投 / 不投了 = 灰，已投递 = 蓝，笔试 / 测评 = 黄，面试中 = 橙，offer = 绿，未通过 = 红。
- 单选 / 标签按文字哈希取九色之一（`toneOf()`），同一个值在表格、看板、甘特、详情里永远同色。
- 甘特条用浅底，事件菱形用圆点色。
- 禁止深底浅字的胶囊（v1 时期的 Notion 深色主题胶囊放在浅色页面上过重，已移除）。

### 2.4 深色与高对比度

- 深色：`:root.dark` 下同名 Token 有一套深色值（色阶反转、色调底 L≈0.29、文字 L≈0.86，对比 ≥ 9:1）。页面不需要写 `dark:` 类。
- 增强对比度（`prefers-contrast: more`）：分隔线、控件描边各加深一级，次要 / 三级文字各加深一级。旧变量经桥接自动跟随。

## 3. 字体与字号

| 角色 | Token | 约值 | 用途 |
| --- | --- | --- | --- |
| Meta | `--ou-type-xs` | 12px | 时间、快捷键、计数 |
| Detail | `--ou-type-sm` | 13px | 标签、元数据、次要按钮 |
| Pill | `--ou-type-pill` | 12.5px | 状态 / 标签胶囊 |
| Body | `--ou-type-body` | 14px | 表格、表单、Agent 正文 |
| Section | `--ou-type-section` | 16px | 区块、弹窗标题 |
| Page | `--ou-type-page` | clamp 22–28px | 页面标题 |

- 系统字体 + 中文回退；输入框用正文字体，等宽只给代码和 ID。
- 降一级层级至少同时换颜色，再换字号或字重之一。三级文字（N10）里不放必须读的信息。

## 4. 间距与圆角

- 间距：`--ou-space-1/2/3/4/6/8`（4 / 8 / 12 / 16 / 24 / 32px）。组内 8，组间 16，区块 24。
- 圆角：控件 `--ou-radius-control`（6px）、卡片 `--ou-radius-card`（10px）、浮层 / 弹窗 / 看板列 `--ou-radius-floating`（14px）、胶囊 `--ou-radius-pill`。

## 5. 层级（Elevation）L0–L4

| 层 | 是什么 | Token | 描边 | 阴影 |
| --- | --- | --- | --- | --- |
| L0 | 画布 | `--ou-elev-0` | 无 | 无 |
| L1 | 内容面、输入框 | `--ou-elev-1` | 1px N6 | 无 |
| L2 | 卡片（看板卡、列表卡、次按钮） | `--ou-elev-2` → 悬停 `--ou-elev-2-hover` | 1px N6 → N7 | 0 1 2 / 6% → 0 4 12 / 9%，上移 1px |
| L3 | 浮层（菜单、下拉、Popover、⌘K 结果） | `--ou-elev-3` | 1px N7 | 0 8 24 / 12% |
| L4 | 弹窗、⌘K 外壳 | `--ou-elev-4` + `--ou-scrim` | 1px N7 | 0 24 60 / 20% |

- 每一级都是描边 + 阴影成对出现（飞书 / Apple 的做法），不单独用阴影。
- z-index 只用 `--ou-layer-*`：sticky 10、popover 20、overlay 30、modal 40、toast 50、command 90（⌘K 必须盖住尚未迁移的旧层）。
- 毛玻璃（`--ou-glass-*`）只给浮在内容上的导航和控件（⌘K、工具条），内容面一律实底；`prefers-reduced-transparency` 下自动变实底。

## 6. 布局与响应式

| 容器 | 类 | 最大内容宽 | 用于 |
| --- | --- | --- | --- |
| reading | `.ou-page-reading` / `.ou-reading` | 46rem（约 45 个汉字一行） | 档案、设置、岗位详情正文、表单 |
| default | `.ou-page-default` | 72rem | 简历、面试 |
| wide | `.ou-page-wide` | 100rem | 今天（看板）、岗位表格 / 看板 / 甘特 |

- 留白 `--ou-gutter` = clamp(16px … 40px)，随视口流动；顶部留白同理。
- 侧栏宽 `--ou-sidebar-width` = clamp(13.5rem … 16rem)；`md`（768px）以下收成底部标签栏。
- 断点只作为验收档位：**390 / 768 / 1024 / 1440 / 1920**，横竖屏都看；布局本身靠流动宽度，而不是一档一套。
- 看板列宽 `--ou-kanban-column` = clamp(16rem … 22rem)；放不下时在看板自己的轨道里横向滚动并按列吸附，窄屏（< 40rem）一列约 85vw，强制吸附。轨道左右出血到页面边缘，滚动时不被留白截断。
- flex / grid 收缩边界写 `min-w-0`、`minmax(0, 1fr)`；不用 `overflow: hidden` 掩盖错位；弹层由 Radix 做碰撞翻转。

## 7. 动效

动效回答三个问题：**从哪来、到哪去、现在在干嘛**。不做纯装饰。

| Token | 值 | 用于 |
| --- | --- | --- |
| `--ou-motion-fast` | 120ms | 悬停、按下、颜色变化 |
| `--ou-motion-base` | 200ms | 浮层出现、就地换字、折叠展开 |
| `--ou-motion-slow` | 320ms | 页面切换、卡片 / 消息进场、弹窗 |
| `--ou-ease-standard` | cubic-bezier(.2,0,0,1) | 默认 |
| `--ou-ease-spring` | cubic-bezier(.32,.72,0,1) | 进场、展开（接近 iOS 弹簧） |
| `--ou-stagger` | 28ms | 列表逐项进场间隔（最多 8 项） |

| 类 | 效果 | 用在 |
| --- | --- | --- |
| `.ou-page-enter` | 上浮 6px + 淡入 | 每次切换页面 |
| `.ou-enter` + `--i` | 同上，按序号错开 | 看板卡片、工具调用行、新消息 |
| `.ou-swap`（配 `key`） | 淡入 + 去模糊 | Agent「一行步骤」换字 |
| `.ou-shimmer` | 文字扫光 | 正在思考 / 运行中 |
| `.ou-run-pill` | 浮起胶囊 + 呼吸紫点 + 计时 | Agent 运行中 |
| `.ou-activity` | 折叠头箭头旋转、内容上浮 | 「已处理 · N 次工具调用」 |
| `.ou-button:active` | 缩到 0.97 | 所有按钮 |
| `.ou-check-draw` | 勾线画出 | 完成 |
| 看板拖拽 | 卡片拿起微倾 + 抬到 L3；目标列底色和焦点环淡入 | 今天 / 岗位看板 |

`prefers-reduced-motion` 下：时长、位移、错开全部归零，扫光变静态次要色，呼吸点停止。

## 8. 无障碍

- WCAG 2.2 AA：正文 4.5:1、大字和非文字指示 3:1，以实际渲染组合为准。
- 键盘：所有可交互元素 `:focus-visible` 统一 2px 环；菜单 / 下拉 / 弹窗的键盘、焦点锁定、Esc 关闭、焦点归还由 Radix 保证。
- 触控目标 ≥ 32px（桌面）/ 44px（移动底栏）。
- 中文输入法选词时回车不提交；长公司名、中英混排、Emoji 都要截断并提供完整文本（title 或详情）。

## 9. HIG 检查清单（每个 UI PR 填）

- [ ] 这一屏的主任务和唯一主按钮是什么？是否只有一个墨黑实心按钮？
- [ ] 颜色是否都来自语义 Token？每个状态色是否配了文字 / 图标？
- [ ] 每个容器属于 L0–L4 哪一层？同一视图是否只有一层描边容器？
- [ ] 是否只组合了 `components/ui`？有没有裸 `<select>`、手写菜单 / 弹层 / 阴影？
- [ ] 390 / 768 / 1024 / 1440 截图：无横向整页滚动、无裁切、无挤压；Agent 栏开 / 关都看过。
- [ ] 键盘走一遍：Tab 顺序、焦点可见、Esc 返回、焦点归还。
- [ ] 空 / 加载 / 失败 / 重试状态都设计过；保存失败保留草稿。
- [ ] 增强对比度、减少动态效果、深色（若已迁移）下检查过。

## 10. 质量门禁

在 `frontend/` 执行：`npm run design:audit`、`npm run design:audit:test`、`npm run typecheck`、`npm test`、`npm run build`。`design:audit` 阻止新增违规（字面颜色、Tailwind 色板、px 字号、任意圆角 / 阴影 / z-index、裸控件），历史债只报告。不要放宽规则让 CI 变绿。

## 11. 迁移状态（2026-11-13）

| 范围 | 状态 |
| --- | --- |
| 旧变量桥接到色卡 v2 | ✅ 全站 |
| 外壳：侧栏宽度流动、画布 / 侧栏同源 | ✅ |
| 今天：wide 容器 + 阅读宽度段落、看板 L2 卡片 + 流动列宽 | ✅ |
| 岗位：浅色胶囊、墨黑「添加岗位」、wide 容器、甘特状态色 | ✅ |
| ⌘K：Token 化（L4、毛玻璃、层级） | ✅ |
| 组件层 `components/ui`（Button / Field / Select / Menu / Popover / Dialog / Panel / Pill / ContextUsageRing） | ✅ 已建，页面逐步替换 |
| 岗位表格内部的筛选 / 排序 Popover、状态菜单换成 `components/ui` | ⏳ 下一个 PR |
| Agent 栏：运行胶囊、一行步骤、上下文用量环接数据 | ⏳ 需要后端在 run 事件里给 token 用量 |
| 简历、设置、面试页 | ⏳ 按页迁移 |
| 深色模式 | ⏳ Token 已备好，待旧页面迁完再开 |
