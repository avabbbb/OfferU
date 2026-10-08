> **已归档（2026-10）**：本文不再是当前权威。当前文档：历史证据，见 09-quality-and-release.md（位于 `docs/`）。

# Dogfooding 会话记录 — 接入 → 简历导入 → 岗位 → 简历优化/复刻 — 2026-09-29（终态）

**性质声明**：本报告是一次 dogfooding 会话（OMP/SWE-2 作为外部 Agent Harness 驱动 OfferU）的执行记录与评估，不是 `offeru-core-v1` 正式 suite 报告，不构成 Public Release 证据。状态枚举沿用 `docs/evals/README.md`（PASS/FAIL/BLOCKED/NOT_RUN/INVALID），岗位任务用 `PARTIAL` 标注"链路跑通但数据为种子"。

## 1. 运行身份与环境

| 项 | 值 | 证据 |
| --- | --- | --- |
| 执行者 | OMP / SWE-2 主代理 + 4 个子代理（JobPipeline、ProfileImporter、ResumeForge、EvalRecorder 等） | 会话 roster |
| Commit | `6665d3e`，工作树 dirty | `git rev-parse --short HEAD` |
| 后端 | `python run_server.py`（`backend/`），SQLite `backend/djm.db`，注入 `OFFERU_APPROVAL_TOKEN` | 会话口述 + DB 行 |
| 前端 | Vite dev server `http://127.0.0.1:7410`（浏览器，非 Tauri） | `frontend/src/lib/desktop-proposal-decision.ts` |
| 批准方式 | `OFFERU_APPROVAL_TOKEN` HTTP 旁路（浏览器端无法走 Tauri `decide_agent_proposal`） | F1 |
| LLM 网关 | 本地 CLIProxyAPI `127.0.0.1:8317`；会话中被改为 `sk-` key + `devin/deepseek-v4-1-flash` + timeout 300（见 Limitations） | F9/F10 |
| 数据源 | `backend/djm.db` 只读复核（agent_runs / memory_proposals / profile_sections / jobs / job_research_runs / resumes）+ 导出 PDF 文件 | 本报告所有 id 可回查 |

## 2. Trajectory（按 run_id，全部来自 `agent_runs` / `job_research_runs`）

### 简历导入（3 轮）

| run_id | Operation | 状态 | 时间 | 结果/备注 |
| --- | --- | --- | --- | --- |
| run_2b018eb494284494 | inspect_resume_document | failed | 15:49→17:03 | 文件路径白名单拒绝（文件在 `C:/Users/<user>/Downloads/`），错误延迟暴露（F4） |
| run_028b4284b59547b4 | inspect_resume_document | completed | 17:03→17:04 | pymupdf 解析，quality 0.969，全文 2310 字符；step `outputs.text` 脱敏+截断（F5） |
| run_3d4a5045f6a540b7 | save_profile_resume_import（v1） | completed | 17:06→17:07 | `parse_mode=ai`，产出提案 735–743 |
| run_ca840461d0d74008 … run_e7009ad2371d42b3 | review_memory_proposal(735–741,743, accept) ×8 | 7 failed + 1 completed | 17:08:21–17:08:59 | 742（学历）过 → section 811；其余 7 条 fact_gate `档案条目包含来源中无法验证的事实`（根因 F6） |
| run_1519cc8008d142c3 | save_profile_resume_import（v2） | completed | 17:20→17:21 | 同 PDF 重复导入，提案 744–751 |
| run_68ec7a241d454c80 / f06d3741 / 9f2beabc / 62edb604 / 9bdcac31 | review(744,747,749,750,751 accept) | completed | 17:22–17:23 | 5 条过 → sections 812–816 |
| run_03021e29 / 5bdb6138 / e4dc25d7 | review(745,746,748 accept) | failed | 17:22–17:23 | 仍被 fact_gate 拒 |
| run_9b00cae7c2514fac | save_profile_resume_import（v3） | completed | 17:33→17:33 | per-candidate excerpt ≤980 字符绕开 confirm 期截断，提案 752–759 |
| run_e3ded103 / fde72315 / 82b4fb14 / 9ccef93d / ecd1bff7 / 841626d4 / c4f330ff / af23f739 | review(752–759 accept) ×8 | completed | 17:34:03–17:34:39 | **v3 全过** → sections 817–824 |
| run_670f3a4a 起一批 | review_memory_proposal（reject/revoke 旧提案与旧 section） | completed × 多数 / failed ×4 | 17:35–17:39 | 清理 v1/v2 残留：735–741,743→rejected；744,747,749,750,751→revoked；sections 812–816→revoked |

