# Contributing / 参与贡献

Contributions are welcome! / 欢迎提交 PR！

1. Fork the repository / Fork 本仓库
2. Create your branch / 创建分支：`git checkout -b feature/amazing-feature`
3. Commit your changes / 提交：`git commit -m 'Add some amazing feature'`
4. Push the branch / 推送：`git push origin feature/amazing-feature`
5. Open a Pull Request against `main` / 向 `main` 发起 PR

Bug fixes can go straight to a PR. New features and refactors need an Issue first.
Bug 修复可直接提 PR；新功能与重构请先开 Issue。

## What the main repository accepts / 主仓接受什么

- OfferU is a local, single-user app. Business mutations go through the Operation Registry, and configuration goes through `app.config` settings.
  OfferU 是本地单人应用；业务写入走 Operation Registry，配置走 `app.config` settings。
- No affiliate, referral or promotional links. PRs that add them will be closed.
  不接受返佣、推荐或推广链接，此类 PR 会被关闭。
- Changes must pass CI. If you used AI tools, say so in the PR.
  改动须通过 CI；使用 AI 辅助请在 PR 中说明。

## Third-party integrations / 第三方接入

The main repository does not accept integrations tied to a specific third-party or paid vendor (job-data scrapers, hosted actors, paid APIs). Please maintain those in your own repository or fork; the OfferU maintainers do not provide support for them. A community repository or plugin registry will be listed here once it exists.
主仓不接受绑定特定第三方或付费供应商的接入（岗位数据爬虫、托管 actor、付费 API 等）。请在你自己的仓库或 fork 中维护，OfferU 维护者不提供技术支持。社区仓库或插件注册表建立后会在此列出。

Non-integration fixes to existing sources (bugs, security) are still welcome in the main repository.
对现有数据源的非接入类修复（bug、安全）仍欢迎提到主仓。

## Security / 安全

Report vulnerabilities privately as described in [SECURITY.md](./SECURITY.md), not in public Issues.
漏洞请按 [SECURITY.md](./SECURITY.md) 私密报告，勿发公开 Issue。

## License / 许可证

Contributions are released under the [MIT License](./LICENSE). / 贡献内容以 [MIT 许可证](./LICENSE) 发布。
