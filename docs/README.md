# OfferU 文档

| 文档 | 回答的问题 |
| --- | --- |
| [PRD](./PRD.md) | 给谁用、解决什么、做什么不做什么、每个功能怎样算做好 |
| [架构](./ARCHITECTURE.md) | 代码在哪；`packages/core`、`backend-ts` 适配器；网页版 / Worker / 桌面伴侣各能做什么 |
| [系统设计](./DESIGN.md) | 数据怎么存、工具有哪些、Agent 怎么接、撤销怎么做 |
| [开发](./DEVELOPMENT.md) | 装依赖、npm 命令、测试与契约测试 |
| [部署到 Cloudflare](./DEPLOY-CLOUDFLARE.md) | wrangler 部署网页版，零成本的前提 |
| [迁移进度](./backend-ts-migration.md) | Python → TS 各阶段状态、还没迁的 |
| [已知问题](./KNOWN_ISSUES.md) | 当前缺口 |
| 同步（`sync.md`） | 多设备同步：用户自带 S3/R2，端到端加密、增量快照、按记录合并 |
| [视觉系统](./design/visual-system.md) | 新 UI 的视觉与交互 |
| [DOGFOOD](./DOGFOOD.md) | 真实使用中的卡点和偏好 |

规则：

1. 文档和代码不一致时，在同一个 PR 里改对其中一个。
2. 不写会过期的数字（测试数量、commit 号、模型名）。
3. 还没定的事写在 PRD 的「还没定的问题」里，定了就删掉。
4. 过时文档移到 [archive/](./archive/)`<年-月>/`，在该目录的 README 记一笔；只作参考，不再维护。演进脉络见 [发展历史](./archive/development-history.md)。
