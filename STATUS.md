# OfferU Public Release Status

更新时间：2026-09-03

## Current release phase

```text
AUTONOMOUS_PRODUCTION_READINESS
```

## Current verdict

```text
OFFERU_PUBLIC_RELEASE_NOT_READY
```

`RESUME_WORKSPACE_BETA_READY` 是上一阶段的 Internal Beta 检查点，不是 Public Release 结论。当前工作树已经补齐一组可复现的 E2E、性能、Sidecar、安装生命周期、release Doctor、主要页面空状态和 live Agent 证据，但实时 Role Intelligence 的 Pi CLI 适配在真实隔离运行中未形成结构化结果，Codex 仍受认证阻塞；同时仍没有 signed installer、previous-release upgrade、真正 clean-machine 人工验收和完整 security/privacy 决策，因此不得宣称 Public Release Ready。

## Current Gate

```text
PUBLIC_RELEASE_RESIDUAL_79
Role Intelligence controlled backend-search adapter → public web HTTP boundary, generated extension artifact, RustSec, live Provider, clean-machine and release residual
```

状态：`PARTIAL`

原因：`DATA_SAFETY_03` 已通过结构化导出完整性、递归敏感字段排除、Demo Reset scope 和隔离 Settings 浏览器路径。`SECURITY_02` 至 `SECURITY_11` 已补齐 error ID、脱敏诊断、canary、依赖/权限/logger contract、云端类别同意、Gmail/IMAP 只读确认、邮箱撤回、合成数据清理、Provider health 和 durable error projection 的直接 PII redaction；但正常工作区仍有 3 条历史旧正文，历史 artifact/行 scrub、完整 runtime PII data-flow、retention/公开政策、真实 OAuth 和完整外部信号浏览器证据仍未验证。Reliability-03 至 -14 已补齐保存失败重试、Interview/Learning 启动恢复、真实 backend 100-cycle HTTP 与 worker workload、关键 mutation retry/restart、邮箱测试隔离、浏览器双击/已提交后 503 重试唯一性、CareerTask/AutomationEvent 的跨进程原子 claim，以及跨进程 auth/timeout/restart recovery contract；Reliability-12 按 Goal 的“2 小时或 100 个代表性 task cycles”通过 soak 与 100-cycle RSS 门槛。2026-09-01 又完成 10/10 组合 E2E、50/50 first-run、失败路径、主要页面空状态矩阵、Interview Focus/Debrief/Learning 浏览器路径、性能 SLO、Tauri bundle、安装生命周期、release-mode Doctor、打包 PDF、staged-config live Pi smoke、可移植的隔离浏览器 smoke、Role Intelligence authority tests、启动恢复 health/diagnostics 证据，以及正式架构/Registry drift audit；完整后端回归现为 `362 passed, 19 warnings, 1 subtests passed in 329.19s`。但签名、previous-release upgrade、真正 clean-machine 独立验收、完整 provider/browser/network/restart 矩阵、远程 CI runner 和隐私/法律决策仍未完成。OpenCode `1.17.11` 虽可执行，但当前没有 OfferU 控制的公开网页工具边界，已 fail-closed，不计入 live Role Intelligence 通过。Public Release 继续保持 `NOT_READY`。

最新代码切片 `LLM_PROBE_BOUNDARY_54`：共享 LLM 连接探测和模型列表探测均显式绕过系统代理、拒绝 HTTP 重定向，并在返回 UI 前对上游错误、异常和配置 URL 做脱敏与长度限制。`127.0.0.1:8080` 仍只属于可选 llama.cpp 模型端点，不是网页入口；本轮没有启动 Edge、打开任何浏览器窗口或访问 8080。该切片未运行测试、构建、语法检查或 Provider/PDF/browser 验收，不能提升 Public Release 动态 Gate。

最新代码切片 `CONFIG_ATOMIC_WRITE_55`：Provider 配置统一通过同目录临时文件与原子替换写入，覆盖 Server route、Provider import 和本地模型发现，避免中断写入留下半个 `config.json` 并在启动时静默回退。该切片未运行测试、构建、语法检查或浏览器验收，没有启动 Edge、创建浏览器窗口或访问 8080，Public Release 仍为 `NOT_READY`。

最新代码切片 `ERROR_BOUNDARY_56`：Codex Agent Bridge、Gmail 回调配置错误和 Resume 可选渲染依赖错误统一使用 bounded redaction，不再把原始异常文本直接送入用户/模型响应。该切片未运行测试、构建、语法检查或浏览器验收，没有启动 Edge、创建浏览器窗口或访问 8080，Public Release 仍为 `NOT_READY`。

最新代码切片 `EXTENSION_ERROR_BOUNDARY_57`：扩展 `HttpOfferUControl` 在非 2xx 响应时不再读取或回显后端响应正文，只保留 HTTP 状态码和可选 `X-OfferU-Error-Id`；新增单元测试与 release architecture contract。该切片未运行测试、构建、语法检查或浏览器验收，没有启动 Edge、创建浏览器窗口或访问 8080；正式 WXT bundle 仍需通过构建链刷新，Public Release 继续为 `NOT_READY`。

最新代码切片 `LOCAL_DISCOVERY_ERROR_BOUNDARY_58`：本地模型自动发现写入配置失败时也通过 `safe_error_message` 返回，不把原始异常文本直接暴露给调用方；`127.0.0.1:8080` 仍只是可选 llama.cpp Provider 端点，不是网页入口。该切片未运行测试、构建、语法检查或浏览器验收，没有启动 Edge、创建浏览器窗口或访问 8080；新增 contract 尚未执行，Public Release 继续为 `NOT_READY`。

最新代码切片 `AGENT_RUNTIME_ERROR_BOUNDARY_59`：Codex turn、Claude SDK worker 和非 hosted worker stderr 现在经过 bounded redaction 后再进入上层错误/结果，保留退出码和重试信息但不直接传播外部进程原文；新增 release architecture contract。该切片未运行测试、构建、语法检查或浏览器验收，没有启动 Edge、创建浏览器窗口或访问 8080，Public Release 继续为 `NOT_READY`。

最新代码切片 `PLUGIN_ERROR_BOUNDARY_60`：Capability Plugin stderr 现在在失败消息和返回诊断字段中统一进行邮箱、电话、凭据脱敏并限制为 2,000 字符；新增 release architecture contract。该切片未运行测试、构建、语法检查或浏览器验收，没有启动 Edge、创建浏览器窗口或访问 8080，Public Release 继续为 `NOT_READY`。

最新代码切片 `EXTENSION_SMARTFILL_ERROR_BOUNDARY_61`：扩展 Smart Fill 共享 HTTP 请求在非 2xx 响应时不再读取或回显响应正文，只保留 HTTP 状态码和可选错误 ID；新增 release architecture contract，覆盖 AI ping、mapping、Profile 和缓存请求。该切片未运行测试、构建、语法检查或浏览器验收，没有启动 Edge、创建浏览器窗口或访问 8080；正式 WXT bundle 仍需刷新，Public Release 继续为 `NOT_READY`。

最新代码切片 `STANDALONE_CREDENTIAL_REDACTION_62`：共享脱敏器新增独立 `sk/rk/pk`、GitHub token 和 Google API key 识别，覆盖公共错误、诊断、Agent/插件错误和持久化投影的共用边界；新增回归测试与 release architecture contract。该切片未运行测试、构建、语法检查或浏览器验收，没有启动 Edge、创建浏览器窗口或访问 8080，Public Release 继续为 `NOT_READY`。

最新代码切片 `PI_GUARDIAN_ERROR_BOUNDARY_63`：Pi Agent Guardian 失败现在先生成共享脱敏错误，再写入 `learning_observation` 与 `guardian.failed`，避免持久化事件和实时事件出现不同泄露边界；新增 release architecture contract。该切片未运行测试、构建、语法检查或浏览器验收，没有启动 Edge、创建浏览器窗口或访问 8080，Public Release 继续为 `NOT_READY`。

最新代码切片 `FRONTEND_TRANSPORT_ERROR_BOUNDARY_64`：前端主 API/SWR 连接失败不再回显原始 transport error，校徽解析失败也不读取或回显响应正文，只保留固定提示、HTTP 状态和可选错误 ID；新增 release architecture contract。该切片未运行测试、构建、语法检查或浏览器验收，没有启动 Edge、创建浏览器窗口或访问 8080，Public Release 继续为 `NOT_READY`。

最新代码切片 `FRONTEND_REDIRECT_BOUNDARY_65`：前端主 API、SSE、SWR 和统一请求层均拒绝 HTTP 重定向，错误服务无法把本地请求带到 8080 或外部地址；新增 release architecture contract。该切片未运行测试、构建、语法检查或浏览器验收，没有启动 Edge、创建浏览器窗口或访问 8080，Public Release 继续为 `NOT_READY`。

最新代码切片 `GENERATED_EXTENSION_ARTIFACT_GUARD_66`：扩展构建完成后的专用架构审计现在检查 tracked `extension/background.js`、`extension/popup.html` 和 `manifest.json`；旧 background bundle 缺少固定 8765 health/redirect 防线，popup 直接引用 `src/popup.ts` 或缺少构建后的 `chunks/*.js` 时会 fail-closed。CI 已将该检查放在受保护 WXT build/sync 之后，避免全新 checkout 在构建前误报；当前工作树的旧/未同步扩展产物仍保持 release finding。本切片未运行测试、构建、语法检查或浏览器验收，没有启动 Edge、创建浏览器窗口或访问 8080，Public Release 继续为 `NOT_READY`。详见 [generated extension guard](docs/evals/reports/2026-09-03-codex-offeru-public-release-generated-extension-guard.md)。

最新代码切片 `FRONTEND_DIRECT_FETCH_GUARD_67`：Studio、Optimize、Settings 模型探测和 Showcase LLM 的直接 fetch 现在统一设置 `redirect: "error"`，补齐统一 API/SWR 层之外的网络边界；错误服务不能把请求跟随到 8080 或外部地址。本切片未运行测试、构建、语法检查或浏览器验收，没有启动 Edge、创建浏览器窗口或访问 8080，Public Release 继续为 `NOT_READY`。详见 [frontend direct-fetch guard](docs/evals/reports/2026-09-03-codex-offeru-public-release-frontend-direct-fetch-guard.md)。

最新代码切片 `EXTENSION_DIRECT_FETCH_GUARD_68`：扩展岗位详情补全、简历图片、反馈提交和远程规则包请求现在也统一设置 `redirect: "error"`，所有已发现扩展网络路径均不自动跟随到 8080 或外部错误地址。本切片未运行测试、构建、语法检查或浏览器验收，没有启动 Edge、创建浏览器窗口或访问 8080，Public Release 继续为 `NOT_READY`。详见 [extension direct-fetch guard](docs/evals/reports/2026-09-03-codex-offeru-public-release-extension-direct-fetch-guard.md)。

最新代码切片 `SKILL_ERROR_BOUNDARY_69`：Skill Pipeline 失败结果现在通过共享 `safe_error_message` 才进入 Agent 聚合结果，不再直接传播原始 `str(e)`；新增 release architecture contract，保持 Skill 执行和业务错误分类不变。本切片未运行测试、构建、语法检查或浏览器验收，没有启动 Edge、创建浏览器窗口或访问 8080；OfferU 网页仍只使用 `http://127.0.0.1:7410`，后端仍只使用 `http://127.0.0.1:8765`，Public Release 继续为 `NOT_READY`。详见 [skill error boundary](docs/evals/reports/2026-09-03-codex-offeru-public-release-skill-error-boundary.md)。

最新代码切片 `RESEARCH_ERROR_PROJECTION_70`：Role Intelligence 的读取投影现在对历史 `RoleBenchmarkRun.error` 二次使用共享 `safe_error_message`，研究驱动器的 `TASK_EXC` 输出也不再直接打印原始异常；新增 release architecture contract，保持 Provider 分类、任务状态和研究结果不变。本切片未运行测试、构建、语法检查或浏览器验收，没有启动 Edge、创建浏览器窗口或访问 8080；OfferU 网页仍只使用 `http://127.0.0.1:7410`，后端仍只使用 `http://127.0.0.1:8765`，Public Release 继续为 `NOT_READY`。详见 [research error projection](docs/evals/reports/2026-09-03-codex-offeru-public-release-research-error-projection.md)。

最新代码切片 `OPENCODE_LIVE_CAPABILITY_GUARD_71`：OpenCode `1.17.11` 的 `run`/JSON 能力探测未被误当成受控实时网页搜索；由于当前 `--pure` 子进程 seam 没有 OfferU 的公开网页 host/redirect/private-address enforcement，`supports_live_web_search` 已设为 `False`，Role Intelligence live 选择会在启动前 fail-closed。通用 OpenCode 适配器仍保留；新增 architecture contract 与 [OpenCode live boundary](docs/evals/reports/2026-09-03-codex-offeru-public-release-opencode-live-boundary.md)。本轮只做 CLI 帮助探测，未调用 `opencode web`，没有启动 Edge、创建浏览器窗口或访问 8080，Public Release 继续为 `NOT_READY`。

最新代码切片 `EXTENSION_ERROR_PROJECTION_72`：扩展的 Background、Popup、Content、Page Agent、远程规则包、Smart Fill cascade 和 HTTP control 错误现在统一经过 240 字符有界脱敏；本机 endpoint、常见凭据、邮箱和手机号不会原样进入用户提示、跨消息响应或 bootstrap console。Smart Fill opt-in debug console 只输出安全遥测，不直接打印任意表单/简历 payload。新增 helper 单元测试与 release architecture contract；本轮未运行扩展测试、typecheck、WXT build 或浏览器，没有启动 Edge、创建浏览器窗口或访问 8080，Public Release 继续为 `NOT_READY`。详见 [extension error projection](docs/evals/reports/2026-09-03-codex-offeru-public-release-extension-error-projection.md)。

最新代码切片 `FRONTEND_ERROR_PROJECTION_73`：前端新增 500 字符有界 `safeClientErrorMessage`，主 API/SWR hooks、直接 fetch、SSE、Showcase LLM 及核心页面错误均不再直接展示 Provider endpoint、凭据、邮箱、手机号或原始后端 `detail/error`；岗位、投递、Resume、Interview、Profile、Today、Settings 和 Agent 仍保留具体业务 fallback。新增 release architecture contract；本轮未运行 frontend typecheck/build、测试或浏览器，没有启动 Edge、创建浏览器窗口或访问 8080，Public Release 继续为 `NOT_READY`。详见 [frontend error projection](docs/evals/reports/2026-09-03-codex-offeru-public-release-frontend-error-projection.md)。

