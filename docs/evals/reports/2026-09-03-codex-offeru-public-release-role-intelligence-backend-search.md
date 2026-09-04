# OfferU Public Release — Role Intelligence Backend Search Adapter

日期：2026-09-03

切片：`ROLE_INTELLIGENCE_BACKEND_SEARCH_79`

状态：`PARTIAL`

## 目标

让保存岗位后的 Role Intelligence 自动链在没有可用 live-capable CLI 时，能够选择受控的后端公开网页搜索路径；该路径不启动浏览器、不访问 OfferU 网页端口，也不把后端 HTTP 伪装成 coding-agent runtime。

## 已落盘

- `role_intelligence` 新增明确的 `backend_search` provider adapter。
- `runtime_id=auto` 先选择满足公开网页能力的 live CLI；只有自动选择失败且搜索 API 与 LLM 配置齐全时，才选择 `backend_search`。
- 显式指定 `codex`、`pi` 等 runtime 仍然 fail-closed，不会偷偷切换到其它 Provider。
- 后端搜索只调用 `web_search(..., allow_optional_ddgs=False)` 和受控 `fetch_readable`；来源 URL 必须来自已提供的公开页面，LLM 不能发明来源。
- `backend_search` 的 Role Intelligence 结果继续经过现有 schema、normalization、dedupe、cohort、sample、Delta 和持久化链。
- `data_mode=live_backend` 在前端显示为“受控后端检索”，不会被误标为 Fixture。
- 保存岗位的自动任务和“实时研究”入口改为请求 `auto`，本地准备仍保持 `replay`。

## 网络与浏览器边界

```text
OfferU web       http://127.0.0.1:7410
OfferU API       http://127.0.0.1:8765
llama.cpp 可选模型 API  http://127.0.0.1:8080
```

本切片没有启动 Edge、系统浏览器、可见浏览器或 `opencode web`，没有访问 `8080`。`backend_search` 仅使用受控公开 HTTP 研究边界；所有网络来源的代理、重定向、DNS 私网解析和受限域名检查仍由 `web_search` / `fetch_readable` 负责。

## 未执行

按 `AGENTS.md`，本轮没有运行：

- backend tests / syntax check；
- frontend typecheck / build；
- extension build / tests；
- 真实搜索 API、LLM 或 Provider 网络调用；
- Browser E2E、Edge 或任何可见浏览器验收；
- installer、clean-machine、签名和 upgrade 验收。

## 剩余风险

- 当前环境是否配置了可用搜索 API 和 LLM 尚未动态验证；没有配置时必须继续显示明确 blocked/failed，而不是伪造 Role Intelligence 完成。
- 真实 `10-role` Live Acceptance 尚未执行。
- 生成的扩展 bundle 仍需用户通过正式 WXT build 刷新和审计。
- Public Release 仍受签名 installer、previous-release upgrade、clean-machine 验收、严格 RustSec unsound policy、真实 Provider/network 矩阵和隐私/法律决策阻塞。
