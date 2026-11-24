# OfferU Third-Party Notices

状态：`RELEASE_CANDIDATE_INVENTORY`。

本文件是发布候选阶段的依赖清单入口，不是法律意见，也不替代对最终 lockfile、二进制 bundle、字体、模型和平台组件的逐项许可证审阅。每次发布必须从当前 lockfile 和实际 bundle 重新生成/核对清单，并随安装包分发适用的版权与许可证文本。

## OfferU

OfferU 自有代码使用本仓库 [MIT License](./LICENSE)。

## Runtime and application dependencies

以下是当前直接依赖入口；传递依赖以对应 lockfile 为准：

- TS 后端 / 桌面伴侣：Hono、@hono/node-server、fast-png、jpeg-js、可选 playwright-core（见 `backend-ts/package-lock.json`）；桌面安装包附带 Node.js 运行时（MIT 及其附带的第三方许可）；
- Frontend：React、React DOM、Vite、TypeScript、Tauri CLI、NextUI、TipTap、Puck、React PDF、FullCalendar、MediaPipe、dnd-kit、Framer Motion、Recharts、SWR 和 Lucide；
- Desktop runtime：Tauri、Rust crates、WebView2 和随平台提供的系统组件。

## Required review flags

- 随桌面包附带的 Node.js、Chromium（Windows/Linux 无头 PDF）、字体、浏览器/WebView2 和模型/Provider 的分发许可必须在选择正式公开渠道前由产品所有者核对；
- 仅通过 npm 的 vulnerability audit 不能证明许可证合规；
- 只把实际随 installer 分发的依赖、二进制和资源列入最终 signed artifact notice，并保留对应 source/license URL 或文本；
- 若某 Provider、模型或第三方 Capability 需要独立条款或账号授权，不得把它包装成 OfferU 自有能力。

## Verification source

- `frontend/package-lock.json`
- `backend-ts/package-lock.json`
- `extension/package-lock.json`
- `frontend/src-tauri/Cargo.lock`

最终 RC artifact 必须包含本文件、`CHANGELOG.md`、`LICENSE` 和生成的 checksum；在法律/许可证审阅完成前，发布清单保持 `PARTIAL`。

## Migrated OfferU Agent source

Agent primitives (first migrated into the Python backend, now ported to `packages/core/src/agent/`) and the React tool-stream reducer/view were migrated from
[luyishui/OfferU](https://github.com/luyishui/OfferU), commit
`3a446ff941da66000ba2cc24e5d2e5d19cd3a2e5`, under MIT. Copyright (c) 2025 Chunxu Han.
The complete original license is preserved in `packages/core/src/agent/UPSTREAM-LICENSE`.
The Python adaptation notes (`backend/app/agent/UPSTREAM.md`) remain at tag `python-backend-final`.

## 简历「纸」模板相关

- **tw93/Kami**（MIT）：「纸」模板的版式参数参考其 `design.md` 与简历模板。https://github.com/tw93/Kami
- **仓耳今楷 TsangerJinKai02 W04/W05**：Kami 使用的中文字体。**仅限个人非商业使用**，商用需向仓耳字库购买授权。默认不使用；只有用户在「排版 → 字体」里主动选择今楷后，才从 jsDelivr / GitHub 下载到本机数据目录。默认字体是随应用附带的思源宋体（见下）。
- **Noto Serif SC / 思源宋体**（SIL Open Font License 1.1）：随应用附带，`frontend/src/assets/fonts/`，从 Noto Serif CJK 裁剪到 GB2312 字符集并转为 woff2，Regular / Medium 各约 3.4 MB。https://github.com/notofonts/noto-cjk
- **xioajiumi/Chinese_Universities**（MIT）：校徽来源。约 800 所学校的校徽缩到 160px、64 色 PNG 后随应用附带（`backend-ts/assets/school_logos/`，约 5.7 MB），匹配时不联网。校徽本身的权利归各高校所有，仅用于用户自己的简历。