最新代码切片 `PUBLIC_WEB_HTTP_BOUNDARY_74`：公开网页研究兜底链的 HTTP client 现在显式绕过系统代理并拒绝自动重定向；`fetch_readable` 最多手动跟随 3 跳，每一跳和最终地址都经过公开 HTTP(S)、受限域名和 DNS 公网地址检查，缺失 Location、超限或私网解析时 fail-closed。该切片不打开浏览器，不改变授权浏览流程；新增 release architecture contract，未运行测试、构建、语法检查或 Provider/network/browser 验收，没有启动 Edge、创建浏览器窗口或访问 8080，Public Release 继续为 `NOT_READY`。详见 [public web HTTP boundary](docs/evals/reports/2026-09-03-codex-offeru-public-release-public-web-http-boundary.md)。

最新代码切片 `CONTROLLED_BACKEND_RESEARCH_FALLBACK_75`：`run_backend_research` 现在收敛进 `start_job_research` 的同一个 `JobResearchRun` 生命周期；没有 live-capable CLI 且已配置 bocha/tavily/serper 搜索 API 与 LLM 时，才自动选择明确标记的 `backend_search`，并复用同一事实门、报告、dossier、memory observation、失败、取消和恢复路径。受控路径关闭无法证明网络边界的 ddgs 兜底，不把后端 HTTP 路径伪装成 Agent Runtime；新增页数上限、Operation input 和 architecture contract。该切片未运行测试、构建、语法检查或 Provider/network/browser 验收，没有启动 Edge、创建浏览器窗口或访问 8080，Public Release 继续为 `NOT_READY`。详见 [controlled backend research fallback](docs/evals/reports/2026-09-03-codex-offeru-public-release-backend-research-fallback.md)。

最新代码切片 `JOB_SEARCH_PLUGIN_HTTP_BOUNDARY_76`：公开 `job-search` Capability 现在使用不继承系统代理、拒绝自动重定向的独立 urllib opener，只请求固定的 Arbeitnow API；插件不会把系统代理或数据源重定向带到本地网页、`8080` 或其它未授权地址。新增 release architecture contract 与报告。本轮未运行测试、构建、语法检查或 Provider/network/browser 验收，没有启动 Edge、创建浏览器窗口或访问 8080，Public Release 继续为 `NOT_READY`。详见 [job-search plugin HTTP boundary](docs/evals/reports/2026-09-03-codex-offeru-public-release-job-search-plugin-http-boundary.md)。

最新代码切片 `JOB_SEARCH_SOURCE_URL_GUARD_77`：`job-search` Capability 对公开源返回的岗位 URL 增加本机、私有 IP、凭据、非 HTTP(S) scheme 过滤；`jobs.get` 与岗位基准输入不会把这些链接继续传播。新增插件单元测试与 release architecture contract。本轮未运行测试、构建、语法检查或 Provider/network/browser 验收，没有启动 Edge、创建浏览器窗口或访问 8080，Public Release 继续为 `NOT_READY`。详见 [job-search plugin HTTP boundary](docs/evals/reports/2026-09-03-codex-offeru-public-release-job-search-plugin-http-boundary.md)。

最新代码切片 `PUBLIC_WEB_TRANSPORT_AUDIT_78`：正式 `audit_architecture.py` 现在把后端公开研究和 `job-search` Capability 的直连、无自动重定向、公开 DNS/URL 过滤纳入持续架构审计；恢复默认代理、普通 `urlopen` 或移除本机 URL guard 会产生 release finding。新增 audit contract 与报告补充。本轮未运行测试、构建、语法检查或 Provider/network/browser 验收，没有启动 Edge、创建浏览器窗口或访问 8080，Public Release 继续为 `NOT_READY`。

最新代码切片 `ROLE_INTELLIGENCE_BACKEND_SEARCH_79`：Role Intelligence 新增受控后端公开网页搜索 adapter。`runtime_id=auto` 先选择满足公开网页能力的 live CLI，只有自动选择失败且搜索 API 与 LLM 配置齐全时才回退到 `backend_search`；显式 `codex`/`pi` 等 runtime 仍 fail-closed。后端 adapter 只使用既有 direct HTTP、bounded redirect、public DNS 和 restricted-domain 边界，LLM 引用的 comparator URL 必须来自已提供的公开 JD 页面；运行结果继续进入统一 schema、dedupe、cohort、Delta、CareerTask 和 Today/Pipeline 投影。保存岗位自动任务和“实时研究”入口改为 `auto`，本地准备仍为 `replay`；前端新增 `live_backend` 数据模式文案。本切片未运行测试、构建、语法检查、真实 Provider/network、浏览器或打包验收，没有启动 Edge、创建浏览器窗口或访问 8080，Public Release 继续为 `NOT_READY`。详见 [Role Intelligence backend search](docs/evals/reports/2026-09-03-codex-offeru-public-release-role-intelligence-backend-search.md)。

本轮新增 `LOCAL_ENTRY_DOCTOR_BOUNDARY_42`：Doctor 只允许 `http://127.0.0.1:7410`，拒绝 `8080`、凭据、路径和查询参数；同时要求固定 `http://127.0.0.1:8765/api/health` 返回 OfferU 健康身份，前后端任一不可达都会得到 `CORE_NOT_READY`。扩展网页打开与连接检测复用同一个 7410 有界探测，失败时不创建浏览器标签；Tauri dev URL 与项目 `.env` CORS 已同步。该切片写入后未执行测试、构建、语法检查或浏览器，因而不提升远程/动态 Gate。

恢复可靠性补丁随后把 SQLite `-wal/-shm` sidecar 移动纳入同一个回滚范围，并新增第二个 sidecar 移动失败的隔离测试；本轮仍未执行该测试或构建，R44/R46 不变。

本轮新增 `TAURI_HEALTH_IDENTITY_43`：Tauri 等待桌面 sidecar 时不再用字符串包含判断，而是只接受 HTTP 成功且 JSON 同时满足 `status=ok`、`service=OfferU`、`runtime=python` 的 `8765/api/health` 响应；错误服务、错误 payload 或错误 HTTP 状态不会触发 `offeru-ready=true`。同步修正 Tauri security contract 对 `127.0.0.1:7410` dev URL 的断言。本轮仍未执行 Rust contract、构建或浏览器，Public Release 继续为 `NOT_READY`。

入口审计范围也纳入 `frontend/src-tauri/tauri.conf.json`、`frontend/src-tauri/src/lib.rs`、CLI Doctor 和简历用户 URL 代码，防止桌面壳或生成链接未来重新引入旧网页端口或错误本地入口；本轮仅补静态审计范围与 contract 断言，未执行审计测试。

同一切片还固定简历 PDF 打印地址和分享地址为 `http://127.0.0.1:7410`，不再读取可能残留 `8080` 的 `FRONTEND_BASE_URL` 环境变量；模型供应商端点仍由 LLM 配置独立管理。本轮未执行相关 contract 或 PDF/browser 验收。

邮箱 OAuth 完成后的本地回调也固定重定向到 `http://127.0.0.1:7410/email`，不再随 CORS 列表顺序漂移到其它本地主机名；OAuth 仍需用户主动授权，本轮未执行外部登录。

CI 的本地服务等待和 Windows installed-app smoke 也同步要求 `status=ok`、`service=OfferU`、`runtime=python`，不再把其它占用 8765 的 HTTP 服务当成后端；本轮未执行远程 runner。

公共 worker soak 与 previous-release migration 的健康等待也复用同一 `OfferU/python` identity predicate，避免 E2E 在错误服务上继续执行；本轮新增脚本/contract 尚未执行。

CLI Doctor 的固定 7410/8765 探测也改为显式禁用系统代理，和 Tauri 的 direct loopback client 保持一致；代理不会再把本机服务误判为不可达。本机 Doctor runtime 已通过，contract、打包和远程 runner 尚未执行。

发布专用的 migration smoke、worker soak 和 CI 本地服务等待随后也改为直连 loopback 探测；repeatability 等待同步要求后端 health 的 `status=ok / service=OfferU / runtime=python`，避免系统代理或其它 8765 服务造成假失败/假通过。本轮未执行远程 runner。

共享 release opener 又增加 URL 白名单，只允许 7410 根页与 8765 health；误传 8080 或其它端口/路径/查询/凭据会在网络调用前失败，并已加入 architecture audit 的静态防回归项。新增 contract 尚未执行。

CLI、release E2E、CI 和 Tauri 的本地健康探测又禁止 HTTP 重定向；服务若把 7410/8765 重定向到 8080 或外部主机，会直接失败而不会跟随或误报 ready。新增 contract、Rust 构建和远程 runner 尚未执行。

前端 `BackendReadyGate` 随后同步要求 `status=ok / service=OfferU / runtime=python`，避免其它 Python 服务占用 8765 时误放行 UI；静态契约、typecheck/build 尚未重跑。

本轮继续收紧本地入口：前端 `BackendReadyGate` 现在对后端启动使用 45 秒有界重试，超时后显示可读的后端地址、正确网页地址和“重新检查”，不再无限显示启动中；前端与扩展网页健康探测均拒绝 HTTP 重定向，扩展后端 Adapter 也要求完整 `OfferU/python` health identity。前端 API base 对非本机配置 fail-closed，避免构建环境把职业数据请求发往任意外部 origin。相关 typecheck/build、扩展构建与 contract 尚未重跑；本轮没有启动 Edge、没有打开浏览器、没有访问 8080。

CLI Doctor 现在额外提供 `doctor --require-ready`：普通诊断仍返回完整报告，发布/安装脚本可以要求 `CORE_READY` 才以零退出码结束；Windows installed-app smoke 的 8765 health probe 也明确禁止重定向。相关远程 runner、构建和 contract 尚未重跑，Public Release 仍为 `NOT_READY`。

## Latest local runtime boundary

2026-09-03：命令行 HTTP 验证 `http://127.0.0.1:7410/` 返回 OfferU 前端，`http://127.0.0.1:8765/api/health` 返回 `status=ok / service=OfferU / runtime=python`；8080 无监听且不是 OfferU 网页地址。仓库根目录历史 `OfferU.exe` 的 `0.1.0` 二进制曾内嵌旧的 `8000/3300` 入口，本轮已可恢复地改名为 `OfferU-legacy-0.1.0.exe.disabled`，不属于当前启动链。自动化 PDF/验收路径不再探测系统 Edge，统一使用 managed Chromium 的 `headless=True`；本轮只做无浏览器 HTTP/进程核验，没有启动 Edge、打开窗口或访问 8080。扩展 fixture、Docker Compose、seed 和静态扩展设置也已统一到同一 `7410/8765` 边界。详见 [readiness audit](docs/evals/reports/2026-09-02-codex-offeru-public-release-readiness-audit.md)。

同日随后使用仓库约定的 `.venv312\\Scripts\\python.exe -m app.cli doctor --pretty` 做了无浏览器运行时复核：前后端 HTTP 均为 200，后端身份为 `status=ok / service=OfferU / runtime=python`，Doctor 报告 `release_readiness=CORE_READY` 且 `blockers=[]`；数据库 `integrity_check=ok`、foreign-key violations 为 0，Replay Provider 可用。该证据只覆盖当前本机核心入口；Rust contract、打包安装、远程 CI、签名、真实 Provider、隐私决策和最终陌生用户验收仍未完成。

随后补强了 Doctor 的健康身份契约：CLI 现在同时要求 `status=ok`、`service=OfferU`、`runtime=python`，其它占用 8765 的服务即使返回前两个字段也会被拒绝；新增了错误 runtime 的回归契约，尚未按 `AGENTS.md` 执行测试。

本轮又收紧了容器公开配置：`.env.example` 不再包含固定数据库密码或默认 `SECRET_KEY`，`docker-compose.yml` 缺少使用者显式提供的 `DB_PASSWORD`/`SECRET_KEY` 时直接 fail-closed；新增静态 contract，但未运行测试或 Docker build。该变化不改变网页入口：OfferU 仍只使用 7410/8765，8080 仅为可选模型 Provider endpoint，不是网站，也未启动 Edge。

又收紧 Resume 导出失败边界：`resume_export` 在 Playwright 与 WeasyPrint 同时失败时通过统一 `safe_error_message` 返回有界脱敏文本，不再拼接原始 renderer exception；新增 architecture contract，未运行测试/构建。该修复不启动浏览器，PDF 正式渲染与远程发布证据仍待后续验收。

修复 Docker 外部数据库启动边界：`main.py` 现在只有 SQLite 才进入本地 staged-restore；PostgreSQL 等外部数据库会明确记录“不适用”并继续启动，不把外部数据库伪装成已完成本地恢复。新增静态 contract，未运行测试或 Docker build；OfferU 网页仍只用 7410，后端只用 8765，8080 不是网页入口。

## Completed LOCAL_BROWSER_NAVIGATION_GUARD_36 slice

- 扩展“打开 OfferU 网页”和 Docker 模式入口现在先以 2 秒超时检查固定的 `http://127.0.0.1:7410`；前端未启动、返回错误或超时，只提示用户，不创建无法连接的浏览器标签；
- 扩展不会把 `8765` 后端或 `8080` 模型接口当成网页打开，且正常诊断路径不调用 Edge；
- Windows installed-app smoke 新增 `8765` 启动前占用检查，并在健康后核对监听进程可执行文件确实来自临时安装目录，避免复用其它本机服务造成假通过；
- 新增 release architecture contract，固定要求扩展网页导航先完成有界 `7410` 检查再创建标签；同时将 `extension/src/popup.ts` 与端口归一化模块纳入本地入口扫描；本切片只修改入口防护和 CI smoke 合约，未运行扩展构建、测试、语法检查、远程 runner 或浏览器，也没有修改真实用户数据库；正式扩展产物和 Windows runner 仍待验证，Public Release 继续为 `NOT_READY`。

## Completed RELEASE_ARTIFACT_SYMLINK_GUARD_37 slice

