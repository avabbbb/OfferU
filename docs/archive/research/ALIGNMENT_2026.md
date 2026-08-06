# OfferU 2026 对齐文档

> 落盘日期：2026-06-29
> 目的：动手升级基座 / 推新功能前，把三个需求（smart-resume 对比、open-design 借鉴、模板 UGC 市场、多 Provider）的现状、缺口、矛盾、建议一次性摆清楚，供决策。

---

## 0. 摘要

| 需求 | 现状判定 | 是否需要动手 |
|---|---|---|
| smart-resume 简历编辑闭环 | **骨架已建、未串完** | ✅ 需要，工作量中等 |
| open-design 全部复刻 | **不现实**（71K stars 团队项目，OfferU 只搭了 runtimes 骨架，9 surface 全空白） | ❌ 不做全部复刻 |
| open-design résumé 线借鉴 | **值得有限借鉴**（沙箱 iframe + SKILL 协议 + 单一 résumé surface） | 🟡 可选，工作量小 |
| 简历模板 UGC 市场 | **完全空白**（open-design 本身也不做这个） | ✅ 需要，工作量中等 |
| 多 Provider 重构 | **已实现**（`llm.py` 已有 7 provider 抽象 + active 配置 + tier 映射） | ❌ 不需要重构 |

**核心矛盾**：用户先选了"全部升级基座再推新功能"，随后又追加三个新功能方向。两者不能并行——在 Next 14 上堆新功能等于在过期基座上盖楼。

**建议优先级**（Dario 视角）：
1. 先修确认的 Bug（`agent_operations.py` / `studio.py` 字段不匹配，会运行时崩溃）
 2. 再升级基座（Next 16 / React 19 / FastMCP 3 / LLM tier 映射刷新——不绑死任何 provider）
3. 升级干净后串 smart-resume 简历闭环（未提交的工作正好在补这块）
4. 最后做模板 UGC 市场（真正的新功能，依赖前三步的稳定基座）

---

## 1. smart-resume 逐项功能对比

参考仓库：`OrtonY/smart-resume`（Spring Boot + React/Vite，非 Python，**只能功能对标，不能代码复用**）

| # | smart-resume 功能 | OfferU 现状 | 缺口 | 现状文件 |
|---|---|---|---|---|
| 1 | 多用户登录注册 | ✅ Profile 表 + is_default | — | `models.py:113` |
| 2 | 简历 CRUD | ✅ Resume/ResumeSection/ResumeVersion 表 + `resume.py` 2878 行完整路由 | — | `routes/resume.py` |
| 3 | 段落管理（教育/经历/技能/项目/自定义） | ✅ ResumeSection 通用块表 + reorder/photo/upload | — | `routes/resume.py:18-22` |
| 4 | 模板管理 | 🟡 ResumeTemplate 表 + `templates.py` 278 行 + `template_seeder.py`（未提交） | seeder 未提交，内置模板数据可能未初始化 | `routes/templates.py` |
| 5 | 结构化编辑器 + A4 实时预览 | 🟡 有 5 个模板组件（SwissSingle/SwissTwoColumn/ModernSingle/ModernTwoColumn/Reference）+ `ResumePreview.tsx` + TipTap 2.6 | **缺"全功能编辑工作台"**——当前是只读预览，不是编辑器 | `frontend/.../resume/components/` |
| 6 | 版本管理 | 🟡 ResumeVersion 表已建，路由未确认串通 | 需核实版本对比/diff/回滚 UI | `models.py` |
| 7 | 分享 | ❌ 无公开分享链接 | **完全空白** | — |
| 8 | AI 对话 | ✅ `optimize_agent.py` ReAct + Function-calling | — | `agents/optimize_agent.py` |
| 9 | AI 评分 | ❌ 无独立评分端点 | **完全空白** | — |
| 10 | AI 翻译 | ❌ 无翻译端点 | **完全空白** | — |
| 11 | 面试工作台 | 🟡 Interview/InterviewMessage 表 + `interviews.py` 635 行（未提交） | 未提交，未串通前端 | `routes/interviews.py` |
| 12 | 投递记录 | ✅ Application 表 + 路由完整 | — | `models.py` |
| 13 | BOSS 插件 | 🟡 有 `extension/` + `Niuke/` 两套（未提交） | 需核实哪套在用 | `Niuke/` |
| 14 | 双路 PDF 导出 | 🟡 `pdf_exporter.py` 295 行 Playwright（未提交）+ 前端 jspdf/html2canvas | 后端路径未串到 resume 路由 | `services/pdf_exporter.py` |

