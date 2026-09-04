# Known Issues

这些问题不应被误认为核心 Career State 成功或失败。

## Public Release residual

### Legacy local executable warning

如果仓库根目录仍有 `OfferU.exe`，不要双击它。当前发现该文件是未纳入当前发布链的历史 `0.1.0` 二进制，内嵌旧的 `127.0.0.1:8000` / `127.0.0.1:3300` 入口，可能唤起无法连接的旧浏览器页面；本轮已将它可恢复地改名为 `OfferU-legacy-0.1.0.exe.disabled`。当前源码开发入口只有 `http://127.0.0.1:7410`，后端为 `http://127.0.0.1:8765`；`8080` 只用于可选 llama.cpp Provider，不是网页服务。该旧文件不由当前启动脚本使用，也不会被当前 Tauri Release artifact 收集。

## Release triage ledger

下表是当前已知残余的唯一 severity inventory。`GATE` 表示发布前置条件，不把它伪装成产品 Bug；`P0/P1` 只用于实际产品缺陷。当前 ledger 没有 P0/P1，但这不替代 clean-machine、动态 E2E 或最终发布者验收。

| ID | Kind | Severity | Status | Release impact |
| --- | --- | --- | --- | --- |
| PKG-001 | RELEASE_GATE | GATE | BLOCKED_EXTERNAL | Windows/macOS 合法代码签名证书仍需产品所有者提供 |
| PKG-002 | RELEASE_GATE | GATE | NOT_VERIFIED | 没有 previous-release installer，升级路径未验证 |
| PKG-003 | RELEASE_GATE | GATE | NOT_VERIFIED | Tauri updater 尚未启用和签名验证 |
| QA-001 | RELEASE_GATE | GATE | NOT_VERIFIED | clean OS 与陌生用户人工验收仍未完成 |
| ROLE-001 | RELEASE_GATE | GATE | NOT_VERIFIED | live Role Intelligence 结构化 Provider claim 尚未通过 |
| PRIV-001 | EXTERNAL_DECISION | GATE | BLOCKED_EXTERNAL | 3 条历史旧邮箱正文需要产品/隐私决定 |
| PROVIDER-001 | PROVIDER_ISSUE | P2 | OPEN | 默认 DeepSeek 模型不可用，但 Replay/已验证 staged Pi 路径可用 |

- 当前 `0.4.0` Windows NSIS/MSI 可以安装并运行 Python sidecar，但 Authenticode 状态仍为 `NotSigned`；在取得合法代码签名证书前不得作为公开发布 installer 分发。
- 当前没有 previous-release installer，因此升级/迁移 Golden Path 尚未验证；Tauri updater 也未启用，不能宣传自动更新。
- Release-mode Doctor、packaged PDF 和 staged Provider 的 Pi smoke 已通过；当前开发配置选择的 `deepseek-v4-flash-free` 由上游返回 `model unavailable`，界面应保持失败可见，不应回退成伪造成功。
- [Live Role Intelligence report](docs/evals/reports/2026-09-01-codex-offeru-public-release-live-role.md)：Pi CLI `0.74.0` 的真实网页研究任务未返回结构化结果；Pi/OMP 已 fail closed，不作为 live web research Provider。Codex live 仍需要外部认证。
- 当前 10/10、50/50 浏览器证据使用隔离 Replay/Fixture workspace；这不替代 clean OS 上由独立测试者完成安装、Profile、Job、Resume、Interview、Learning 的人工验收。
- 正常工作区仍有 3 条来源不明的历史 `InterviewNotification.email_body`（共 506 字符）。未取得明确产品/隐私决定前不自动删除；这项残余阻止 Security/Privacy 完整发布结论。

## 外部认证

- Codex live 需要本机有效 OAuth / Provider 登录；未登录时为 `BLOCKED_EXTERNAL_AUTH`，不阻塞 Replay/Fixture 内测路径。
- Gmail、第三方岗位平台和 DSH 需要额外账号、授权或稳定环境，当前属于可选/实验性能力。

## 数据与产品范围

- 默认数据库是本地 SQLite；当前没有云同步、多人协作或云端备份。使用 Settings 中的“一致性备份”保存 SQLite、受管资产和版本 manifest。
- 完整恢复通过 Settings 选择已校验备份并暂存，关闭后重新打开 OfferU 执行恢复；启动前会保留 pre-restore 备份，不应手工覆盖正在运行的 SQLite 文件。
- Settings 的本地数据导出是核心职业数据 JSON，不包含 Provider/邮箱凭据，也不替代完整 SQLite 备份。
- Showcase 是独立的浏览器 IndexedDB 展示模式，数据是虚构的，不能代表后端真实运行能力。

## Resume Workspace

- Resume Workspace 是桌面优先的三栏编辑器，小窗口会压缩布局，但暂不提供完整移动端体验。
- PDF 首选使用 Python Playwright 的 managed Chromium，使打印页与预览共用 React renderer；不探测或启动系统 Chrome/Edge。如果运行环境缺少 managed Chromium 或字体，后端会尝试 ReportLab fallback，仍失败时界面会显示可重试错误。
- Resume 手动编辑不会自动写入 Profile；检测到新职业事实时，后续应通过 Candidate / Evidence review 回流。

## 研究与面试

- Fixture benchmark 和合成公司只用于回归与产品体验，不代表实时市场百分比或真实公司结论。
- 真实网页研究受 Provider、网络和登录墙影响；证据不足时会保留可解释的失败/缺口。
- 面试学习先进入 Observation/Candidate；接受后才进入 Profile，并保留来源与审核账本。

## 外部写入

OfferU 不自动提交职位申请、发送邮件、发布内容或联系第三方。真实外部写入必须由用户在产品边界内明确完成和确认。