- `audit_artifacts.py` 现在拒绝符号链接作为审计根目录，并在发布目录内遇到符号链接时直接记录 `symlink` finding，不跟随链接读取目录外文件；
- 新增隔离 artifact contract，验证根链接被拒绝、内部链接被报告、外部文件不计入扫描文件数，且不把外部内容带入结果；按 `AGENTS.md` 本轮没有运行测试、构建或语法检查；
- 该切片没有启动 Edge、没有访问 `8080`、没有打开任何浏览器，也没有修改真实用户数据库；Public Release 仍为 `NOT_READY`。

## Completed TAURI_LOOPBACK_HEALTH_38 slice

- Tauri 桌面壳等待 8765 sidecar 时改用 `reqwest` direct client，并显式调用 `no_proxy()`，不会把本机 health 请求交给系统代理；client 创建失败会返回失败状态，不伪造 ready；
- Tauri security contract 增加 direct-loopback health client 断言；按 `AGENTS.md` 本轮没有运行 Rust 构建、测试或语法检查；
- 该切片没有启动 Edge、没有访问 `8080`、没有打开任何浏览器，也没有修改真实用户数据库；桌面 bundle、代理环境和远程 runner 仍待验证，Public Release 继续为 `NOT_READY`。

## Completed RELEASE_ARTIFACT_VERIFIER_SYMLINK_GUARD_39 slice

- `verify_release_artifacts.py` 现在拒绝符号链接作为发布物根目录，并对 `artifacts.json`、`SHA256SUMS.txt`、`version.json` 等发布元数据链接 fail-closed；校验器不会因为 `resolve()` 读取目录外文件；
- 新增隔离 contract，覆盖 symlink root 和 symlink metadata；本轮按 `AGENTS.md` 没有运行测试、构建或语法检查；
- 该切片没有启动 Edge、没有访问 `8080`、没有打开任何浏览器，也没有修改真实用户数据库；签名 artifact、远程 runner、安装和升级 Gate 仍未验证，Public Release 继续为 `NOT_READY`。

## Completed RELEASE_E2E_ENDPOINT_GUARD_40 slice

- public-release 的 smoke、empty-state、Interview、worker soak 和 previous-release migration 脚本现在统一经过 `release_endpoints.py`，只接受 `http://127.0.0.1:7410` 网页和 `http://127.0.0.1:8765` API；详见 [E2E endpoint guard](docs/evals/reports/2026-09-02-codex-offeru-public-release-e2e-endpoint-guard.md)；
- `8080`、其它端口、`localhost`、外部主机、路径、查询参数、fragment 和 URL credentials 都会在 Playwright/httpx/urllib 发起请求前 fail-closed，不会被当作 OfferU 网站；
- 扩展根目录同步脚本还会检查生成 popup 包含 7410 readiness guard、AbortController 和失败提示；缺少这些标记时拒绝同步旧 popup；
- 新增隔离 contract 覆盖默认端口、8080 误配和非本机/带路径/凭据误配；本轮按 `AGENTS.md` 没有运行测试、构建、语法检查或浏览器；
- 该切片没有启动 Edge、没有打开任何浏览器窗口、没有访问 `8080`、没有修改真实用户数据库；远程 runner、扩展正式构建和完整 release E2E 仍待验证，Public Release 继续为 `NOT_READY`。

## Completed RELEASE_ARTIFACT_TEXT_PII_GUARD_41 slice

- `audit_artifacts.py` 现在对文本型诊断、日志、配置和说明产物额外扫描邮箱地址与手机号；二进制 installer/sidecar 不执行这组宽文本规则，避免把随机二进制字节当作个人信息；
- findings 只保留文件相对路径和类别，不返回匹配值；新增 contract 验证文本产物会被报告、二进制同内容不会被这组 PII 规则误报；
- 本轮按 `AGENTS.md` 没有运行测试、构建、语法检查、远程 runner 或浏览器；没有启动 Edge、没有访问 `8080`、没有修改真实用户数据库；完整 artifact/PII/retention matrix 仍待验证，Public Release 继续为 `NOT_READY`。

## Completed SECURITY_11 slice

正式报告：[durable error redaction boundary](docs/evals/reports/2026-09-02-codex-offeru-public-release-durable-error-redaction.md)

Provider health、CareerTask、AutomationEvent 和 Hosted Executor 的持久化错误现在在写入与读取投影两侧都使用同时处理 credential-like 文本、邮箱和电话的 bounded redaction；Hosted Executor 的 Provider event payload 也在两侧处理直接 PII，普通职业 payload 仍保留 secret-only redaction。新增 contract coverage 已落盘，但按 `AGENTS.md` 写入后没有运行测试、构建、语法检查或浏览器。本轮没有启动 Edge、没有访问 `8080`、没有打开任何可见窗口，也没有修改真实用户数据库；历史日志/artifact、retention、3 条旧邮箱正文、真实 OAuth 和远程 Release runner 仍未完成，Public Release 继续为 `NOT_READY`。

## Completed SECURITY_10 slice

正式报告：[RustSec dependency audit](docs/evals/reports/2026-09-02-codex-offeru-public-release-rustsec.md)

本轮用 `cargo-audit 0.22.2` 成功更新 advisory database，并扫描 `frontend/src-tauri/Cargo.lock` 的 441 个依赖：普通 `cargo audit` 为 0 known vulnerabilities；严格 `cargo audit --deny unsound` 明确暴露 `glib 0.18.5 / RUSTSEC-2024-0429`，另有 16 条 unmaintained warning。`.github/workflows/build.yml` 已加入 RustSec job，tag release 依赖严格 unsound 检查，避免默认 exit 0 掩盖 unsound 依赖。本轮没有启动 Edge、没有访问 `8080`、没有打开浏览器，也没有修改真实用户数据库；R50/R55/R92 仍保持 `NOT_VERIFIED`，Public Release 仍为 `NOT_READY`。

## Completed PRIVACY_HYGIENE_UI_11 slice

正式报告：[Privacy hygiene control surface](docs/evals/reports/2026-09-02-codex-offeru-public-release-privacy-hygiene-ui.md)

Settings 的本地数据安全区域现在显示隐私卫生计数，并提供明确确认后的旧邮件正文清理入口；合成邮箱测试数据另有独立确认入口，避免与岗位 Demo Reset 混用。页面只显示记录数/字符数，不展示正文；读取和清理都通过 Operation Registry，清理前必须输入对应确认短语，不会自动处理当前 3 条真实历史正文。新增路由契约测试但按 `AGENTS.md` 未在写入后执行；本轮没有启动 Edge、没有访问 `8080`、没有打开浏览器，也没有修改真实用户数据库。Privacy/retention 的最终产品决定和完整历史 scrub 仍未完成，Public Release 继续为 `NOT_READY`。

## Completed RELEASE_ARTIFACT_VERIFICATION_33 slice

继续收紧正式发布物的完整性边界：

- 新增 `backend/scripts/release/verify_release_artifacts.py`，对 `artifacts.json`、`SHA256SUMS.txt` 和 `version.json` 做 fail-closed 校验；验证文件存在、根目录路径约束、文件大小、SHA-256、OfferU/windows-x64 版本元数据、NSIS/MSI 集合和 signed 标记；不输出发布文件内容；
- Windows 打包在上传前执行校验，安装 smoke 与 Draft Release 在下载 artifact 后也执行同一校验，tag 还必须带 `signed=true`；避免上传端、安装端与发布端只验证“文件存在”；
- 新增 manifest、篡改、未签名和路径穿越 contract tests；按 `AGENTS.md` 本轮没有运行测试、构建或语法检查；
- 该切片没有启动浏览器、没有访问 Edge、没有把 `8080` 当网页，也没有修改真实用户数据库。远程 CI/tag、真实签名和最终 installer 产物仍未验证，因此 R91/R92 保持 `NOT_VERIFIED`，Public Release 仍为 `NOT_READY`。

## Completed RELEASE_VERSION_AUDIT_34 slice

继续收紧 Release 元数据边界：

- 新增 `backend/scripts/release/audit_version_consistency.py`，只读核对 frontend `package.json`、Tauri `tauri.conf.json`、Rust `Cargo.toml` 和 backend CLI 的版本声明；缺失、非法 SemVer 或漂移都会 fail-closed；
- backend CI 和 Windows 打包前都执行该审计，避免安装包、sidecar 和诊断信息携带不同版本；
- 新增匹配、漂移和缺失声明 contract tests；本轮按 `AGENTS.md` 未运行测试、构建或语法检查，远程 runner 尚未验证，因此 R87/R92 不因本切片新增 PASS 证据；
- 本切片没有启动 Edge、没有访问 `8080`、没有打开浏览器，也没有修改真实用户数据。

## Completed DOWNLOADED_ARTIFACT_AUDIT_35 slice

继续收紧最终发布物的安全边界：

- installed smoke 下载 `offeru-windows-x64` 后，先执行 manifest/hash/version/signature 校验，再执行 `audit_artifacts.py --json`；
- Draft Release 下载同一 artifact 后也执行 secret、canary、private-key、token 和敏感文件名审计，审计失败不会创建 Draft Release；
- 这与 Windows 打包端的源目录审计形成上传前、安装前、发布前三段防线；本轮只完成 CI 配置，远程 runner、签名 artifact 和最终发布目录尚未验证，因此 R51/R52/R91/R92 继续保持 `NOT_VERIFIED`；
- 本切片没有启动 Edge、没有访问 `8080`、没有打开浏览器，也没有修改真实用户数据。

## Completed NO_AUTO_BROWSER_31 slice

为避免开发服务再次替用户唤起 Edge 或系统默认浏览器：

- `frontend/vite.config.ts` 显式设置 `server.open = false`；开发服务只监听固定的 `7410`，不会自动打开网页窗口；
- `audit_architecture.py` 将 Vite 自动打开浏览器配置加入本地入口审计；缺少 `open: false` 会 fail-closed；
- Tauri 桌面 WebView、用户主动触发的扩展 `chrome.tabs.create` 和授权研究登录窗口仍保持各自明确边界；本轮没有调用它们；
- `8080` 仍只表示可选 llama.cpp Provider endpoint，不是 OfferU 网页入口。

本切片只收紧启动入口，不改变桌面壳或外部授权研究能力；按 `AGENTS.md` 没有启动浏览器、运行测试、构建或执行可见验收。

## Completed DIAGNOSTIC_ARTIFACT_AUDIT_32 slice

将浏览器失败产物与运行日志纳入同一 fail-closed secret audit：

- `browser-smoke`、10 次 `critical-browser-repeatability` 和 `migration-browser-smoke` 都会把各自的 trace、screenshot、backend/frontend log 收集到 CI 专属临时目录；
- 每个目录在 failure artifact upload 前调用 `audit_artifacts.py --json`，发现 canary、Bearer、API key、private key 或敏感文件名时让 CI 失败；
- 审计只处理该 job 自己生成的临时目录，不扫描正常用户工作区，也不读取或上传 `backend/offeru.db`；
- 这只是 CI 配置证据，远程 runner 尚未执行，因此不把 Security、Playwright failure artifacts 或 Public Release 提升为 PASS。

## Completed RELIABILITY_14 slice

正式报告：[Reliability 14](docs/evals/reports/2026-09-02-codex-offeru-public-release-reliability-14.md)

新增跨进程故障恢复矩阵：认证失败、网络超时均会形成脱敏 durable `blocked/failed` 状态并可由第二个进程 retry；运行中 task 的 owner 进程被终止后，新的进程会 recovery 为 `blocked`，再通过 retry 完成。矩阵使用隔离 SQLite、确定性 fault injection 和 Replay，不连接真实 Provider、不打开浏览器、不访问 8080。GitHub 新增独立 `reliability-failure-recovery` job，但本轮按 `AGENTS.md` 未执行脚本或远程 runner，因此 R34/R35/R36/R73/R74 仍为 `NOT_VERIFIED`/`PARTIAL`，Public Release 仍为 `NOT_READY`。

## Completed PORT_BOUNDARY_21 slice

本轮把错误的前端端口入口收敛为 fail-closed 行为：

- `_doctor_frontend_health()` 只允许本地 `http://127.0.0.1:7410`（兼容 `localhost:7410`），对 `8080` 或外部/其他端口在调用网络前 fail-closed，并返回正确入口；
- 新增 Doctor contract test，确认该错误配置不会触发任何网络探测；按当前 `AGENTS.md`，本轮没有执行测试；
- README、README_EN、DEVELOPMENT 和 HANDOFF 的可见网页入口统一写为 `http://127.0.0.1:7410`，并明确 `8080` 只是可选 llama.cpp endpoint，不是网页；
- 只读检查发现仓库根目录 `OfferU.exe` 为历史 `0.1.0` 未签名二进制；没有启动、覆盖或删除它，文档已明确禁止将其作为当前入口；
- readiness report 修正为区分自动无头路径与用户主动触发的授权登录窗口，避免把 `authorized_research.py` 的外部登录流程误报为自动 Edge 验收。

这只解决入口误导与旧配置误探测，不改变 8080 的 llama.cpp Provider 语义，也不改变 Public Release 的未签名/未 clean-machine 验收状态。

## Completed CLI_CONTRACT_22 slice

为消除 CLI/Doctor 启动时的 Pydantic `schema` 保留名警告，投递工作区两个输入模型现在使用内部 `schema_` 字段并以 `schema` 作为协议别名；Operation Registry 验证后的参数统一按 alias 输出，业务函数仍收到原有 `schema` 参数。新增了闭合 schema 与 dry-run 参数映射 contract，未改变外部 Operation 名称或业务数据模型。本轮按 `AGENTS.md` 未运行该测试。

## Latest privacy hygiene recheck

通过 Operation Registry 的只读 `get_privacy_hygiene_status` 重新核对当前工作区：`legacy_email_notification_bodies.records=3`、`characters=506`，合成邮箱测试数据各项均为 `0`，`safe_to_publish=false`。本轮没有调用需要确认的清理 Operation，也没有读取或输出正文内容；历史数据处理仍等待产品/隐私所有者决定。

## Completed ARTIFACT_BOUNDARY_23 slice

工作区中发现大量本地 Playwright profile、trace、截图和失败诊断包；它们不是发布输入，且可能包含用户界面状态或敏感数据。本轮没有删除或读取其正文，只将 `.tmp/` 与 `.e2e-artifacts/` 加入 `.gitignore`，防止测试产物被误提交。正式发布仍只收集经过审计的 bundle、sidecar 和 `release-artifacts`，并继续要求 clean-machine/CI artifact matrix。

