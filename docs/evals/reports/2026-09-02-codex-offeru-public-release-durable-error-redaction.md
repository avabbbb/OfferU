# OfferU Public Release — durable error redaction boundary

日期：2026-09-02  
观察 checkout：当前工作树  
结论：`PARTIAL`

## Change

把持久化失败状态的读取和写入边界统一到同时处理凭据与直接 PII 的脱敏路径：

- Provider health 的旧行和新写入错误现在使用 `redact_sensitive_text`；
- `CareerTask`、`AutomationEvent` 和 Hosted Executor 的错误字段在写入和投影时都会脱敏邮箱、电话及 credential-like 文本；Hosted Executor 的 Provider event payload 也在写入/读取两侧处理直接 PII；
- durable diagnostic bundle 原有的失败摘要继续只输出 bounded metadata、`error_id` 和脱敏错误片段，不读取 Profile、Job、Resume 或原始 provider payload；
- 普通 CareerTask/Automation payload 仍使用 secret-only redaction，避免把合法职业内容误当成错误文本抹掉。

## Verification mapping

新增/扩展 contract coverage：

- Provider health 旧持久化错误中的邮箱和电话不会进入 API projection；
- CareerTask、AutomationEvent、Hosted Executor 的错误 projection 对同一组邮箱/电话输入均不返回明文；
- Hosted Executor 的持久化 Provider event payload 不返回邮箱、电话或 credential-like 值，同时保留普通结构化 metadata；
- durable payload 的普通 `email`/职业内容仍保持原值，只有敏感 key 继续被 secret-only redaction 处理。

按 `AGENTS.md`，本切片写入后没有运行测试、构建、语法检查或浏览器；新增测试待用户执行。现有运行时入口未改变：网页仍为 `http://127.0.0.1:7410`，后端为 `http://127.0.0.1:8765`，`8080` 不是网页服务，也没有启动 Edge 或任何可见浏览器。

## Remaining release risk

这不是完整 PII/retention 证明。历史日志、artifact、third-party provider 原始输出、3 条旧邮箱正文、公开隐私政策、真实 OAuth 和远程 Release runner 仍需独立验收；Security 与 Public Release 继续保持 `NOT_VERIFIED` / `NOT_READY`。
