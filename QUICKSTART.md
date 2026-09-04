# OfferU Quickstart

## Public Release status

```text
OFFERU_PUBLIC_RELEASE_NOT_READY
```

OfferU 目前尚未提供通过 Public Release Gate 的 signed installer。不要把源码开发命令、Replay/Fixture 路径或 Tauri dev shell 当作公开安装方式，也不要要求普通用户安装 Python/Node、clone repo 或打开终端。

最终 Public Quickstart 只会包含：

```text
Download
→ Verify publisher / checksum
→ Install
→ Launch
→ Onboarding
```

在 installer、Python sidecar、签名、clean-machine、upgrade、backup/restore 和关键 Golden Path 全部通过前，本文件不会提供虚假的公开下载或“忽略未知开发者警告”步骤。

如果仓库根目录存在 `OfferU.exe`，请不要双击它：当前发现的该文件版本是历史 `0.1.0`，不是当前 `0.4.0` Release Candidate，也不是有效的 Public Release 入口。源码开发时只按 [`DEVELOPMENT.md`](./DEVELOPMENT.md) 启动，网页入口固定为 `http://127.0.0.1:7410`；`8080` 不是网页地址。

开发者请使用 [`DEVELOPMENT.md`](./DEVELOPMENT.md)。当前 Release 状态与阻塞项见 [`STATUS.md`](./STATUS.md) 和 [`RELEASE_CHECKLIST.md`](./RELEASE_CHECKLIST.md)。
