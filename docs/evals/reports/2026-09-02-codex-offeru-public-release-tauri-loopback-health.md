# OfferU Public Release — Tauri loopback health client

日期：2026-09-02  
结论：`NOT_VERIFIED`

## Scope

确保桌面壳检查本地 Python sidecar 时不会继承用户的 HTTP 代理。OfferU 的桌面 readiness 目标是 `127.0.0.1:8765`，不应因外部代理配置造成误判或超时。

## Changes

- `frontend/src-tauri/src/lib.rs` 的 `wait_for_python_backend` 使用 `reqwest::blocking::Client::builder().no_proxy()`；client 创建失败时返回 `false` 并记录 bounded error；
- Tauri security contract 要求 direct-loopback health client 保持 `no_proxy()`。

## Verification boundary

按项目 `AGENTS.md`，本切片写入后没有运行 Rust 构建、测试或语法检查，也没有启动 Edge、访问 `8080`、打开浏览器或修改真实用户数据库。Windows bundle、真实代理环境和远程 installed smoke 仍需验证。
