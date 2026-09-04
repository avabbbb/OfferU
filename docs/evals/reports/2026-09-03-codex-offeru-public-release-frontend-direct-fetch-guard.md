# OfferU Public Release — Frontend Direct Fetch Guard

日期：2026-09-03

## 结论

前端剩余的直接网络请求现在也显式拒绝 HTTP 重定向，补齐统一 API 层之外的路径，避免错误本地服务把请求带到 8080 或任意外部地址。

## 覆盖范围

- `frontend/src/app/studio/page.tsx`
- `frontend/src/app/optimize/components/OptimizeChatPanel.tsx`
- `frontend/src/app/settings/page.tsx`
- `frontend/src/lib/showcase/llm.ts`

这些路径的 GET、POST 和流式 LLM 请求均使用 `redirect: "error"`。请求仍沿用原有 API/Provider 地址和业务流程，没有增加新的后端或浏览器入口。

## 当前状态

源码边界已落盘；前端 typecheck、production build、真实网络重定向故障和远程 Release runner 尚未执行，因此该切片不提升 Public Release 动态 Gate。

本切片未启动 Edge、未创建浏览器窗口、未访问 8080，也未修改真实用户数据库。
