# OfferU Public Release — Frontend Error Boundary

日期：2026-09-03  
状态：`PARTIAL`

## 变更

前端主 API 客户端和 SWR 连接失败不再回显原始 transport error；校徽解析失败也不读取或回显响应正文，只保留固定提示、HTTP 状态和可选 `X-OfferU-Error-Id`，避免中间层返回的凭据、路径或职业隐私进入 UI。

## 边界

- 没有改变 API 路由、请求方法、重试或 Resume Workspace 业务逻辑。
- OfferU 网页仍固定为 `http://127.0.0.1:7410`，后端仍固定为 `http://127.0.0.1:8765`。
- 没有访问 `8080`，没有启动 Edge，也没有创建浏览器窗口。

## 未执行

按照 `AGENTS.md`，本切片未运行测试、构建、语法检查或浏览器验收；新增 architecture contract 仍待执行，Public Release 继续为 `NOT_READY`。

