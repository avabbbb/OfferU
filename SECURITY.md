# OfferU Public Release Security

更新时间：2026-09-03

## Current verdict

```text
SECURITY_NOT_VERIFIED
```

现有 Operation Registry、候选事实门、只读外部研究和本地单人边界是安全基础，但它们不是 Public Release 安全证明。`SECURITY_01` 至 `SECURITY_11` 已补齐错误关联、脱敏诊断包、canary、依赖/权限/logger contract、云端类别同意、邮箱撤回、合成测试数据清理、Provider health 读取侧脱敏和 durable error projection 的直接 PII 脱敏；当前 release artifact/sidecar secret audit 与 architecture/Registry boundary audit 也已通过。最新 RustSec advisory fetch 已成功，但 `cargo audit --deny unsound` 仍被 `glib 0.18.5 / RUSTSEC-2024-0429` 阻塞，另有 16 条 unmaintained warning。正常工作区仍有 3 条历史旧正文，历史 artifact/行 scrub、完整 runtime PII data-flow、retention/公开政策、真实 OAuth/浏览器和发布签名仍未完成，因此 Public Release 继续保持 `SECURITY_NOT_VERIFIED`。

## Security 01 current evidence

当前报告：[2026-08-31-codex-offeru-core-v1-security-01](docs/evals/reports/2026-08-31-codex-offeru-core-v1-security-01.md)，对应 commit `7529c59`。

已验证的子项包括：

- 新增的递归敏感信息脱敏覆盖公开错误、Agent Run 新写入元数据、配置投影和已审计的 Agent/研究/面试/简历/自动化路径；Operation Audit、CareerTask、Automation/Hosted Event 以及隔离 canary targeted regression 为 37 passed；
- agent-runtime、frontend、extension 三个 npm production audit 均为 0 vulnerabilities；
- Tauri capability 仅保留 `core:default`，shell plugin/通用 execute/spawn/kill 权限已移除；CSP 不再为 `null`；
- CORS 方法/请求头已收敛，正常 API 返回 `nosniff`、frame deny、no-referrer 和 `no-store`；
- Pi worker `runtime.probe` 与无外部模型请求的生命周期 smoke 通过；tracked secret scan 无 unexpected match。
- 原始 LLM 响应、provider stderr、爬虫异常和向量索引内容不再直接写入日志；日志审计扫描不再发现 `logger.exception` 或内容片段路径。

这些结果只证明安全子项，不等于完整 Security Gate PASS。历史 Agent Run 行不会被静默重写；当前 CSP 为支持用户自定义 LLM endpoint 和 MediaPipe 资源仍保留 broad `https:`；RustSec advisory fetch 已在 SECURITY_10 中成功，但严格 unsound policy 仍失败；历史行/artifact scrub、完整 runtime PII/retention 和真实 OAuth/浏览器矩阵尚未完成。

## Security 02 current evidence

当前补充报告：[2026-08-31-codex-offeru-core-v1-security-02](docs/evals/reports/2026-08-31-codex-offeru-core-v1-security-02.md)，对应 commit `485871b`。

本轮已验证：

- HTTP、Starlette 404、请求验证错误和未处理异常具备 `error_id` / `X-OfferU-Error-Id`；验证错误响应不回显 FastAPI 的原始 `input`；前端 API/SSE 会把错误 ID 带给用户；
- `export_diagnostic_bundle` 通过 Operation Registry 提供本地脱敏诊断包，只含运行元数据、健康摘要和有限错误关联记录，不包含 Profile、Job、Resume、请求 headers 或 credentials；
- Settings 浏览器路径实际下载 v2 反馈包；fake `api_token` 在下载内容中未命中，endpoint 200，page/console errors 为 0；
- 已确认的 Profile/Resume/Doctor/database migration/scraper 原始异常或远端 message 泄露已收口；health 只返回数据库文件名；
- `python-multipart` 已升级到 `0.0.31`；JobSpy 固定到上游更新 markdownify 约束的 commit，并使用 `markdownify==1.2.3`；`pip check` 无冲突，`pip-audit` 无已知漏洞；npm production audit 使用官方 registry 为 0 vulnerabilities；
- 依赖替换后的后端全量为 `298 passed, 10 warnings, 1 subtest passed`，前端 typecheck/build 通过。

