# OfferU Public Release Handoff

当前 Public Release 仍为 `OFFERU_PUBLIC_RELEASE_NOT_READY`；Resume Workspace 已达到 `RESUME_WORKSPACE_BETA_READY`。后续工作继续遵守 `STATUS.md` 的验收边界，不重新扩展 Agent 或一级产品模块。

- 2026-09-03 `OPENCODE_LIVE_CAPABILITY_GUARD_71`：本机 OpenCode `1.17.11` 的 `run`/JSON CLI 探测通过，但未证明 `--pure` 具备 OfferU 所需的公开网页 host、重定向和私网地址约束；OpenCode 的 `supports_live_web_search` 已 fail-closed 为 `False`，不会被 Role Intelligence 当作 live Provider，也没有调用 `opencode web`。通用 Agent adapter 保留；本轮没有启动 Edge、创建浏览器窗口或访问 8080，详见 [report](docs/evals/reports/2026-09-03-codex-offeru-public-release-opencode-live-boundary.md)。
- 2026-09-03 `EXTENSION_ERROR_PROJECTION_72`：扩展新增统一 `safeExtensionError`，Background/Popup/Content/Page Agent/规则包/Smart Fill/HTTP control 的跨边界错误均做控制字符清理、240 字符上限和 endpoint/credential/email/phone 脱敏；bootstrap console 不再记录原始异常对象，Smart Fill opt-in debug console 只记录安全遥测字段。新增 helper 单元测试与 architecture contract，正式 WXT bundle、typecheck/test、远程 runner 尚未执行；没有启动 Edge、创建浏览器窗口或访问 8080，详见 [report](docs/evals/reports/2026-09-03-codex-offeru-public-release-extension-error-projection.md)。
- 2026-09-03 `FRONTEND_ERROR_PROJECTION_73`：前端新增统一 500 字符 `safeClientErrorMessage`，主 API/SWR、直接 fetch、SSE、Showcase LLM 与核心页面错误均经过 endpoint/credential/email/phone 脱敏；hooks 的后端 `detail/error` 也不再原文抛出，SSE/Agent/Chat 错误投影保持有界。新增 release architecture contract；前端 typecheck/build、测试、正式产物和浏览器验收尚未执行；没有启动 Edge、创建浏览器窗口或访问 8080，详见 [report](docs/evals/reports/2026-09-03-codex-offeru-public-release-frontend-error-projection.md)。
- 2026-09-03 `PUBLIC_WEB_HTTP_BOUNDARY_74`：后端公开网页检索兜底链统一 `trust_env=False` / `follow_redirects=False`；公开页面读取改为最多 3 跳手动重定向，并逐跳校验公网 URL、受限平台黑名单和 DNS 解析地址，避免系统代理或重定向/解析把研究带到错误本地服务。新增 release architecture contract；真实 Provider/network matrix、测试和构建尚未执行；没有启动 Edge、创建浏览器窗口或访问 8080，详见 [report](docs/evals/reports/2026-09-03-codex-offeru-public-release-public-web-http-boundary.md)。
- 2026-09-03 `CONTROLLED_BACKEND_RESEARCH_FALLBACK_75`：`run_backend_research` 已接入 `start_job_research` 的统一 `JobResearchRun` 生命周期；无 live-capable CLI 时只有在搜索 API 与 LLM 均已配置才选择明确的 `backend_search`，并复用同一事实门、报告、dossier、memory observation、失败、取消和恢复。研究任务关闭 ddgs 非受控路径，不把 HTTP fallback 伪装成 Agent Runtime；新增页数上限、Operation input 和 architecture contract。测试、构建、Provider/network matrix 尚未执行；没有打开 Edge、浏览器或访问 8080，详见 [report](docs/evals/reports/2026-09-03-codex-offeru-public-release-backend-research-fallback.md)。
- 2026-09-03 `JOB_SEARCH_PLUGIN_HTTP_BOUNDARY_76`：公开 `job-search` Capability 现在通过独立 urllib opener 直接请求固定 Arbeitnow API，禁用系统代理并拒绝重定向，避免公开数据源路径误入本地网页/`8080` 或其它未授权地址。新增 release architecture contract；插件、测试、构建和真实网络 Provider 尚未执行，没有打开 Edge、创建浏览器窗口或访问 8080，详见 [report](docs/evals/reports/2026-09-03-codex-offeru-public-release-job-search-plugin-http-boundary.md)。
- 2026-09-03 `JOB_SEARCH_SOURCE_URL_GUARD_77`：`job-search` Capability 过滤公开源返回的本机/私有 IP、凭据和非 HTTP(S) 岗位链接，覆盖 `jobs.search`、`jobs.get` 的结构化文档；新增单元测试与 architecture contract，尚未执行。没有打开 Edge、创建浏览器窗口或访问 8080，详见 [report](docs/evals/reports/2026-09-03-codex-offeru-public-release-job-search-plugin-http-boundary.md)。
- 2026-09-03 `PUBLIC_WEB_TRANSPORT_AUDIT_78`：`audit_architecture.py` 新增公开网页传输边界审计，覆盖后端 `web_search` 与 `job-search` Capability 的 direct HTTP、redirect/DNS/本机 URL guard，并对默认 `urlopen` 回归 fail-closed。新增 contract 尚未执行；没有打开 Edge、创建浏览器窗口或访问 8080。
- 2026-09-03 `ROLE_INTELLIGENCE_BACKEND_SEARCH_79`：Role Intelligence 新增受控 `backend_search` adapter；`auto` 先选 live-capable CLI，只有自动选择失败且搜索 API/LLM 配置完整时才回退，显式 runtime 仍 fail-closed。adapter 复用 `web_search`/`fetch_readable` 的直连、bounded redirect、public DNS、restricted-domain 边界，并要求 comparator URL 必须来自已提供页面；结果继续经过统一 schema、dedupe/cohort/Delta 和 CareerTask 投影。保存岗位自动任务与“实时研究”入口改为 `auto`，`live_backend` 在 UI 显示为“受控后端检索”。本轮未运行测试、构建、Provider/network 或浏览器，没有启动 Edge、创建浏览器窗口或访问 8080，详见 [report](docs/evals/reports/2026-09-03-codex-offeru-public-release-role-intelligence-backend-search.md)。

