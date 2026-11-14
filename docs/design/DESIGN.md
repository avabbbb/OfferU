# OfferU · DESIGN.md

> **求职工作台 · Agent 协作 · v3 Glass 设计套件（2026-11-13 起）**
>
> 像一扇磨砂玻璃窗：窗外是一片很淡的天色——左上冷蓝、右下桃色（`--ou-bg-wash`）；窗里是一块磨砂侧栏和几张半透明的白纸，只有一支墨黑的笔在写字。层次靠透明度、柔和的大阴影和留白，几乎没有 1px 边框；悬停是一颗白胶囊浮起来。橙色只在「今天 / 截止 / 交给 OfferU」时亮一下，紫色只出现在 Agent 身上。适用于校招求职者每天打开、一待就是半天的工作台。
>
> 主参考：Inspora · Rolando「[Bleep App](https://www.inspora.design/posts/bleep-app)」；辅参考：Inspora · Jeet「[Coding agent](https://www.inspora.design/posts/coding-agent)」。v2 Minimal 已归档到 [archive/visual-system-v2.md](archive/visual-system-v2.md)。

| | |
| --- | --- |
| Accent | `#231D19` 墨黑（N12），主按钮是墨黑胶囊 |
| Canvas | 冷暖渐变 `#C9D6F2` → `#EEECF1` → `#F6E3D2`（`--ou-bg-wash`） |
| Surfaces | 磨砂玻璃（白 55% + 24px 模糊）· 半透明白纸（白 84%）· 浮层白 90% + 模糊 |
| Palette | 渐变底 + 暖近黑文字 · 1 个提示色 + 1 个身份色 |
| Source | `frontend/src/styles/design-tokens.css`（唯一写字面值的地方） |
| 字体 | 系统字体（SF Pro / PingFang SC / Segoe UI / Microsoft YaHei） |
| 细则 | [visual-system.md](visual-system.md) · [components.md](components.md) · [references.md](references.md) |

本文件是**一页式设计套件**，写法参照 vechooool.com 的 *gilhuybrecht* 套件（概览 → 色 → 字 → 按钮 → 图标 → 间距 → 层次 → 形状 → 内容单元 → 推导控件 → 底层逻辑 → 规范与禁忌 → 动效）。数值细则在 visual-system.md，组件规格在 components.md；三者冲突时以 Token 文件为准。

> **动手前先找参考。** 做任何新界面或动效之前，按 [references.md](references.md) 的流程在 Inspora / Awwwards / GSAP Showcase / Refero 找 2–3 个参考，写进 PR 描述。

---

## v3 改了什么 · 怎么看

| | v2 Minimal（已归档） | v3 Glass（现行） |
| --- | --- | --- |
| 画布 | 暖白纯色 N1 | 冷蓝 → 桃色的淡渐变，整站只此一处渐变 |
| 侧栏 / Agent 栏 | 深一级的纸色 + 1px 分隔线 | 浮在渐变上的磨砂玻璃窗格，四周留 8px 缝，20px 圆角 |
| 内容面 | 纯白 + 1px 描边 | 半透明白纸，无描边，柔和大阴影 |
| 层级 | 每级「描边 + 阴影」成对 | L1–L2 只有阴影；L3–L4 加 0.5px 极淡环 + 模糊 |
| 圆角 | 6 / 10 / 14 | 10 / 12 / 16 / 18 / 20，按钮全胶囊 |
| 悬停 / 选中 | 灰底 N4 / N5 | 玻璃上白胶囊，白面上半透明墨 |
| 图标 | 裸图标 | 放进 28px 磨砂小方块（侧栏、面板标题、文档模块） |
| 简历编辑器 | 白卡 + 灰输入框 | 一页文档：正文直接写在纸上，16px / 1.6，左侧留白里的 + 和 ⋮⋮ |

不变：墨黑主按钮（一屏一个）、橙 = 紧急 / 委托、紫 = Agent、九色状态胶囊、字号阶梯、间距、动效 Token、HIG 无障碍要求。

**怎么看**：`frontend/` 里 `npm run build`，再在 `backend/` 里 `OFFERU_RUNTIME_MODE=lite uvicorn app.main:app --port 8766`，打开 `http://127.0.0.1:8766/#/`（今天）、`#/jobs`、`#/resume`；或 `npm run dev` 看 `http://127.0.0.1:7410`。PR：#196（Token + 外壳）、#197（简历编辑器文档化）。

## v3.1 新增 · 怎么看（2026-11-13，PR #198 / #199 / #200）

参考都来自 Inspora，只借思路：Mona「feature menu」（改成浅色）、kian bazza「Morphing braille loader」、sam「Event Swatch」、Seb Cornelius「composer mockup」。

| 模式 | 一句话 | 在哪看（lite 后端 `http://127.0.0.1:8766/`） |
| --- | --- | --- |
| 浅色玻璃 Menu / Popover | 22px 圆角、白 70% + 40px 模糊、柔和大阴影；一行 40px 胶囊，层级只靠墨色透明度；悬停白胶囊浮起 + 文字右挪 4px + 右侧小箭头淡入 | `#/jobs` 任一行「…」、表格工具条的筛选 / 排序 |
| LabelPicker / Tag / BrailleLoader | 顶上搜索，一行「色点 + 名字」，勾选框只在悬停或已选时出现；搜不到出「创建标签：xxx」，创建时图标 → 盲文点阵 → 对勾就地变形 | `#/jobs` 表格视图，点状态胶囊或标签格 |
| ⌘K 两栏 | 左边索引（分组列表），右边预览（磨砂图标块 + 标题 + 「打开页面 / 会交给右侧 OfferU」卡 + ↵ 提示） | 任意页按 ⌘K / Ctrl K |
| 色块 `.ou-swatch` | 按语气色取粉彩面 + 内白边 + 深 3px 底边，16px 圆角；悬停上浮放大 1.04（带回弹），拖动倾斜 -5° + 深阴影 | 看板卡、日历事项 |
| 周日历 | 无框安静网格（只有极淡整点线），工具条全是胶囊；只有「今天 / 现在」是橙色；同时段事项叠成一摞 +「+N 隐藏」胶囊；拖动按 15 分钟吸附改时间 | `#/jobs?view=calendar`（旧 `#/calendar` 会跳过来） |
| 看板尺寸 | 列 `flex: 1 0 0`，在 12.5rem–22rem 之间平分可用宽度；1440 下五列放满不截断，放不下时在自己的轨道里横滚、右缘渐隐 | `#/`（投递看板）、`#/jobs` 看板视图 |
| Agent 窗格 + 输入框 | 和侧栏对称的浮动磨砂窗格；头部「紫色身份块 + 对话标题 ▾ + … / ×」；空状态问候 + 建议胶囊；输入框是一张 26px 圆角玻璃卡，整卡焦点环 / 拖入紫环，墨黑「发送 ↑」胶囊，运行中收成像素格加载 | 右上角 bot 钮打开，在输入框里打字 |

## 概览 · Overview

打开是一片淡淡的冷暖渐变，左边一块磨砂玻璃侧栏（图标在小方块里，当前页是一颗白胶囊），中间是半透明的白纸面，右边是 Agent 栏（同样是玻璃）。界面退后，岗位、简历、Agent 的产出站在前面。一屏只有一个墨黑胶囊主按钮；其余是白胶囊或纯文字。

| 情绪 | 布局 | 内容宽度 | 框景 | 网格 | 图标 |
| --- | --- | --- | --- | --- | --- |
| Calm · soft · glass | 侧栏窗格 + 内容 + Agent 栏 | reading 46rem / doc 46rem / default 72rem / wide 100rem | 无框：玻璃和白纸浮在渐变上 | 流体 gutter，无固定列 | Lucide 线性 16px，放进磨砂小方块 |

## 色 · Color

| 角色 | 值 | Token | 用于 |
| --- | --- | --- | --- |
| 强调（墨黑） | `#231D19` | `--ou-action-primary` / `--ou-text-primary` | 主按钮（一屏最多一个）、主文字 |
| 辅色（次要文字） | `#69625D` | `--ou-text-secondary` | 次要文字、元数据 |
| 画布 | 冷暖渐变 | `--ou-bg-wash`（兜底 `--ou-bg-canvas` `#EEECF1`） | L0，`body` 上 |
| 玻璃 | 白 55% + 模糊 | `--ou-glass-bg` / `--ou-bg-sidebar` | 侧栏、Agent 栏、顶栏 |
| 纸面 | 白 84% | `--ou-bg-surface` | 面板、卡片、文档 |
| 实白 | `#FFFFFF` | `--ou-bg-surface-solid` | A4 纸、表格单元格、输入框、白胶囊 |
| 浮层 | 白 90% + 模糊 | `--ou-bg-floating` | 菜单、下拉、弹窗、⌘K |
| 提示（橙） | `#FF4F00` | `--ou-color-orange` | 今天线、截止临近、未读、「交给 OfferU」 |
| 身份（紫） | `#2B2358` / 点 `#9E88DA` | `--ou-color-purple` / `--ou-tone-purple-dot` | 只属于 Agent：面板身份、运行中 |

完整 12 级暖中性色阶、九色状态胶囊、深色与高对比度见 [visual-system.md §2](visual-system.md#2-颜色)。色卡：![色卡 v2](assets/palette-v2.png)

## 字 · Typography

| 角色 | 尺寸 | 字重 | 用于 |
| --- | --- | --- | --- |
| page | clamp(22px → 28px) | 600 | 页面标题（流体：`1.2rem + 0.45vw`） |
| section | 16px / 1.4 | 600 | 区块、弹窗标题 |
| body | 14px / 1.55 | 400 | 表格、表单、Agent 正文 |
| detail | 13px | 400 / 500 | 标签、元数据、次按钮 |
| pill | 12.5px | 500 | 状态 / 标签胶囊 |
| meta | 12px | 400 | 时间、快捷键、计数（`tabular-nums`） |
| doc | 16px / 1.6 | 400 | 文档视图正文（简历编辑器），`--ou-type-doc` |
| doc heading | 20px | 700 | 文档视图模块标题，`--ou-type-doc-heading` |

降一级层级至少同时换**颜色**，再换字号或字重之一。三级文字（N10）里不放必须读的信息。等宽只给代码和 ID。

## 按钮 · Buttons

| 变体 | 外观 | 用于 |
| --- | --- | --- |
| Primary | 墨黑胶囊 + 白字 | 一屏一个：添加岗位、保存、下载 PDF |
| Secondary | 白胶囊 + 极淡阴影（无描边），悬停阴影变大 | 普通动作 |
| Ghost | 透明 + 次要色，悬停半透明墨底（玻璃上是白胶囊） | 工具条、行内动作 |
| Icon | 32px 圆形，三级色；成组时放进 `.ou-button-group` 磨砂胶囊 | 关闭、更多（「…」溢出菜单）、前进后退 |

全部是胶囊 / 圆形；按下缩到 0.97（120ms）；禁用 50% 透明。不做彩色按钮，橙色永远不是按钮底色。组件：`components/ui/Button`。

## 图标 · Iconography

Lucide 线性图标，15–16px，描边 1.75–2，颜色跟文字走（多数是 `--ou-text-secondary / tertiary`）。导航、面板标题、文档模块的图标放进 28px 磨砂小方块（`.ou-tile`，`--ou-radius-tile`），一个半径到处一样。图标只做辅助：每个图标旁边都有文字或 `aria-label`。不用彩色图标、不用 emoji 当图标、不画插画式图标。

## 间距 · Spacing

| Token | 值 | 用于 |
| --- | --- | --- |
| `--ou-space-1` | 4px | 图标与文字 |
| `--ou-space-2` | 8px | 组内 |
| `--ou-space-3` | 12px | 卡片内边距 |
| `--ou-space-4` | 16px | 组间 |
| `--ou-space-6` | 24px | 区块 |
| `--ou-space-8` | 32px | 页面段落 |
| `--ou-gutter` | clamp(16px → 40px) | 页面左右留白 |

## 层次与深度 · Elevation & Depth

**玻璃叠在渐变上。** 层次靠「越靠上越白、越实」+ 宽而淡的阴影，几乎不用 1px 描边。

| 层 | 是什么 | 材质 | 阴影 |
| --- | --- | --- | --- |
| L0 | 渐变画布 | `--ou-bg-wash` | — |
| L1 | 玻璃窗格、纸面 | 玻璃 / 白 84% | 0 6 20 / 6%，无描边 |
| L2 | 卡片、白纸、次按钮 | 白 84% / 实白 | 0 12 32 / 10% → 悬停 0 18 44 / 16%，上移 2px，无描边 |
| L3 | 菜单、下拉、Popover、格式条 | 菜单 / Popover：白 70% + 40px 模糊（`--ou-glass-menu`）；其余白 90% + 模糊 | 菜单 / Popover：`--ou-elev-menu`（0.5px 环 + 0 2 6 + 0 24 60 / 18%）；其余 0.5px 极淡环 + 0 12 32 / 16% |
| L4 | 弹窗、⌘K | 白 90% + 模糊 + 模糊遮罩 | 0.5px 极淡环 + 0 28 72 / 24% |

阴影墨色是偏冷的紫灰 `rgba(60,50,80,·)`。

## 形状 · Shapes

| Token | 值 | 用于 |
| --- | --- | --- |
| `--ou-radius-1` / `--ou-radius-tile` | 10px | 菜单项、磨砂图标方块 |
| `--ou-radius-control` | 12px | 输入框、搜索胶囊、侧栏行、分段项 |
| `--ou-radius-floating` | 16px | 下拉（Select）、格式条 |
| `--ou-radius-swatch` | 16px | 色块（看板卡、日历事项）、附件拼贴 |
| `--ou-radius-card` | 18px | 卡片 |
| `--ou-radius-panel` | 20px | 侧栏窗格、Agent 窗格、面板、纸面、弹窗、看板列 |
| `--ou-radius-menu` | 22px | 浅色玻璃 Menu / Popover / LabelPicker / ⌘K |
| `--ou-radius-composer` | 26px | Agent 输入框卡片 |
| `--ou-radius-button` / `--ou-radius-pill` | 999px | 所有按钮、chip、状态胶囊、运行胶囊 |

圆角随层级变大：越浮起来越圆。

## 内容单元 · Content

1. **岗位卡（看板）**：公司名（body 500）+ 职位（次要色）+ 一行下一步 / 截止 + 标签。v3.1 起是色块 `.ou-swatch`：按状态取粉彩面（想投灰、已投递蓝、笔试黄、面试橙、offer 绿），放在玻璃列里；没有封面图、没有分数徽章。
1a. **日历事项**：同样是色块，按类型取色（截止红、笔试黄、面试橙、待办蓝，做完灰 + 删除线）；左上类型图标、右上「…」、底部「时间 · 类型 · 公司」+ 粗体标题。
2. **岗位行（表格）**：表格整体放在一张 20px 圆角的白纸上；行高 36px，悬停半透明墨底。
3. **状态胶囊**：浅底 + 深字 + 圆点（同色极淡内描边）；同一个值在所有视图同色。
4. **筛选 chip**：前面一颗空心圆，选中时填墨黑打勾（`.ou-chip` + `.ou-chip-check`）。
5. **卡片底部**：放不下的文字底部渐隐（`.ou-fade-bottom`），不硬裁切。
5a. **标签 / 状态**：选择和展示都是「色点 + 名字」（`Tag`），和 LabelPicker 里的行一个样子；表格的状态列仍可用胶囊。
6. **Agent 输入框**：一张 26px 圆角玻璃卡：正文 → 附件（图片拼贴 / 文档小胶囊）→ 底栏「+ · 模型 · 模式 … 发送」。
6a. **Agent 运行**：输入框上方一颗浮起的玻璃胶囊（紫点呼吸 + 一行步骤扫光 + 「N 步 · 秒数」）；完成后收成「› 已处理 · N 次工具调用」。
7. **Context Meter**：发送键左边 20px 圆环 + 百分比；56k 压缩线起转琥珀。

不做「数字 + 标签」的 KPI 卡。

## 推导控件 · Derived

由同一批 Token 推导：输入框 = 实白 + 白胶囊阴影 + 12px 圆角，聚焦时焦点环；下拉 / 菜单 = L3 磨砂浮层 + 菜单项半透明墨高亮；弹窗 = L4 磨砂 + 模糊遮罩；分段控件 = 玻璃轨道 + 白胶囊选中段；侧栏行 = 玻璃上的白胶囊。全部来自 `components/ui`（Radix Primitives）和 `components.css` 的 `.ou-*` 类，不手写。

## 底层逻辑 · Logical

| 规则 | 说明 |
| --- | --- |
| 三层 Token | 原始色阶 `--ou-neutral-*` / 渐变 `--ou-wash-*` → 语义 `--ou-bg-* / glass-* / capsule-* / text-* / line-* / tone-*` → 组件类 `.ou-*` |
| 流体 | 字号、留白、侧栏宽、看板列宽都用 `clamp()`，不按断点一档一套 |
| 断点 | 验收档：390 / 768 / 1024 / 1440 / 1920；768 以下侧栏变底部标签栏 |
| hover | 玻璃上白胶囊、白面上半透明墨底；卡片阴影变大并上移 2px；不加描边 |
| focus | `:focus-visible` 显示 N8 焦点环，鼠标点击不显示 |
| prefers-reduced-motion | 所有时长、位移、错开归零；扫光变静态 |
| prefers-contrast: more | 分隔线、描边、次要文字各加深一级 |
| 审计 | `npm run design:audit` 拦截新增的裸色值、px 字号、自写阴影 / 圆角 / z-index、裸 `<select>` |
| 降低透明度 | `prefers-reduced-transparency` 下玻璃变实底、画布变纯色 |

## 简历编辑器 · Resume editor (v3.1 三栏, 2026-11-14)

用户要求参考 offershow.cn 的简历编辑器重做编辑逻辑（PR：三栏 + 左栏模块管理 → 右栏条目编辑 → 排版 / 模版标签与顶栏）。v3 的「一页文档」改成**三栏工作台**，玻璃语言不变：

- **顶栏**：实白纸面 + 玻璃高光（不再 sticky 盖在内容上，修了「顶栏微微透出下面的字」）。从左到右：返回 · 简历名（下拉切换 / 新建 / 复制 / 删除，铅笔就地改名）· 保存状态点 ……… 保存（白胶囊，有没存的改动才可点）· **导出 ▾**（这一屏唯一的墨黑胶囊，PDF / PNG）· 分享 ▾（复制纯文本 / 下载 PDF；本地优先，没有在线链接）。导出、分享前先把没存的改动存下。
- **三栏**（`styles/resume-editor.css`，按编辑器自身宽度用容器查询降级）：≥ 66rem 左 13.5rem · 中预览 · 右 26rem，各栏自己滚；40–66rem 左栏 + 右栏并排、预览放下面；< 40rem 一列。
- **左栏「我的模块」**：一张半透明白纸。基础信息带锁、固定第一位；其余模块「⋮⋮ 把手 · 名字 · … · 开关」，拖把手排序（dnd-kit，键盘也能排），开关只改 `hidden`，点名字右栏切到它，选中是白胶囊。「更多模块」列还没加过的常用模块（荣誉奖项、个人总结、作品集…），开关一开即加入；底部「+ 添加自定义模块」。开关是 `components/ui/Switch`。
- **中间预览**：A4 实白纸 + L2 阴影，和 PDF 同一份 HTML；点预览里的块 → 左栏选中那个模块、右栏切到「编辑内容」并滚到那一条、闪一下浅底、光标进第一个输入框。
- **右栏标签**（`.ou-segment`，固定在顶上，下面的内容自己滚）：
  - **编辑内容**：模块名（20px 粗体，可就地改）；每条「教育经历 1 · 删除 · 虚线 · ↓ ↑」，两列表单用 `Field + Input`（学校 *、专业、学历 `Select`、城市、开始 / 结束时间——结束不填即「至今」）；描述是带常驻格式条的实白框（加粗 / 斜体 / 下划线 / 无序 / 有序列表 / 链接）；要点沿用文档式块；底部「✦ AI 润色」（白胶囊 + 紫色图标，交给右侧 OfferU Agent，只改这一条、可撤销）；最后「+ 添加条目」。
  - **排版美化**：智能一页 · 字体 · 字号 / 行距 · 模块 / 条目间距 · 上下 / 左右边距（− 数字 +）· 主题色。
  - **更换模版**：两列卡片，缩略图是用自己的内容按该模板渲染的第一页；换模板回到模板默认排版，照片和校徽保留。
- 存储不变：表单字段和 `doc.resume` 之间的换算在 `lib/resumeFields`（时间仍是一串 `date`，学历仍拼在 `subtitle`）；行内标记新增 `++下划线++`（前后端共用 `richMarkup.cases.json`）。

## 规范与禁忌 · Do & Don't

| ✓ Do | ✗ Don't |
| --- | --- |
| 一屏只留一个墨黑胶囊主按钮 | 不要彩色按钮、不要橙色主按钮 |
| 层级靠透明度 + 柔和阴影 + 字号 + 留白 | 不要新加 1px 描边、不要深色硬阴影 |
| 渐变只在画布（`--ou-bg-wash`） | 不要卡片 / 按钮 / 标题渐变、KPI 卡、徽章墙、网格底 |
| 玻璃上悬停用白胶囊 | 不要用描边表示悬停 / 选中 |
| 文档类内容直接写在纸上 | 不要一屏灰色输入框 |
| 橙色只给今天 / 截止 / 委托 | 不要把橙色当装饰 |
| 紫色只给 Agent | 不要用紫色表示成功或置信度 |
| 胶囊浅底深字 | 不要深底浅字胶囊 |
| 内容透不得的地方用实白（A4、表格、输入） | 不要把半透明面叠在会滚动的内容上而不加模糊 |
| 只组合 `components/ui` | 不要裸 `<select>`、手写菜单 / 阴影 |
| 二维数据在自己的容器里横滚 | 不要让整页横向滚动 |
| 做之前先找参考（references.md） | 不要凭感觉直接画 |

## 动效 · Motion

| Motion Level | Durations | Easings | Hover | Scroll | Canvas |
| --- | --- | --- | --- | --- | --- |
| subtle · 功能性 | 120 / 200 / 320ms | standard `(.2,0,0,1)`、spring `(.32,.72,0,1)` | 白胶囊淡入、卡片阴影变大并上移 2px | 无滚动驱动动画 | 渐变底静止 |

动效只回答三件事：**从哪来、到哪去、现在在干嘛**。

- 页面切换：上浮 6px + 淡入（`.ou-page-enter`）
- 列表进场：逐项错开 28ms，最多 8 项（`.ou-enter` + `--i`）
- Agent 步骤换字：淡入 + 去模糊（`.ou-swap`）；思考中：文字扫光（`.ou-shimmer`）
- 浮层：从触发点缩放 0.97 → 1；弹窗：0.96 → 1 + 遮罩淡入
- 看板拖拽：卡片拿起微倾、抬到 L3；目标列底色和焦点环淡入
- 色块（v3.1）：悬停上浮 + 放大 `--ou-swatch-scale`（1.04，`--ou-ease-spring-soft` 小回弹）；拖动用一张已倾斜 `--ou-swatch-tilt`（-5°）+ 深阴影的副本做拖动图，原卡变淡
- 菜单行：悬停文字右挪 `--ou-nudge`（4px）+ 右侧箭头淡入，弹簧曲线
- 标签创建：标签图标 → 盲文点阵轮流亮 → 对勾画出（`BrailleLoader`），动词「创建 → 创建中 → 已创建」同步换字
- Agent 输入框：发送时整卡轻压一下；运行中发送键收成 5×5 像素格，一步一格（`steps()`）

```css
.ou-enter {
  animation: ou-rise-in var(--ou-motion-slow) var(--ou-ease-spring) both;
  animation-delay: calc(var(--i, 0) * var(--ou-stagger));
}
```

完整动效表见 [visual-system.md §7](visual-system.md#7-动效)。要加新动效时，先去 [GSAP Showcase](https://gsap.com/showcase/) 和 Inspora 的 Motion 分类找参考（见 [references.md](references.md)），再用 CSS + Token 实现；工作台里不引入滚动驱动或 WebGL 动画。
