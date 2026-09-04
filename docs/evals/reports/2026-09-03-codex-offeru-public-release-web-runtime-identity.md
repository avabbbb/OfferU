# OfferU Public Release — web/runtime identity guard

日期：2026-09-03  
状态：静态实现完成，前端/扩展构建与运行证据待执行

## 目标

避免一个“能返回 HTTP 200 的错误服务”被误认为 OfferU 网页或后端，尤其避免旧端口/旧服务把用户带到无法连接的窗口。

## 变更

- 前端 `BackendReadyGate` 除 `status/service/runtime` 外，要求 8765 health 的版本与当前 Vite package version 一致；
- 扩展打开网页前仍固定探测 `http://127.0.0.1:7410`，拒绝 redirect，并读取响应确认页面包含 OfferU 标识后才允许用户点击触发的 tab；
- 现有 8080 仍不会被探测或导航；自动化与日常诊断继续不启动 Edge/Chrome；
- 本轮没有打开浏览器，没有访问 8080，也没有修改真实数据库。

## 验收映射

- GOAL：10–12、37、56–58、68–70、84、96、100–104；
- Release Checklist：R10–R12、R37、R56–R58、R68–R71、R84、R96、R100–R104；
- Web entry：错误服务只产生可读失败，不创建错误网页标签。

## 尚未执行

按 `AGENTS.md`，本轮没有运行前端/扩展构建、测试、语法检查、远程 runner 或浏览器流程。当前工作区的实际 7410/8765 HTTP 只读健康已确认，扩展正式生成物仍需后续构建后检查。

该切片不提升 Public Release Gate；clean-machine、安装包、远程 CI、签名和陌生用户人工路径仍未完成。
