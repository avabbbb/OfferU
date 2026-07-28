# Issue tracker: GitHub

OfferU 的 Issues 和 PRD 发布到当前 Git remote 对应的 GitHub Issues。所有操作使用 `gh` CLI，并从仓库内运行以自动解析目标仓库。

## Conventions

- 创建：`gh issue create --title "..." --body-file <file>`
- 读取：`gh issue view <number> --comments`
- 列表：`gh issue list --state open --json number,title,body,labels,comments`
- 评论：`gh issue comment <number> --body "..."`
- 标签：`gh issue edit <number> --add-label "..."` 或 `--remove-label "..."`
- 关闭：`gh issue close <number> --comment "..."`

多行正文优先使用临时 body 文件或 PowerShell here-string，避免命令行转义改变内容。发布前必须确认 `gh auth status` 有效。

## Pull requests as a triage surface

**PRs as a request surface: no.**

Pull Request 只承载代码评审，不进入 Issues 的需求分诊状态机，也不因为外部作者身份自动添加分诊标签。

## Skill conventions

- 当技能要求“publish to the issue tracker”时，创建 GitHub Issue。
- 当技能要求“fetch the relevant ticket”时，运行 `gh issue view <number> --comments`。
- GitHub 的 Issue 与 Pull Request 共用编号空间；需要识别类型时先检查 PR，再回退到 Issue。
