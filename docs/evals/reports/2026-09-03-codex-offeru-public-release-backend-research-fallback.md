# OfferU Public Release · Controlled backend research fallback

## Scope

`run_backend_research` 之前没有进入 `start_job_research` 的统一运行生命周期；当没有可用的 live-capable CLI 时，岗位调研会在启动阶段直接失败。本切片把它收敛为同一个 `JobResearchRun`：

```text
自动选择 live CLI
        ↓ 无可用 CLI
controlled backend_search
        ↓
search API → public HTTP fetch → LLM JSON → fact gate → dossier
```

## Changes

- 未指定 `runtime_id` 时，`start_job_research` 先按既有 CLI priority 选择；只有没有可用 CLI 且已配置 bocha / tavily / serper 与 LLM 时，才选择 `backend_search`。
- 显式指定某个 CLI 仍然 fail-closed，不会静默换 Provider；`backend_search` 也必须满足自己的配置检查。
- 后端路径复用 `JobResearchRun`、`_execute_run`、状态/失败/取消/恢复、报告、事实门、dossier 和 memory observation，不再创建第二条持久化路径。
- backend search 只使用已配置的搜索 API；研究任务关闭无法证明代理/重定向边界的可选 ddgs 路径。
- 每次 backend run 保存 `public_web_transport`、来源引擎、页面数量和 schema enforcement 状态，明确它不是 Agent Runtime，schema 仍由 OfferU 事实门兜底。
- 页面上限固定为 8；search API、公开页面读取、LLM 失败仍进入原有 `failed` 与 `error_id` 投影，不伪造成功。

## 入口与浏览器边界

- OfferU 网页入口仍是 `http://127.0.0.1:7410`。
- OfferU 后端入口仍是 `http://127.0.0.1:8765`。
- `127.0.0.1:8080` 仍只可能是用户配置的 llama.cpp 模型 API，不是网页地址；本切片没有访问它。
- 本切片没有启动 Edge、系统默认浏览器、可见浏览器或任何 `chrome.tabs.create` 路径。
- backend research 不使用浏览器；受限登录站点仍必须走用户授权的只读浏览切片。

## Verification status

已落盘：backend fallback、Operation input contract、Agent skill 文档和 architecture contract。

按 `AGENTS.md`，写入后未运行测试、语法检查、frontend typecheck/build、扩展构建、Provider/network matrix 或浏览器验收。因此这只是一个待验证的发布切片，不能提升 `OFFERU_PUBLIC_RELEASE_NOT_READY` 为 Ready。
