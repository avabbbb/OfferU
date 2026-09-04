# OfferU Public Release — Frontend Redirect Boundary

日期：2026-09-03  
状态：`PARTIAL`

## 变更

前端主 API、SSE、SWR 和非展示模式统一请求现在显式使用 `redirect: "error"`。本地 7410/8765 服务若被错误服务重定向到 8080 或外部地址，请求会直接失败并进入现有错误提示，不会继续访问或把错误网页当成 OfferU。

## 边界

- 没有改变 API 路由、SSE 协议或展示模式数据层。
- OfferU 网页仍固定为 `http://127.0.0.1:7410`，后端仍固定为 `http://127.0.0.1:8765`。
- 没有访问 `8080`，没有启动 Edge，也没有创建浏览器窗口。

## 未执行

按照 `AGENTS.md`，本切片未运行测试、构建、语法检查或浏览器验收；新增 architecture contract 仍待执行，Public Release 继续为 `NOT_READY`。