## Completed WEB_ENTRY_BOUNDARY_24 slice

本轮修复了仍可能把用户或自动化带到旧端口/系统浏览器的入口：

- SmartFill fixture 现在只使用 Playwright 自带的 managed Chromium、临时隔离 profile 与 `headless: true`，不再扫描、传入或启动系统 Chrome/Edge 可执行文件；
- Docker Compose 与 frontend image 的公开开发入口统一为前端 `7410`、后端 `8765`，CORS 和 Vite API 地址同步；
- 扩展静态设置、扩展 README 和三个 seed 脚本的默认后端统一为 `http://127.0.0.1:8765`；
- 默认 CORS 删除旧的 `3011/3000/3001/5140` 开发端口，保留 `7410` 与 Tauri 本地来源；llama.cpp 的 `8080` Provider 配置未改变；
- 扩展 README 同步说明 SmartFill 只能手动触发、结束于用户审核，不自动提交；
- AGENTS 增加扩展 fixture 不得选择系统浏览器的执行规则；现有 architecture audit 已纳入本地入口和所有自动 E2E/PDF 浏览器路径扫描，当前 `finding_count=0`；授权研究可见登录与只包含负向字符串断言的 contract test 被明确排除。

按当前 `AGENTS.md`，本切片写入后没有运行测试、语法检查、构建或可见浏览器；后续仍需由用户执行 extension/Compose 相关验证，并保留 Public Release 的签名、升级、clean-machine 与真实 Provider Gate。

随后只读复核：CLI Doctor 为 `ok=true`、前端 `7410` ready、后端 `8765` ready、数据库 integrity `ok`、`8080` 无监听；architecture audit 为 `0 findings`；release checklist 为 `114/114` 行、`0 findings`、最终 verdict 仍为 `OFFERU_PUBLIC_RELEASE_NOT_READY`（R90 代码签名为真实外部 blocker，其余未验证 Gate 继续保留）。

## Completed EXTENSION_SERVER_BOUNDARY_25 slice

扩展现在通过共享 `normalizeOfferUServerUrl()` 处理 popup、background 和 `HttpOfferUControl` Adapter 的 server URL：历史保存的本机 `8080/8000/7410` 或其它错误端口会 fail-closed 回到 `http://127.0.0.1:8765`，当前本机后端和远程自定义 origin 仍可用。新增 Vitest contract 覆盖旧端口归一化与 Adapter 请求边界；按 `AGENTS.md` 未运行该测试或构建。

## Completed FRONTEND_API_BOUNDARY_26 slice

前端 `resolveApiBase()` 现在同时读取 Vite 的 `VITE_API_URL` 与旧环境变量，并对本机 host 统一返回 `http://127.0.0.1:8765`；本机 `8080/8000/7410` 等旧值不会再成为 API 目标，远程自定义 origin 只保留 origin 部分。architecture audit 的本地入口文件清单已纳入该解析器，重新扫描仍为 `0 findings`。按 `AGENTS.md` 未运行前端 typecheck/build。

## Completed CONTAINER_ENTRY_BOUNDARY_27 slice

补齐了容器发布入口的同一端口契约：`backend/Dockerfile` 现在只暴露并启动 FastAPI `8765`，不再把容器内的 `8000` 暴露为 OfferU 后端入口；与现有 Docker Compose 的 `7410/8765` 映射一致。正式 architecture audit 已将该 Dockerfile 纳入本地入口扫描，结果为 `0 findings`。本轮没有运行 Docker build、测试或启动容器，Public Release 的 clean-machine/package 验收仍未完成。

## Completed BROWSER_SELECTOR_BOUNDARY_28 slice

修复了仓库内被跟踪的 `_tmp_online.cjs` 对系统 Chrome 可执行文件的显式选择，改为 Playwright managed Chromium 的 `headless: true` 默认启动，并同步收紧扩展架构文档：真实侧载只由用户主动执行，Agent 自动化不使用 Edge/Chrome。该脚本已纳入自动浏览器静态审计；当前所有自动 E2E/PDF/fixture/临时浏览器路径均无系统 Chrome/Edge 选择器，architecture audit 为 `0 findings`。本轮没有启动该脚本、Edge、Chrome 或任何可见浏览器；用户主动授权研究窗口仍是唯一明确的非自动化例外。

## Completed BACKEND_PORT_LOCK_29 slice

进一步锁定运行时入口：`run_server.py` 不再读取 `OFFERU_LEGACY_PORT`，且会拒绝任何不是 `8765` 的 `OFFERU_PORT`；冻结 sidecar 也会覆盖继承环境并固定使用 `8765`。新增运行时端口 contract，architecture audit 同时扫描 `run_server.py` 与 `sidecar_entry.py`，当前 `0 findings`。因此 OfferU 不会因为旧环境变量把后端误启动在 `8080/8000`；`8080` 继续只保留给可选 llama.cpp Provider，不是网页入口。本轮没有重启现有服务或执行测试/构建。

## Completed DATA_SAFETY_DOC_30 slice

修正 `KNOWN_ISSUES.md` 与 `HANDOFF.md` 的过期恢复说明：当前正式路径是 Settings 的 SQLite Online Backup/受管资产一致性备份、校验后暂存、重启恢复和 pre-restore 保护；文件级复制只保留为开发期应急说明，不再作为 Public Release 的用户恢复指引。没有修改真实数据库或执行恢复操作。

## Completed SETTINGS_ENDPOINT_COPY_31 slice

Settings 的模型配置区域现在明确区分“模型接口地址（非网页）”与 OfferU 网页入口，并解释 `127.0.0.1:8080` 只可能是可选 llama.cpp 模型端点；网页入口固定为 `127.0.0.1:7410`。这只是防止用户误把 Provider endpoint 当网站的文案收敛，不改变 llama.cpp Provider 配置或网络行为；本轮没有打开 8080、Edge 或任何可见浏览器。

## Completed EXTENSION_WEB_LAUNCHER_32 slice

修复扩展桌面端打开入口仍可保存旧自定义端口的问题：网页启动端口现在 fail-closed 固定为 `7410`，历史 `8080/3000` 等值不会再被用于 `chrome.tabs.create`，并在根目录实际加载的扩展页面中同步修正旧的 `9000/3000` 占位符。后端控制通道仍固定为 `8765`，`8080` 只保留给可选模型 Provider。新增端口归一化 contract，并把根扩展入口纳入 architecture audit；本轮没有打开 Edge、Chrome、8080 或任何可见浏览器，也没有执行扩展构建/测试。

同时修正扩展顶部“打开服务”按钮原先把后端 API 根地址当网页打开的问题：现在只有用户主动点击时才导航到固定网页入口 `7410`，所有 API 请求仍使用 `8765`。这样扩展不会再把 `8080` 模型端点、`8765` API 或其它旧端口当作 OfferU 网页。

扩展设置页也已把后端字段改为“后端 API 地址（非网页）”，并在用户检查连接时将旧输入立即归一化到 `8765`；网页入口 `7410` 和模型端点 `8080` 分开说明。

## Completed EXTENSION_WXT_ENTRYPOINT_33 slice

继续处理扩展发布链的真实白屏风险：

- WXT 默认只扫描 `extension/entrypoints`，现通过 `entrypoints:found` 将实际根目录 `popup.html` 纳入正式 popup entrypoint；
- 根弹窗源码改为从 `src/popup.ts` 进入构建，不再依赖仓库中不存在的旧 `chunks/popup-*.js` 文件；
- `sync-root-build.mjs` 对 `manifest.json`、`background.js`、`popup.html`、`content-scripts/` 和 `chunks/` 做必需产物检查，缺失时 fail-closed，不会把旧根目录文件误当作新构建结果；
- 这不会改变网页入口：OfferU 网页仍固定为 `http://127.0.0.1:7410`，后端 API 为 `http://127.0.0.1:8765`，`8080` 仍只属于可选 llama.cpp Provider；
- 本轮没有启动 Edge、Chrome、8080 或任何可见浏览器，也没有执行扩展构建、测试或语法检查。待用户按项目规则运行扩展构建后，再验证正式 WXT 产物。

## Completed CI_EXTENSION_34 slice

扩展质量链已接入 `.github/workflows/build.yml`：CI 现在会在 Ubuntu 上独立执行 extension `npm ci`、typecheck、Vitest、WXT production build 和生产依赖 audit；Windows desktop package 依赖该 job，避免 popup/chunks 构建缺陷进入发布包。该 CI job 本身不启动 Edge 或可见浏览器；本地仍按 `AGENTS.md` 不执行扩展构建、测试或语法检查。

同时将 WXT dev runner 显式设为 `disabled: true`：`npm run dev` 只提供扩展开发服务和手动加载提示，不会自动拉起系统默认浏览器或 Edge。产品内用户主动点击“打开 OfferU 网页”仍只导航到 `http://127.0.0.1:7410`。

## Implemented AGENT_SSE_ERROR_CORRELATION_35 slice

继续补齐支持诊断链：

- Agent 的两个 SSE 路径现在都为流式执行期间的异常生成统一 `error_id`，并通过 `event: error` 返回，而不是让连接无提示断开；
- Run 消失、Provider/worker 异常和流结束阶段的异常都会记录到 bounded diagnostic error store，用户可将该 ID 交给 Settings 的本地诊断包；
- 错误载荷保留安全的错误摘要，并附带已知的 `run_id`、`task_id`、`provider_id`，不返回 traceback、请求正文或凭据；
- 为正常 Provider stream、Provider failure 和 Run disappearance 增加了 contract coverage；按 `AGENTS.md`，本轮没有执行测试、语法检查、构建或浏览器流程。

这只修复 Agent 流式失败的可定位性，不把失败伪装成成功，也不改变 7410/8765 入口；`8080` 仍无网页服务且不属于 OfferU 网页。Public Release 仍需真实运行矩阵、CI/clean-machine、升级/签名和隐私决策证据。

## Implemented CAREER_TASK_ERROR_CORRELATION_36 slice

继续补齐后台任务的支持诊断链：

- CareerTask 在 Provider 失败、任务取消、进程重启恢复和其他 durable failure 路径生成 bounded `error_id`，并把它保存在任务进度与失败事件中；
- Automation Inbox、Today 任务详情和独立任务卡展示同一任务错误 ID，用户可以将它交给 Settings 的本地诊断包；
- retry 会清理上一次失败的临时错误关联并重新开始，不把旧错误误显示为新任务成功；
- 这只增加失败可定位性，不改变 CareerTask 状态机、业务事实或 7410/8765 入口；`8080` 仍无网页服务，也没有启动 Edge、Chrome 或任何可见浏览器；
- 按 `AGENTS.md`，本轮没有执行测试、语法检查、构建或浏览器流程。真实 worker/provider/restart/desktop/audit matrix 仍待验证。

## Implemented CAREER_TASK_PROJECTION_ERROR_37 slice

继续补齐“任务完成但用户界面投影失败”的诊断闭环：

- CareerTask 结果投影到 AutomationEvent/Inbox 失败时生成 bounded `error_id`，写入脱敏诊断存储、失败事件结果和 Inbox payload；
- Today 从同一 Inbox payload 读取该 ID，用户可以在不暴露正文或凭据的情况下把它交给 Doctor/Diagnostic Bundle；
- CareerTask 保持已完成状态，投影失败只标记对应 AutomationEvent/Inbox，避免把已经提交的任务事实错误回滚；
- 本轮没有改变 7410/8765 入口，也没有启动 Edge、Chrome、8080 或任何可见浏览器；按 `AGENTS.md` 未执行测试、语法检查或构建。真实跨进程投影/诊断矩阵仍待验证。

## Implemented DURABLE_FAILURE_DIAGNOSTICS_38 slice

继续补齐“应用重启后仍能支持定位失败”的诊断闭环：

- Diagnostic Bundle 现在从持久化 `CareerTask` 和 `AutomationEvent` 中读取最近的 `failed`、`blocked`、`interrupted` 元数据，并保留 bounded 数量；
- 摘要只包含任务/事件类型、状态、Provider、运行/错误关联 ID、重试信息、时间和脱敏错误短句，不包含 `input_json`、`payload_json`、`result_json` 或任何岗位/简历/邮件正文；
- durable failure 查询失败时由 bundle 的现有 `_capture` 边界报告 `unavailable`，不会把数据库诊断错误伪装成空的成功结果；
- Registry 诊断操作的审计继续对 `recent_errors` 与 `durable_failures` 做摘要保护，前端类型同步新的持久化失败投影；
- 新增隔离数据库契约，验证失败摘要可关联且不会泄露 canary 或持久化正文字段；按 `AGENTS.md`，本轮没有运行测试、语法检查、构建、Edge/Chrome 或任何可见浏览器，也没有把 8080 当作网页打开。

这只改善支持诊断与错误可定位性，不提升 Public Release 的硬 Gate；签名、升级、clean-machine、真实 Role Intelligence Provider、完整可靠性/隐私矩阵仍保持未完成。

## Implemented ROLE_BENCHMARK_ERROR_CORRELATION_39 slice

继续收口岗位情报失败的支持路径：

- 独立触发的 `RoleBenchmarkRun` 失败现在复用统一 `error_id`，写入既有 `trace_json`，不新增表结构或第二套错误状态；
- Job Detail 的岗位情报失败卡与上一份可用 snapshot 的最近失败提示会展示该错误 ID，用户可将它与 Settings Diagnostic Bundle 对照；
- benchmark 重试进入 running 时会清理旧错误 ID，成功完成时仍由正式 snapshot trace 覆盖，避免旧失败被误显示为当前结果；
- 错误信息继续使用 bounded/redacted 文本，未把岗位正文、Provider 凭据或 LLM 输出写入诊断字段；新增隔离契约测试但尚未执行；本轮没有启动 Edge/Chrome、可见浏览器或 8080 网页。

这只改善 Role Intelligence 的失败可定位性，不把公开 `job-search` Capability 或任何 live benchmark 宣称为已通过；真实 Provider、样本矩阵和 Public Release 硬 Gate 仍待验证。

## Implemented JOB_RESEARCH_FAILURE_CORRELATION_40 slice

继续把长期岗位研究纳入同一支持诊断闭环：