## 稳定主链

```text
TypeScript UI
→ Python FastAPI Career Runtime
→ Operation Registry
→ Replay / Fixture / Pi / Codex Adapter
```

Today、Pipeline、Job Detail 和 Profile 读取同一份职业状态；Memory 是 Profile 更新机制，Agent 不拥有 Career Truth。

Resume 主链：

```text
Career Evidence → Master / source Resume → Job Tailored Workspace
→ Proposal Diff → Manual / AI Review → ResumeVersion
→ Application Packet → Today / Pipeline
```

Workspace 通过 `get_resume_workspace`、`ensure_resume_workspace` 和 `review_resume_proposal_item` 进入 Operation Registry；`workspace_snapshot_hash` 阻止 stale Proposal 覆盖手工修改。PDF 打印页使用 HashRouter 地址，并由 Python Playwright 的 managed Chromium 无头路径渲染。

## 本地复现与诊断

```powershell
Set-Location <OfferU>
backend\.venv312\Scripts\python.exe backend\run_server.py
npm --prefix frontend run dev
```

打开 `http://127.0.0.1:7410`，第一次使用选择快速建档，再保存岗位并选择“本地准备（推荐）”。`http://127.0.0.1:8080` 不是 OfferU 网页地址，不要打开它；Vite 已显式设置 `server.open=false`，不会自动唤起 Edge 或系统默认浏览器。若仓库根目录存在历史 `OfferU.exe`，也不要双击：它是仍内嵌旧 `8000/3300` 入口的 `0.1.0` 二进制，不属于当前启动链。浏览器验收只使用仓库内的 release E2E 脚本、隔离数据库和 Playwright managed Chromium 无头模式；不要运行历史 `C:\temp` 临时脚本。Settings 生成的 Diagnostic Bundle 现在还会包含最近的脱敏 durable CareerTask/AutomationEvent/RoleBenchmarkRun/JobResearchRun failure 摘要，以便重启后通过 `error_id` 定位问题。

## 数据与进程边界