本轮仍未把 Security Gate 标为 PASS：RustSec advisory DB 已成功拉取且普通 audit 报告 0 vulnerabilities，但严格 `--deny unsound` 被 `glib 0.18.5 / RUSTSEC-2024-0429` 阻塞；完整 release artifact canary、所有权限 surface diff、全部 logging/PII data-flow、历史 Agent Run scrub、privacy/consent 和签名仍待完成。

## Stable security boundary

- Career Truth 的 mutation 必须经过 Operation Registry、验证、权限、持久化与审计；
- Agent、Automation、CLI、MCP、Plugin、Browser Extension 不得绕过 Registry；
- 外部不可逆写入始终由用户本人完成；
- API key、OAuth token、password、cookie、keychain secret 不进入源码、SQLite、日志、trace、diagnostic bundle 或 Agent context；
- `.env.example` 不提供可用凭据，Docker Compose 要求使用者显式提供唯一的 `DB_PASSWORD` 与 `SECRET_KEY`，缺失时 fail-closed；
- PDF/导出失败只返回有界脱敏错误，不把 Playwright、WeasyPrint 或本机路径异常原样暴露给用户；
- 简历、邮件、面试 transcript、电话和私人邮箱默认不写完整日志；
- Optional Provider 失败必须显式，不静默降级或伪造成功；
- local-first 不等于自动安全，安装包、备份、Temp、日志和 updater 都属于同一数据保护边界。

## Release security gates

| Gate | Status | Required evidence |
| --- | --- | --- |
| Secret scan | PARTIAL | tracked repo、当前 Windows bundle/sidecar artifact audit 已通过；历史 logs、trace、Temp、diagnostic、export 的完整 matrix 仍缺 |
| Canary secret | PARTIAL | durable Agent/Audit/export + API validation/error + diagnostic + browser feedback canary 已通过；完整 release artifact matrix 仍缺 |
| Dependency audit | PARTIAL | 三个 npm production audit 与 Python `pip-audit` 已通过；最新 RustSec fetch 成功且普通 audit 为 0 vulnerabilities，但严格 unsound policy 被 `glib 0.18.5 / RUSTSEC-2024-0429` 阻塞，另有 16 条 unmaintained warning |
| Operation permission audit | PARTIAL | architecture audit 的 route/Registry、CLI/MCP/plugin、Automation/startup boundary 为 0 finding；动态 legacy/runtime 全 surface 仍缺 |
| Logging / PII audit | PARTIAL | Python logger AST contract 当前敏感动态参数为 0；历史日志、桌面/第三方日志和完整 runtime data-flow 仍缺 |
| Diagnostic redaction | PARTIAL | Registry-backed bundle、error ID、API 与浏览器下载 canary 已通过；完整 artifact/PII review 仍缺 |
| Tauri capabilities | PASS | 当前 capability 仅保留 `core:default`；shell plugin 与通用 execute/spawn/kill 权限已移除 |
| Tauri CSP | PASS with limitation | 当前 CSP 非 `null`，包含 `object-src 'none'`、`frame-ancestors 'none'`；为用户自定义 endpoint/MediaPipe 保留 broad `https:` |
| Updater signing | NOT_VERIFIED | 若启用 updater，公钥校验和签名 artifact 通过；私钥不入仓库 |
| Code signing | BLOCKED_EXTERNAL | 代码准备完成后仍需目标平台合法证书与所有者凭据 |
| Privacy disclosure | PARTIAL | `docs/PRIVACY_CONSENT.md`、Interview/Email/Settings UI 已披露主要数据流与 export/delete；最终公开法律政策和历史 retention 仍缺 |
| Consent | PARTIAL | local/cloud Interview、Gmail/IMAP 只读和 authorized browser boundary 有 contract；真实 OAuth/媒体授权和最终 outcome policy 仍缺 |

