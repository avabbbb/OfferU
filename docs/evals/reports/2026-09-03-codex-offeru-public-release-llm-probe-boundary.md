# OfferU Public Release — LLM Probe Boundary

日期：2026-09-03  
状态：`PARTIAL`

## 本轮处理

- 共享 LLM 连接探测不再继承系统代理；本地模型端点（包括可选的 `127.0.0.1:8080` llama.cpp）只作为模型 API 使用，不会被当成网页入口。
- LLM 连接探测和模型列表探测都禁止 HTTP 重定向，避免把带有授权头的请求跟随到未经确认的目标。
- 上游错误正文、异常文本和配置 URL 在返回给 UI 前经过长度限制与敏感信息脱敏。
- 没有改变用户显式配置外部模型 Provider 的能力，也没有启动 Edge、创建浏览器窗口或访问 `8080`。

## 未完成

本轮按 `AGENTS.md` 未运行测试、语法检查、构建、PDF 渲染或浏览器验收；因此不能把 LLM Provider、真实 Role Intelligence、Public Release 或 8080 模型服务声明为通过。签名安装包、previous-release upgrade、clean-machine、真实 Provider、完整网络/重启矩阵和隐私/法律决策仍是发布残余。
