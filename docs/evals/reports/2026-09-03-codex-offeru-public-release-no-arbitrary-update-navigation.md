# OfferU Public Release — update navigation boundary

日期：2026-09-03  
状态：静态实现完成，扩展构建与浏览器证据待执行

## 目标

继续落实本机入口边界：扩展的“检查更新”不能把后端返回的任意 URL 直接交给浏览器，尤其不能把 `8080` 或其它本地服务当成网页打开。

## 变更

- 扩展更新下载地址现在只接受无 credentials、无显式端口的 HTTPS URL；localhost、回环地址、`0.0.0.0`、无效 URL 和明文 HTTP 都 fail-closed；
- 拒绝不安全更新地址时只显示可读提示，不调用 `chrome.tabs.create`；
- WXT 根目录同步脚本把该保护列为生成 popup 的必需 marker，旧 bundle 不会被同步为正式入口；
- background 通用 HTTP helper 也明确拒绝重定向，避免后端或外部模型请求被错误服务转发；
- 现有 OfferU 网页入口仍固定为 `http://127.0.0.1:7410`，后端为 `http://127.0.0.1:8765`；`8080` 仍只属于可选模型端点；
- 本轮没有启动 Edge/Chrome、没有打开浏览器、没有访问 8080，也没有修改真实用户数据库。

## 验收映射

- GOAL：10–12、37、50–52、84、89–92、96、100–104；
- Release Checklist：R10–R12、R37、R50–R52、R84、R89–R92、R96、R100–R104；
- 用户入口：不安全更新响应只能形成可读失败，不能创建错误网页标签。

## 尚未执行

按 `AGENTS.md`，本轮没有运行前端/扩展构建、测试、语法检查、远程 runner 或浏览器流程。现有 `.output` 仍可能是旧构建物，必须后续执行正式扩展构建后检查；该切片不提升 Public Release Gate。
