# OfferU Public Release — Standalone Credential Redaction

日期：2026-09-03  
状态：`PARTIAL`

## 变更

共享 `security_redaction` 现在除了 Bearer、键值对和 URL 参数外，还会识别常见的独立 Provider credential 形态：OpenAI-compatible `sk/rk/pk`、GitHub token 和 Google API key。它们会在公共错误、诊断、Agent/插件错误和持久化投影经过同一脱敏边界。

## 边界

- 只改变错误/诊断文本的脱敏，不改变职业内容、Provider 选择或 Operation 行为。
- OfferU 网页仍固定为 `http://127.0.0.1:7410`，后端仍固定为 `http://127.0.0.1:8765`。
- 没有访问 `8080`，没有启动 Edge，也没有创建浏览器窗口。

## 未执行

按照 `AGENTS.md`，本切片未运行测试、构建、语法检查或浏览器验收；新增回归测试与 architecture contract 仍待执行，Public Release 继续为 `NOT_READY`。

