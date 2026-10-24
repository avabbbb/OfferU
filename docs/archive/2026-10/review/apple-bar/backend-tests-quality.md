> 已归档（2026-10-21）：本文不再是当前权威，只用于考古。当前文档：09-quality-and-release.md（位于 docs/）。2026-09-19 对抗评审的历史证据，评分与缺陷只属于当时代码。

# Backend Tests & E2E 质量对抗评审 — 2026-09-19

## 结论（对照 Apple 上线水准一句话定性）

测试资产数量可观（67 个测试文件、621 个 test 函数、~17.5k 行 + 26 个 e2e 脚本），其中 `test_reliability.py`、`test_security_canary.py`、`test_public_release_smoke.py` 是教科书级的行为/并发/身份校验测试；**但存在两处不能上线的硬伤：约 7 个测试文件直接读写用户真实数据库 `backend/djm.db`（118MB 生产数据、零清理），以及整个 FastAPI 路由层（~12.5k 行、22 个模块）几乎零 HTTP 层单测覆盖**。另有一批 `inspect.getsource` / `read_text` 源码字符串断言把测试变成了「重构即红」的实现镜像，和数个遗留的 localhost 硬编码调试脚本混在 e2e 目录里。整体离 Apple 水准的「测试即可信发布门禁」还有明确差距。

## 覆盖矩阵

统计口径：静态扫描 `backend/tests/` + `backend/scripts/e2e/` 中对 `app.services.*` 的 import/patch 引用（含 `from app.services import a, b`、`app.services.mod` patch 字符串、job_sources 子包）。Route 层单独统计。

### 服务模块覆盖（82 个顶层 services + job_sources 子包）

| 领域 | 模块数 | 零直接覆盖 | 仅 1 个测试文件 |
|---|---|---|---|
| resume | 11 | `pdf_exporter`, `resume_builder`, `resume_export`, `resume_optimize_support` | `resume_drafts`, `resume_optimization`, `resume_versions`, `resume_workspace` |
| jobs/ingest | 13 | `campus_detector`, `job_ingest`(经 `app.ops` 间接覆盖), `job_sources.adapters.local`, `job_sources.boss_progress`, `job_sources.boss_signals` | `batch_job_evaluations`, `job_projection`, `job_sources.adapters.boss/normalize/protocol/router` |
| agent/bridge | 18 | `agent_run_coordinator`, `optimize_agent_operations` | `agent_conformance`, `agent_connection`, `agent_files`, `agent_integration`, `agent_runtime`, `agent_skill_projections`, `main_agent_guardian`, `pi_agent_worker`, `profile_agent_operations` |
| profile/memory | 22 | `context_projector`, `memory_consolidation`, `memory_distiller`, `profile_archive`, `profile_schema` | `application_followups`, `application_workspace`, `artifact_workspace`, `career_evolution`, `work_sources` |
| ops/自动化 | 18 | `local_data_reset`, `scraper_operations` (+`optimize_agent_operations`) | `harness_operations`, `legacy_operations`, `startup_recovery` |
| config/秘钥 | 12 | `field_mapper`, `option_matcher`, `profile_schema`, `semantic_search`, `template_seeder`, `web_search` | `demo_data`, `directory_skills`, `runtime_credentials` |
| email | 1 (`email_sync`) | — | 覆盖良好（`test_email_incremental_sync` 633 行 + 隔离内存 DB） |
| interview | 3 | — | `interview_scoring` 单文件 |

### Route 层覆盖（22 个 `app/routes/*.py`，合计 ~12,558 行）

- 直接 `import app.routes.*` 的测试文件：**0 个**（`test_pi_agent_host.py`/`test_role_intelligence.py`/`test_security_canary.py` 只在函数体内 `from app.main import app` / `from app.routes.main_agent import …` 共 3 处）。
- `TestClient`/`httpx` 打 app 的测试：**0 个**。httpx 仅用于 `MockTransport` 打 LLM 桩。
- 最大且零 HTTP 层覆盖：`profile.py` 2813 行、`resume.py` 2471 行、`optimize.py` 1206 行、`main_agent.py` 1074 行、`config.py` 978 行、`jobs.py` 632 行、`email.py` 322 行。请求校验、HTTPException→status 映射、SSE 头、CORS/鉴权边界全部只能靠浏览器 E2E 兜底。

## Findings

