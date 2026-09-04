# OfferU Public Release — User-visible Error Boundary

日期：2026-09-03  
状态：`PARTIAL`

## 本轮处理

- Codex Agent Bridge 将未预期异常返回给模型时，改用统一的 bounded redaction，不再拼接原始异常文本。
- Gmail 本地回调配置错误和 Resume 的可选 Playwright 依赖错误也经过同一安全错误摘要边界。
- 本轮没有改变 Agent Provider、Operation Registry 或浏览器导航行为；没有启动 Edge、创建浏览器窗口或访问 `8080`。

## 未完成

本轮按 `AGENTS.md` 未运行测试、语法检查、构建或浏览器验收；其它历史异常路径、真实 Provider/网络矩阵、签名安装包、升级和隐私决策仍需 Public Release 证据。