**结论**：smart-resume 的 14 项功能中，OfferU **已完整 4 项、骨架在建 6 项、完全空白 4 项**。未提交的工作（studio/templates/pdf_exporter/interviews/template_seeder）正是在补骨架——方向正确，但还差**评分、翻译、分享、A4 编辑工作台**四块。

---

## 2. open-design 借鉴范围

参考仓库：`nexu-io/open-design`（71K stars，Next.js + Node daemon，本地优先 agent 设计工具）

### 2.1 open-design 核心能力（OfferU 现状对比）

| open-design 能力 | OfferU 现状 | 差距 |
|---|---|---|
| 本地 daemon + REST/SSE | ❌ 无 daemon，纯 Web | 架构不同，不借鉴 |
| agent adapter pool（17+ CLI） | 🟡 `agents/runtimes/` 只有 detection/invocation/types + claude.py | 只搭了框架 |
| SKILL.md 协议 + skills 库 | 🟡 `.claude/skills/offeru/` 有 1 个 skill | 缺生态 |
| DESIGN.md 品牌系统（150 个） | ❌ 无 | 完全空白 |
| 9 surface modes（magazine/deck/poster/XHS/tweet/prototype/report/Hyperframes） | ❌ 无 | **完全空白** |
| 沙箱 iframe 预览 | 🟡 `studio/page.tsx` 只是模板选择器，无沙箱 | 未实现 |
| HTML/PDF/PPTX/MP4 导出 | 🟡 `pdf_exporter.py` 只到 PDF | 缺 PPTX/MP4 |
| UGC 生态 | ❌ open-design **本身明确不做**（写在它的"不做"清单） | 不存在 |

### 2.2 借鉴范围（用户确认 2026-06-29）

**需求本意**：现在是新时代，除了传统 PDF 简历，还有 HTML 网站版简历/作品集。OfferU 要补这个能力。

**借鉴 open-design 的 HTML 设计生成能力**，用于 OfferU 的 HTML 网页版简历/作品集：

| 借鉴的 open-design 能力 | OfferU 用途 |
|---|---|
| agent 生成 HTML（读 DESIGN.md 实时渲染） | OfferU agent 根据 profile + 模板生成 HTML 网页简历 |
| 沙箱 iframe 预览 | 安全预览用户提交的 HTML 模板（UGC 市场必需） |
| 150 个 DESIGN.md 品牌系统 | 作为 HTML 简历的配色/字体/间距 token 库 |
| résumé surface 生成逻辑 | 参考其简历生成 prompt + 布局策略 |

**明确不做**（open-design 的 8 个无关 surface）：
- magazine（杂志）/ deck（PPT）/ poster（海报）/ XHS（小红书卡片）
- tweet（推文）/ prototype（原型）/ data report（数据报告）/ Hyperframes（视频）

理由：OfferU 是求职工具，不是设计工具。这 8 个 surface 和校招简历用户完全不重叠。

**与第 3 节的关系**：HTML 网页版简历 = 第 4 步的核心，依赖沙箱 iframe（UGC 市场也依赖）。150 DESIGN.md 作为 HTML 简历的品牌 token 库。

---

## 3. 简历模板 UGC 市场设计（你的真实需求）

你澄清了"UGC 生态"= **简历模板 UGC 市场**（类似 AIGesume 的"模板市场展示 + 模板开发者共创"）。这在 OfferU 现状中完全空白。

### 3.1 现状

- `ResumeTemplate` 表：字段有 `name/thumbnail_url/css_variables/html_layout/is_builtin`——**只有内置模板字段，无 UGC（作者/审核/定价/下载量/标签/评论）**。
- `HtmlResumeTemplate` 表：`name/display_name/category/preview_image/html_template/css_template/design_tokens`——同样无 UGC 字段。
- `templates.py` 路由：只有 list/get/create/update，**无"市场"语义（浏览/搜索/排序/收藏/下载/审核）**。

