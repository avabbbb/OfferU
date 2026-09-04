# OfferU Public Release — Doctor and local entry boundary

日期：2026-09-02

## 目标

继续 Public Release 的本地入口收敛，解决错误网页端口被误认为 OfferU 网页、以及前端不可达时 Doctor 仍可能显示核心就绪的问题。该切片不启动浏览器、不调用 Edge、不访问 `8080`，也不修改真实业务数据库。

## 变更

- `backend/app/cli.py` 的前端 Doctor 现在只接受 `http://127.0.0.1:7410` 的无凭据、无路径、无查询参数入口；`8080` 在网络请求前失败，并且不回显输入中的 credentials；
- `backend/app/cli.py` 同时探测固定的 `http://127.0.0.1:8765/api/health`，要求服务身份为 OfferU；API 不可达或健康 payload 不正确时，release readiness 也会 fail-closed；
- release readiness 将前端状态纳入必需检查：本地必须 `ready`，桌面包允许 `embedded`，不可达或错误端口会得到 `CORE_NOT_READY`；
- 扩展将“打开网页”和“检测网页连接”统一使用同一个 2 秒有界 `7410` 探测，不再用 `no-cors` 宽松探测；探测失败不会创建浏览器标签；
- Tauri dev URL、项目 CORS 配置统一到 `127.0.0.1:7410`；
- architecture audit 与 Doctor contract 增加防回归检查。

## 验收映射

| Gate | 当前状态 | 证据 |
| --- | --- | --- |
| R104 Doctor | `PARTIAL` | Doctor 前端错误状态现在会阻断 Core readiness；本轮写入后按 `AGENTS.md` 未执行测试或运行时命令 |
| R96 Architecture drift | `PARTIAL` | 静态 audit 禁止扩展 `no-cors` 网页探测；正式 audit 尚未在本轮执行 |
| R73/R74 failure and duplicate browser path | `NOT_VERIFIED` | 统一探测降低误判/错误标签风险；浏览器 E2E 仍待 managed Chromium/远程 runner 验证 |

## 当前入口

```text
网页： http://127.0.0.1:7410
后端： http://127.0.0.1:8765
8080：可选模型 Provider endpoint，不是网页
```

本轮未打开 Edge 或任何可见窗口，未访问 `8080`，未执行构建、测试、语法检查、扩展构建或远程 runner。Public Release 仍为 `OFFERU_PUBLIC_RELEASE_NOT_READY`。

## 2026-09-03 入口失败可见性与重定向边界

- 前端 `BackendReadyGate` 使用 45 秒有界健康重试；后端仍未就绪时显示 `127.0.0.1:8765`、正确网页入口 `127.0.0.1:7410`、8080 的模型端点说明和可重试按钮，不会无限停在“正在启动”；
- 前端与扩展网页健康探测显式拒绝 HTTP 重定向，扩展的后端 HTTP Adapter 也拒绝重定向并要求 `status=ok`、`service=OfferU`、`runtime=python`，避免错误服务或重定向目标被视为 OfferU 已就绪；
- 前端 `resolveApiBase` 对非本机配置 fail-closed，只允许回到固定本地 `http://127.0.0.1:8765`，不让 stale build setting 把职业数据请求发往任意 origin；
- 新增/更新静态 contract，覆盖启动错误提示、重试入口、重定向拒绝和本地 API base 边界；按 `AGENTS.md` 本轮未执行测试、typecheck、构建、扩展构建或浏览器。
- CLI Doctor 新增 `--require-ready`，仅在 `release_readiness.status=CORE_READY` 时返回零退出码；Windows installed-app smoke 的 8765 probe 也显式将重定向视为失败，便于发布脚本 fail-closed。

本轮仍没有启动 Edge、没有打开任何浏览器窗口、没有访问 `8080`，也没有修改真实用户数据库。Public Release 继续为 `OFFERU_PUBLIC_RELEASE_NOT_READY`。

## 2026-09-03 无浏览器运行时复核

在不启动浏览器、不调用 Edge、也不访问 `8080` 的前提下，使用仓库约定的
`.venv312\\Scripts\\python.exe -m app.cli doctor --pretty` 完成了本机只读复核：

