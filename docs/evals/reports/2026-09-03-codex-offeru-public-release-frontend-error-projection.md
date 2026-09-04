# OfferU Public Release — Frontend Error Projection

日期：2026-09-03  
状态：`PARTIAL`

## 目标

将前端用户可见的错误统一投影为有限长度、可读且不泄露本地服务地址、Provider 凭据或个人信息的消息。错误投影不改变业务状态、请求方法或失败分类。

## 变更

- 新增 `frontend/src/lib/safe-error.ts`，统一处理本地 HTTP/WS endpoint、常见 credential、独立 token、邮箱、手机号、控制字符和长度上限。
- 主 API/SWR hooks、直接 fetch、SSE 流和 Showcase LLM 的后端/Provider 错误均先经过 `safeClientErrorMessage`。
- Today、Pipeline/Applications、Job、Role Intelligence、Profile、Resume、Interview、Email、Settings、Agent 和 Onboarding 的用户提示不再直接展示 `error.message` / `err.message` / 原始 `detail`。
- Resume、Job、Interview 和 Profile 的关键失败仍保留具体业务 fallback，避免脱敏后变成空白或假成功。
- SSE progress/error、Agent tool presentation 和 Profile chat 的服务端消息也经过同一投影边界。
- 新增 release architecture contract，要求核心用户界面引用统一 helper，并拒绝常见原始异常展示模式。

## 8080 / 浏览器边界

- OfferU 网页入口仍然只有 `http://127.0.0.1:7410`。
- OfferU 后端仍然只有 `http://127.0.0.1:8765`。
- `127.0.0.1:8080` 只代表可选模型 API，不是网页地址。
- 本轮没有访问 8080，没有启动 Edge、系统默认浏览器或任何可见浏览器窗口。

## 未执行

按照 `AGENTS.md`，本切片未运行测试、typecheck、构建、语法检查或浏览器验收；新增 contract 仍待执行，正式 WXT/桌面产物也未刷新。Public Release 继续为 `OFFERU_PUBLIC_RELEASE_NOT_READY`。
