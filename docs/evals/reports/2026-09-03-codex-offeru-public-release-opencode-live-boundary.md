# OpenCode live web capability boundary

日期：2026-09-03

## 结论

OpenCode `1.17.11` 在本机可执行，`opencode run` 支持非交互 JSON 事件输出，且 `opencode web` 是单独的 Web UI 命令。本轮只做了版本与帮助信息探测，没有调用 `opencode web`，没有启动浏览器或 Edge，也没有访问 `8080`。

OfferU 目前没有为 OpenCode 建立可证明的受控公开网页适配器。`run --pure` 只能说明外部插件模式被关闭，不能证明 web 工具会拒绝回环/内网地址、会在重定向后重新做私网校验，或只允许 `public_web_only` capability grant。因此不能把 OpenCode CLI 的存在当成 Role Intelligence 的 live Provider 证据。

## 代码边界

- `RUNTIME_DEFINITIONS["opencode"].capabilities_decl.supports_live_web_search` 已设为 `False`；通用无网页 Agent seam 仍保留。
- `select_local_executor(..., requirements=ExecutorRequirements(web_search=True))` 会在启动子进程前拒绝该 runtime。
- Role Intelligence 继续对 live web 研究 fail-closed；Replay/fixture/plugin 路径不受影响。
- 新增 release architecture contract，防止未来仅凭 `run`/`--pure` 帮助文本重新宣称 live web 能力。

## 发布影响

这不是 Public Release 的通过证据，而是消除一条潜在的错误通过/错误本地访问路径。当前 live Role Intelligence 仍需要 Codex/Claude 或一个真正执行公开网页 host/redirect/private-address allowlist 的 Provider adapter；Codex 认证仍属于外部 blocker。

## 未执行

按 `AGENTS.md`，本轮没有运行测试、语法检查、构建、浏览器验收或真实 Role Intelligence 请求。没有修改真实用户数据库。正式 Provider、远程 runner、clean-machine 与签名发布仍未验证。

参考：

- OpenCode webfetch source: <https://github.com/anomalyco/opencode/blob/dev/packages/core/src/tool/webfetch.ts>
- OpenCode agent permissions: <https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/agents.mdx>