- `http://127.0.0.1:7410/` 返回前端 HTTP 200；
- `http://127.0.0.1:8765/api/health` 返回 HTTP 200，且身份为
  `status=ok`、`service=OfferU`、`runtime=python`；
- CLI Doctor 对错误的 `runtime` 也会 fail-closed，不会只因为 `status/service` 字段正确就接受其它进程；
- Doctor 的 `release_readiness.status` 为 `CORE_READY`，`blockers` 为空；
- 数据库 `integrity_check=ok`、foreign-key violations 为 0；
- `replay` Provider 可用；Codex/Gmail/DSH 仍按可选或实验性集成处理；
- 当前 `8080` 没有监听，它是可选模型 Provider endpoint，不是 OfferU 网页入口。

这次复核只证明当前本机核心服务入口正确，不能替代 Rust contract、打包安装、远程 CI、签名、真实 Provider、隐私决策或公开发布验收。

## 后续桌面健康身份收紧

随后将 Tauri sidecar readiness 从字符串包含判断收紧为结构化校验：只有 HTTP 成功且 JSON 同时满足 `status=ok`、`service=OfferU`、`runtime=python` 才会发出 `offeru-ready=true`。这样即使 `8765` 被其他 HTTP 服务占用，桌面壳也不会把错误服务当成 OfferU 后端。该修改已同步 Rust security contract，但按 `AGENTS.md` 尚未执行 Rust 构建、测试或 packaged smoke。

## CI 健康身份同步

CI 的本地服务等待和 Windows installed-app smoke 随后也改为同时核对 HTTP 成功、`status=ok`、`service=OfferU`、`runtime=python`，避免错误的 8765 服务形成假通过；该改动尚未在远程 runner 执行。

公共 worker soak 与 previous-release migration 的健康等待随后复用同一个 `is_offeru_health_payload` predicate，错误服务不会被继续用于 E2E；新增脚本和 contract 尚未执行。

CLI Doctor 的固定 7410/8765 探测也改为使用禁用系统代理的 loopback opener，避免本机代理导致健康检查假失败；本机运行时复核已通过，但 contract、打包和远程 runner 仍未执行。

发布专用的 migration smoke、worker soak 和 CI 本地服务等待也统一使用直连 loopback opener / `trust_env=False`，并让 repeatability 等待严格校验 `status=ok`、`service=OfferU`、`runtime=python`；避免系统代理或其它占用 8765 的服务造成假失败或假通过。本轮未执行远程 runner。

共享 release opener 进一步改为 URL 白名单，只允许 7410 根页和 8765 health；误传 8080、其它端口、路径、查询参数或凭据会在网络调用前抛出错误。architecture audit 已增加该防回归检查，本轮未执行新增 contract。

CLI、release E2E、CI 和 Tauri 的本地健康探测现在还禁止 HTTP 重定向；7410/8765 返回指向 8080 或外部主机的 3xx 时直接失败，不会跟随跳转或把错误服务记为 ready。本轮未执行新增 contract、Rust 构建或远程 runner。

前端 `BackendReadyGate` 也同步要求 `status=ok`、`service=OfferU`、`runtime=python`，不再只凭 `runtime=python` 放行错误服务；新增静态契约尚未执行，前端 typecheck/build 尚未重跑。

本地入口静态审计范围随后扩展到 Tauri 配置/启动器、CLI Doctor 以及简历打印/分享 URL 代码；旧网页端口或从环境变量继承错误模型端点时会 fail-closed。该范围扩展及 Resume URL contract 尚未执行。

邮箱 OAuth 完成后的本地回调也固定为 `http://127.0.0.1:7410/email`，不再从 CORS 列表顺序选择本地主机名；真实 OAuth 没有在本轮触发。

## 后续可靠性修复

在同一执行阶段又收紧了 `backend/app/services/data_safety.py` 的恢复替换：SQLite `-wal/-shm` sidecar 的移动现在位于统一 rollback scope 内，第二个 sidecar 移动失败时会恢复已经移动的第一个 sidecar；新增隔离测试覆盖该故障。该测试尚未执行，因此 R44/R46 仍依赖既有证据，不能因源码变更自动提升 Gate。
