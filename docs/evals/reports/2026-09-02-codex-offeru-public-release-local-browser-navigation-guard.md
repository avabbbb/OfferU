# OfferU Public Release — local browser navigation guard

日期：2026-09-02  
结论：`NOT_VERIFIED`

## Scope

收敛本机网页入口，避免停止服务时由扩展创建无法连接的浏览器标签，并避免把模型端点当成 OfferU 网页。网页入口仍固定为 `http://127.0.0.1:7410`，后端为 `http://127.0.0.1:8765`，`8080` 仅保留给可选本地模型 Provider。

## Changes

- 扩展 popup 的 OfferU 网页入口先以 2 秒超时执行 `7410` GET 健康检查；检查失败时显示可理解提示，不调用 `chrome.tabs.create`；
- 扩展 Docker 模式打开路径复用同一 readiness gate，不再直接打开停止中的本机服务；固定端口归一化继续把历史 `8080/8000/7410` 输入收敛到 `7410`；
- Windows `desktop-installed-smoke` 在启动已安装应用前拒绝已有 `8765` listener，并在健康检查后确认 listener owner 的可执行路径位于本次安装临时目录，防止其它本地服务制造假通过。

## Verification boundary

本切片没有启动 Edge、系统浏览器或可见窗口，没有访问 `8080`，也没有修改真实用户数据库。按项目 `AGENTS.md`，扩展构建、测试、语法检查和远程 Windows runner 均未执行；因此扩展正式产物、clean-machine 与 installed smoke 仍不能提升为 Public Release PASS。
