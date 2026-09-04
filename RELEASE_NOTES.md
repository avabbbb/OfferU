# OfferU 0.4.0 Release Candidate Notes

状态：`INTERNAL_RELEASE_CANDIDATE`，不是公开发布版本。

## 本候选版本包含

- local-first Profile、Job、Application、Today 和 Pipeline 工作流；
- Job 上下文中的 Role Intelligence、Resume Workspace、Application Packet 和 Interview Learning；
- Resume 手动编辑、AI Proposal diff、stale protection、版本和 PDF 导出；
- Python sidecar、Operation Registry、Replay/Fixture 验收路径、Doctor 和本地数据备份/恢复边界；
- Windows NSIS/MSI bundle。

## 当前已验证

- Windows 安装、卸载、重装和 sidecar health/integrity smoke；
- Replay/Fixture 核心浏览器路径和 Resume Conflict 路径；
- 失败可见、保存重试、SQLite integrity、结构化导出和本地恢复路径。

## 发布前仍需完成

- 合法代码签名证书和签名验证；
- previous-release upgrade/migration 与真正 clean-machine 人工验收；
- 完整隐私/保留期限/删除语义和历史本地数据决定；
- live Role Intelligence Provider 的真实 E2E；
- 2 小时或完整代表性 worker/browser soak、远程 CI tag 验证和最终产品所有者验收。

在上述 Gate 全部通过前，不要把本文件或当前 bundle 当成公开下载版本。
