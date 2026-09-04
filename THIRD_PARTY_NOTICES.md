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

最终 RC artifact 必须包含本文件、`RELEASE_NOTES.md`、`LICENSE` 和生成的 checksum；在法律/许可证审阅完成前，发布清单保持 `PARTIAL`。
