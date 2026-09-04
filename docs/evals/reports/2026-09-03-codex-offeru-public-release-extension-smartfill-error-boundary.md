# OfferU Public Release — Extension Smart Fill Error Boundary

日期：2026-09-03  
状态：`PARTIAL`

## 变更

扩展 Smart Fill 的共享 HTTP 请求函数在非 2xx 响应时不再读取后端或外部模型的响应正文，只返回 HTTP 状态码和可选 `X-OfferU-Error-Id`。这覆盖 AI ping、mapping、Profile catalog、缓存和运行日志等共用请求路径，防止上游错误正文中的凭据或职业隐私进入扩展错误消息。

## 边界

- 没有改变 Smart Fill 的 fallback、缓存或字段映射逻辑。
- OfferU 网页仍固定为 `http://127.0.0.1:7410`，后端仍固定为 `http://127.0.0.1:8765`。
- 没有访问 `8080`，没有启动 Edge，也没有创建浏览器窗口。
- 根目录生成的旧 `extension/background.js` 未手工修改；正式 WXT bundle 仍需由构建链刷新。

## 未执行

按照 `AGENTS.md`，本切片未运行测试、构建、语法检查或浏览器验收；新增 architecture contract 仍待执行，Public Release 继续为 `NOT_READY`。

