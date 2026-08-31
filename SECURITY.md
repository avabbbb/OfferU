# OfferU Public Release Security

更新时间：2026-08-31

## Current verdict

```text
SECURITY_NOT_VERIFIED
```

现有 Operation Registry、候选事实门、只读外部研究和本地单人边界是安全基础，但它们不是 Public Release 安全证明。`SECURITY_01` 已完成首轮边界硬化，`SECURITY_02` 又补齐了错误关联、脱敏诊断包、验证输入隔离和 Python/npm dependency 证据；Rust advisory、完整 canary、全量 logging/PII、权限 diff、历史行 scrub、privacy/consent 和发布签名仍未完成，因此 Public Release 继续保持 `SECURITY_NOT_VERIFIED`。

## Security 01 current evidence

当前报告：[2026-08-31-codex-offeru-core-v1-security-01](docs/evals/reports/2026-08-31-codex-offeru-core-v1-security-01.md)，对应 commit `7529c59`。

已验证的子项包括：

- 新增的递归敏感信息脱敏覆盖公开错误、Agent Run 新写入元数据、配置投影和已审计的 Agent/研究/面试/简历/自动化路径；Operation Audit、CareerTask、Automation/Hosted Event 以及隔离 canary targeted regression 为 37 passed；
- agent-runtime、frontend、extension 三个 npm production audit 均为 0 vulnerabilities；
- Tauri capability 仅保留 `core:default`，shell plugin/通用 execute/spawn/kill 权限已移除；CSP 不再为 `null`；
- CORS 方法/请求头已收敛，正常 API 返回 `nosniff`、frame deny、no-referrer 和 `no-store`；
- Pi worker `runtime.probe` 与无外部模型请求的生命周期 smoke 通过；tracked secret scan 无 unexpected match。
- 原始 LLM 响应、provider stderr、爬虫异常和向量索引内容不再直接写入日志；日志审计扫描不再发现 `logger.exception` 或内容片段路径。

这些结果只证明安全子项，不等于完整 Security Gate PASS。历史 Agent Run 行不会被静默重写；当前 CSP 为支持用户自定义 LLM endpoint 和 MediaPipe 资源仍保留 broad `https:`；`pip-audit`、`cargo-audit`、全链路 canary、完整日志/PII/diagnostic 关联审计尚未完成。

## Security 02 current evidence

当前补充报告：[2026-08-31-codex-offeru-core-v1-security-02](docs/evals/reports/2026-08-31-codex-offeru-core-v1-security-02.md)，对应 commit `485871b`。

本轮已验证：

- HTTP、Starlette 404、请求验证错误和未处理异常具备 `error_id` / `X-OfferU-Error-Id`；验证错误响应不回显 FastAPI 的原始 `input`；前端 API/SSE 会把错误 ID 带给用户；
- `export_diagnostic_bundle` 通过 Operation Registry 提供本地脱敏诊断包，只含运行元数据、健康摘要和有限错误关联记录，不包含 Profile、Job、Resume、请求 headers 或 credentials；
- Settings 浏览器路径实际下载 v2 反馈包；fake `api_token` 在下载内容中未命中，endpoint 200，page/console errors 为 0；
- 已确认的 Profile/Resume/Doctor/database migration/scraper 原始异常或远端 message 泄露已收口；health 只返回数据库文件名；
- `python-multipart` 已升级到 `0.0.31`；JobSpy 固定到上游更新 markdownify 约束的 commit，并使用 `markdownify==1.2.3`；`pip check` 无冲突，`pip-audit` 无已知漏洞；npm production audit 使用官方 registry 为 0 vulnerabilities；
- 依赖替换后的后端全量为 `298 passed, 10 warnings, 1 subtest passed`，前端 typecheck/build 通过。

本轮仍未把 Security Gate 标为 PASS：RustSec advisory DB 在当前网络环境无法拉取且本地 cache 不存在；完整 release artifact canary、所有权限 surface diff、全部 logging/PII data-flow、历史 Agent Run scrub、privacy/consent 和签名仍待完成。

## Stable security boundary

- Career Truth 的 mutation 必须经过 Operation Registry、验证、权限、持久化与审计；
- Agent、Automation、CLI、MCP、Plugin、Browser Extension 不得绕过 Registry；
- 外部不可逆写入始终由用户本人完成；
- API key、OAuth token、password、cookie、keychain secret 不进入源码、SQLite、日志、trace、diagnostic bundle 或 Agent context；
- 简历、邮件、面试 transcript、电话和私人邮箱默认不写完整日志；
- Optional Provider 失败必须显式，不静默降级或伪造成功；
- local-first 不等于自动安全，安装包、备份、Temp、日志和 updater 都属于同一数据保护边界。

## Release security gates

| Gate | Status | Required evidence |
| --- | --- | --- |
| Secret scan | NOT_VERIFIED | tracked repo scan 已通过；build output、logs、trace、Temp、diagnostic、export 的完整报告仍缺 |
| Canary secret | PARTIAL | durable Agent/Audit/export + API validation/error + diagnostic + browser feedback canary 已通过；完整 release artifact matrix 仍缺 |
| Dependency audit | PARTIAL | 三个 npm production audit 与 Python `pip-audit` 已通过；RustSec advisory DB 无法在当前环境获取 |
| Operation permission audit | NOT_VERIFIED | 所有写 surface 与 Registry diff，0 known bypass |
| Logging / PII audit | NOT_VERIFIED | 已修复确认的原始路径；完整 logging/data-flow review 仍缺 |
| Diagnostic redaction | PARTIAL | Registry-backed bundle、error ID、API 与浏览器下载 canary 已通过；完整 artifact/PII review 仍缺 |
| Tauri capabilities | PASS | 当前 capability 仅保留 `core:default`；shell plugin 与通用 execute/spawn/kill 权限已移除 |
| Tauri CSP | PASS with limitation | 当前 CSP 非 `null`，包含 `object-src 'none'`、`frame-ancestors 'none'`；为用户自定义 endpoint/MediaPipe 保留 broad `https:` |
| Updater signing | NOT_VERIFIED | 若启用 updater，公钥校验和签名 artifact 通过；私钥不入仓库 |
| Code signing | BLOCKED_EXTERNAL | 代码准备完成后仍需目标平台合法证书与所有者凭据 |
| Privacy disclosure | NOT_VERIFIED | UI 可见的数据流、第三方、camera/mic、export/delete 说明 |
| Consent | NOT_VERIFIED | email、microphone、camera、external model 的明确授权 outcome |

## Security exception format

Release 时不得静默接受 High。唯一可接受记录格式：

```text
SECURITY_EXCEPTION
dependency / finding:
risk:
reason:
mitigation:
owner:
expiry / review date:
```

## Canary protocol

1. 仅在隔离 release workspace 中注入唯一假 secret；
2. 执行 Agent、API、错误、诊断、数据导出和浏览器失败路径；
3. 扫描 stdout/stderr、结构化日志、SQLite audit、Playwright artifacts、下载、Temp 和 bundle；
4. 任一明文命中即 FAIL；哈希/长度等不可逆摘要必须确认无法还原；
5. 清理隔离 workspace，不对真实用户数据执行 destructive scan。

## Product privacy disclosure required before release

公开产品必须在 UI 中明确：哪些数据只在本地；哪些内容会发送给选定模型；第三方集成读取什么；camera/microphone 是否保存原始媒体；如何导出、备份、恢复和删除；卸载是否保留用户数据。
