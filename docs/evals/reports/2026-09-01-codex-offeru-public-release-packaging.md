# OfferU Public Release Packaging Evidence — 2026-09-01

## Scope and verdict

本报告记录当前 `0.4.0` Windows Tauri bundle、Python sidecar、安装生命周期、release-mode Doctor 和打包 PDF/live Agent smoke。结论为 `PARTIAL`：产物能生成并运行，但当前 installer 未签名，也没有 previous-release upgrade 证据。

## Build and version

```text
frontend npm run typecheck                 PASS
frontend npm run build                     PASS
Tauri npm run tauri -- build               PASS
backend full pytest                        362 passed, 19 warnings, 1 subtests
```

统一版本：

```text
OfferU frontend package: 0.4.0
Tauri config:             0.4.0
Rust package:             0.4.0
Python CLI/API:           0.4.0
```

## Release artifacts

| Artifact | Size | SHA-256 | Signature |
| --- | ---: | --- | --- |
| `frontend/src-tauri/target/release/bundle/nsis/OfferU_0.4.0_x64-setup.exe` | 190,441,228 bytes | `788074CF9EC3A19306F62C1817AC5EAE91E46B80DD4F988DE7E1E35685900096` | `NotSigned` |
| `frontend/src-tauri/target/release/bundle/msi/OfferU_0.4.0_x64_en-US.msi` | 222,430,052 bytes | `6037D58D4FC7217D6DA7E3001D3609A3BFEC90E1F208F2A5CB1B1473497731B9` | `NotSigned` |
| `frontend/src-tauri/binaries/offeru-backend-x86_64-pc-windows-msvc.exe` | 152,484,029 bytes | `C9A53756555C74BBF4B993A6493F2A3ACB20B897743F26FA82AC2F4FCA4D2B2E` | sidecar, not separately signed |

## Installed lifecycle

在精确隔离目录 `.tmp/offeru-clean-install` 执行：

```text
initial install
→ first uninstall
→ reinstall
→ launch installed app.exe
→ installed sidecar health/integrity/skills smoke
→ final uninstall
```

结果：

```json
{
  "status": "PASS",
  "first_uninstall_exit": 0,
  "reinstall_exit": 0,
  "smoke": "PASS",
  "final_uninstall_exit": 0,
  "install_dir_exists_after_final_uninstall": false,
  "user_appdata_preserved": true
}
```

Installed smoke 还验证：

```text
runtime=python
runtime_mode=desktop-sidecar
version=0.4.0
integrity=ok
skill_count=35
installed files include app.exe, offeru-backend.exe, node.exe, agent-runtime
```

另外在同一安装包上将启动进程的 `PATH` 限制为 Windows 系统目录，去除 Python、Node、npm 和仓库开发路径后再次执行 sidecar health/integrity/skills smoke，结果为 `PASS`。这证明当前 bundle 不依赖开发机 PATH，但仍不替代独立 clean OS 和陌生用户人工验收。

## Release-mode Doctor

使用 release 环境变量、隔离 data directory、staged runtime directory 和 node executable 验证：

```text
release_readiness.status = CORE_READY
backend = ready
database = ready
storage = ready
desktop_bridge = ready
version_consistency = ready
agent_runtime = ready
live_provider_gate = not_verified
```

`CORE_READY` 只表示本地核心运行边界可用，不代表签名、升级、live Provider claim 或 Public Release 已通过。

## Packaged sidecar capabilities

已通过 packaged sidecar 的 PDF smoke：

```text
desktop-sidecar health                 PASS
Python runtime                         PASS
Resume PDF export                      PASS
PDF magic=%PDF                         PASS
PDF size=27,157 bytes                  PASS
```

在 staging 的用户 config + env 引用和可用模型 `mimo-v2.5-free` 下，packaged Pi Agent smoke 也通过：

```text
run_status=completed
assistant_message_length=30
provider=deepseek
model=mimo-v2.5-free
event_types include run.started, assistant.delta, assistant.message, run.completed
pending actions=0
```

该 smoke 使用隔离 staging，未输出或保存凭据到报告；当前开发配置中的 `deepseek-v4-flash-free` 另一次探测返回 `model unavailable`，应作为 Provider 配置/外部服务问题显示，而不是伪造成功。

## Packaging warnings / open gates

- 当前 NSIS/MSI 的 Authenticode 状态为 `NotSigned`；合法代码签名证书需要产品所有者提供，属于真实外部 blocker；
- `.github/workflows/build.yml` 已增加正式 `v*` tag 的 PFX 签名与 Authenticode 验证门；缺少证书 secret 时 tag job 直接失败，不会上传未签名 release artifact；
- Tauri updater 未启用，不能宣传自动更新；若启用，必须补签名更新包验证；
- 没有 previous release installer，因此 upgrade/migration journey 尚未验证；
- 本次 clean install 是隔离 Windows 用户目录下的安装生命周期与 sidecar smoke，不等于全新 OS、无开发工具环境下的独立人工验收；
- WeasyPrint 原生库/字体在打包构建日志中有缺失 warning；当前 PDF fallback smoke 通过，但中文字体和多平台渲染仍需正式发布前继续验证；
- CI release workflow 尚未在远程 runner 上执行；
- Tauri identifier 仍触发 `.app` 后缀建议 warning，本次未改变发布 identity 以避免数据目录迁移风险。

## Release mapping

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| R83 Production Packaging | `PASS` for local Windows artifact generation | Tauri bundle + sidecar present |
| R84 Clean Machine | `PARTIAL` | Isolated install/lifecycle、去除开发 PATH 的 app/sidecar smoke；无真正 clean OS 和陌生用户人工路径 |
| R85 Python Sidecar | `PASS` | Installed sidecar health, resources and runtime mode |
| R86 Installer lifecycle | `PASS` | uninstall/reinstall/final uninstall all passed |
| R87 Unified Versioning | `PASS` | frontend/Tauri/Rust/Python all `0.4.0` |
| R88 Upgrade | `NOT_VERIFIED` | No previous installer fixture |
| R89 Update Signing | `NOT_VERIFIED` | Updater not configured |
| R90 Code Signing | `BLOCKED_EXTERNAL` | Certificates required; artifacts currently NotSigned |
| R91 Release Artifact Set | `PARTIAL` | Installer, sidecar and hashes exist; signed/notices/RC package not complete |
| R92 CI Release Pipeline | `PARTIAL` | Workflow 已包含 backend/frontend audit、Windows NSIS+MSI package、正式 tag signing/verification 和 artifact hash；remote tag execution 尚未运行 |
| R104 Doctor Release Gate | `PASS` for release-mode local core contract | `CORE_READY`, all required local checks ready |

## Machine-readable summary

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-public-release",
  "run_id": "public-release-packaging-2026-09-01",
  "version": "0.4.0",
  "verdict": "PARTIAL",
  "installer_lifecycle": "PASS",
  "release_doctor": "CORE_READY",
  "packaged_pdf": "PASS",
  "packaged_live_agent": "PASS_WITH_STAGED_PROVIDER_CONFIG",
  "code_signing": "BLOCKED_EXTERNAL",
  "upgrade": "NOT_VERIFIED",
  "updater": "NOT_CONFIGURED",
  "public_release": "NOT_READY"
}
```
