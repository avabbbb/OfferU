# OfferU Public Release — 2026-09-07 真实数据验收

## 结论

`OFFERU_PUBLIC_RELEASE_NOT_READY`

本轮完成了当前 checkout 的隔离数据库、真实 HTTP、worker、无头浏览器、打包 sidecar 和依赖验收。结果证明核心本地运行链可复现，但不满足 `GOAL.md` 的 Public Release 终点；live external Role Intelligence、签名、clean-machine/独立人工验收、previous-release upgrade、远程 CI/RC 和隐私/法律 Gate 仍未完成。

## 验收边界

- 网页仅使用 `http://127.0.0.1:7410`；后端仅使用 `http://127.0.0.1:8766`。
- 浏览器场景使用 Playwright managed Chromium、`headless=true`、隔离 profile/数据库。
- `127.0.0.1:8080` 未作为网页地址访问；它仍只是可选模型 Provider endpoint。
- 测试数据使用本轮新建的隔离数据目录；没有把 Replay/fixture 结果标成 live external provider 结果。

## 动态证据

| 范围 | 结果 |
| --- | --- |
| Backend 全量回归 | `487 passed, 17 warnings, 1 subtests passed in 354.99s` |
| 主要页面空状态 | 3 次连续通过：Today、Jobs、Pipeline、Profile、Resume；bad responses、console、page errors 均为空 |
| Public smoke | 通过：Job、CareerTask、retry、HTTP 503 failure projection 和可恢复状态 |
| Migration browser path | 通过：schema v2、integrity `ok`、foreign-key violations 0、migration 后页面可用 |
| Failure/recovery | 通过：auth blocked、timeout、backend restart 三条路径均在 retry 后完成 |
| Automation concurrency | 通过：两个 worker 只产生一个 AutomationEvent、一个 task、一个 Inbox projection |
| Worker soak | 通过：100/100 cycles、100 unique jobs/tasks/events、task `completed`、attempt 1、integrity `ok`、FK violations 0 |
| Interview | Replay path 通过：8 个答案、Focus Plan、adaptive follow-up、Debrief、Learning Candidate、Profile accept；默认未配置运行时则明确返回 `/api/interviews/runtime` HTTP 400，未伪造模型已加载 |

## 构建、运行和安全证据

- Frontend `typecheck`、`build` 通过。
- Extension `typecheck`、WXT build 通过；managed single-thread Vitest 为 `208 passed, 7 skipped`（标准 PowerShell `npm test` 曾因宿主 `System.OutOfMemoryException` 失败）。
- Tauri MSI/NSIS、Python sidecar 和 Rust release build 通过；打包 sidecar 直接 health smoke 返回 HTTP 200、`status=ok`、`service=OfferU`、`version=0.4.0`、`runtime_mode=desktop-sidecar`。
- `pip-audit`、frontend/agent-runtime/extension production `npm audit` 均无已知漏洞。
- `cargo audit --no-fetch` 扫描通过但含 17 条 warning；严格 `cargo audit --no-fetch --deny unsound` 仍因 `glib 0.18.5 / RUSTSEC-2024-0429` 退出失败。
- version、product-claims、architecture audit 和 Tauri/sidecar/Extension artifact audit 当前均为 0 finding；Extension 的合成 Firefox ID `offeru-extension@offeru.local` 只在精确的 `chrome-mv3/manifest.json` 路径放行，其他路径或其他邮箱仍 fail-closed。
- 隔离 Doctor `--require-ready` 返回 `ok=true`、backend/frontend `ready`、schema `2`、integrity `ok`；其 `CORE_READY` 只代表核心运行时就绪，不代表公开发布 Gate。

## 最终打包物

| Artifact | SHA-256 | Authenticode |
| --- | --- | --- |
| `frontend/src-tauri/target/release/bundle/msi/OfferU_0.4.0_x64_en-US.msi` (222,520,164 bytes) | `EC58CC849484905CD15CD6A6464704DB6A75782EA058D23DF29064C3CCB800BC` | 未签名 |
| `frontend/src-tauri/target/release/bundle/nsis/OfferU_0.4.0_x64-setup.exe` (190,526,002 bytes) | `4EF47564EE6586AB8E992B8EA78E97FC5DC2D9F6B072E3982C396FEA740F18BA` | 未签名 |
| `frontend/src-tauri/binaries/offeru-backend-x86_64-pc-windows-msvc.exe` (152,554,447 bytes) | `F542AE882C00C292A671697F4FAD07F09B6EE8636B074AAE632DEEC6A60B1A65` | 不适用 |

## 仍然阻塞 Public Release 的项目

1. 真实 external Role Intelligence provider，以及跨公司、岗位族和 seniority 的 10-role acceptance matrix。
2. 代码签名证书和签名后的最终 artifact。
3. previous internal release → current installer upgrade/migration。
4. 无开发工具 clean OS 安装、卸载、重启及独立陌生用户人工验收。
5. 远程 CI runner、正式 RC/tag、artifact manifest/checksum/signature verification。
6. 隐私/法律政策、retention、历史 PII/artifact/log scrub、真实 OAuth 和完整 provider/network/restart 矩阵。
7. 严格 RustSec unsound Gate 的 `glib` 依赖风险。