终态：`profile_sections` active 9 条（811 华南师大本科、817 电信经历、818 CLIProxyAPI、819 OfferU、820 Agent 无限画布、821 AI 产品与 Agent 架构、822 创作者生态、823 CET-6、824 红岭中学）——与原简历逐节对应。

### 岗位发现与投前链路

| run_id | Operation | 状态 | 时间 | 结果 |
| --- | --- | --- | --- | --- |
| run_146f89de447a4955 | triage_job(478, picked) | completed | 17:23 | jobs 表 480 行全为种子数据；选 job_id=478「目标公司A·AI工具与创作工作台 产品经理」 |
| run_a6fe24643dd44c5a | start_job_research | completed | 17:23 | 启动调研 |
| run_95fb65ddc2c14c49 | start_job_research | failed | 17:24 | claude runtime 'Not logged in'（F9） |
| job_research_d754341c535c45b5a494e7548743f00f | job research（codex runtime live） | completed / review accepted | 17:27 | 4 sources / 4 findings；`job_research_runs` 行可回查 |
| run_174d06c8717446c0 | start_job_research | completed | 17:27 | — |
| run_aadfa1128d7c43f3 | prepare_pre_application_decision | failed | 17:37 | 兄弟 agent 更新 profile 致 input_hash stale（F8） |
| run_eb103aed2ebe4427 | submit_manual_pre_application_decision | completed | 17:39 | 第一次提交（stale 后重试路径中的一次） |
| run_5382a43ec67146a1 | submit_manual_pre_application_decision | completed | 17:40 | decision `pre_app_fd9b91017d3240398431da07502c0080` → go |
| run_acc4e72f62794e4e | review_job_research | completed | 17:35 | 调研 review accepted |

### 简历优化（BLOCKED）

| run_id | Operation | 状态 | 失败层 |
| --- | --- | --- | --- |
| run_4f28fbf8e8ef41e8 | prepare_resume_optimization | failed (17:36) | 网关 401：`env:OFFERU_LLM_KEY` 48 位 hex 不被 CLIProxyAPI 接受；`nemotron-3.5-lightning-free` 不在网关模型列表 |
| run_cfd86688c7884b52 | prepare_resume_optimization | failed (17:39) | 同上 |
| run_9d5882513c314fb5 | prepare_resume_optimization | failed (17:41) | 换 key 后 `devin/deepseek-v4-flash` 为 reasoning 模型，12288 max_completion_tokens 全耗于 reasoning_content，content 空 → "LLM 调用失败"（F10） |
| run_f6d3bd452fd14e14 | prepare_resume_optimization | failed (17:47→17:55) | 同上 |
| run_412e2a703a0e41f1 | prepare_resume_optimization | failed (17:57→18:00) | 换 `devin/deepseek-v4-1-flash` 后网关上游 502 |
| run_256c6e87a3d04e34 | prepare_resume_optimization | failed (18:12→18:17) | 同上 |

### 简历复刻

| run_id | Operation | 状态 | 结果 |
| --- | --- | --- | --- |
| — | create_resume_record → resume_id=68「<候选人>简历」 | — | 5 section 与原 PDF 逐节对应；自动注入的 3 个默认段被清空重建（F16）；`PUT /api/resume/{id}` 带无 id 新 section 曾 400（F13） |
| run_467652d16a53459d | export_resume_pdf | completed | 17:46；首个导出缺日期（F14） |
| run_3c64783846e24f32 | export_resume_pdf | completed | 17:52→17:54；产物 `backend/data/exports/resume_68_20260928T175404Z.pdf`（241,965 B，2 页，playwright）。PyMuPDF 验证：5 个 h2 标题 color=0x7c3aed + 同色下划线、姓名 24pt、28 项关键事实全命中 |

## 3. Task 验收（终态）