- `JobResearchRun` 失败/中断现在使用既有 `trace_json` 保存 bounded `error_id`，并通过通用诊断记录关联 run/provider；
- 重试进入 running 时清理旧错误 ID，成功结果仍由正常研究 trace 写入，避免将历史失败误显示为当前状态；
- Diagnostic Bundle 现在以脱敏元数据摘要同时覆盖 CareerTask、AutomationEvent、RoleBenchmarkRun 和 JobResearchRun；不导出研究结果、报告、证据正文或岗位内容；
- 新增的持久化研究失败契约尚未执行，且本轮没有启动 Edge/Chrome、可见浏览器或 8080 网页。

这只改善研究链的错误可定位性，不改变 live Provider 的真实性判断；真实研究 Provider、网络/重启矩阵和 Public Release 硬 Gate 仍未完成。

## Implemented RELEASE_TAG_FAIL_CLOSED_41 slice

继续收紧 Public Release 的最后一道发布边界：

- Windows `v*` tag 在打包前必须执行 `audit_release_readiness.py --require-ready`；当前 checklist 仍有 `NOT_VERIFIED`/`BLOCKED_EXTERNAL` 时不会浪费构建资源生成可发布安装包；
- GitHub Draft Release 在下载 artifact 前再次执行同一 fail-closed 检查，防止人工或流程误把未 ready artifact 发布为公开 Draft Release；
- main、PR 和本地开发路径不受影响；本轮没有启动 Edge、Chrome、8080 或任何可见浏览器，也没有执行测试、构建或远程 workflow；
- 这不替代签名证书、previous-release upgrade、clean-machine、CI runner 和最终隐私/法律决策，只把“未通过 Release Gate 仍可进入发布步骤”的流程漏洞关闭。

## Implemented PREVIOUS_RELEASE_MIGRATION_42 slice

继续收口 Public Release 的 previous-release 证据链：

- 新增 `backend/scripts/e2e/test_public_release_migration.py`，在临时数据库中建立带有旧版 `schema v1`、Profile、5 个 Job、Applications、Interview、Calendar 和旧 triage 值的合成工作区；启动时由当前后端真实执行 migration、pre-migration Online Backup、integrity/FK 校验和 v2 状态归一化；
- 浏览器验收只使用 Playwright managed Chromium `headless=True`，并检查 Today、Pipeline、Job Detail、Profile 读取迁移后的同一份数据；脚本拒绝非 `127.0.0.1:7410/8765` 地址，若 8765 已被其他进程占用则 fail-closed，不会停止或复用用户进程；
- GitHub workflow 新增独立 `migration-browser-smoke` job，仅启动隔离前端；迁移脚本自己拥有临时后端进程，失败时上传脱敏范围内的 synthetic fixture、后端日志、screenshot/trace；Windows package 依赖该 job，tag 发布链因此不会跳过 previous-release browser smoke；
- Windows workflow 另新增 `desktop-installed-smoke`：从 package job 下载 NSIS 安装包，在独立 runner 的临时安装目录执行静默安装，启动已安装的 OfferU，直接通过 `127.0.0.1:8765/api/health` 验证 sidecar，再只清理自己创建的进程并卸载；该 smoke 不使用浏览器，且本轮未执行远程 runner；
- 本轮只写入仓库内可重复验收路径，按 `AGENTS.md` 没有执行测试、构建、远程 workflow、Edge、Chrome、8080 或任何可见浏览器；R72/R88 仍不能因脚本存在而宣称 PASS，必须由 managed-Chromium runner 或用户执行该路径后补当前证据。

这条切片没有改变正常 `backend\offeru.db`、前端 `7410`、后端 `8765` 或可选模型端点 `8080`；临时后端结束后只清理自身临时目录，不触碰用户进程和真实数据。

## Release dashboard

| Gate | Status | Current evidence |
| --- | --- | --- |
| Core Product | PARTIAL | [Public Release E2E](docs/evals/reports/2026-09-01-codex-offeru-public-release-e2e.md) + [portable browser smoke](docs/evals/reports/2026-09-01-codex-offeru-public-release-ci-browser-smoke.md)：10/10 composite、50/50 first-run、新用户准备、Interview learning smoke；仍缺独立陌生用户验收 |
| Data Safety | PASS | R43–R49、R76 已由 `data-safety-01`、`data-safety-02`、`data-safety-03` 报告覆盖 |
| Security | PARTIAL | Security 01–09 已覆盖当前代码边界、canary、logger、权限、同意、Provider health read-side redaction 和合成数据清理；仍有 3 条历史旧正文、历史 artifact/行 scrub、完整 PII data-flow、retention、真实 OAuth/浏览器与代码签名残余 |
| Reliability | PARTIAL | Reliability 01–14 加当前 [E2E](docs/evals/reports/2026-09-01-codex-offeru-public-release-e2e.md) 已覆盖真实 backend 局部恢复、100-cycle worker、100-cycle RSS 门槛、两个独立进程的 CareerTask/AutomationEvent claim、mutation retry、浏览器双击/传输重试、Provider auth/timeout durable failure、跨进程 retry/restart contract、10/10/50/失败浏览器路径；Reliability-14 尚未执行，完整 worker/browser/network/restart 矩阵仍缺 |
| Architecture / Control | PARTIAL | [Architecture audit](docs/evals/reports/2026-09-01-codex-offeru-public-release-architecture-audit.md)：route/Registry、CLI/MCP/plugin、Python dependency direction、frontend Provider execution branch、唯一 Automation dispatcher 和 optional startup recovery 均无静态违规；动态 browser/legacy runtime audit 与远程 CI 仍缺 |
| Packaging | PARTIAL | [Packaging](docs/evals/reports/2026-09-01-codex-offeru-public-release-packaging.md)：Tauri bundle、sidecar、安装生命周期和 release Doctor 通过；installer 未签名，upgrade/clean OS 未验证 |
| Live Runtime | PASS (staged) | [Packaging](docs/evals/reports/2026-09-01-codex-offeru-public-release-packaging.md)：打包 Pi 在隔离 staged config/env + 可用模型下完成真实 Run；正常当前模型返回 unavailable，实时 Role Intelligence 另见 [live role report](docs/evals/reports/2026-09-01-codex-offeru-public-release-live-role.md) |
| E2E | PARTIAL | [E2E](docs/evals/reports/2026-09-01-codex-offeru-public-release-e2e.md) + [portable browser smoke](docs/evals/reports/2026-09-01-codex-offeru-public-release-ci-browser-smoke.md) + [Interview learning](docs/evals/reports/2026-09-01-codex-offeru-public-release-interview.md) + [duplicate/retry](docs/evals/reports/2026-09-01-codex-offeru-public-release-reliability-08.md)：10/10、50/50、失败路径、双击/传输重试、Interview Focus/Debrief/Learning 和本地 managed-Chromium smoke 通过；远程 runner、clean-machine、migration/existing-user、完整 live/provider 矩阵仍缺 |

## Last passing checkpoint

```text
PUBLIC_RELEASE_RELIABILITY_20
scope: provider failure matrix, health redaction, and deterministic release contracts
date: 2026-09-02
```

该最新检查点在前序启动恢复、唯一 Automation dispatcher、severity ledger、Provider health matrix 和 `362` 全量回归证据之上，新增 Provider auth/timeout 的 durable failure contract；当前仍没有把模拟异常宣称为真实外部 Provider/network/restart 通过。

历史 `STARTUP_RECOVERY_15` / `RELEASE_SEVERITY_17` 检查点仍保留其当日摘要；最新全量数字以本节上方 `362 passed` 的 revalidation 为准。

该检查点记录了启动恢复可观测性、唯一 Automation dispatcher 和授权环境下的全量后端回归：health/diagnostics 正常启动均为 `ready`，7 个核心恢复检查无失败；可选邮箱、Memory distill、工作源自动同步通过同一 recovery wrapper，失败 contract 返回 `degraded + error_id` 且不暴露异常正文；architecture audit 的 21 个 route 文件、151 个 mutation route functions、Automation/Registry/startup recovery bypass 均为 0；完整后端套件为 `352 passed, 19 warnings, 1 subtests passed in 320.12s`。此前 Role Intelligence `11 passed`、Role Interview `6 passed`、Interview learning 浏览器路径、双进程 claim、100-cycle worker、10/10/50/失败浏览器路径、性能/打包/Doctor 证据继续保留。Reliability-12 又按 Goal 的替代门槛确认 100 个代表性 task cycles 与 100-cycle RSS 资源门槛通过。它仍是局部发布证据，不等于最终发布结论；独立 clean-machine 人工验收、签名、升级、live/provider matrix 和安全/隐私残余仍阻止 Public Release。

## Completed RELEASE_SEVERITY_17 slice

正式报告：[Release Severity Gate](docs/evals/reports/2026-09-01-codex-offeru-public-release-severity.md)

本轮新增 `backend/scripts/release/audit_release_severity.py` 并接入 backend CI：

- `KNOWN_ISSUES.md` 的 7 条当前残余全部拥有 kind、severity、status 和 release impact；
- 当前 inventory 为 `GATE=6`、`P2=1`、`P0=0`、`P1=0`，audit findings 为 0；
- 未完成的 GATE 仍保持 `BLOCKED_EXTERNAL`/`NOT_VERIFIED`，不会因 P0/P1 为 0 而放行 Public Release；
- CLI Doctor 现在探测本地 frontend，当前 7410 返回 HTTP 200；网络错误只保留 bounded `error_kind`，不回显响应正文。

因此 R82 提升为当前已知问题 inventory 的 `PASS`；它不替代最终 clean-machine、动态 E2E、签名、升级或隐私所有者验收。

## Completed PROVIDER_HEALTH_18 slice

正式报告：[Provider health matrix](docs/evals/reports/2026-09-02-codex-offeru-public-release-provider-health.md)

- Provider 健康投影已对 `unprobed`、`ready`、`auth_required`、`blocked`、`unavailable` 五种状态建立隔离数据库 contract；
- `pi`、`replay`、`codex`、`deepseek-harness` 四个 known Provider 的列表投影稳定；
- `provider_health_view()` 现在在读取时再次清理 `last_error`，旧数据库行或恢复路径不能绕过写入侧脱敏；
- 定向发布测试为 `4 passed`，R107 的确定性 Optional Integration 子项提升为 `PASS`；真实 Provider availability、live Role Intelligence 和完整 network/restart matrix 仍保持独立残余。

## Completed SELF_REVIEW_19 slice

正式报告：[Three-perspective self review](docs/evals/reports/2026-09-02-codex-offeru-public-release-self-review.md)

- Product review 复核了新用户核心路径、Resume/Today/Pipeline、Product claims 和用户可见失败；
- Architecture review 复核了 Registry/Provider/dependency/Automation/startup recovery 边界，当前静态审计仍为 `0 finding`；
- Reliability/Security review 复核了 `362` 全量回归、100-cycle worker/RSS、双进程 claim、备份恢复、canary 和 severity ledger；
- 三轮审查没有产生新增 P0/P1，也没有把现有 GATE/NOT_VERIFIED 错误提升为 PASS；R95 现为 `PASS`，Public Release 仍为 `NOT_READY`。

## Completed RELIABILITY_20 slice

正式报告：[Provider failure matrix](docs/evals/reports/2026-09-02-codex-offeru-public-release-reliability-13.md)

- `401 invalid_api_key` 进入 `blocked`，网络 timeout 进入 `failed`；两者均保留 retryable、一次 attempt 和对应 durable lifecycle event；
- 认证错误统一为 `provider authentication failed`，canary 不出现在 task view 或事件 payload；
- 定向矩阵测试为 `1 passed in 5.04s`；R34/R35/R61/R74 的对应确定性 failure 子项补证，但完整 Provider/network/restart matrix 仍为 `PARTIAL`。

## Completed STARTUP_RECOVERY_15 slice

正式报告：[Public Release Startup Recovery Evidence](docs/evals/reports/2026-09-01-codex-offeru-public-release-startup-recovery.md)

本轮将启动恢复从“异常不阻塞启动”收口为“异常可见且不阻塞可选能力”：

- 7 个核心 recovery check 和 3 个可选后台服务统一记录 `ready/failed`、bounded check name 与 `error_id`；
- `/api/health` 和 `diagnostics/bundle` 暴露同一 startup recovery projection，公开状态不含异常正文/凭据；
- optional email sync、Memory distill、work-source auto sync 不再直接调用，均经过 `run_startup_recovery`；
- architecture audit 新增唯一 Automation dispatcher 与 startup recovery boundary contract，脚本 `finding_count=0`；
- 启动恢复/安全/Doctor 定向回归 `11 passed`，架构 contract + recovery `9 passed`，授权环境后端全量 `362 passed`。

该切片只把 R33 提升为 PASS，并把 R36/R56/R57/R58/R61/R73/R96/R103 的对应子项补为当前 `PARTIAL` 证据；强制进程重启矩阵、live Provider、clean-machine、签名/升级和历史隐私政策仍未完成。

## Completed ROLE_AUTHORITY_14 slice

正式报告：[Role Intelligence Authority Evidence](docs/evals/reports/2026-09-01-codex-offeru-public-release-role-authority.md)

本轮确认 Agent/Provider 与 Runtime 的权责边界：候选材料可以来自 Replay 或 deep executor，但 normalization、canonicalization、dedupe、cohort、样本充分性、frequency、Delta、Evidence Gap 和持久化均由 Python Runtime 完成。`test_role_intelligence.py` 的 11 个测试和 `test_role_interview.py` 的 6 个测试通过；该证据提升 R23 为 PASS，但实时 Provider 和 10-role live acceptance 仍保持未完成。

## Completed ARCHITECTURE_12 slice

正式报告：[Public Release Architecture Audit](docs/evals/reports/2026-09-01-codex-offeru-public-release-architecture-audit.md)

本轮新增 `backend/scripts/release/audit_architecture.py`，并将其接入 backend CI。当前工作树已通过：

- route direct ORM/SQL mutation 扫描；
- mutation route 的 Registry/runtime boundary 扫描；
- route 直接调用 mutating service 扫描；
- `app/models`、`app/agents`、`app/services` 到 FastAPI route 的反向依赖扫描；
- ORM model 到 application/control-plane 的依赖扫描；
- CLI/MCP/plugin control-surface escape-hatch 扫描；
- 非配置型前端 Provider execution branch 扫描。

定向回归为 `9 passed in 1.32s`；脚本输出 `finding_count=0`，并已在 backend CI 中执行。该切片只证明静态边界没有新增违规，不替代动态 legacy/browser runtime audit、远程 CI 执行或最终发布 review。

