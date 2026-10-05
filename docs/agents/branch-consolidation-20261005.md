# 本地分支整理与后续合并

核对时间：2026-10-05。用户选择先整理本地分支，远端另列清单。

本地分支已从 **29 条减少为 3 条**。本次是 Git 分支整理，未将尚未验收的业务代码合入 main，也未将 Proposal v2 切换到原工作区。

## 保留的三条分支

| 分支 | 核对时 HEAD | 职责 |
| --- | --- | --- |
| `main` | `265cad5f49c1d68bd82bcd97a28d915881689200` | 与核对时 `origin/main` 对齐 |
| `feat/agent-contract-desktop-binding` | `588d86082e99323da15fb5dd584916d3d938471a` | 原项目当前开发分支；用户未提交改动保留 |
| `codex/proposal-v2-integration-20261002` | `cf8deae627a8fbdb3debb66d620d4010acf420ed` | 隔离 Proposal v2 集成实现；完整交付验收未完成 |

后续按这三个职责管理分支，临时子代理和评审使用 detached worktree，不再永久留下命名分支。

## 为什么会累积

- `pr-1`、`pr9`–`pr12`、review 和旧 docs 分支来自历史评审或 PR。
- `codex/main-green`、CI 修复、PR40 和多个 Agent 接入分支来自不同阶段实验；部分仍有独有提交。
- Proposal v2 增加了基线、五个 worker、集成和 successor review 分支。worker 内容经 cherry-pick 和后续修正进入集成分支后，原引用没有及时归档。
- 多条分支共享历史。分支提交数不能相加计算独立工作量；`git cherry` 的不等价补丁也不必然代表功能缺失，可能已有修订版实现。

## 已执行的整理与保留证据

1. `git fetch origin --prune` 核验当前远端，未推送、删除远端分支或修改 PR。
2. 对全部 29 条本地分支记录 SHA、上游、祖先关系、相对集成分支的 patch-id，以及 19 个 worktree 的状态。
3. 创建完整 Git bundle，`git bundle verify` 通过。
4. 旧分支关联 worktree 在原 HEAD 上转为 detached；目录、索引、已暂存/未暂存差异和未跟踪文件保留。
5. 以原 SHA 校验的原子 ref transaction 移除 26 条本地分支引用。旧 main `6e419230cf809b9717026d2b2785811bdc437a92` 已在归档中；其 `.temp/main-wt` 留在原 HEAD，原文件保留。
6. 所有 worktree 的 HEAD、状态、已暂存/未暂存差异和修改文件内容指纹，整理前后完全一致。原开发分支和 Proposal v2 集成分支 SHA 不变。
7. 在 `H:/tmp/offeru/branch-audit-20261005/restore-proof.git` 恢复全部 29 个原分支，逐个 SHA 比对通过。只读核验远端 tracking refs 未被整理过程修改。

主工作区在比对后新增了本说明及 AGENTS 分支规则，这是本轮明确的文档修改；原业务改动未被覆盖。未运行业务测试，因为此次未修改业务代码。

## 归档及恢复

持久归档：

`H:/WorkSpace_For_VsCode/Python/OFFERU/.git/archives/branch-consolidation-20261005/`

其中包含：

- `local-branches-before-cleanup.bundle`：全部原分支提交历史。
- `audit.json`：原分支与 worktree 清单，独有补丁仅作待审线索。
- `cleanup-result.json`：移除引用、保留引用、旧 main 和验证记录。
- `worktree-fingerprints-before.json` / `worktree-fingerprints-after.json`：差异和文件指纹；它们不是未提交文件内容备份，原文件仍在对应 worktree 中。
- `verification.json`：全部原分支恢复比对结果。

Bundle SHA-256：`0e058d5265d749568bf48f32e919b16b9ed3d051172d42b976d935a0908bc1c4`。

需要回看归档分支时，在原仓库执行下例。它只取回提交并创建新的 detached worktree，不增加第四条本地分支；目标目录必须尚不存在：