| ID | Sev | Type | 位置 | 证据 | 问题 | 建议修法 |
|---|---|---|---|---|---|---|
| T1 | P0 | bug/security | `tests/test_slice_01.py:31,73`, `test_job_ingest.py:30-32`, `test_career_memory.py:20,126+`, `test_work_source_memory.py:19,140+`, `test_resume_optimization.py:22,255+`, `test_agent_control_plane.py:17,88+`, `tests/agent_bridge/test_slice1_server.py` | 全部 `from app.database import async_session, init_db` 且 **不 patch session、不设 `OFFERU_DATA_DIR`/`DATABASE_URL`、0 处 delete**（`grep -c "db.delete\|DELETE"` = 0）；`app/runtime_paths.py:66` → `backend/djm.db`（118MB 真实用户库，9/18 还在写）；`test_slice_01.py:56-125` 直接 `import_jd` 造 Job、`db.add(Resume/ApplicationAttempt/Profile)` | 每次跑测试都往用户真实库里插入 `secrets.token_hex` 命名的假岗位/简历/档案且永不清理；`import_jd` 走 md5 去重会污染 `Job.raw_description_hash` 去重空间；`djm.db` 已被污染（同目录还有 69MB `offeru.db` 疑为历次误写的 decoy 库）；同时测试依赖真实 schema 状态，CI 与本地结果不可复现 | conftest 在 import 早期 `os.environ["OFFERU_DATA_DIR"]=H:\tmp\offeru\pytest-data`（须在 `app.config` import 前），或给这 7 个文件统一加 `patch.object(app.database,'async_session',isolated_session)` fixture；已有正确范式可抄：`test_email_incremental_sync.py:135-146`（内存 engine+patch）、`test_role_intelligence.py:284-329`（子进程 `DATABASE_URL` env） |
| T2 | P1 | design | 全部 `app/routes/*.py`（22 文件 12.5k 行） | `grep "app\.routes\." tests/ scripts/e2e/` 命中 0 个文件；`grep TestClient` 0 命中；`app/routes/email.py`、`resume.py` 等只在浏览器 E2E 里间接触达 | HTTP 层完全无单测：pydantic 请求校验错误→422、HTTPException detail→body、SSE content-type/事件帧格式、404/409 语义、`/api/health` payload（`is_offeru_health_payload` 只测了 payload 函数本身没测真端点）都无回归网；一次 route 签名重构（如 `optimize.py` 里 `_llm_rewrite_sections` 的 tier 参数）只能靠源码 grep 测试「发现」 | 用 `httpx.ASGITransport`+`AsyncClient`（或 `TestClient`）对每个 route 模块补「请求→响应」契约测试，优先 `config.py`（vault_status 红线暴露面）、`optimize.py`（SSE）、`jobs.py`（分页 envelope）、`email.py`（OAuth redirect）；不必全量，先覆盖 envelope/status/error 三类 |
| T3 | P1 | bug | `scripts/e2e/test_e2e_optimize.py:4`, `test_optimize_e2e.py:22`, `test_llm_rewrite.py:9`, `test_profile_chat.py:9`, `test_extension_ingest_contract.py:14`, `test_extension_to_webui_link.py:16`, `test_job_test_data_filter.py:14` | `BASE = "http://127.0.0.1:8766"` / `"http://localhost:8766"` 硬编码，未走 `release_endpoints.py`；`test_release_browser_endpoint_guard.py:143-162` 的 parametrize 名单只含 5 个 `test_public_release_*` 文件，这 7 个脚本游离在 fail-closed 之外 | 违反 AGENTS.md 第 31 行红线的精神（fail-closed 解析器对 test_public_release_* 强制，但这些脚本同为「打正在运行的后端」却裸连）；`localhost` 在 Windows 可能解析 `::1` 而服务只绑 `127.0.0.1` → 假阴性；且它们直接对真实运行实例发 POST（`test_e2e_optimize.py` 打 `job_ids:[1]`、`test_profile_chat.py` 调真实 LLM），既污染数据又烧 API 额度 | 把这 7 个脚本要么改走 `release_api_url()`+`assert_release_backend_ready()`，要么移出 `scripts/e2e/` 到 `scripts/dev/` 并去掉 `test_` 前缀（防 pytest 误收集/防被当门禁）；顺手把 guard 测试的 parametrize 改为扫描 `scripts/e2e/test_*.py` 全集 |
| T4 | P1 | design | `tests/test_privacy_hygiene.py:103-108`, `tests/test_profile_agent_memory_gate.py:39-59`, `tests/test_agent_control_plane.py:49-69`, `tests/test_agent_runtime_convergence.py:534`, `scripts/e2e/test_optimize_chain_config.py:11-16`, `scripts/e2e/test_cleanup_contract.py` 全文 | `inspect.getsource(fn).count("_ui_operation_outputs")==1`、`"ProfileSection(" not in source`、`assertNotIn("async_session", source)`、regex 抠 `_llm_rewrite_sections` 函数体断言 `'tier="standard"'`、grep `Sidebar.tsx` 是否含 `href:"/scraper"` | 这批测试断言的是**源码文本**而非可观察行为：重命名内部函数、把调用抽成 helper、调整字符串引号风格都会红，而真正的行为回归（绕过 fact gate、直连 DB）反而测不出。`test_cleanup_contract.py` 本质是 lint 规则，放进测试目录伪装成测试 | 架构约束类改写成真 lint（ast 规则放 `scripts/release/audit_architecture.py` 已经这么做了——这些应并进去）；行为约束类（如「apply_profile_agent_patch 不得直写 ProfileSection」）改成行为断言：patch `ProfileSection.__init__`/`session.add` 计数器验证零直写，或验证产生的 audit/operation envelope |
| T5 | P2 | bug | `tests/test_agent_integration.py:54` | `tempfile.TemporaryDirectory(dir="H:/tmp/offeru")` 硬编码 H: 盘 | conftest.py 专门建立了 `OFFERU_TEST_TEMP_ROOT`/`tempfile.tempdir` 统一临时策略，此文件用 `dir=` 绕过；在没有 H: 盘的机器（CI runner、其他开发者机）上 `TemporaryDirectory` 直接 FileNotFoundError；RELEASE_CHECKLIST 宣称「测试临时边界 PASS」但这里漏网 | 删掉 `dir=` 参数（conftest 已把 `tempfile.tempdir` 指到受控根），或改 `dir=os.environ.get("OFFERU_TEST_TEMP_ROOT")` |
| T6 | P2 | ux/doc | `backend/offeru.db`（69.5MB）+ `backend/djm.db`（118.5MB）并存 | `ls -la backend/*.db`；根 `.env` `DATABASE_URL=sqlite+aiosqlite:///./offeru.db`；AGENTS.md:28 已记录该 footgun | 测试 `os.chdir(BACKEND_DIR)` 后任何按 cwd 相对解析的 `DATABASE_URL`（若经系统 env 注入）会落 `offeru.db`；两个库都是真实体积，无人能说清哪个是「真库」——T1 的污染会分散到两个文件里更难发现 | 与 T1 同修；另外把 `backend/offeru.db` 加入「启动时检测到非默认库路径就警告」的诊断（`diagnostics` 服务已有类似检查可挂） |
| T7 | P2 | design | `tests/test_release_browser_endpoint_guard.py:119-141`, `test_release_architecture_audit.py:78-105,161,448-456` | `assert "HTTPRedirectHandler" in source`、`assert "return None" in source`、`assert 'const APP_VERSION = import.meta.env.VITE_APP_VERSION || "0.0.0"' in source`、assert docker-compose 模板字符串 | release 守门测试自身也用源码字符串断言：把 `return None` 改成等价写法就红，把 `VITE_APP_VERSION` fallback 改法就红——护门测试本身脆，会让「修 guard」比「绕过 guard」更烦 | 源码断言保留但放宽到 AST/语义级（如「opener 链中含 NoRedirect handler 类」用对象断言而非文本）；docker-compose/env 检查已有 `audit_architecture.run_audit()` 通道，重复断言删除 |
| T8 | P2 | ux | `scripts/e2e/` 无「connect coding agent / BYOK 连接」场景的浏览器或 API 级验收 | `grep -l "connect\|连接\|coding" scripts/e2e/` 仅命中 contract/migration/cleanup 文件；golden path「first-run→connect→job→resume」中 connect 环节只有重度 mock 的 `test_agent_connection.py`（`MagicMock` adapter、`AsyncMock` probe），无任何 e2e 验证「用户配好 key→连接成功→profile 可用」 | 新用户最关键的第二步（连上 AI 才能干活）在 E2E 层缺失；`test_public_release_smoke.py` 用 replay provider 绕过了真实连接 | 加一个 replay-provider 连接链 e2e：UI 设置页选 replay→保存→`/api/agent/connection` 状态→profile 页可用；不需要真 LLM，验证的是连接状态机与 UI 打通 |
| T9 | P3 | perf/ux | `tests/test_cli_ops.py:44-110`, `tests/test_pi_agent_host.py:294-308` | `expected = {…250 个 operation 名…}` 全量字面量集合断言；`paths = {getattr(route,"path","") for route in app.routes}` 断言路由注册表 | 操作注册表/路由表快照测试：加一个新 op 必须同步改测试，属于「改代码必改测试」的 pinning；但 contract 价值真实存在（防误删 op） | 保留但降级：断言「关键 op 子集 ⊆ registry」+「总数>0」而非全等；或对 OPERATIONS 做 schema 校验（每个 op 有 input_schema/handler）比枚举名字更稳 |
| T10 | P3 | design | `tests/test_llm_secret_vault.py:14-43` FakeVault vs `test_byok_directory_skills.py:152` `import_provider(api_key="sk-test-123")` | byok 测试传明文 key，仅靠「disabled 检查先于 vault 写」的顺序避免真钥匙串写入 | 顺序一旦调整（先 dehydrate 后 disabled 校验），测试会静默写真实钥匙串——AGENTS.md:76 红线就破了；当前靠实现细节兜底 [INFERENCE] | 给 `import_provider` 测试统一 patch `llm_secret_vault.dehydrate`/`credential_store` 为 fail-loud stub（调用即 raise），把「绝不碰真钥匙串」变成可失败断言 |
| T11 | P3 | doc | `tests/` 67 文件中 ~57 个用 `unittest.TestCase`/`IsolatedAsyncioTestCase`，~12 个 pytest 风格混用；`tests/evals/`、`tests/agent_bridge/`、`tests/evolve_bench/` 三个子目录 | `grep -l "unittest.TestCase"` 57 vs `def test_` 顶层函数风格；子目录各有 `__init__.py` 但 pytest 收集规则无 ini 文件 | 风格分裂本身不是错，但 `asyncio.run` 在 unittest 方法里手动驱动 vs `IsolatedAsyncioTestCase` vs pytest-asyncio 三种模式并存，新人照抄就会选错；无 pytest.ini/pyproject 声明 asyncio_mode，pytest 风格 async 测试依赖默认配置 | 定一个 `backend/pytest.ini`（或 pyproject `[tool.pytest.ini_options]`）声明 testpaths/asyncio_mode/temp 策略，把「新测试怎么写」写进 DEVELOPMENT.md 一段 |