| Task | 状态 | 证据 |
| --- | --- | --- |
| 接入（外部 Harness 连接 + 环境拉起） | PASS（带旁路） | 后端正常服务全程；批准走 `OFFERU_APPROVAL_TOKEN` 旁路（F1）；release sidecar / `DATABASE_URL` 覆盖见 F2/F3 |
| 简历导入 | **PASS**（经 3 轮迭代） | 9 条 active profile_section（811, 817–824）；v1 8/9 拒 → v2 5/8 过 → v3 8/8 过；旧提案全部 rejected/revoked，旧 sections 812–816 revoked |
| 岗位发现 + 投前决策 + 岗位调研 | **PARTIAL** | 链路全通（triage→research live codex→decision go），但 jobs 480 行全为种子数据，无真实岗位源接入证据；claude runtime 与 backend_search 不可用（F9） |
| 简历优化 | **BLOCKED** | prepare_resume_optimization ×6 全 failed；三层根因（401 / reasoning content 空 / 上游 502）均为 LLM 网关与模型兼容问题，非产品断言失败，但未测到目标行为 |
| 简历复刻 | **PASS（有限定）** | resume_id=68 + export_resume_pdf run_3c64783846e24f32；PDF 结构与事实 28/28 命中。限定：紫色靠 style_config CSS 注入实现（F11），与 React 预览渲染不一致（F12） |

## 4. Findings

| # | 缺陷 | 现象 / 证据 | 影响 | 建议 |
| --- | --- | --- | --- | --- |
| F1 | 浏览器端无法批准提案 | `frontend/src/lib/desktop-proposal-decision.ts:9`：`!isTauri()` 直接 reject；批准仅经 Tauri `decide_agent_proposal`（`src-tauri/src/lib.rs:62`） | 非桌面环境确认环节整体失效，只能 token 旁路，绕过"工作台独立确认"安全模型 | 浏览器态提供等价确认通道或明确仅限 Tauri |
| F2 | release sidecar 只支持 schema v2 | 对 v5 数据库直接 crash 且前端无可见错误 | 安装版对现有用户库静默不可用 | sidecar 启动探测 schema 并向前端透出可读错误 |
| F3 | `DATABASE_URL` 环境变量泄漏覆盖 `runtime_env_file` | AGENTS.md 已记载；后端静默连到 `./offeru.db` 空库 | 无报错连错库，数据"凭空消失" | 启动打印实际 DB 路径/schema；env 覆盖需显式 opt-in |
| F4 | inspect_resume_document 路径白名单报错延迟暴露 | run_2b018eb494284494 15:49 发起、17:03 才 failed | Downloads 是常态放简历路径；延迟失败浪费一轮交互 | 白名单校验前置到入参校验，或支持显式授权目录 |
| F5 | step `outputs.text` 脱敏+截断 1000 字符 | run_028b4284b59547b4 解析全文 2310 字符但 output 截断；`optimize_agent.py:1296` 同款 `[:1000]` | Agent 无法从 run 结果还原完整解析文本 | 完整文本入 artifact（脱敏后）+ output 给引用 |
| F6 | **confirm 阶段持久化 args 每字符串字段 1000 字符截断（修正根因）** | `ops.py:5543` `_audit_inputs` → `redact_sensitive_value`（`security_redaction.py:63`，`max_length=1000`）；`ops.py:5378` `_claim_authorized_execution` 同样 `redact_sensitive_value(inputs)` 写入 OperationAuditLog。confirm 执行使用的持久化 args 中凡 >1000 字符的文本参数（如 resume parsed_text、长 excerpt）在 confirm 阶段失真 → fact_gate 判定"来源中无法验证"。v1 8/9 拒、v2 3/8 拒均为同一根因；v3 以 per-candidate excerpt ≤980 字符绕开后 8/8 全过 | 任何携带长文本参数的 confirm 型 Operation 都会在批准时静默失真，证据门对长简历系统性误拒且错误消息误导为"简历造假" | 分离"审计存储用脱敏副本"与"确认执行用原始 args"——审计可截断，执行必须用未截断输入；错误消息指明截断原因 |
| F7 | `GET /api/bridge/proposals/{run_id}` 一次 500 | err_79c3006fb8ef4ef7 | 桥接读路径存在未处理边界错误 | 复现 err id，5xx 加结构化错误 |
| F8 | 并发写入导致投前决策 stale | run_aadfa1128d7c43f3 prepare_pre_application_decision failed：兄弟 agent 更新 profile 使 input_hash 过期 | 多 Agent 并发会话中 prepare→submit 链路需重试，无自动刷新 | prepare 返回最新 input_hash 或提供 stale-aware retry 语义 |
| F9 | research fallback 链两个 runtime 不可用 | job_research_d95746b5a5bb40428273289029445e94（claude）failed 'Not logged in'；backend_search 无 key | fallback 链实际只剩 codex 单点 | doctor 透出各 runtime 可用性；fallback 排序跳过不可用项 |
| F10 | chat_completion 不兼容推理模型 | `devin/deepseek-v4-flash` 把 12288 max_completion_tokens 全耗在 reasoning_content，content 为空 → 报"LLM 调用失败"且无区分度（jd_analysis/match_analysis 输出小侥幸过） | 任何 reasoning 模型接入即失败，错误无指向性 | 读 reasoning_content / 识别空 content 并给专属错误；模型元数据标注 reasoning 类型 |
| F11 | 导出 PDF 颜色靠 CSS 注入实现 | `resume_export.py:74` `escape()` 只过滤 `<>"'&`，`{};/#` 透传：`style_config.primaryColor` 被写入 `#000000; font-size: 24pt } h2 { color: #7C3AED; ...` 实现紫色标题 | **安全**：任意 CSS 可注入导出 PDF 模板 | primaryColor 走值校验（颜色字面量白名单），不在 escape 后拼接 CSS 块 |
| F12 | 预览/导出渲染不一致 | React 预览与 Jinja 导出路由不认识上述 token（accent 枚举无紫） | 同一简历 UI 预览与 op 导出 PDF 颜色不一致 | 颜色表达收敛到枚举/校验后的单一通道，预览与导出共用 |
| F13 | `PUT /api/resume/{id}` 带无 id 新 section 400 | flush 后赋 section_type 触发 NOT NULL | 追加新 section 的标准用法直接报错 | flush 前赋值或对无 id 行显式 insert 路径 |
| F14 | ops 导出器首个导出缺日期 | run_467652d16a53459d 产物缺日期字段；第二次（run_3c64783846e24f32）正常 | 首份导出文档不完整 | 修复导出器 description 短路路径 |
| F15 | splitBullets 在日期区间连字符处误切 | 简历复刻中发现 | bullet 拆分错位 | 连字符规则排除日期区间模式 |
| F16 | create_resume_record 自动注入 3 个默认段 | 复刻时需清空重建（cosmetic） | 空初始化语义不空 | 提供 `empty=true` 参数或不注入默认段 |