## Security 09 current evidence

当前补充报告：[Public Release Provider Health Matrix](docs/evals/reports/2026-09-02-codex-offeru-public-release-provider-health.md)。

- 健康状态只从统一投影输出 `unprobed`、`ready`、`auth_required`、`blocked`、`unavailable`；
- 已知 Provider 列表固定为 `pi`、`replay`、`codex`、`deepseek-harness`，不存在 Provider 时不会默认显示为可用；
- `last_error` 在持久化写入和 API 读取两侧都经过 bounded credential redaction，覆盖可能来自旧数据或恢复路径的行；
- 定向隔离数据库 contract 为 `4 passed`，canary token 不出现在 provider-health projection 中。

这只提升 Provider health 的确定性安全边界，不代表真实 OAuth、live Role Intelligence、历史 PII scrub、retention policy 或代码签名已经完成。

## Security 11 current evidence

当前补充报告：[durable error redaction boundary](docs/evals/reports/2026-09-02-codex-offeru-public-release-durable-error-redaction.md)。

- Provider health 的读取/写入路径现在都使用同时处理凭据和直接 PII 的 bounded redaction，旧持久化行也不会原样返回；
- CareerTask、AutomationEvent 和 Hosted Executor 的错误字段在 durable write 与 API projection 两侧都不再依赖 secret-only redaction；Hosted Executor Provider event payload 也有写入/读取两侧的直接 PII redaction；
- 普通职业 payload 仍维持 secret-only redaction，避免把合法职业资料中的邮箱字段误当作错误内容处理；
- 新增 contract coverage 验证统一的邮箱/电话错误输入不会进入错误 projection。

该切片只收紧错误状态的直接 PII 暴露面，不替代历史日志/artifact scrub、第三方原始输出审计、retention policy、3 条历史旧邮箱正文决定或真实发布验收；Security 仍为 `SECURITY_NOT_VERIFIED`。

## Downloaded artifact audit boundary

CI now runs `audit_artifacts.py --json` on the artifact directory after the installer smoke job and Draft Release job download it, in addition to the upload-side scan. This rechecks canary, credential-like token, private-key, sensitive-filename and text-artifact email/phone patterns immediately before installation or publication. The text PII rules apply to diagnostic/log/config/document extensions, while binary installer/sidecar files remain on the value-free secret scan to avoid treating arbitrary bytes as phone numbers. The audit rejects a symlink root and fails closed on artifact-directory symlinks instead of following paths outside the scan root. The manifest verifier independently rejects a symlink root and symlink `artifacts.json`, `SHA256SUMS.txt`, or `version.json` before resolving release metadata. The remote runner, signed artifact and full PII/retention matrix are still unverified, so this is a control boundary rather than a completed Security Gate.

## RustSec dependency audit

本地 `cargo-audit 0.22.2` 已成功更新 advisory database，并扫描当前 `Cargo.lock` 的 441 个依赖：普通 audit 为 `0 vulnerabilities`，但严格 `cargo audit --deny unsound` 发现 `glib 0.18.5 / RUSTSEC-2024-0429`，同时保留 16 条 unmaintained warning。目标图检查显示 `glib` 不在 `x86_64-pc-windows-msvc` 图中，而来自 Tauri/Wry 的跨平台 GTK/WebKit Linux 分支；这只能界定 Windows 包的实际链接范围，不能替代全锁文件策略处置。`.github/workflows/build.yml` 已加入同一审计并让 tag release 依赖严格 unsound 检查；在依赖升级或经批准的安全例外前，R55 不得视为 PASS。

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