## Completed INTERVIEW_LEARNING_13 slice

正式报告：[Public Release Interview Learning E2E](docs/evals/reports/2026-09-01-codex-offeru-public-release-interview.md)

本轮使用全新隔离 SQLite、managed Chromium 和显式 Replay provider 完成真实用户可见路径：

- Profile onboarding → Job 保存 → Role Intelligence Focus Plan；
- 首个模糊回答触发 `Adaptive follow-up`，活跃页面保持 Interviewer Mode，不显示即时夸奖、答案补全或 Coach 面板；
- 8 次回答完成 Interview，API transcript 为 16 条消息；
- 完成报告展开后引用实际回答文本；
- Learning Candidate 进入 Profile 记忆收件箱，并通过 Profile UI 接受，回写 applied Profile section；
- accepted 状态再次反映回 Interview report；
- HTTP、console、page error 均为 0。

该切片为 `PASS_FIXTURE_REPLAY`，补足 R27–R30 的浏览器证据但不替代 live provider、失败/重启矩阵或陌生用户安装验收。

## Completed DATA_SAFETY_01 slice

正式报告：[2026-08-31-codex-offeru-core-v1-data-safety-01](docs/evals/reports/2026-08-31-codex-offeru-core-v1-data-safety-01.md)

本轮已在隔离数据库上完成并验证：

- SQLite Online Backup API 一致性快照；
- SQLite、受管 uploads/artifacts、版本 manifest 和逐文件 hash；
- `PRAGMA integrity_check` 与 foreign-key 检查；
- restore staging、确认门、取消、启动前恢复、pre-restore 备份和失败自动回滚；
- Operation Registry、CLI Doctor、Settings UI 和浏览器 restart/cancel 路径；
- 三次 backup → mutate → restore → restart 循环，以及恢复后的真实 Profile/Job 查询。

因此当前将 R43、R44、R45、R46、R49、R76 标记为 PASS；这不改变 Public Release 总结论。

## Completed DATA_SAFETY_02 slice

正式报告：[2026-08-31-codex-offeru-core-v1-data-safety-02](docs/evals/reports/2026-08-31-codex-offeru-core-v1-data-safety-02.md)

本轮已在隔离的 old-schema A/B fixtures 和正常本地启动路径验证：

- `PRAGMA user_version` 的 v1/v2 编号迁移路径；
- migration 前 verified Online Backup API 备份；
- migration 后 integrity、foreign-key 和 required-table smoke；
- migration 失败释放 ORM 引擎、恢复 pre-migration snapshot 并停止启动；
- future schema version fail-closed；
- 正常 `djm.db` 启动从 version 0 到 2，`integrity_check=ok`，Doctor migration `ready`。

因此 R43、R44 现标记为 PASS；R47/R48 仍是 Data Safety 的剩余验收项。

## Completed DATA_SAFETY_03 slice

正式报告：[2026-08-31-codex-offeru-core-v1-data-safety-03](docs/evals/reports/2026-08-31-codex-offeru-core-v1-data-safety-03.md)

本轮已在隔离数据库、真实 Settings UI 和正常运行库上完成并验证：

- JSON structured export 包含 Profile、Job、Application、Resume、Interview 及 CareerArtifact 等核心集合，并保留可读记录与 counts；
- 嵌套 metadata 中的 `api_key`、`api_token` 等凭据字段会递归排除；
- Demo Reset 只匹配 `source=offeru-demo` 且 `batch_id=offeru-demo-v1` 的合成 Job；
- 明确确认门、子记录清理、重复 reset no-op，以及真实 Profile/未标记 Job 保留；
- 浏览器路径从 2 条 Job 重置到 1 条真实 Job，Settings 成功提示可见，console errors 为 0；
- 正常 `djm.db` 已恢复，HTTP health 200，Doctor 报告 schema 2/2、integrity `ok`、FK violations 0。

因此 R47、R48 现标记为 PASS，Data Safety domain 完整通过；这不改变 Public Release 总结论。

## Completed RELIABILITY_01 slice

正式报告：[2026-08-31-codex-offeru-core-v1-reliability-01](docs/evals/reports/2026-08-31-codex-offeru-core-v1-reliability-01.md)

本轮在隔离 SQLite/Replay 和当前 commit `f0de8cb` 上完成并验证：

- 并发 CareerTask/AutomationEvent 的 exactly-once 创建与复用；
- queued、running、waiting_for_approval 的 CareerTask 恢复；
- queued AutomationEvent 的启动恢复；
- cancel 与晚到结果的终态保护，以及重复 retry 的复用；
- 100 个 Replay task cycles：100 completed、500 lifecycle events、0 live workers；
- 当前 commit 后端全量 `297 passed, 10 warnings, 1 subtest passed`。

这只证明控制面和确定性后端切片；Reliability domain 仍为 `NOT_VERIFIED`，因为真实进程强退/浏览器恢复、Resume/Interview/Learning 恢复、全业务 mutation exactly-once、RSS 和混合用户 soak 尚未完成。

## Completed SECURITY_02 slice

正式报告：[2026-08-31-codex-offeru-core-v1-security-02](docs/evals/reports/2026-08-31-codex-offeru-core-v1-security-02.md)

本轮已在当前 checkout 和隔离 canary 上完成并验证：

- HTTP、Starlette 404、validation、未处理异常与前端 request/SSE 的 error ID 关联；
- Registry-backed 脱敏 diagnostic bundle 与 Settings 浏览器反馈下载；
- API validation、diagnostic、browser feedback、durable Agent/Audit/export canary；
- Profile/Resume/Doctor/database migration/scraper 已确认的原始异常路径收口；
- Python `pip-audit`、`pip check`、JobSpy markdown conversion 与 npm production audit；
- 后端全量 `298 passed, 10 warnings, 1 subtest passed`，前端 typecheck/build 通过。

Security 仍保持 `NOT_VERIFIED`：Rust advisory DB、完整 release artifact matrix、权限 diff、全量 logging/PII、历史 Agent Run scrub、privacy/consent 和签名未完成。

## Completed RELIABILITY_02 slice

正式报告：[2026-08-31-codex-offeru-core-v1-reliability-02](docs/evals/reports/2026-08-31-codex-offeru-core-v1-reliability-02.md)

本轮在隔离 SQLite、真实 backend 进程和真实 7410 浏览器页面完成：

- force-stop/restart 后 running CareerTask blocked/retryable、waiting checkpoint 保留、queued Replay 完成；
- queued AutomationEvent startup recovery 安全处理；
- backend outage 时显示启动状态，恢复后 Today 核心 UI 回来；
- 中文 Resume 编辑 autosave 后刷新内容保留，单次更新请求，page errors 为 0；
- 测试后正常 `djm.db` health 200，真实职业数据未被修改。

在 Reliability-02 结束时，Reliability 仍为 `NOT_VERIFIED`：Interview/Learning 恢复、保存失败重试、全业务 mutation exactly-once、RSS 与混合用户 soak 未完成；保存失败重试已由后续 Reliability-03 补证为 `PARTIAL`。

## Completed RELIABILITY_03 slice

正式报告：[2026-08-31-codex-offeru-core-v1-reliability-03](docs/evals/reports/2026-08-31-codex-offeru-core-v1-reliability-03.md)

本轮在隔离 SQLite 和真实 Resume Workspace 浏览器路径完成并验证：

- 中文 Resume autosave 成功后刷新内容保留，单次更新请求；
- 注入第一次 503 保存失败后，失败状态可见、编辑内容保留；
- 用户点击“重试保存”后第二次请求成功，无 JavaScript page error；
- 当前 draft signature guard 防止晚到旧响应覆盖新编辑。

该切片只把 Resume 保存失败推进为 `PARTIAL`，不改变 Reliability 总 Gate，也不继承为 Resume 冲突、Interview/Learning 恢复或 Public Release 通过。

## Completed RELIABILITY_04 slice

正式报告：[2026-08-31-codex-offeru-core-v1-reliability-04](docs/evals/reports/2026-08-31-codex-offeru-core-v1-reliability-04.md)

本轮在全新隔离 SQLite 和两次真实 backend 进程启动上完成并验证：

- active Interview 保留当前轮次；
- running EvaluationRun 在启动恢复时标为 failed，并保留明确 retry 语义；
- completed Interview 缺少 learning candidate 时补齐 Observation 与 pending Proposal；
- 第二次启动不重复新增 Evaluation、Observation 或 Proposal；
- 正常 `djm.db` 在测试结束后恢复健康。

该切片只把 Interview/Learning recovery 和本地 handoff duplicate prevention 推进为 `PARTIAL`，不改变 Reliability 总 Gate，也不等于 live Provider、完整 UI 或 Public Release 通过。

## Completed RELIABILITY_05 slice

正式报告：[Reliability 05](docs/evals/reports/2026-08-31-codex-offeru-core-v1-reliability-05.md)

本轮在隔离 SQLite 和真实 backend `8765` 进程完成：

- 10 个 warm-up read cycles 加 100 个串行混合 HTTP cycles；
- 覆盖 Job/Resume/Application/Memory/Automation/CareerTask 读取，100 次 Resume 写入，12 次 Candidate accept/reject，10 次 Automation/CareerTask proposal，10 次 Replay short interview；
- 0 workload error，RSS warm-up 后增长 `3.01%`，SQLite integrity `ok`，foreign-key violations 为 0；
- 持久化计数显示 10 个 completed Interview、10 个 completed EvaluationRun、22 条 Observation、22 条 Proposal，20 个 Agent Run 保持 waiting confirmation；没有把 proposal boundary 误报成 worker completion；
- 隔离 backend 停止后，正常 `djm.db` 以受控可写 runtime 恢复，health、diagnostics bundle 和 integrity 均通过，原有 463 条岗位读取仍在，未被 fixture 污染。

该切片只将 R34/R35/R36/R62/R63/R74 推进为 `PARTIAL`。100-cycle 测量时间约 15.3 秒，不等价于 2 小时 endurance；duplicate click/network retry、完整 CareerTask worker mixed RSS、浏览器/Provider 矩阵和 Public Release 仍未通过。

## Completed RELIABILITY_06 slice

正式报告：[Reliability 06](docs/evals/reports/2026-08-31-codex-offeru-core-v1-reliability-06.md)

本轮在全新隔离 SQLite 和真实 backend `8765` 进程完成关键 mutation matrix：

- Resume identical payload、Application auto-write、legacy Application create/status 和 Memory accept/reject 重试均只产生一次 business effect；
- 两个并发 Replay Interview answer 只产生一个 evaluation/learning handoff；
- backend 重启后重复提交同一 Interview answer 返回 `duplicate=true`，持久化计数不增加；
- 定向测试 `3 passed`，与现有 Application/Resume 测试合并为 `7 passed`；
- 隔离 backend 停止后正常 `djm.db` health、diagnostics、integrity 均通过，岗位总数仍为 463。

该切片只把 R34/R36/R62/R74 的服务层重复请求子项推进为 `PARTIAL`。完整浏览器/network fault、CareerTask/Automation worker、2 小时 endurance、Security residual 和 Public Release 仍未通过。

## Completed SECURITY_03 slice

正式报告：[Security 03](docs/evals/reports/2026-08-31-codex-offeru-core-v1-security-03.md)

本轮在隔离临时目录验证同一 fake canary 不会进入：

- 共用 `atomic_write_json` 的 Agent history/memory、Resume draft、Application event/follow-up、Pre-application decision 和 Career artifact；
- 独立的 Run workspace JSON artifact；
- 其他普通 JSON 写入边界。

所有非临时文件扫描结果为 0 次 canary，普通邮箱文本仍保留。定向安全测试为 `3 passed`。该切片只把 R51/R52 的 JSON artifact 子项推进为 `PARTIAL`；历史文件、binary/PDF、全量 logging/PII、Rust、权限 diff、privacy/consent 和 Public Release 仍未通过。

## Completed SECURITY_04 slice

正式报告：[Security 04](docs/evals/reports/2026-08-31-codex-offeru-core-v1-security-04.md)

本轮完成：

- 清理 Cargo.lock 中已知 vulnerable `quick-xml 0.39.4` 与未使用 `rkyv 0.7.46` 路径，升级至安全依赖组合；
- `cargo audit --no-fetch` 报告 `0 vulnerabilities`，`cargo check` 成功；
- Tauri capability/permission contract 通过：仅 `core:default`，无 generic shell capability，CSP 基线仍有效。

最新 RustSec 数据库 fetch 仍受当前网络环境限制，17 条 unmaintained/unsound warning 和 logging/PII、privacy/consent residual 继续保留，不把本轮结果升级为完整 Security PASS。

## Completed SECURITY_05 slice

正式报告：[Security 05](docs/evals/reports/2026-08-31-codex-offeru-core-v1-security-05.md)

本轮完成：

- AST 扫描 `backend/app/**/*.py` 的标准 logger 调用，当前敏感动态日志参数为 0；
- 面试提取、岗位搜索、远端 Qdrant 和 LLM 异常等已确认路径改为固定状态、长度/计数或脱敏错误信息；
- Tauri 启动日志不再输出 Python 可执行路径或项目根目录；
- 定向日志 contract `1 passed`，与 Tauri contract、Security-03 canary 合并为 `5 passed, 2 warnings`。

该切片只把 R53/R56/R57 的当前代码边界推进为 `PARTIAL`。历史日志、桌面/第三方日志、完整 runtime PII data-flow、privacy/consent、retention 和 Public Release 仍未通过。

## Completed SECURITY_06 slice

正式报告：[Security 06](docs/evals/reports/2026-08-31-codex-offeru-core-v1-security-06.md)

本轮完成并验证：

- 云端 Interview Runtime 的明确数据类别同意与本地/云端边界；
- authorized browser 的最小摘录、无 credentials/cookies/storage state 保存声明；
- Gmail `gmail.readonly` scope 与服务端确认门；
- IMAP `imap:read` scope 与服务端只读确认门；
- Email 设置页确认复选框、授权错误可见和活动账号撤销入口；
- 邮箱撤回后的 credential reference 删除、停止同步、signal/candidate 清理与已确认阶段事件的最小审计外壳。

定向隐私、邮箱、授权研究和面试测试为 `27 passed, 2 warnings`；前端 typecheck 通过。该切片只把 R41/R51/R53/R56/R58/R98/R99/R107 的对应子项推进为 `PARTIAL`，不等于真实 OAuth、真实媒体授权、历史数据 scrub、retention/公开法律政策、完整浏览器 E2E 或 Public Release 通过。

