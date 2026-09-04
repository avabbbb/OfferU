# OfferU Public Release — Job Search Plugin HTTP Boundary

日期：2026-09-03  
状态：`PARTIAL`

## 变更

`plugins/job-search` 的公开 Arbeitnow 数据源现在使用独立的 urllib opener：

- `ProxyHandler({})` 禁止继承系统代理；
- `HTTPRedirectHandler` 被显式替换为拒绝重定向的 handler；
- 插件输出的岗位链接只接受公开 HTTP(S) URL，拒绝凭据、本机主机、私有 IP 和非 HTTP(S) scheme；
- 插件仍然只读取固定的 `https://www.arbeitnow.com/api/job-board-api`，不访问 OfferU 本地网页入口。

这使插件的公开数据采集边界与后端受控研究路径保持一致，错误不会被系统代理或自动跳转带到本地端口、`8080` 或未授权地址。

## 未完成验收

本轮只完成代码与静态 contract；没有运行插件、测试、构建、网络 Provider、浏览器或打包验收。OfferU 网页仍固定为 `http://127.0.0.1:7410`，后端为 `http://127.0.0.1:8765`；没有启动 Edge、创建浏览器窗口或访问 `8080`。

真实 Arbeitnow 可用性、10 岗位 Role Intelligence 矩阵、插件构建产物和 Public Release 动态 Gate 仍未通过。

同时，正式 `audit_architecture.py` 已纳入后端公开研究与 `job-search` 插件的传输边界检查；如果未来恢复默认代理、自动重定向、普通 `urlopen` 或移除本机 URL 过滤，架构审计会 fail-closed。
