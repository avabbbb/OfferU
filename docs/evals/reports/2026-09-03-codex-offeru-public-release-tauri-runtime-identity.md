# OfferU Public Release — desktop runtime identity guard

日期：2026-09-03  
状态：静态实现完成，Rust build/runtime evidence 待执行

## 目标

防止 Tauri 启动后把已经占用 `8765` 的旧开发后端或其它同名服务误认为当前桌面 sidecar，造成版本、数据目录或发布模式混用。

## 变更

- Tauri dev spawn 显式注入 `OFFERU_BUILD_MODE=local-development`、`OFFERU_RUNTIME_MODE=local` 和当前 Rust package version；
- Tauri release readiness 现在要求 health 同时匹配 `status=ok`、`service=OfferU`、`runtime=python`、对应 `build_mode` 和 `CARGO_PKG_VERSION`；
- 已有的 `no_proxy()` 与禁止 HTTP redirect 规则保持不变；
- 本轮没有启动 Tauri、Edge、Chrome 或任何可见浏览器，也没有访问 8080 或修改真实数据库。

## 验收映射

- GOAL：3、4、36–38、56–58、84–89、96–97；
- Release Checklist：R36、R37、R39、R55–R58、R84–R89、R96–R97；
- Desktop boundary：只接受与当前构建模式和版本一致的 8765 Python sidecar。

## 尚未执行

按 `AGENTS.md`，本轮没有运行 Rust build、测试、语法检查、远程 runner 或浏览器流程。当前 Tauri contract 需要后续在目标平台真实编译并启动安装包后验证；RustSec `glib 0.18` 上游依赖残余仍未被此改动解决。

因此不能把桌面 runtime identity Gate 提升为 Public Release PASS，签名、clean-machine、upgrade、远程 CI 和完整 provider/restart 矩阵仍未完成。