## Completed SECURITY_07 slice

正式报告：[Security 07](docs/evals/reports/2026-08-31-codex-offeru-core-v1-security-07.md)

本轮完成并验证：

- `get_privacy_hygiene_status` 只暴露旧邮件正文计数，不暴露历史内容；
- `scrub_legacy_email_notification_bodies` 必须明确确认，并通过 Operation Registry 执行；
- 清理后保留结构化面试通知字段，不静默删除岗位、公司、类别和时间；
- Diagnostic Bundle 暴露 bounded privacy hygiene summary；
- 正常工作区只读审计记录为 3 条旧正文、506 字符，本轮未执行不可恢复的真实用户数据清理。

隔离隐私卫生、canary、logger 和 Tauri contract 为 `7 passed, 2 warnings`。该切片只把 R50/R51/R52/R53/R56/R58 的历史持久化子项推进为 `PARTIAL`，不等于历史 artifact 全量 scrub、retention/公开法律政策或 Public Release 通过。

## Completed SECURITY_08 slice

正式报告：[Security 08](docs/evals/reports/2026-08-31-codex-offeru-core-v1-security-08.md)

本轮完成并验证：

- 通过严格的 `gmail-*@example.com` / `imap-*@qq.com` 测试命名空间识别合成邮箱测试数据；
- 清理 Operation 要求 `user_confirmed=true`，并在发现正式阶段事件或日历事件时 fail closed；
- 先后验证缺少 Windows keyring 依赖时安全失败且不改库，安装 `keyring` 后再通过 Operation Registry 完成清理；
- 从正常 `djm.db` 清理 140 个合成邮箱账号、30481 个同步运行记录、70 个信号、70 个候选和 105 个凭据引用；
- 清理后 `PRAGMA integrity_check=ok`、foreign-key violations 为 0，HTTP health/diagnostics 为 200，邮箱状态为 disconnected，岗位总数仍为 463；
- 定向 privacy hygiene、canary、logger 和 Tauri contract 为 `8 passed, 2 warnings`。

该切片只把合成测试污染清理和 Operation 保护推进为 `PARTIAL`。正常工作区仍有 3 条历史旧邮件正文（506 字符），本轮没有静默删除；历史 artifact/行 scrub、完整 runtime PII data-flow、retention/公开政策、真实 OAuth 和完整浏览器证据仍未完成。

## Completed RELIABILITY_07 slice

正式报告：[Reliability 07](docs/evals/reports/2026-08-31-codex-offeru-core-v1-reliability-07.md)

本轮修复了邮箱增量同步测试直接调用正常数据库 `init_db()` 的隔离缺口。每个 case 现在使用独立临时 SQLite，并将邮箱同步、应用进展摄取及测试 helper 的 session 一并指向该隔离库。定向测试为 `7 passed, 2 warnings in 48.66s`；测试后正常工作区的邮箱账号、同步运行、外部信号和候选均为 `0`，SQLite integrity 为 `ok`，foreign-key violations 为 `0`。

该切片只证明该测试文件不再污染正常用户工作区，不等价于其他历史测试、浏览器、真实进程或 Public Release 隔离全部通过。

## Completed RELIABILITY_09 slice

正式报告：[Real CareerTask worker matrix](docs/evals/reports/2026-09-01-codex-offeru-public-release-reliability-09.md)

本轮完成并验证：

- 100 个独立岗位通过公开 ingest → `JOB_SAVED` → CareerTask → Replay Role Intelligence worker 链；
- 100/100 task、100/100 AutomationEvent、100/100 Job 均唯一且最终完成；
- 每个 task 都有持久化 `task.queued`、`task.started`、`task.completed` 生命周期事件，attempt 均为 1；
- 运行约 62.9 秒，无 task/HTTP 错误；隔离数据库 integrity 通过、foreign-key violations 为空；
- 测试只使用隔离 SQLite，正常 `djm.db` 随后恢复 health 200。

本轮把真实 backend worker 的 100-cycle 子项补成当前证据，但不把短时串行 Replay workload 宣称为 2 小时 endurance、并发压力、跨进程恢复或真实 Provider 矩阵。

## Completed RELIABILITY_11 slice

正式报告：[AutomationEvent cross-process claim](docs/evals/reports/2026-09-01-codex-offeru-public-release-reliability-11.md)

本轮完成并验证：

- 两个独立进程同时提交同一个 `JOB_SAVED` 信号时，数据库 `queued → processing` 原子 claim 只允许一个进程进入分发；
- 隔离数据库最终只有 1 条 AutomationEvent、1 条 CareerTask、1 个 Inbox projection，CareerTask `attempt_count=1`，`task.started`/`task.completed` 各 1 条；
- 任务完成后的自动化投影可以把 event 从 `dispatched` 收敛为 `completed`；
- Inbox 主键竞争会复用已提交行，不把并发恢复误报成失败；
- CareerTask 已处于 terminal 状态时，后续投影取消不会把它改写为 `blocked`；定向可靠性回归为 `12 passed in 72.75s`。

本轮把 AutomationEvent 的跨进程 duplicate/recovery 子项补成当前证据，但 provider/network/cancel/resume 全矩阵、完整业务 mutation 并发和长时 endurance 仍未完成。

## Completed RELIABILITY_12 slice

正式报告：[Reliability gate reconciliation](docs/evals/reports/2026-09-01-codex-offeru-public-release-reliability-12.md)

本轮按 Public Release Goal 的明确替代条件重新核对 soak：

- Reliability-09 已完成 100 个真实 CareerTask worker cycles，100/100 Job、Task、AutomationEvent 唯一且完成，attempt 均为 1，SQLite integrity/FK clean；
- Reliability-05 已记录 100 个真实混合 backend cycles 后 warm-up RSS 增长 `3.01%`，低于 Goal 的 `20% after 100 cycles` 门槛，且无 workload error；
- 因 Goal 使用“2 小时或 100 个代表性 task cycles”，R62 与 R63 当前均提升为 `PASS`；2 小时是未执行的等价验证方式，不再作为该 Gate 的叠加硬要求；
- 这不扩展为完整 provider/network/restart matrix，也不改变 Public Release 总结论。

## Completed RELIABILITY_08 slice

正式报告：[Browser duplicate/retry](docs/evals/reports/2026-09-01-codex-offeru-public-release-reliability-08.md)

本轮完成并验证：

- Add Job 提交按钮真实双击只产生 1 个 Job 和 1 个 Role Intelligence CareerTask；
- 第一次请求由后端真实提交后，浏览器将客户端响应模拟为 503；UI 显示可理解错误且保留重试能力；
- 用户重试同一 payload 后仍只有 1 个 Job 和 1 个 CareerTask，task 最终 `completed`；
- Job Detail 等待异步 Role Intelligence 投影完成后显示 20 个 fixture comparator；
- page errors 和 unexpected browser errors 为 0，唯一 503 被明确记录为预期失败；
- 测试使用隔离 SQLite 和 managed Chromium，正常 `djm.db` 随后恢复 health 200。

本轮将 R74 的浏览器 double-click/transport retry 子项补为当前证据，并补强 R34/R62/R73；完整 CareerTask/Automation worker、Provider/network/restart 全矩阵、2 小时 endurance 和 Public Release 仍未通过。

## Completed PUBLIC_RELEASE_EVIDENCE_11 slice

正式报告：[Portable CI browser smoke](docs/evals/reports/2026-09-01-codex-offeru-public-release-ci-browser-smoke.md)

本轮完成并验证：

- 将新用户 Profile → Job → 自动 Replay Role Intelligence → Job Detail 的浏览器冒烟整理为 `backend/scripts/e2e/test_public_release_smoke.py`；
- 使用 Playwright managed Chromium、隔离 browser context 和隔离 SQLite，不依赖本机 Chrome 路径或直接改库跳步；
- 失败时才保存 screenshot/trace，成功不保留大体积 trace；
- `.github/workflows/build.yml` 增加 `browser-smoke` job，包含 7410/8765 隔离服务、Playwright 安装和 failure-only artifact upload，并让 desktop/tag release 依赖该 job；
- 本机真实浏览器执行结果：task completed、provider replay、bad responses 0、console errors 0、page errors 0；正常 `djm.db` 后端随后恢复 health 200。

本轮只把 R68/R70/R71/R92 推进为更完整的 `PARTIAL`，不把本地执行升级为远程 CI、签名或 Public Release PASS。远程 runner、CI artifact upload、2 小时 endurance、signed installer、previous-release upgrade、clean-machine 独立验收和隐私/法律 residual 仍阻止 Public Release。

## Completed PUBLIC_RELEASE_EVIDENCE_10 slice

正式报告：[Long Task UX](docs/evals/reports/2026-09-01-codex-offeru-public-release-long-task-ux.md)

本轮完成并验证：

- Automation Inbox 按关联 CareerTask 投影实时 status/progress/error/retryability/attempt snapshot；
- Today 轮询并显示 queued/running/waiting/failed/blocked/cancelled 任务状态、阶段、百分比和可读错误；
- cancel/retry 通过 UI Operation proposal → runtime confirmation，不把 HTTP 200 或 proposal 当成已执行；
- 隔离可见浏览器路径验证 task status/progress/error/cancel/retry/confirmation，`controlCalls=2`、`confirmCalls=2`、cancelled 1、queued 1、page errors 0、failed requests 0；
- 当前真实 7410/8765 页面 smoke 的 Today/Pipeline 可见，page errors 0、failed requests 0；
- 后端 `test_reliability.py` + `test_agent_runtime_convergence.py` 为 `25 passed, 2 warnings`，前端 typecheck PASS。

本轮只把 R13/R34/R35/R61/R73/R74 推进为更完整的 `PARTIAL`，不把隔离 fixture 控制链升级为 live provider 或完整 >2 秒路径 PASS。2 小时 endurance、完整 worker/provider/network/restart 矩阵、CI failure artifacts、signed installer、previous-release upgrade、clean-machine 独立验收和隐私/法律 residual 仍阻止 Public Release。

## Completed PUBLIC_RELEASE_EVIDENCE_09 slice

正式报告：

- [Public Release E2E](docs/evals/reports/2026-09-01-codex-offeru-public-release-e2e.md)
- [Public Release Performance](docs/evals/reports/2026-09-01-codex-offeru-public-release-performance.md)
- [Public Release Packaging](docs/evals/reports/2026-09-01-codex-offeru-public-release-packaging.md)
- [Public Release Severity](docs/evals/reports/2026-09-01-codex-offeru-public-release-severity.md)
- [Public Release Reliability Gate](docs/evals/reports/2026-09-01-codex-offeru-public-release-reliability-12.md)

本轮完成并验证：

- 10/10 个隔离数据库上的 New User → Resume Workspace → Interview/Learning 组合浏览器旅程；
- CI 新增 10 个彼此隔离的 critical new-user browser repeatability runner，每次只使用 `127.0.0.1:7410`、`127.0.0.1:8765` 与 managed Chromium 无头路径；本轮未执行远程 runner；
- 50/50 个独立 first-run 数据库的新用户浏览器旅程，50/50 integrity `ok`、FK 0；
- Resume 保存 503/PDF 503 的真实浏览器失败可见与保存重试；
- production Vite preview 下冷启动 `993.239 ms`、warm renderer startup `1071.201 ms`、缓存导航 p95 `339.558 ms`、用户操作反馈 `35.123 ms`、后台进度可见 `661.186 ms`，五项当前性能 SLO 均通过；
- Tauri `0.4.0` NSIS/MSI bundle、Python sidecar、安装/卸载/重装生命周期、installed app health/integrity/skills smoke；
- release-mode Doctor `CORE_READY`，打包 PDF smoke，及 staged config/env + 可用模型下的真实 packaged Pi Agent Run；
- 隔离 staged Provider 下的 live Role Intelligence 尝试如实失败；并收紧 Pi/OMP 的 live web capability declaration，避免通用 CLI 工具面被误报为受控网页研究能力；
- 最新后端全量 `362 passed, 19 warnings, 1 subtests passed in 329.19s`，前端 typecheck 与 production build 通过。

本轮明确没有把以下事项伪装成 PASS：installer 签名、previous-release upgrade、真正 clean OS 独立人工验收、2 小时 endurance、完整 worker/browser/network failure matrix、当前 `deepseek-v4-flash-free` 的 model availability、历史隐私正文处理和远程 CI runner。

## Evidence policy

- `PASS`：当前可定位 commit 的权威证据覆盖整个 Gate；
- `FAIL`：已知实现或运行事实违反 Gate；
- `BLOCKED_EXTERNAL`：仅限签名证书、本人 OAuth、法律/隐私决策或第三方生产账号；
- `PRE_EXISTING_FAILURE`：已确认在本 Release 改动前存在，但仍需在 Release 前处理；
- `NOT_VERIFIED`：没有足够证据；不得按 PASS 计算。

临时终端输出、`C:\temp` 脚本、历史聊天结论、单次测试和静态代码存在性不能单独证明 Release Gate。

## Next action

```text
1. 完成 Security/Privacy residual：历史 3 条旧正文的明确产品决定、artifact/PII/retention 审计与公开披露边界；Provider health 五状态矩阵和三视角 self review 已通过。
2. 完成 release engineering：签名证书接入、previous-release upgrade/migration、CI runner、clean-machine UI 和 RC artifact/notices。
3. 继续 Reliability：CareerTask/Automation 的跨进程 provider/network/restart matrix；100-cycle worker、100-cycle RSS 门槛、双进程 claim、AutomationEvent claim 和浏览器双击/传输重试已补证，2 小时是可选的等价 endurance 验证方式。
4. 验证 `ROLE_INTELLIGENCE_BACKEND_SEARCH_79` 的实际配置路径：先确认可用搜索 API/LLM；再做真实 Role Intelligence provider 与 10-role matrix。当前 staged packaged Pi Agent 已通过，但历史 Role Intelligence 任务失败且 `deepseek-v4-flash-free` 返回 model unavailable。
```

## External requirements (current or upcoming blockers)

- Windows/macOS 合法代码签名证书；
- 若选择 Codex/Gmail 等生产集成，需要使用者完成对应 OAuth；
- 隐私披露、数据处理与公开发布策略需要产品所有者最终确认；
- 实时第三方研究若作为正式 claim，需要真实 Provider 账号/配额。