## Top-5 修复优先级

1. **T1（P0）**：conftest 早期注入 `OFFERU_DATA_DIR`→隔离目录（必须早于 `app.config` import），并给 `test_slice_01/test_job_ingest/test_career_memory/test_work_source_memory/test_resume_optimization/test_agent_control_plane/test_slice1_server` 7 个文件补隔离；顺手清理 `backend/djm.db`/`offeru.db` 里已有 `token_hex` 命名的测试残留行。这是「跑测试毁用户数据」级别的问题。
2. **T2（P1）**：给 `config.py`、`optimize.py`、`jobs.py`、`email.py`、`resume.py` 五个 route 补 ASGITransport 契约测试（envelope/status/error 三类，每文件 3-5 个），先把 12.5k 行裸奔面积砍掉一半。
3. **T3（P1）**：7 个硬编码 localhost/127.0.0.1 的 e2e 脚本收口——或走 `release_endpoints`，或改名移出 test_ 前缀；同时把 endpoint guard 的 parametrize 改成目录扫描，让「新增 e2e 脚本绕过 guard」在 CI 立刻红。
4. **T4（P1）**：把 `inspect.getsource`/`read_text` 字符串断言分批换成行为断言或并入 `scripts/release/audit_*.py` 的 AST 通道；至少先修 `test_privacy_hygiene.py:103-108`（`.count()==1` 最脆）和 `test_optimize_chain_config.py`（regex 抠函数体）。
5. **T8+T5（P2）**：补一个 replay-provider 的「connect→profile 就绪」e2e 补齐 golden path 缺口；修 `test_agent_integration.py:54` 的 `dir="H:/tmp/offeru"` 硬编码。

## 已达标的点（简短）

- `test_reliability.py`（920 行）：隔离 engine + 真并发断言 exactly-once/recovery/soak，是全套测试里最有 Apple 味的。
- `test_security_canary.py`：canary 字符串穿透持久化层断言「落盘无 canary」——真正的行为级安全测试。
- `release_endpoints.py` + `test_release_browser_endpoint_guard.py`：fail-closed URL 解析、no-redirect opener、身份 payload 校验、「guard 先于 browser 创建」顺序断言，设计完整。
- `test_email_incremental_sync.py`：内存 engine + patch session 的正确隔离范式。
- `test_role_intelligence.py:284`：子进程 + `DATABASE_URL` env 覆盖的隔离 init 测试，可复制为通用范式。
- `test_product_claim_audit.py`：行为断言 + 反例 + 「结果不回显源码文本」细节到位。
- conftest.py 的 tempfile 统一策略 + C 盘 fail-closed：方向正确，只是被 T5/T1 漏网。