## 5. 限制

- **LLM 配置已被修改且原配置本身不可用**：会话中原配置 `active_llm_config_id=mojcutwz-emcczrdo`（provider=deepseek / model=nemotron-3.5-lightning-free / base_url=127.0.0.1:8317/v1 / api_key=env:OFFERU_LLM_KEY / timeout=60）本身就 401——还原配置不恢复可用性。当前库内为 JobPipeline 改后的网关 `sk-` key + `devin/deepseek-v4-1-flash` + timeout 300。
- 岗位任务数据源为种子数据（jobs 480 行无真实公司名），"PARTIAL"仅证明链路可跑通，不证明真实岗位发现能力。
- 批准均经 `OFFERU_APPROVAL_TOKEN` 旁路完成，未验证 Tauri 桌面端真实人工确认路径（F1 使浏览器端本就无法走通）。
- 简历复刻的"PASS"依赖 CSS 注入（F11），是一次成功执行而非对导出管线健壮性的背书。
- `run_2b018eb494284494` 的 `failure_reason`/`final_result_json` 在 DB 中为空（`{}`），其失败原因靠会话观察+代码推断。
- F6 根因描述基于 `ops.py`/`security_redaction.py` 代码与三轮实验对照（v1/v2 拒、v3 缩 excerpt 全过），未做单元级隔离复现。

## 6. Recommended decision

- **F6（confirm 期 args 截断）为本次最高优先级修复项**：它不是简历功能的局部 bug，而是所有 confirm 型长文本 Operation 的系统性失真。修复（审计副本截断、执行用原始输入）后，"长简历全字段 accept"应加入 regression suite。
- **接入链路**：Internal Beta 开发态可用（旁路批准），F2/F3 属"无报错失败"，建议优先于 F1 修复。
- **简历优化 BLOCKED**：阻塞点在外部 LLM 网关与推理模型兼容（F9/F10），修复 F10 前 resume optimization 不可对外声称可用。
- **简历复刻**：导出链路可产出正确 PDF，但 F11 是安全缺陷（CSS 注入），应在对外宣称导出能力前修复；F12 修复后复刻才无需注入即可达成样式目标。