- `backend\offeru.db` 是用户本地数据库，任何验收请使用新的 `.tmp\internal-beta-*` SQLite 文件。
- 本轮隔离后端应在交付前停止；不要把临时 `DATABASE_URL` 留给用户环境。
- 备份、恢复和隐私说明见 `QUICKSTART.md`；本地数据导出入口在 Settings。
- Codex、Gmail、DSH 失败只能保留为明确的 blocked/optional 状态，不能伪造成功或阻塞 Replay 核心路径。

## 本阶段验证

- 前端三栏 Workspace 已覆盖结构化编辑、实时预览、Proposal Before/After、逐条审核、模板控制、版本历史、撤销、自动保存和 PDF 导出。
- 隔离数据库浏览器路径已验证 Job Detail → Workspace、Accept/Reject、手动修改、stale 阻断、V2、Application Packet 和 PDF。
- Fact Gate blocked Proposal 的单条/全部接受按钮会被禁用；中文/英文混排 PDF 已渲染检查无裁切。
- 后端全量回归最新记录为 `362 passed, 19 warnings, 1 subtests passed in 329.19s`，前端 typecheck/build 通过；正常 lifespan 启动完成。
- Durable failure diagnostics 已加入持久化 CareerTask/AutomationEvent/RoleBenchmarkRun/JobResearchRun 摘要与脱敏契约；本轮新增契约尚未执行。
- `.env.example` 与 Docker Compose 已移除固定公开凭据：容器启动必须显式提供唯一 `DB_PASSWORD` 与 `SECRET_KEY`，缺失时 fail-closed；对应架构 contract 尚未执行。
- Resume 导出双渲染器失败时现在使用统一脱敏错误边界，不把 Playwright/WeasyPrint 原始异常直接返回用户；对应 architecture contract 尚未执行。
- Docker PostgreSQL 启动不再误入 SQLite staged-restore：`main.py` 对外部数据库明确跳过本地恢复并继续启动，未把该步骤报告为已应用；对应 architecture contract/Docker runner 尚未执行。
- LLM 连接与模型列表探测现在显式绕过系统代理、禁止 HTTP 重定向，并对上游错误、异常和配置 URL 做 bounded redaction；`127.0.0.1:8080` 仍仅作为可选模型 API，不是网页入口。对应 contract、Provider/network 和远程 runner 尚未执行。
- Provider `config.json` 写入现在统一使用同目录临时文件和 `os.replace` 原子替换，避免进程中断留下半个 JSON；对应测试、配置恢复和远程 runner 尚未执行。
- Codex Bridge 未预期异常、Gmail 回调配置错误和 Resume Playwright 缺失错误现在经过 `safe_error_message`；对应 contract、全量异常矩阵和远程 runner 尚未执行。
- 扩展 `HttpOfferUControl` 的非 2xx 错误现在只保留 HTTP 状态码和可选 `X-OfferU-Error-Id`，不再把后端响应正文复制进扩展错误；单元测试与 architecture contract 已落盘但尚未执行。正式 WXT bundle 仍需由构建链刷新；本轮没有打开 Edge、没有访问 8080。
- 本地模型自动发现保存配置失败时现在使用 `safe_error_message`，不再直接回显原始异常；新增 release architecture contract，尚未执行测试/构建。`8080` 仍仅是可选 llama.cpp Provider 端点，不是网页；本轮没有打开 Edge 或访问 8080。
- Agent Runtime 的 Codex/Claude/非 hosted worker 进程错误现在经过 bounded redaction，stderr 上限收紧为 4,000 字符，退出码仍保留；新增 contract 尚未执行。未启动 Edge、未访问 8080。
- Capability Plugin stderr 现在在失败和成功诊断返回两侧都经过 `redact_sensitive_text` 与 2,000 字符上限；新增 contract 尚未执行。未启动 Edge、未访问 8080。
- 扩展 Smart Fill 共享 HTTP 请求的非 2xx 错误现在只保留状态码和可选错误 ID，不读取后端/模型响应正文；新增 contract 尚未执行。正式 WXT bundle 仍需构建链刷新；未启动 Edge、未访问 8080。
- 共享 `security_redaction` 新增独立 `sk/rk/pk`、GitHub token、Google API key 的脱敏；新增 security regression 与 architecture contract 尚未执行。未启动 Edge、未访问 8080。
- Pi Agent Guardian 失败的持久化/实时事件现在共用 `safe_error_message`，不再使用原始 `str(guardian_error)`；新增 contract 尚未执行。未启动 Edge、未访问 8080。
- 前端主 API/SWR transport 错误与校徽解析错误不再回显原始网络文本/响应正文，只保留固定提示、状态和错误 ID；新增 contract 尚未执行。未启动 Edge、未访问 8080。
- 前端主 API、SSE、SWR 和统一请求层现在都拒绝 HTTP 重定向，避免错误服务把本地请求带到 8080/外部地址；新增 contract 尚未执行。未启动 Edge、未访问 8080。
- Skill Pipeline 的失败结果现在通过共享 `safe_error_message` 才进入 Agent 聚合结果，不再直接传播原始 `str(e)`；新增 release architecture contract 尚未执行。本轮没有启动 Edge、打开浏览器或访问 8080，网页仍只使用 7410，后端仍只使用 8765。
- Role Intelligence 读取历史失败记录时现在二次使用 `safe_error_message`，研究驱动器的 `TASK_EXC` 也经过同一脱敏边界，避免旧 `run.error` 或 CLI 异常原文重新进入 API/输出；新增 contract 尚未执行。本轮没有启动 Edge、打开浏览器或访问 8080。
- `v*` tag 的 Windows 打包和 Draft Release 现在都会在进入发布步骤前执行 `audit_release_readiness.py --require-ready`；未达到 Public Release Ready 会 fail closed，不会创建公开 Draft Release。本轮未在远程 runner 验证。
- previous-release migration 已固化为 `backend/scripts/e2e/test_public_release_migration.py`：它只使用临时 schema v1 数据库、自己拥有的 8765 后端子进程和 Playwright managed Chromium 无头路径；它拒绝复用已有 8765 进程，不能使用 Edge/可见浏览器，也不能把 8080 当网页。GitHub 的 `migration-browser-smoke` job 仅启动 7410 前端并由脚本负责隔离后端；本轮未执行该 E2E。
- Windows `desktop-installed-smoke` 会从 `desktop-package` artifact 安装 NSIS 包到 runner 临时目录，启动已安装的 OfferU 并只用 loopback HTTP 检查 8765 sidecar，随后停止自身进程并卸载；它不启动浏览器、不访问 8080，本轮未执行远程 runner。
- Windows installed smoke 现在还会在启动前拒绝已被其它进程占用的 8765，并在健康检查后确认端口 owner 的可执行文件来自本次临时安装目录；扩展打开 7410 前也会先做 2 秒健康检查，服务不可用时不创建浏览器标签。相关扩展构建与远程 runner 尚未执行。
- Tauri `wait_for_python_backend` 的 loopback health client 已显式 `no_proxy()`，代理配置不会再影响 8765 sidecar readiness；Rust contract/build 仍需由后续验收执行。
- CI `critical-browser-repeatability` 已配置 10 个彼此隔离的 Linux runner，重复执行 new-user critical browser smoke；只使用 `127.0.0.1:7410`、`127.0.0.1:8765` 和 Playwright managed Chromium 无头模式，不启动 Edge、不访问 8080；本轮未执行远程 runner。
- 三个 CI 浏览器 job 会在失败产物上传前审计各自的 trace、screenshot、前后端日志；审计发现 secret/canary 会 fail closed。审计目录限定在 runner 临时目录，远程 runner 尚未执行。
- Windows release artifact 在上传前、installed smoke 下载后、Draft Release 下载后都会运行 `backend/scripts/release/verify_release_artifacts.py`；它只接受 artifact 根目录内的 NSIS/MSI 文件，并交叉核对 manifest、SHA-256、bytes、version/target、installer 集合和 tag 的 `signed=true`。本轮只完成配置与 contract tests，未运行测试或远程 tag runner，不能把 R91/R92 记为 PASS。
- backend CI 与 Windows 打包前新增 `backend/scripts/release/audit_version_consistency.py`，核对 frontend、Tauri、Rust 和 backend 的版本声明；匹配/漂移/缺失 contract tests 已落盘，但本轮未运行测试或远程 runner，不把 R87/R92 的远程证据提前标为 PASS。
- 下载后的 Windows artifact 在安装 smoke 和 Draft Release 阶段还会再次执行 `audit_artifacts.py --json`；与上传前扫描及 manifest/hash 校验组成三段式发布边界。本轮未运行远程 runner，R51/R52/R91/R92 仍不提升为 PASS。
- `audit_artifacts.py` 现在拒绝 symlink 作为 release 审计根，并对目录内符号链接 fail-closed，不跟随扫描根目录外的目标；新增隔离 contract 尚未执行，不能把该静态控制当成完整 artifact/PII 安全 Gate。
- `verify_release_artifacts.py` 现在也拒绝 symlink release root 和 `artifacts.json`、`SHA256SUMS.txt`、`version.json` 元数据链接；它在解析发布清单前 fail-closed，不会把目录外文件当成已验证 artifact。新增 contract 尚未执行，不能把该静态控制当成远程发布证据。
- public-release 的 smoke、empty-state、Interview、worker soak、migration 五个 E2E 入口现在统一使用 `backend/scripts/e2e/release_endpoints.py`；它们只解析固定的 `127.0.0.1:7410`/`127.0.0.1:8765`，误指向 `8080` 或其它端口会在任何网络请求、Playwright 导航前失败；architecture audit 也会拒绝直接读取这两个环境变量；新增 endpoint contract 尚未执行。
- `extension/scripts/sync-root-build.mjs` 在同步根目录前还会检查生成 popup 的 7410 readiness guard；缺少 `7410`、AbortController 或服务未启动提示就 fail-closed，避免旧 bundle 恢复错误网页入口；相关 build/contract 尚未执行。
- `audit_artifacts.py` 对文本型诊断/日志/配置/说明文件增加 value-free email/phone findings，二进制 installer/sidecar 不套用文本 PII 规则；新增 artifact PII contract 尚未执行，R51/R53/R58/R91/R92 仍不能据此标为 PASS。
- `LOCAL_ENTRY_DOCTOR_BOUNDARY_42` 已把 Doctor 的前后端检查收紧为固定 `127.0.0.1:7410` 与 `127.0.0.1:8765/api/health`；前端不可达、后端不可达、健康身份错误或误用 8080 都会阻断 `CORE_READY`，且错误 URL credentials 不会回显。扩展网页打开/检测共用 7410 有界探测，不再用 `no-cors` 宽松判定。Tauri dev URL 与 `backend/.env` CORS 已统一；本轮新增 contract 尚未执行。
- `TAURI_HEALTH_IDENTITY_43` 又收紧桌面壳的 sidecar readiness：Tauri 现在解析 8765 health JSON，并同时要求 HTTP 成功、`status=ok`、`service=OfferU`、`runtime=python`；不再接受仅包含 `runtime=python` 的错误服务响应。Tauri security contract 已同步固定 dev URL 为 `127.0.0.1:7410`，Rust contract/build 尚未执行。
- 本地入口静态审计现同时扫描 Tauri `tauri.conf.json`、桌面 `src/lib.rs`、CLI Doctor 和简历用户 URL 代码，旧 8080/8000/3300 等网页端口重新出现时会 fail-closed；新增范围 contract 尚未执行。
- Resume PDF print/share URL 已固定为 `http://127.0.0.1:7410`，不再从 `FRONTEND_BASE_URL` 继承错误模型端口；相关 contract/PDF 验收尚未执行。
- Email OAuth callback 的本地前端重定向也固定为 `http://127.0.0.1:7410/email`，不再依赖 CORS origin 顺序；真实 OAuth 仍是用户主动的外部授权，尚未执行。
- CI 本地服务等待与 Windows installed-app smoke 现在同样严格核对 `status=ok`、`service=OfferU`、`runtime=python`，避免错误的 8765 服务造成假通过；远程 runner 尚未执行。
- public-release worker soak 与 migration 的 API 健康等待现在复用 `is_offeru_health_payload`，错误服务不会被继续用于 E2E；新增 contract/runner 尚未执行。
- CLI Doctor 的 7410/8765 固定回环探测现在显式绕过系统代理，与 Tauri `no_proxy()` 规则一致；本机 runtime Doctor 已通过，相关 contract/打包/远程回归尚未执行。
- 2026-09-03 已实际执行 `.venv312\\Scripts\\python.exe -m app.cli doctor --pretty`：7410 前端、8765 OfferU/python health、数据库 integrity/FK 和 Replay Provider 均通过，本机 `release_readiness=CORE_READY`；这次只读复核不启动 Edge、不打开浏览器、不访问 8080，也不替代 Rust/打包/远程/签名/真实 Provider 验收。
- Doctor 随后补上 `runtime=python` 的严格身份校验；错误 runtime 不会因 `status/service` 看似正确而被接受。新增回归契约尚未执行。
- 发布 E2E 的 migration/worker/CI loopback 等待也不再继承系统代理；repeatability 后端等待同步验证 OfferU/python health。远程 runner 与新增 contract 尚未执行。
- release opener 现有第二层固定 URL 白名单，只允许 7410 根页和 8765 health，误传 8080 会在网络调用前拒绝；对应 contract/audit 尚未执行。
- 本地健康探测还统一禁止 HTTP 重定向，避免 7410/8765 被错误服务转发到 8080/外部地址；对应 contract、Rust 构建和远程 runner 尚未执行。
- 前端 BackendReadyGate 也要求完整 OfferU/python health identity，不再只检查 `runtime=python`；现在使用 45 秒有界重试，后端未在 `127.0.0.1:8765` 就绪时显示可读错误和“重新检查”，而不是无限 loading。前端/扩展网页探测拒绝重定向，扩展后端 Adapter 也拒绝错误 health identity；前端非本机 API 配置 fail-closed。相关 typecheck/build、扩展构建与 contract 尚未重跑。
- CLI Doctor 新增 `doctor --require-ready` fail-closed 退出模式；Windows installed-app smoke 的 8765 health probe 也不跟随重定向。它们用于发布/安装诊断，不会打开浏览器或访问 8080；远程 runner、构建和 contract 尚未重跑。
- 恢复路径新增 sidecar 回滚保护：SQLite `-wal/-shm` 移动中途失败会回滚已移动的 sidecar；隔离故障测试已落盘但尚未执行，不能将 R44/R46 的历史证据升级为当前 PASS。
- RustSec 当前 advisory fetch 已成功：`cargo audit` 扫描 441 个 Cargo.lock 依赖为 0 known vulnerabilities，但 `cargo audit --deny unsound` 被 `glib 0.18.5 / RUSTSEC-2024-0429` 阻塞，另有 16 条 unmaintained warnings；`.github/workflows/build.yml` 已加入严格审计，tag release 依赖该 job，远程 runner 尚未验证。不要用默认 audit 的 exit 0 掩盖 unsound finding。
- Settings 本地数据安全卡新增隐私卫生投影：只显示历史旧邮件正文的记录数/字符数，清理必须由用户输入“清理旧正文”并经 `scrub_legacy_email_notification_bodies` Operation；3 条真实历史正文未被自动读取或删除。合成邮箱测试数据现在由独立的“清理合成邮箱”确认入口调用 `purge_synthetic_email_test_data`，不与岗位 Demo Reset 混用。
- Durable Provider/CareerTask/AutomationEvent/Hosted Executor 错误现在在写入和 projection 两侧都使用 credential/邮箱/电话脱敏；Hosted Executor Provider event payload 也在两侧处理直接 PII，普通职业 payload 仍维持 secret-only redaction。新增 contract 尚未执行，详见 [durable error redaction](docs/evals/reports/2026-09-02-codex-offeru-public-release-durable-error-redaction.md)。
- `backend/scripts/e2e/test_public_release_failure_recovery.py` 已加入跨进程 auth/timeout/restart recovery 矩阵，使用隔离 SQLite、确定性 fault injection 和 Replay；CI 的 `reliability-failure-recovery` job 已接入，但本轮没有执行脚本或远程 runner，不能把模拟故障结果当成 live Provider PASS。
- Codex OAuth、Gmail、DSH 和 live research 仍是外部/实验性能力，不阻塞本地 Resume Workspace。
- 2026-09-03 备份归档在校验、stage restore 和启动恢复的哈希读取前拒绝符号链接；扩展 WXT 根目录同步同时要求 popup 的 7410 readiness marker 与 background 的 8765 OfferU/Python health/redirect marker。该静态切片未运行测试或构建，现有 `.output` 仍需用户执行正式扩展构建后再验证；本轮没有打开 Edge、没有访问 8080。
- 2026-09-03 Tauri dev/release health 现在还校验 build mode 与 package version，避免桌面壳误接入旧 8765 服务；Rust build、目标平台安装包和远程 runner 尚未重跑。本轮没有启动 Tauri/Edge、没有访问 8080。
- 2026-09-03 前端 BackendReadyGate 校验当前 package version，扩展 7410 网页 probe 还读取正文确认 OfferU 标识后才允许用户主动打开 tab；正式扩展构建、前端构建和运行验收尚未重跑。本轮没有启动 Edge、没有访问 8080。
- 2026-09-03 扩展更新下载 URL 现在只接受无凭据、无显式端口的 HTTPS 外部地址，拒绝本地/回环/HTTP/无效地址后不创建浏览器标签；WXT 同步脚本会阻止缺少该保护的旧 popup。正式扩展构建与动态验收尚未重跑；本轮没有启动 Edge、没有访问 8080。
- 2026-09-03 Data Safety 又增加受管目录父链和 pending marker 的符号链接防护；备份/恢复遇到目录链接会在读写前拒绝，隔离契约已落盘但未按 `AGENTS.md` 执行。正式备份/恢复、安装升级与远程 runner 仍未重验；本轮没有启动 Edge、没有访问 8080。
- 2026-09-03 Windows `desktop-installed-smoke` 又要求下载 artifact 的版本与已安装 `release` sidecar health 的版本/build mode 完全匹配，并把 expected/actual identity 写入 smoke summary；health client 显式禁用代理/重定向。Linux browser/migration 等源码服务等待也验证网页正文、版本与 build mode。该流程只用 8765 loopback HTTP，`browser=none`，不访问 8080、不启动 Edge。本轮未运行安装包、测试或远程 runner，详见 `docs/evals/reports/2026-09-03-codex-offeru-public-release-installed-smoke-identity.md`。
- 2026-09-03 无效 restore marker 的隔离目录也增加 symlink 防护；目标是符号链接时取消操作在移动前失败并保留 marker，不会写到目录外。本轮未运行测试/构建，不触碰真实库、8080 或浏览器。
- 2026-09-03 release version audit 已纳入 `backend/app/main.py` 的 FastAPI health 版本，并要求它与 frontend/Tauri/Rust/CLI 一致；新增静态 drift/missing contract，未运行测试或构建，不打开 Edge、不访问 8080。详见 `docs/evals/reports/2026-09-03-codex-offeru-public-release-version-health-source.md`。
- 2026-09-03 扩展 background 的通用 fetch 已加入 `redirect: "error"`，使 WXT background marker 检查与真实源代码一致；未运行扩展构建/测试，不打开 Edge、不访问 8080。详见 `docs/evals/reports/2026-09-03-codex-offeru-public-release-no-arbitrary-update-navigation.md`。
- 2026-09-03 Doctor 现在验证 8765 的当前版本/build mode 与 7410 HTML 的 OfferU 标识，错误服务/错误网页返回 fail-closed；本轮未运行测试/构建/浏览器，不打开 Edge、不访问 8080。详见 `docs/evals/reports/2026-09-03-codex-offeru-public-release-doctor-page-identity.md`。
- 2026-09-03 previous-release migration smoke 的 health wait 现在从当前 `frontend/package.json` 读取版本，并要求 8765 返回匹配版本、`OfferU`、`python`、`local-development`；migration backend 显式设置 local build/runtime mode，避免旧服务或错误端口被当成迁移目标。本轮未运行测试/构建/浏览器，不打开 Edge、不访问 8080。详见 `docs/evals/reports/2026-09-03-codex-offeru-public-release-migration-health-identity.md`。
- 2026-09-03 100-cycle worker soak 的初始 health 也要求当前 checkout 版本和 `local-development`，避免 worker 在错误/旧 8765 服务上运行；本轮未运行测试/构建/浏览器，不打开 Edge、不访问 8080。与 migration 共用 `release_endpoints.py` 的版本身份 helper。
- 共享 E2E health predicate 还拒绝缺少版本/build mode 的“半健康”响应；相关 contract 尚未执行，不能替代远程 runner 证据。
- 2026-09-03 扩展 `HttpOfferUControl.probe()` 也要求非空版本和 `local-development/release` build mode，部分 health payload 不再被判为 ready；扩展测试/构建和远程 runner 尚未执行。
- 2026-09-03 public-release endpoint guard 的拒绝错误改为固定无回显文本；错误端口、凭据、路径和外部主机不会进入 CI/诊断异常消息，相关回归契约已落盘但未执行。网页仍只认 7410、API 仍只认 8765，8080 不是网页入口；本轮没有打开 Edge 或浏览器。
- 2026-09-03 Gmail OAuth 前端跳转新增严格 Google OAuth URL allowlist；后端返回异常地址时不会导航到 `8080`/本地错误端口/任意外部地址，仍保留用户主动授权流程。相关 architecture contract 已落盘但未执行，正式前端 build/浏览器/真实 OAuth 仍待验证；本轮没有打开 Edge 或访问 8080。
- 2026-09-03 Gmail OAuth 本地 callback 又固定为 `http://127.0.0.1:8765/api/email/callback`；校验已下沉到 `email_sync` Domain Service，旧 `GMAIL_REDIRECT_URI` 指向 8080/其它错误本地端口时，无论 HTTP 路由还是 Agent/CLI/MCP Operation 都会 fail-closed，异常不回显原始地址。相关 contract 未执行，真实 OAuth/clean-machine 仍待验证；本轮没有打开 Edge 或访问 8080。
- 2026-09-03 扩展构建完成后的专用架构审计新增 tracked 产物检查：根目录 `extension/background.js` 必须含 8765 OfferU health/redirect 防线，`extension/popup.html` 不得直接引用 `src/popup.ts`，必须由受保护 WXT build/sync 生成 `chunks/*.js`；CI 已把检查放在扩展 build 后，当前旧/未同步 bundle 仍保持 release finding，不能加载或发布。本轮未启动 Edge、未创建浏览器窗口、未访问 8080；详见 `docs/evals/reports/2026-09-03-codex-offeru-public-release-generated-extension-guard.md`。
- 2026-09-03 前端 Studio、Optimize、Settings 模型探测和 Showcase LLM 的直接 fetch 也补上 `redirect: "error"`；当前所有已发现的前端网络路径均拒绝错误服务的重定向到 8080/外部地址。typecheck/build、真实重定向故障和远程 runner 尚未执行；本轮未启动 Edge、未创建浏览器窗口、未访问 8080。详见 `docs/evals/reports/2026-09-03-codex-offeru-public-release-frontend-direct-fetch-guard.md`。
- 2026-09-03 扩展岗位详情补全、简历图片、反馈提交和远程规则包的直接 fetch 也补上 `redirect: "error"`；扩展所有已发现网络路径均拒绝自动重定向，失败走现有错误/离线路径，不创建浏览器标签。扩展 typecheck/test/build、真实重定向故障和远程 runner 尚未执行；本轮未启动 Edge、未创建浏览器窗口、未访问 8080。详见 `docs/evals/reports/2026-09-03-codex-offeru-public-release-extension-direct-fetch-guard.md`。

## Public Release 剩余工作

按 `STATUS.md` 的最高优先级继续：处理 RustSec unsound 依赖或完成批准的安全例外、真实 live Role Intelligence Provider、完整 provider/network/restart matrix、clean-machine 与 previous-release upgrade、签名/RC/CI runner，以及历史隐私数据和公开披露决策。数据恢复优先复用 Settings 的一致性备份/重启恢复，不要重新引入新的一级模块、Automation Agent、Memory 页面或 Python → TypeScript 全量重写。
