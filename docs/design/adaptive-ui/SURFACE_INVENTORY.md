# OfferU Adaptive UI Surface Inventory

更新时间：2026-09-09

这份清单只记录当前 OfferU checkout 中实际存在的页面和组件。Flovart 的 Infinite Canvas / Workflow 画布不在本仓库；OfferU 当前对应的创作表面是 HTML Resume Studio，不能把 Studio 的验证冒充 Canvas 验证。

| Surface | Current layout | Fixed assumption | Small-screen issue | Priority |
| --- | --- | --- | --- | --- |
| App shell / navigation | `WorkbenchShell` + `Sidebar` | 旧版使用 `h-screen` 高度链 | WebView 动态地址栏可能留下底部空区；窄屏导航需折叠 | P0 |
| Today / Jobs / Applications | Workbench 页面 + responsive cards/table region | 数据密集区有局部最小宽度 | 表格必须把横向滚动限制在表格区域 | P1 |
| Interview / Calendar | Workbench 页面 + cards | 部分操作行依赖桌面间距 | 短高度时 CTA 和状态区需要可达 | P1 |
| Email | 状态卡、只读授权、IMAP dialog、sync history | 模态内容需要随容器收缩 | 320px 下授权说明和 dialog 不能溢出 | P0 |
| Profile / onboarding | 表单卡、候选事实审核、全屏 onboarding | 旧入口使用 `min-h-screen` | 动态 viewport 和长表单滚动必须稳定 | P0 |
| Settings | provider/model/routing/data-safety master-detail sections | Provider model table 有 `min-w-[780px]` | 仅表格区域允许横向滚动，表单必须单列可操作 | P0 |
| Agent Workspace / Agent Link | Context rail、conversation、connection panel | Dock/rail 需要区分布局和拖拽行为 | 中小容器应折叠 Context，保留连接状态和操作 | P0 |
| Resume workspace | 编辑器三栏在 `xl` 展开 | 预览区有较大最小高度 | 小屏必须允许纵向阅读、保存和导出 | P0 |
| Resume Studio | 模板 / preview / design controls | 宽屏三栏 | `lg` 以下单列，避免窄屏三列被压成不可读列 | P0 |
| Optimize / Role Intelligence | chat/panel/card composition | 长文本和模型状态会变长 | CTA、错误信息和聊天内容需要 wrap | P1 |
| Modals / popovers / toasts | NextUI modal + local overlays | 个别内容区有最大宽度 | 需要 viewport 内 inset、最大高度和内部滚动 | P0 |

## Static scan snapshot

对 `frontend/src` 的静态扫描结果：

- `w-screen`：0
- `window.innerWidth` / `window.innerHeight`：仅拖拽 Dock 边界和 Settings 诊断显示，共 4 处读取
- `resize` listener：仅 `useDraggableDock`，用于拖拽位置重新 clamp
- page-level `h-screen`：0
- `min-h-screen`：0（Onboarding、Resume workspace 已迁移到 `.offeru-viewport-min-height`）

固定宽度仍允许存在于图标、按钮、可读性上限和局部数据区域；是否会影响页面级溢出由浏览器矩阵验证，而不是按字符串机械删除。
