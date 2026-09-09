# Current Layout Debt

## 已处理

1. App shell、loading gate、Sidebar 和 ContextRail 不再把 `h-screen` 作为唯一高度策略。
2. 根节点高度链补齐 `min-height`，并提供 `.offeru-viewport-shell` / `.offeru-viewport-min-height`，优先使用 `100dvh`，同时保留 `100vh` fallback。
3. Resume Studio 在 `lg` 以下改为单列；宽屏仍保留模板、预览、设计控制三栏。
4. Studio 各列和预览区补 `min-width: 0`，避免内容把 grid track 撑出容器。
5. Email 授权/IMAP dialog、Settings、Agent Link 的 320/390px 路由探针通过无横向溢出检查。

## 仍然有意保留的局部约束

- Settings 的模型数据表使用 `min-w-[780px]`，但它位于局部 `OverflowRegion` 语义内；页面级 scroll width 在 320px 矩阵中仍等于 viewport。
- Applications 的列宽和表格操作保留最小可读宽度；横向滚动只属于表格区域。
- `useDraggableDock` 读取 viewport 是拖动后的边界 clamp，不负责页面组合、断点或数据请求；resize 不会发起 `/api/` 请求。

## 下一步审计边界

- 真实 Resume workspace（带真实 resume id）的 320/390/768 矩阵尚需真实数据输入。
- Canvas/Workflow 画布需要在 Flovart checkout 单独验收；OfferU 当前没有该路由。
- 真实用户数据、Gmail OAuth 和 Provider live 状态仍是 Local Agent Golden Path 的外部门，不得用空状态截图替代。