代码 Agent 会继续完成不依赖这些事项的仓库内工作；只有签名证书、产品所有者的历史隐私处理/公开政策决定、本人 OAuth 或第三方生产账号仍需人工介入。当前它们与尚未完成的内部 release evidence 共同阻止最终 `OFFERU_PUBLIC_RELEASE_READY`。

## Completed INSTALLED_SMOKE_IDENTITY_49 slice

- Windows `desktop-installed-smoke` 现在从下载的 `release-assets/version.json` 读取期望版本，并要求已安装 sidecar 的 8765 health 同时匹配 `OfferU`、`python`、`release` 和该版本；
- smoke 结果会记录 expected/actual version 与 build mode，继续检查 8765 在启动前未被占用且最终 owner 来自本次临时安装目录；
- health 检查客户端现在显式禁用系统代理和 HTTP 重定向，避免发布 runner 把错误服务或代理响应当作本地 sidecar；
- Linux browser/migration CI 的源码服务等待也会检查网页正文的 OfferU 标识、后端版本和 `local-development` build mode，不接受只有 HTTP 200 的错误服务；
- 该 smoke 明确不使用浏览器，网页地址为 `not_used`，只使用 `http://127.0.0.1:8765`，不会访问 8080 或启动 Edge；
- 新增静态 workflow contract；按 `AGENTS.md` 本轮未运行测试、构建、安装包或远程 runner，Public Release 继续为 `NOT_READY`。详见 [installed smoke runtime identity](docs/evals/reports/2026-09-03-codex-offeru-public-release-installed-smoke-identity.md)。

## Completed DATA_SAFETY_QUARANTINE_GUARD_50 slice

- 无效 `pending_restore.json` 的 `cancelled_restore_markers` 隔离目录现在也必须是受管、非符号链接的本地目录，移动前后均进行父链检查；
- 若隔离目标是符号链接，取消操作 fail-closed，原 marker 保留，不会把文件移动到目录外；新增隔离契约覆盖该路径；
- 按 `AGENTS.md` 本轮未运行测试、构建或语法检查，没有触碰真实数据库、8080 或任何浏览器，Public Release 继续为 `NOT_READY`。详见 [backup symlink guard](docs/evals/reports/2026-09-03-codex-offeru-public-release-backup-symlink-guard.md)。

## Completed VERSION_HEALTH_SOURCE_51 slice

- 版本一致性审计现在覆盖 FastAPI health 真正使用的 `backend/app/main.py` 版本，不再只检查 CLI 常量；
- 前端、Tauri、Rust、CLI 与 health 五个版本声明必须同时匹配，新增 health 版本缺失/漂移契约；
- 本轮未运行测试、构建、安装包或远程 runner，没有启动 Edge、访问 8080 或修改真实数据库，Public Release 继续为 `NOT_READY`。详见 [health version source audit](docs/evals/reports/2026-09-03-codex-offeru-public-release-version-health-source.md)。

## Completed EXTENSION_REDIRECT_GUARD_52 slice

- 扩展 background 的通用 HTTP helper 现在显式使用 `redirect: "error"`，与 popup、HttpOfferUControl 和 WXT 根目录同步 marker 一致；
- 后端/外部模型请求遇到重定向会如实失败，不会被错误本地服务转发；WXT 构建缺少该 marker 时仍 fail-closed；
- 本轮未运行扩展构建、测试或语法检查，没有打开 Edge、访问 8080 或修改真实数据库，Public Release 继续为 `NOT_READY`。详见 [update navigation boundary](docs/evals/reports/2026-09-03-codex-offeru-public-release-no-arbitrary-update-navigation.md)。

## Completed DOCTOR_PAGE_IDENTITY_53 slice

- Doctor 的 8765 检查现在还要求当前 `APP_VERSION` 和运行模式对应的 `build_mode`，避免旧版本/错误服务被报成 ready；
- Doctor 的 7410 检查现在读取有限正文并确认 OfferU 标识，错误网页返回 `frontend_payload_invalid`，正文不会写入诊断结果；
- 新增版本/build mode 漂移与错误网页契约；本轮未运行测试、构建、安装包、远程 runner 或浏览器，没有启动 Edge、访问 8080 或修改真实数据库，Public Release 继续为 `NOT_READY`。详见 [Doctor page/runtime identity](docs/evals/reports/2026-09-03-codex-offeru-public-release-doctor-page-identity.md)。

## Completed MIGRATION_HEALTH_IDENTITY_54 slice

- previous-release migration browser smoke 的 8765 等待器现在从当前 checkout 的 `frontend/package.json` 读取期望版本，并严格要求 `OfferU`、`python`、该版本和 `local-development` build mode；
- isolated migration backend 显式固定 `OFFERU_BUILD_MODE=local-development` 与 `OFFERU_RUNTIME_MODE=local`，避免旧服务或错误模式服务被误认成迁移目标；
- migration smoke 的 7410 等待器也要求 2xx 和有限网页正文中的 OfferU 标识，不接受只有 HTTP 200 的错误网页；
- 本轮未运行测试、构建、安装包、远程 runner 或浏览器，没有启动 Edge、访问 8080 或修改真实数据库，Public Release 继续为 `NOT_READY`。详见 [migration health identity](docs/evals/reports/2026-09-03-codex-offeru-public-release-migration-health-identity.md)。

## Completed E2E_HEALTH_IDENTITY_55 slice

- 100-cycle CareerTask worker soak 的 8765 health 校验也要求当前 checkout 版本和 `local-development` build mode，不再只凭 `OfferU/Python` 继续执行；
- migration 与 worker 两条 API 冒烟继续复用固定 `127.0.0.1:8765`、无代理、无重定向边界，8080 不属于任何网页/Release E2E 入口；
- 共享 `is_offeru_health_payload` 现在也拒绝缺失/空的 `version` 或 `build_mode`，避免后续 E2E 新增宽松健康判断；
- smoke、Interview、Empty State 脚本在创建 managed Chromium 前新增固定 7410/8765 readiness helper，错误网页/旧后端会在浏览器创建前 fail-closed；
- 本轮未运行测试、构建、安装包、远程 runner 或浏览器，没有启动 Edge、访问 8080 或修改真实数据库，Public Release 继续为 `NOT_READY`。详见 [migration health identity](docs/evals/reports/2026-09-03-codex-offeru-public-release-migration-health-identity.md)。

## Completed EXTENSION_HEALTH_IDENTITY_56 slice

- 扩展 `HttpOfferUControl.probe()` 现在要求 health 同时含 `OfferU`、`python`、非空版本和合法 `local-development/release` build mode，部分或错误服务不会显示为连接成功；
- 8080 输入仍在 URL 归一化阶段收敛到固定 8765 API，网页入口仍固定 7410；该探测不创建浏览器标签；
- 新增扩展健康身份回归与架构契约；本轮未运行扩展测试、构建、安装包、远程 runner 或浏览器，没有启动 Edge、访问 8080 或修改真实数据库，Public Release 继续为 `NOT_READY`。详见 [migration health identity](docs/evals/reports/2026-09-03-codex-offeru-public-release-migration-health-identity.md)。

## Completed BACKUP_ARCHIVE_SYMLINK_44 slice

继续收紧 Public Release 的本地数据安全边界：

- 备份归档在 ZIP 读取、stage restore、启动恢复计算 SHA-256 之前均拒绝符号链接，避免受管备份目录通过链接读取目录外文件；
- 新增隔离数据安全契约，覆盖 symlink 归档被拒绝、有效备份列表不误收录和外部目标不被当作可恢复输入；
- 扩展根目录同步脚本新增 background 输出的固定 `8765`、OfferU/Python health 与 redirect marker 检查，和 popup `7410` readiness marker 一起阻止旧 bundle 同步；
- 本轮没有启动 Edge、没有访问 8080、没有打开浏览器，也没有修改真实用户数据库；按 `AGENTS.md` 未运行测试、构建或语法检查。

该切片只增加 fail-closed 静态/隔离控制，不把 R44/R46/R51/R52/R91/R92/R96 提升为 PASS；恢复重跑、扩展正式构建、远程 runner、签名和 clean-machine 证据仍待完成。详见 [backup archive symlink guard](docs/evals/reports/2026-09-03-codex-offeru-public-release-backup-symlink-guard.md)。

## Completed TAURI_RUNTIME_IDENTITY_45 slice

继续收紧桌面发布入口：

- Tauri dev backend 显式固定为 `local-development/local`，并注入当前 package version；
- Tauri 8765 health readiness 现在还必须匹配对应的 `build_mode` 和版本，避免旧开发服务或错误版本服务被桌面壳误接管；
- 本轮没有启动 Tauri、Edge、Chrome 或任何可见浏览器，没有访问 8080，也没有修改真实用户数据库；按 `AGENTS.md` 未运行 Rust build、测试或语法检查。

该切片只增加桌面 sidecar 的 fail-closed 身份检查，不把 R36/R37/R55/R84/R87/R88/R89/R96 提升为 PASS；目标平台编译、安装包启动、升级和远程 CI 证据仍待完成。详见 [Tauri runtime identity guard](docs/evals/reports/2026-09-03-codex-offeru-public-release-tauri-runtime-identity.md)。

## Completed WEB_RUNTIME_IDENTITY_46 slice

继续收紧网页入口的错误服务保护：

- 前端 BackendReadyGate 现在要求 8765 health 的版本与当前前端 package version 一致；
- 扩展 7410 readiness probe 在允许用户主动打开网页前读取响应正文并确认 OfferU 标识，同时继续禁止重定向；
- 这不会把 8080 当网页，也不会让日常诊断启动 Edge/Chrome；本轮没有打开浏览器、访问 8080 或修改真实用户数据库；按 `AGENTS.md` 未运行构建、测试或语法检查。

该切片只增加入口身份校验，不把 R10–R12/R37/R56–R58/R68–R71/R84/R96 提升为 PASS；扩展正式构建、目标平台安装包、远程 runner 和陌生用户验收仍待完成。详见 [web/runtime identity guard](docs/evals/reports/2026-09-03-codex-offeru-public-release-web-runtime-identity.md)。

## Completed UPDATE_NAVIGATION_GUARD_47 slice

- 扩展检查更新时不再直接信任后端返回的下载地址：只允许无凭据、无显式端口的 HTTPS 外部地址，localhost/回环/`0.0.0.0`/明文 HTTP/无效地址均 fail-closed；拒绝时不创建浏览器标签；
- WXT 根目录同步脚本要求生成 popup 带有更新地址保护 marker，避免旧 bundle 越过该边界；
- OfferU 网页仍只使用 `http://127.0.0.1:7410`，后端只使用 `http://127.0.0.1:8765`，`8080` 不是网页入口；本轮没有启动 Edge/Chrome、没有打开浏览器、没有访问 8080、没有修改真实用户数据库；
- 按 `AGENTS.md` 未运行构建、测试或语法检查，正式扩展产物、远程 runner、签名和 clean-machine 验收仍待完成。详见 [update navigation boundary](docs/evals/reports/2026-09-03-codex-offeru-public-release-no-arbitrary-update-navigation.md)。

## Completed DATA_SAFETY_DIRECTORY_SYMLINK_GUARD_48 slice

- Data Safety 现在在备份、列举、暂存恢复、启动恢复、直接恢复、状态读取和取消恢复前检查 `data/data_safety`、`backups`、`restore_staging` 及 pending marker 的整条父目录链；目录组件或 marker 为符号链接时 fail-closed，不读写目录外目标；
- 新增隔离契约覆盖 `data` 目录符号链接，外部目标不会被写入；该切片不触碰真实数据库、不打开 8080、不启动 Edge/Chrome；
- 按 `AGENTS.md` 未运行测试、构建或语法检查，Public Release 继续为 `NOT_READY`。详见 [backup symlink guard](docs/evals/reports/2026-09-03-codex-offeru-public-release-backup-symlink-guard.md)。

## Completed RELEASE_ENDPOINT_ERROR_REDACTION_57 slice

- public-release endpoint guard 拒绝错误端口、凭据、路径和协议时不再回显原始 URL；异常文本不会把 `8080`、密码或外部主机写入 CI/诊断输出；
- 新增回归契约检查 endpoint override 与非白名单 URL 的错误信息保持无回显，同时保留 fail-closed 行为；
- OfferU 网页入口仍只认 `http://127.0.0.1:7410`，后端仍只认 `http://127.0.0.1:8765`；本轮没有启动 Edge、没有访问 8080、没有打开浏览器，也没有修改真实用户数据库；
- 按 `AGENTS.md` 未运行测试、构建或语法检查，故该安全切片不提升 Security/Public Release Gate，仍保持 `NOT_READY`。

## Completed GMAIL_AUTH_NAVIGATION_GUARD_58 slice

- Gmail OAuth 前端跳转现在只接受无凭据、无 fragment、无显式端口的 HTTPS `accounts.google.com/o/oauth2/v2/auth` 地址；`8080`、本地网页端口、HTTP 和任意其它地址在跳转前直接拒绝；
- 用户仍需主动勾选只读邮箱授权并点击授权，正常 Google OAuth 路径不变；错误地址只显示固定提示，不创建或导航到错误浏览器窗口；
- 新增 release architecture contract 覆盖该 allowlist。按 `AGENTS.md` 未运行测试、构建、语法检查或浏览器，本轮没有启动 Edge、没有访问 8080、没有修改真实用户数据库；Security/Public Release 继续为 `NOT_READY`。

## Completed GMAIL_CALLBACK_PORT_GUARD_59 slice

- Gmail OAuth 的本地 callback 现在固定为 `http://127.0.0.1:8765/api/email/callback`；空配置不再从请求 Host 推导，旧的 `8080/8000/7410` 本地回调会在生成授权链接前以 503 fail-closed；同一校验也下沉到 `email_sync`，Agent/CLI/MCP 直接调用 Operation 时不能绕过；
- 仍允许用户明确配置无凭据、无 query/fragment 的 HTTPS callback；HTTP 仅允许本机 8765 callback，并统一归一化到 127.0.0.1；
- `GMAIL_REDIRECT_URI` 错误不会回显原始地址。相关 architecture contract 已落盘但未执行；本轮没有启动 Edge、没有访问 8080、没有修改真实用户数据库，Public Release 仍为 `NOT_READY`。