### 3.2 UGC 市场需要的最小新增能力

| 能力 | 现状 | 需要新增 |
|---|---|---|
| 模板作者归属 | ❌ | Template 表加 `author_id` 外键到 Profile |
| 审核状态 | ❌ | 加 `status`（draft/pending/published/rejected）字段 |
| 浏览/下载计数 | ❌ | 加 `view_count` / `download_count` |
| 标签/分类 | 🟡 HtmlResumeTemplate 有 category | 加多对多 `template_tags` 表 |
| 公开市场页 | ❌ | 新增 `/api/marketplace` 路由 + 前端 `/marketplace` 页 |
| 分享链接 | ❌ | 公开预览 `/share/{token}` 无需登录 |
| 用户评论/评分 | ❌ | 可选，第二期 |

### 3.3 工作量评估

- 后端：扩 2 个表 + 新增 1 个路由模块（marketplace.py）+ 审核流程。约 2-3 天。
- 前端：新增 marketplace 页 + 模板详情页 + 提交模板页。约 3-4 天。
- 依赖：必须先有**沙箱 iframe 预览**（用户提交的 HTML 模板不能直接渲染，需沙箱隔离）。

---

## 4. 多 Provider 现状（已实现，不需重构）

**结论**：你说的"不要只支持 Qwen，应支持多 PROVIDER 用户可自设"——**已经实现了**。

### 4.1 已有实现

`backend/app/agents/llm.py` 第 48-100 行：
- `DEFAULT_BASE_URLS`：deepseek / qwen / siliconflow / gemini / zhipu 5 家预设 base_url。
- `TIER_MODEL_MAP`：每家 fast / standard / premium 三档模型映射。
- `_get_client()`：配置优先级 = active 配置 > legacy per-provider key > Ollama 特殊路径。
- 统一 OpenAI 兼容协议。

`backend/app/config.py`：
- 6 家 API key 字段：`deepseek_api_key / qwen_api_key / openai_api_key / siliconflow_api_key / gemini_api_key / zhipu_api_key`。
- `llm_provider` + `llm_model` 选当前。
- `active_llm_config_id / active_llm_base_url / active_llm_api_key` 运行时激活配置。
- `tier_model_map` 可 JSON 覆盖。

### 4.2 唯一的小缺口

- README badge 写"FastMCP 1.27"但实际依赖是 `mcp>=1.27.0`（官方 SDK），属文档漂移。
- `TIER_MODEL_MAP` 里各 provider 的模型名是硬编码默认值（如 qwen 写 `qwen-flash / qwen3.5-plus`，deepseek 写 `deepseek-v4-flash`），**模型 ID 随时间过期**。应改为运行时可配置（用户可在前端设置页覆盖任意 provider 的任意 tier 模型名），而不是在代码里钉死某一代模型。
- 无前端"LLM 设置页"让用户 GUI 配置 provider——目前只能改环境变量/配置文件。

**建议**：不重构架构，只做两点小补——(a) 把 `TIER_MODEL_MAP` 默认值仅作占位，实际模型名走 config 覆盖（`tier_model_map` 字段已支持 JSON 覆盖，需确认前端能改）；(b) 升级基座时顺带加前端 LLM 设置页。**不绑死任何 provider，不绑死任何模型版本**。

---

## 5. 已确认的 Bug（会运行时崩溃）

### 5.1 `agent_operations.py` get_profile() —— Profile 字段不匹配

文件：`backend/app/services/agent_operations.py:16-34`

引用了 Profile 模型上**不存在**的字段：
- `profile.location`（第 30 行）—— Profile 模型无此字段
- `profile.target_locations`（第 32 行）—— Profile 模型无此字段
- `profile.summary`（第 33 行）—— Profile 模型无此字段
- `profile.target_roles`（第 31 行）—— 这是 ORM relationship（指向 ProfileTargetRole 对象列表），不是字符串列表。`profile.target_roles or []` 返回的是 relationship 对象，不是可序列化的字符串列表，会导致 dict 构造异常或 JSON 序列化失败。

