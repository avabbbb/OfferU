> 已归档（2026-10-21）：本文不再是当前权威，只用于考古。当前文档：09-quality-and-release.md（位于 docs/）。2026-09-19 对抗评审的历史证据，评分与缺陷只属于当时代码。

# 前端设计系统对抗评审 — 2026-09-19

## 结论（对照 Apple 上线水准一句话定性）

工程上有真正的 token 骨架（duration/easing/semantic color）且 reduced-motion、focus-visible、aria 在关键路径上有落实，但**设计系统停留在"双皮肤硬编码 + Tailwind arbitrary value 满天飞"阶段**：无 spacing/radius/font-size 数字 token、无暗色模式、`text-[11px]` 出现 245 次、组件层 focus ring 覆盖率仅 ~5%、`!important` 111 处——离 Apple 水准的"克制、一致、系统性"还有一到两轮重构的距离。

## Findings

| ID | Sev | Type | 位置 | 证据 | 问题 | 建议修法 |
|----|-----|------|------|------|------|----------|
| DS-01 | P1 | design | `globals.css:5-51` vs `1048-1088` | 两个顶层 `:root` 块，后者覆盖前者（同一文件 1043 行注释自称 "reference skin"） | 同一文件里存在**两套互斥的设计令牌**，第一套 46 个变量全是死代码（`--background:#f4f6f7` 等被 `#edf0eb` 覆盖）；维护者改 token 时极易改错那份，且任何 `var(--x)` 的实际值取决于文件顺序而非语义 | 删掉第一套死 token（或迁移为 `.theme-classic`），保留单一事实源 |
| DS-02 | P1 | design | 全仓 `*.tsx` | `text-[11px]`×245、`text-[10px]`×58、`text-[12px]`×52、`text-[12.5px]`×19、`text-[10.5px]`×15、`text-[11.5px]`×7、`text-[9.5px]`×1，分布在 37+ 文件 | 字号体系是**7+ 个 1px 步进的 magic number**（9.5/10/10.5/11/11.5/12/12.5/13/13.5/14/15/18/22px），无 `--text-xs/sm/md` token，也无 Tailwind theme.extend.fontSize 归一化（`tailwind.config.js` 只定义了颜色/字体族，没有 fontSize/spacing 扩展） | 定义 5 档字阶（caption/label/body/title/display）映射到 token，批量收敛 arbitrary value |
| DS-03 | P1 | a11y | `frontend/src/components/**/*.tsx` | `focus-visible` 全组件目录仅 4 处命中（JobCard.tsx:125、AgentConnectionPanel.tsx:74,159、resume/page.tsx:363）；`outline-none` 在 JobCard.tsx:125、jobs/[id]/page.tsx:1148,1348、resume/[id]/page.tsx:123,168,356 等 8+ 处**直接清除焦点框** | 键盘用户在导航链接（Sidebar NavLink）、上下文栏 tab、JobCard 按钮、表格行之外几乎全部看不到焦点位置。`outline-none` + 无替代 focus 样式的输入框（jobs/[id] 两个 `outline-none focus:border-…`）违反 WCAG 2.4.7 | 全局 `:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px }` 兜底，逐个删除裸 `outline-none` |
| DS-04 | P1 | design | `globals.css` 全文 | `grep -c '!important'` = **111**；`tailwind.config.js` `darkMode:"class"` 但 `.dark`/`.dark:` 规则 0 条、组件 `dark:` 前缀 0 处 | 无暗色模式（对"career OS"可接受），但 111 个 `!important` 表明皮肤层在对组件层**打补丁而非继承**——尤其 `.bauhaus-panel-sm{box-shadow:3px 4px 0 …!important}`(1161) 与 `*:focus` 等互相覆盖，特异性战争已经打响 | 用 `@layer` 明确皮肤层优先级，消除 `!important`（目标 <10） |
| DS-05 | P2 | a11y | `CommandPalette.tsx:123-207` | palette 打开后只有 `input` 可聚焦；`ArrowUp/Down` 改 `activeIndex` 但**无 `aria-activedescendant`/`role="listbox"`/`role="option"`**；焦点没有 trap，Tab 会穿出到页面背景 | 命令面板是屏幕阅读器盲区：选中项不可感知、焦点可逃逸、Esc 关但焦点不归位到触发按钮 | 加 `role="dialog"` + `aria-modal`、listbox/option 语义、焦点 trap + 关闭时 `triggerRef.focus()` |
| DS-06 | P2 | a11y | `ContextRail.tsx:39-46` | 关闭按钮 `aria-label="打开上下文栏"` 存在；但 rail 面板本身（`motion.aside` z-50 `position:fixed`）**无 `role="complementary"`/`aria-label`**，Esc 关闭后焦点不返回展开按钮 | 键盘/读屏用户进入 rail 后失去上下文锚点 | aside 加 `aria-label="上下文栏"`，关闭时把焦点还给 `.offeru-context-rail-toggle` |
| DS-07 | P2 | a11y | `JobCard.tsx:220-225` | `<span className="bauhaus-button … cursor-not-allowed" title="…">暂无投递链接</span>` | 用 `<span>` 模拟禁用按钮——不可聚焦、无 `aria-disabled`，键盘用户完全感知不到这个状态；JobCard 整张卡片可点（`article` + `onClick` 在父级隐式传播），但卡片本身**不是 button/无 tabindex**，键盘无法打开详情 | 禁用态改 `<button disabled>`；卡片容器加键盘可达入口（标题 Link 已有，但视觉 affordance 与点击区域不一致） |
| DS-08 | P2 | a11y | 对比度实测 | `--foreground-faint`(`rgba(25,25,25,.48)`) on `--background`(#edf0eb) = **3.07:1**；on `--surface-muted` = 3.06:1；`primary-red` on `status-blush` = **4.11:1** | faint 档文字（Sidebar hint `text-[11px]`、CommandPalette hint）只有 3.07:1，低于 WCAG AA 4.5:1；红色按钮文字在 blush 底上 4.11:1 也不达标（小字） | `--foreground-faint` alpha 提到 ≥0.60（→4.5:1）；`bauhaus-button-red` 文字色加深或底色调亮 |
| DS-09 | P2 | design | `globals.css:1048-1088` | skin-2 的 `--surface:rgba(248,249,246,.78)`、`--surface-muted:rgba(232,236,231,.78)` 是 **rgba 半透明**；但组件同时写 `bg-white`/`bg-[var(--surface)]` 混用（AddJobModal.tsx:24 `bg-white`、JobSourceConnectionsCard `bg-white`、JobCard `bg-[var(--surface)]`） | 半透明 surface 叠在网格纸背景上，与 `bg-white` 不透明卡片并排出现，两种"白"不一致；且 `--border:rgba(25,25,25,.13)` 半透明边框在网格线上会发灰 | 统一 surface 为不透明 token，禁止组件层 `bg-white`/`text-black`（JobCard 用了 ~15 处 `text-black/xx` 硬编码而非 token） |
| DS-10 | P2 | ux | `Sidebar.tsx:169-197` | 移动导航 `min-h-[60px]`、grid-cols-4，4 个核心项挤底栏；但 `offeru-mobile-nav` 固定 `z-50` 且 `main` 用 `pb-36` 预留空间 | 移动端可达但触控目标高度 60px 达标（≥44pt）；真正的问题是**桌面 hover-only affordance**：`.job-card:hover` 才有位移/阴影反馈，`press-feedback`/`bauhaus-lift` 的 `:active` scale(0.975/0.992) 反馈存在但仅 2 个 class 被组件引用（`grep press-feedback frontend/src --include='*.tsx'` = 0 引用） | 定义好的 press-feedback/spring-up 等工具类实际零引用，要么接入要么删 |
| DS-11 | P2 | ux | `globals.css:519-543` | `.lcode-pop` `animation: 3.2s infinite`、`.lcode-pop-delay-1/2/3` 循环弹入淡出 | 无限循环动画在页面上永动，不符合 Apple"动效只在需要时出现"原则；虽然 reduced-motion 全局兜底会压掉，但默认状态下是噪音 | 改为 entrance-only（`both` + 非 infinite）或限定在营销/空状态场景 |
| DS-12 | P2 | design | `globals.css:746-748,1160-1162` | `.bauhaus-panel.rounded-none{border-radius:14px}`、`.bauhaus-panel-sm{box-shadow:3px 4px 0 rgba(25,25,25,.1)!important}` | **类名与行为相反**：`.rounded-none` 实际给 14px 圆角、`shadow-none` 给 `0 1px 2px`；说明皮肤层在强行矫正组件层的工具类选择，语义已崩 | 皮肤不该 override 工具类语义；把圆角决策收进 token `--radius-panel` |
| DS-13 | P3 | design | `globals.css:1084-1087` | `--font-serif:"Noto Serif SC","Songti SC"…`、`--font-mono:"JetBrains Mono","Sarasa Mono SC"…`、`--font-sans:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei"` | 字体栈合理（中文优先 PingFang/YaHei，mono 用 Sarasa 保中文等宽），但**正文未声明 `lang="zh-CN"` 的 font-feature**——`body{font-feature-settings:"cv02","cv03","cv04","cv11"}` 在 skin-1 是 Inter 的 stylistic alternate，skin-2 切换到 `-apple-system` 后这串 cvXX 对 PingFang 无效（死属性）；无 `text-spacing`/`:lang(zh)` 的 CJK 标点挤压 | 清理 skin-1 死属性；中文优化可加 `font-variant-east-asian` 或等 `text-spacing` 支持 |
| DS-14 | P3 | ux | `globals.css:571-589` + 各组件 | `.spring-up/.spring-in/.spring-side/.pop-scale` 全套入场动画定义了 `animation-delay:calc(var(--stagger-index)*50ms)`，但 `grep -rn "stagger-index\|spring-up\|spring-in\|pop-scale" frontend/src --include='*.tsx'` = **0 引用**；组件实际全部用 framer-motion 的 `staggerChildren`/`layoutId`（Sidebar、ContextRail、OnboardingChecklist） | CSS 动画工具与 JS 动画体系**双轨并行、一套闲置**；framer-motion 的 spring(stiffness 380-480) 与 CSS `--ease-spring-out` 曲线手感不一致 | 统一走 framer-motion（项目已依赖），删 CSS 死工具类 |
| DS-15 | P3 | a11y | `JobCard.tsx:96,140-168` | 来源标记是 `<span className="h-3 w-3 {accent.marker}">`（纯色块，无文本/aria）；`bauhaus-chip` 里 `<DollarSign size=12>` 等图标无 `aria-hidden`，颜色是**唯一**状态编码（校招/全职 chip 只靠底色区分） | 色盲用户分不清 `bg-[#f3ead2]`(salary) vs `bg-[#eaf0eb]`(校招) 的语义差异；装饰图标会让读屏器读出一串无意义名称 | 图标统一 `aria-hidden`，chip 语义用文本本身承载（已部分做到），来源色块加 `aria-label` 或 `title` |
| DS-16 | P3 | design | `globals.css:39-50` | duration token 5 档（100/160/260/400/600ms）+ easing 5 条曲线——**这是全系统最规范的一块**；但组件实际用 `duration-[var(--dur-quick)]` 引用，同时 framer-motion 用 `type:"spring",stiffness:420` 物理参数，两套动效语言混用 | token 存在但只覆盖 CSS transition；JS spring 的参数（stiffness/damping/mass）没有 token 化，导致 ContextRail(380/36)、Sidebar(480/38)、CommandPalette(460/34)、InspectorPanel(360/36) 每个组件手感略不同 | 抽 `lib/motion.ts` 导出统一 spring preset（`spring.snappy/soft/bouncy`） |

## design-token 缺失清单

已存在（规范、值得保留）：
- 颜色：`--background/--foreground{,-soft,-muted,-faint}/--surface{,-muted,-hover}/--border{,-strong}/--primary-{red,yellow,green,blue}/--status-{blush,sage}/--accent-clay/--focus-ring/--shadow-{soft,medium,paper}`
- 动效：`--dur-{instant,quick,snappy,deliberate,lingering}` + `--ease-{snap,precise,overshoot,settle,spring-out}`
- 字体族：`--font-{sans,serif,mono,display}`
- 材料：`--grid-size/--glass{,-strong}/--fabric-*`

**缺失（Apple 级系统必须有）：**

| 类别 | 现状 | 应有 token |
|------|------|-----------|
| font-size | `text-[9.5px]`…`text-[22px]` 共 13 档 magic | `--text-caption(11)/--text-label(12.5)/--text-body(14)/--text-title(17)/--text-display(22)` |
| spacing | `p-4/px-2.5/gap-1.5` 全部裸 Tailwind 值，无语义层 | `--space-{1..8}`（4px 基）+ 语义别名 `--space-card-padding/--space-section-gap` |
| radius | `rounded-md/rounded-lg/rounded-[3px]/rounded-14px(rounded-none!)` 混用 | `--radius-{sm(6),md(10),lg(14),pill(999)}`，且 `.rounded-none` 不应输出 14px |
| line-height | body 1.55、prose 1.625、组件 `leading-tight/relaxed/none` 散落 | `--leading-{tight,body,relaxed}` 3 档 |
| z-index | `z-[1]`、`z-20`、`z-40`、`z-50`、`z-[90]` 硬编码（JobCard z-20、rail z-40/z-50、palette z-[90]） | `--z-{base,sticky,rail,overlay,modal,palette}` |
| JS motion | framer-motion `stiffness:360-480,damping:32-38` 每组件一组 | `lib/motion.ts` 统一 preset |
| dark mode | `darkMode:"class"` 配置了但零规则 | 要么实现 `[data-theme="dark"]` token 覆盖，要么删配置 |
| 触控目标 | `bauhaus-button min-h:36px`、`-sm 28px`、移动 nav 60px | `--touch-min:44px`（Apple HIG 下限），`bauhaus-button-sm` 28px 不达标 |

## Top-5 修复优先级

1. **DS-01 + DS-04：合并双 `:root`、消灭 111 个 `!important`** —— 这是其他所有 token 工作的前提；现在改任何变量都要先搞清"哪套皮肤生效"。
2. **DS-03 + DS-05 + DS-06 + DS-07：a11y 焦点系统** —— 全局 `:focus-visible` 兜底 + 命令面板 listbox 语义 + JobCard 键盘可达 + 删裸 `outline-none`。一次 commit 可完成，收益是全键盘流恢复。
3. **DS-02 + DS-16：字阶与 JS motion token 化** —— 定义 5 档 `font-size` + `lib/motion.ts` spring preset，批量替换 `text-[Npx]` 与硬编码 spring。消灭最多的"不一致感"来源。
4. **DS-08 + DS-09：对比度与 surface 一致性** —— `foreground-faint` alpha 0.48→0.62、`button-red` 文字/底色组合修到 4.5:1、`bg-white` 与 `bg-[var(--surface)]` 统一为不透明 token。
5. **DS-14 + DS-11 + DS-12：删死代码** —— `spring-up/spring-in/spring-side/pop-scale/press-feedback/indicator-slide/lcode-pop` 零引用全套删除（~120 行死 CSS）；`.rounded-none`/`.shadow-none` 反语义 override 移除。

## 已达标的点（简短）

- **动效 token 骨架存在**：`--dur-*`/`--ease-*` 5+5 定义清晰，比大多数项目强。
- **reduced-motion 全局兜底**：`globals.css:1014-1023` `prefers-reduced-motion:reduce` 对所有 `*` 强制 `animation/transition-duration:0.01ms`，且组件用 `motion-safe:animate-spin` 细分保留必要 loading 反馈。
- **prefers-contrast**：`:1008` 对 `profile-woven-accent` 去纹理。
- **focus-visible 已上关键路径**：`bauhaus-button:focus-visible`（2px outline + 4px ring）、`.offeru-data-row:focus-visible`（内阴影指示）做对了一处是一处。
- **tabular-nums 有落实**：`.offeru-data-table` 全局 `font-variant-numeric:tabular-nums`，AgentConnectionPanel 时间戳、page.tsx 数据也用 `tabular-nums` class。
- **语义标签基本到位**：`<main>/<nav>/<aside>/<article>/<section>/<dl>/<details>/<ol>` 都在用，aria-current="page"、aria-pressed、role="alert"/"status" 覆盖面尚可。
- **触控目标大体合格**：移动 nav 60px、bauhaus-button 36px、JobCard checkbox 44px（h-11 w-11）。
- **语义色去饱和处理克制**：`--primary-*` 非纯红绿，`status-blush/sage` 低饱和底，符合"安静"设计目标。
