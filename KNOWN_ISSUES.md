# Known Issues

这些问题不应被误认为核心 Career State 成功或失败。

## 外部认证

- Codex live 需要本机有效 OAuth / Provider 登录；未登录时为 `BLOCKED_EXTERNAL_AUTH`，不阻塞 Replay/Fixture 内测路径。
- Gmail、第三方岗位平台和 DSH 需要额外账号、授权或稳定环境，当前属于可选/实验性能力。

## 数据与产品范围

- 默认数据库是本地 SQLite；当前没有云同步、多人协作或云端备份。请按 `QUICKSTART.md` 在停服后备份。
- 完整恢复由用户执行文件级恢复；恢复前应保留当前数据库副本。
- Settings 的本地数据导出是核心职业数据 JSON，不包含 Provider/邮箱凭据，也不替代完整 SQLite 备份。
- Showcase 是独立的浏览器 IndexedDB 展示模式，数据是虚构的，不能代表后端真实运行能力。

## Resume Workspace

- Resume Workspace 是桌面优先的三栏编辑器，小窗口会压缩布局，但暂不提供完整移动端体验。
- PDF 首选使用 Python Playwright 调用本机 Chrome，使打印页与预览共用 React renderer；如果 Windows 缺少浏览器或字体，后端会尝试 ReportLab fallback，仍失败时界面会显示可重试错误。
- Resume 手动编辑不会自动写入 Profile；检测到新职业事实时，后续应通过 Candidate / Evidence review 回流。

## 研究与面试

- Fixture benchmark 和合成公司只用于回归与产品体验，不代表实时市场百分比或真实公司结论。
- 真实网页研究受 Provider、网络和登录墙影响；证据不足时会保留可解释的失败/缺口。
- 面试学习先进入 Observation/Candidate；接受后才进入 Profile，并保留来源与审核账本。

## 外部写入

OfferU 不自动提交职位申请、发送邮件、发布内容或联系第三方。真实外部写入必须由用户在产品边界内明确完成和确认。
