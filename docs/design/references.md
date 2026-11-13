# 设计参考库 · References

> **规则：做任何新界面、改版或新动效之前，先在下面的站点找 2–3 个参考，把链接和「借什么」写进 PR 描述。** 只借思路，不照抄视觉，不声称与对方有设计关联。参考和 [DESIGN.md](DESIGN.md) 冲突时，以 DESIGN.md 为准。

## 四个站，各有分工

| 站点 | 用来干什么 | 什么时候翻 | 在 OfferU 里怎么用 |
| --- | --- | --- | --- |
| [Inspora](https://www.inspora.design/) | **找灵感**。按 Web / Branding / Product / Motion / Illustration / 3D / Print 分类，每小时更新 | 开新功能、新页面之前热身 | 重点看 **Product** 和 **Motion** 分类：Agent 面板、看板、表格的交互小动画。Agent 运行胶囊就借自这里的 *agent dashboard*（@barret_jessy） |
| [Awwwards](https://www.awwwards.com/) | **校准审美**。顶级工作室能把网页做到什么程度 | 觉得界面「还行但不够好」时 | 看排版节奏、留白、细节完成度；**不搬**大面积视差、整屏 WebGL——工作台要的是安静 |
| [GSAP Showcase](https://gsap.com/showcase/) | **学动效**。滚动触发、视差、文字动画、各种交互 | 想给界面加「灵魂」、设计新动效时 | 看**节奏和曲线**：一个元素怎么进场、怎么交接给下一个。落地时翻译成 CSS + `--ou-motion-*` Token；不引入 GSAP 依赖，除非 PR 里说明 CSS 做不到 |
| [Refero Styles](https://styles.refero.design/) | **提取风格**。2000+ 网站按风格整理成 DESIGN.md；输入 URL 能自动提取风格 | 要对齐某种风格、或想看别人的 DESIGN.md 怎么写 | 把参考站的 DESIGN.md 和我们的 [DESIGN.md](DESIGN.md) 对照，只借**规则的写法**（色彩角色、层级哲学、Do/Don't），不换掉我们的色卡 |

补充：[Refero](https://refero.design/) 主站有真实产品截图和完整用户流程（Web / iOS），做 onboarding、设置、表单、计费这类常见流程时先搜一下别人怎么排的。它有 MCP（`https://api.refero.design/mcp`，需付费计划），接上后 Agent 可以在动手前自己搜参考。

## 找参考的流程

1. **说清要做什么**：一句话，例如「岗位看板卡片拖拽时的反馈」。
2. **按分工去找**：
   - 布局 / 交互 → Inspora Product、Refero 截图
   - 动效 → GSAP Showcase、Inspora Motion
   - 整体风格 / 审美 → Awwwards、Refero Styles
3. **挑 2–3 个**，每个写一行「借什么」：例如「借它拖起时卡片微倾 + 阴影加深，不借它的弹跳」。
4. **对照 DESIGN.md 翻译**：颜色换成 `--ou-*` 语义 Token，时长 / 曲线换成 `--ou-motion-*`、`--ou-ease-*`，组件用 `components/ui`。
5. **写进 PR**：PR 描述加一节「参考」，列链接 + 借了什么。

## 已借用的参考

| 参考 | 借了什么 | 落在哪 |
| --- | --- | --- |
| Inspora · *agent dashboard*（Jessy Barret） | 运行胶囊、一行步骤就地替换、完成后计数 | `AgentRunPill`、`.ou-run-pill`、`.ou-swap` |
| Motif（motif.sweetretry.com，MIT） | 上下文用量环、「已处理 · N 次工具调用」折叠头、思考扫光 | `components/ui/agent/ContextUsageRing`、`.ou-activity`、`.ou-shimmer` |
| vechooool.com · *gilhuybrecht* 设计套件 | DESIGN.md 的一页式套件结构 | [DESIGN.md](DESIGN.md) |
| Apple HIG | 颜色只表达一种意思、减少动态效果、焦点可见 | 全局 |