```powershell
git fetch "H:/WorkSpace_For_VsCode/Python/OFFERU/.git/archives/branch-consolidation-20261005/local-branches-before-cleanup.bundle" refs/heads/feat/s0-state-runtime-integrity
git worktree add --detach "H:/tmp/offeru/recovered-s0-20261005" FETCH_HEAD
```

此方式恢复的是已提交状态。旧 worktree 中的未提交文件仍需另外审查，不能用 bundle 代替；不要清理这些目录。

## 后续业务代码如何合并

按完整可验收切片整合，不能为了减少分支机械 merge 全部历史：

1. **当前开发分支与 main**：当前分支包含 main，另外有两次交接/验收文档提交；大量未提交业务修改需先按用户工作区实际差异核对。main 本轮只对齐远端，没有接收这些修改。
2. **Proposal v2 → 当前开发工作区**：从原用户状态快照 `fac78f6844de8b4b7ab80a81b335a94576c24355` 提取迁移差异。先核对后续用户改动和必要检查，再逐项合回；不能把包含用户旧改动的整份快照合回，也不能宣称隔离测试通过就已交付。
3. **S0 / Agent 接入 / Profile Discovery**：分别审查当前代码是否已实现等价功能、与 Proposal v2 权威路径的冲突、直接依赖和验收。S0 仍有独有提交与未提交文件；旧 main 的首次 Profile Discovery、旧 CI/PR40 等也仅归档，不宣称已集成。
4. **验收后进入 main**：业务切片通过相应自动检查、人工边界按实际证据记录后，再按仓库流程合并。仍未达到的真实 Desktop/安装升级要求保持明确状态。

五个 Luna 分支的原提交全部可恢复。A/B/D/E 在 patch-id 核对中没有额外不等价提交；C 的 `1fdd754` 有一项不等价补丁，历史已包含其续跑租约实现和后续修订，仍需按行为核对，不能因此重复机械应用。

## 远端清单：本轮未整理

核对时远端共有 **19 条真实分支**，不计符号引用 `origin/HEAD`。下表用于下一次独立整理；开放 PR 状态来自本轮 `gh pr list`，不是 CI 通过记录。

| 远端分支 | 当前关联 / 后续处理 |
| --- | --- |
| `main` | 保留 |
| `feat/agent-contract-desktop-binding` | Draft PR #47；当前开发基线，远端落后于本地 |
| `fix/resume-design-delivery` | Draft PR #46；也是 #47 的 base，删除前必须处理依赖 |
| `feat/host-neutral-offeru-contract` | Draft PR #48；#49 的 base |
| `feat/desktop-agent-verified-access` | Draft PR #49；#50 的 base |
| `feat/contextual-codex-career-runs` | Draft PR #50；Agent 接入堆叠链需整体核对 |
| `feat/proactive-career-director` | Open PR #33；远端与被归档本地引用的历史不同，不按本地已包含就删除 |
| `feat/s0-state-runtime-integrity` | S0 集成待核对；本地归档还包含未推送提交 |
| `feat/unified-local-agent-link` | 未在当前 open PR 清单中，待核对提交与关闭记录 |
| `feat/unified-local-runtime-entry` | 同上 |
| `docs/career-ops-loop-2026-10-01` | Open PR #51；产品定义需按当前 authority 审查 |
| `docs/skill-memory-contract-20260929` | 未在当前 open PR 清单中，待核对 |
| `review/pr51-assessment-588d860` | 评审引用，与本地开发 HEAD 相同；远端未删除 |
| `ci/one-click-macos-dmg-main-20260927` | Open PR #35；平台构建需独立验收 |
| `dependabot/npm_and_yarn/agent-runtime/ip-address-10.7.2` | Open PR #45 |
| `dependabot/npm_and_yarn/extension/brace-expansion-1.1.21` | Open PR #38 |
| `dependabot/npm_and_yarn/extension/multi-835f9d9d35` | Open PR #37 |
| `dependabot/npm_and_yarn/extension/vite-8.3.1` | Open PR #36 |
| `dependabot/npm_and_yarn/extension/postcss-8.5.28` | Open PR #34 |

远端若也要收敛为三条，需要另行处理堆叠 PR 的 base/head、待验收功能和 Dependabot 自动建分支策略；本轮没有这些写入或删除动作。
