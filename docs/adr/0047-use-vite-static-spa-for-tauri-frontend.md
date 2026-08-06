---
status: accepted
---

# Tauri 桌面前端使用 Vite 静态 SPA

OfferU 的桌面前端使用 React 18、Vite 和 HashRouter 构建静态单页应用。开发模式由 Vite 在固定端口 7410 提供模块与热更新；发布模式由 Tauri 直接嵌入并加载 `frontend/dist`，不能把 `frontendDist` 配置成 localhost 或其他远程 URL。现有业务页面按路由懒加载，Python 仍是唯一业务后端和 Agent Run 事实源。

选择这一方案是因为 OfferU 不需要原生 SSR，而 Next.js 开发服务器每次桌面冷启动都要重新准备服务器并编译大型首页依赖图。把 Python 改写为 TypeScript 不会消除这段前端编译，也会复制现有领域逻辑和 Operation Registry。

## Consequences

- 桌面发布包不依赖本机前端服务，启动时间主要由静态资源加载和 Python 后端就绪时间决定。
- 动态业务路径使用 HashRouter；页面级代码分割用于隔离简历编辑器、图表、引导和 AgentPanel 等大型依赖。
- 原 Next.js server route 必须改为构建期静态数据或 Python API；不能在 Tauri 前端内假设 Node.js server runtime。
- Python 后端、Pi SDK Worker 和外部 Coding Agent 路线不因本决策改写为 TypeScript。