Profile 模型实际字段（`models.py:113-148`）：`name/school/major/degree/gpa/email/phone/wechat/headline/exit_story/cross_cutting_advantage/base_info_json/is_default/onboarding_step`。目标岗位是 `ProfileTargetRole` 子表，目标地点需要从 `base_info_json` 或新增字段取。

### 5.2 `agent_operations.py` _public_job_filter() —— Job.is_archived 不存在

文件：`backend/app/services/agent_operations.py:12-13`

```python
def _public_job_filter():
    return Job.is_archived == False
```

Job 模型（`models.py:29-75`）**没有 `is_archived` 字段**。这会导致 SQLAlchemy 在查询时抛 `AttributeError`。此 filter 被 `list_jobs` / `get_job` / `triage_job` / `job_stats` 四处调用——**这些端点全部会崩溃**。

### 5.3 `studio.py` generate_html_resume() —— ORM relationship 当 JSON 字符串解析

文件：`backend/app/routes/studio.py:55-61`

```python
profile_data = {
    "sections": json.loads(profile.sections or "[]"),      # ← relationship，不是字符串
    "target_roles": json.loads(profile.target_roles or "[]")  # ← relationship，不是字符串
}
```

`profile.sections` 是 ORM relationship（指向 ProfileSection 对象列表），不是 JSON 字符串。`json.loads(relationship_or "[]")` 会抛 `TypeError: the JSON object must be str, bytes or bytearray, not InstrumentedList`。

**这三个 Bug 都是运行时崩溃级别，必须在任何功能开发前修复。**

---

## 6. 决策点

按 AGENTS.md 要求，在动手前必须先对齐：

### 决策 A：执行顺序
建议（Dario 视角，严格、防返工）：
1. **先修 3 个 Bug**（5.1 / 5.2 / 5.3）——0.5 天，让现有端点不崩
 2. **再升级基座**（Next 16 / React 19 / FastMCP 3 / LLM tier 映射刷新，不绑死 provider）——3-5 天
3. **串 smart-resume 简历闭环**——把未提交工作提交，补评分/翻译/分享/A4 编辑工作台——5-7 天
4. **做模板 UGC 市场**——扩表 + marketplace 路由 + 沙箱 iframe + 前端市场页——5-7 天
5. **多 Provider 前端设置页**——0.5 天，升级时顺带

### 决策 B：open-design 是否借鉴
建议：**只借鉴沙箱 iframe + SKILL.md 协议**，在决策 A 第 4 步做 UGC 市场时顺带引入。不做 9 surface、不做 daemon、不做 PPTX/MP4。

### 决策 C：未提交的 13 个文件怎么办
未提交的 studio/templates/pdf_exporter/interviews/template_seeder/agent_runtimes/humanizer/Niuke 等都是你在补 smart-resume 闭环的工作——**应该先提交固化**，再升级基座，避免升级时和未提交改动冲突。但其中含 Bug（5.3），需先修后提交。

---

## 附：升级基座风险清单（来自联网核对 2026-06）

| 升级项 | 当前 | 目标 | 风险 |
|---|---|---|---|
| Next.js | 14.2.0 | 16.2.7 | 2 个 major 版本，App Router 缓存语义大改，需逐版本迁移（14→15 cookies/headers async，15→16 TBD） |
| React | 18.3.0 | 19.x | NextUI 2.4 / TipTap 2.6 / dnd-kit / FullCalendar 需逐一验兼容性 |
| MCP | mcp>=1.27.0 | FastMCP 3.4.2 | `mcp.server.fastmcp.FastMCP` → `fastmcp.FastMCP`，import 路径变；工具装饰器 API 变 |
| LLM tier 映射 | 硬编码 qwen-flash/qwen3.5-plus 等 | 默认值仅占位，运行时可配 | 不绑死任何 provider，用户前端可覆盖任意 tier 模型名 |
| SQLAlchemy | 2.0.35 | 2.1.0b3 | beta，可暂缓 |

**升级必须写 `docs/UPGRADE_2026.md` 含回滚清单 + 验证脚本。**

