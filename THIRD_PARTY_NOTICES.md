# OfferU Third-Party Notices

状态：`RELEASE_CANDIDATE_INVENTORY`。

本文件是发布候选阶段的依赖清单入口，不是法律意见，也不替代对最终 lockfile、二进制 bundle、字体、模型和平台组件的逐项许可证审阅。每次发布必须从当前 lockfile 和实际 bundle 重新生成/核对清单，并随安装包分发适用的版权与许可证文本。

## OfferU

OfferU 自有代码使用本仓库 [MIT License](./LICENSE)。

## Runtime and application dependencies

以下是当前直接依赖入口；传递依赖以对应 lockfile 为准：

- Python/FastAPI/SQLAlchemy/aiosqlite/SQLite runtime：见 `backend/requirements.txt`；
- Python PDF、文档与解析组件：WeasyPrint、ReportLab、PyMuPDF、pypdf、python-docx、BeautifulSoup、markdownify；
- Python Agent/AI 与数据组件：OpenAI、MCP、qdrant-client、python-jobspy、jieba；
- Frontend：React、React DOM、Vite、TypeScript、Tauri CLI、NextUI、TipTap、Puck、React PDF、FullCalendar、MediaPipe、dnd-kit、Framer Motion、Recharts、SWR 和 Lucide；
- Agent runtime：Pi AI / Pi Coding Agent、Claude Agent SDK、TypeBox；
- Desktop runtime：Tauri、Rust crates、WebView2 和随平台提供的系统组件。

## Required review flags

- `PyMuPDF`、`python-jobspy`、字体、浏览器/WebView2 和模型/Provider 的分发许可必须在选择正式公开渠道前由产品所有者核对；
- 仅通过 npm/pip 的 vulnerability audit 不能证明许可证合规；
- 只把实际随 installer 分发的依赖、二进制和资源列入最终 signed artifact notice，并保留对应 source/license URL 或文本；
- 若某 Provider、模型或第三方 Capability 需要独立条款或账号授权，不得把它包装成 OfferU 自有能力。

## Verification source

- `frontend/package-lock.json`
- `agent-runtime/package-lock.json`
- `backend/requirements.txt`
- `frontend/src-tauri/Cargo.lock`

最终 RC artifact 必须包含本文件、`CHANGELOG.md`、`LICENSE` 和生成的 checksum；在法律/许可证审阅完成前，发布清单保持 `PARTIAL`。

## Migrated OfferU Agent source

Python Agent primitives and React tool-stream reducer/view were migrated from
[luyishui/OfferU](https://github.com/luyishui/OfferU), commit
`3a446ff941da66000ba2cc24e5d2e5d19cd3a2e5`, under MIT. Copyright (c) 2025 Chunxu Han.
The complete original license is preserved in `backend/app/agent/LICENSE`.
Adaptation details are recorded in `backend/app/agent/UPSTREAM.md`.

## 简历「纸」模板相关

- **tw93/Kami**（MIT）：「纸」模板的版式参数参考其 `design.md` 与简历模板。https://github.com/tw93/Kami
- **仓耳今楷 TsangerJinKai02 W04/W05**：Kami 使用的中文字体。**仅限个人非商业使用**，商用需向仓耳字库购买授权。默认不使用；只有用户在「排版 → 字体」里主动选择今楷后，才从 jsDelivr / GitHub 下载到本机数据目录。默认字体是随应用附带的思源宋体（见下）。
- **Noto Serif SC / 思源宋体**（SIL Open Font License 1.1）：随应用附带，`frontend/src/assets/fonts/`，从 Noto Serif CJK 裁剪到 GB2312 字符集并转为 woff2，Regular / Medium 各约 3.4 MB。https://github.com/notofonts/noto-cjk
- **xioajiumi/Chinese_Universities**（MIT）：校徽来源。约 800 所学校的校徽缩到 160px、64 色 PNG 后随应用附带（`backend/app/assets/school_logos/`，约 5.7 MB），匹配时不联网。校徽本身的权利归各高校所有，仅用于用户自己的简历。
