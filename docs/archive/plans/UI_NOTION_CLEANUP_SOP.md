# UI Notion 极简统一清理 SOP

## 背景
globals.css 已是 Notion 极简令牌（hairline/圆角/无阴影/surface-muted hover/bauhaus-button hover才出色）。
但 9 个主页面 + home 仍遍布 Tailwind 内联浓色硬塞（`bg-[#f7ece9/#e4ece6/#f3ead2]`）+ Bauhaus 装饰
（`aspect-[3:5]`/`rounded-none`/`shadow-[1px_1px_0_0...]`/`bg-[radial-gradient(...)]`点阵/装饰圆点）。
用户确认"一次全拏"。简历卡片形态定：**Notion 网格卡（带柔和缩略图，hairline+圆角+hover surface-muted）**。

## 清理映射
| 旧内联 | → 新 |
|---|---|
| `bg-[#f7ece9]` | `bg-[var(--status-blush)]` 警告语 / `bg-[var(--surface-muted)]` 装饰 |
| `bg-[#e4ece6]` | `bg-[var(--status-sage)]` 成功 / `bg-[var(--surface-muted)]` |
| `bg-[#f3ead2]` | `bg-[var(--surface-muted)]` |
| `bg-[#e8d2cd]` `bg-[#d8e2da]` 装饰圆 | 删除 |
| `bg-[radial-gradient(...)] bg-[size:20px_20px]` 点阵 | 删除 |
| `aspect-[3:5]` `min-h-[380px]` 窄长方体 | 删除，自然高度或 `min-h-[280px]` |
| `rounded-none` 直角 | 删除（默认圆角） |
| `shadow-[1px_1px_0_0...]` `shadow-[2px_2px_0_0...]` 偏移阴影 | 删除 |
| `text-[#b7483c]` 等硬色 | `text-[var(--primary-red)]` 等语义令牌 |
| `border-2 border-black` 浓黑实线 | 删除（默认 hairline var(--border)） |
| `bauhaus-button-red/blue/green/yellow` 主CTA | 保留（hover才出色，已Notion） |

## 简历卡片基准形态（resume/page.tsx）
- 删 `aspect-[3:5]` + `min-h-[380px]` + `rounded-none`
- Card 走 `bauhaus-panel`（hairline+圆角10px+无阴影）+ `bauhaus-lift`（hover surface-muted）
- 缩略图区：`bg-[var(--surface-muted)]` 柔和灰底，无点阵无装饰圆，高度 `min-h-[140px]` 自然
- 信息区自然高度，chip 用 surface-muted

## 进度勾选
- [x] resume/page.tsx （基准页，第一）
- [x] app/page.tsx (home)
- [x] applications/page.tsx
- [x] jobs/page.tsx (+ jobs/[id]/page.tsx)
- [x] settings/page.tsx
- [x] optimize/page.tsx (incl OptimizeWorkspace/OptimizeChatPanel/ConversationList)
- [x] calendar/page.tsx (+ CascadeDatePicker/TimePicker)
- [x] email/page.tsx
- [x] interview/page.tsx
- [x] profile/page.tsx (+ components 牛)

## 已修
- backend CORS 加 3300（config.py + resume.py FRONTEND_BASE_URL） — 创建简历 Failed to fetch 已修
- home：statColors 浓色数组改 surface/surface-muted 交替；text-black/* /装饰浓色清语义 token
- applications：text-black/* (24处) / #f3ead2/#e4ece6/#f7ece9/#5e6f65/#3f6f4a/#a05a4a/#b7483c/#c95548/#fdece8/#f9e2dd/#7f2f24 全部转语义 token；feedback toast/state panels/warning sections 统一 status-blush/sage/border-strong