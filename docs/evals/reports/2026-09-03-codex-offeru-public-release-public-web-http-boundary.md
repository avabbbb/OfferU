# OfferU Public Release — Public Web HTTP Boundary

日期：2026-09-03  
状态：`PARTIAL`

## 目标

为无浏览器的公开网页研究兜底链建立可审计的 HTTP 边界，避免系统代理、自动重定向或 DNS 私网解析把 Role Intelligence 研究请求带到错误/私有地址。

## 变更

- `backend/app/services/web_search.py` 的搜索 Provider HTTP client 统一使用 `trust_env=False` 与 `follow_redirects=False`。
- `fetch_readable` 改为最多 3 次手动重定向；每一跳都验证 HTTP(S)、公网主机、受限站点黑名单，并在读取前校验 DNS 解析地址为公网地址。
- 重定向缺少 `Location`、超过次数、指向私网或受限站点时 fail-closed。
- 保留现有公开网页/登录受限平台边界：小红书、脉脉、牛客和 BOSS 仍需用户授权的只读浏览流程，不由该 HTTP 兜底链直接抓取。
- 新增 release architecture contract，锁定直接连接、重定向上限和 DNS/黑名单检查。

## 8080 / 浏览器边界

- 该切片只处理后端公开网页 HTTP 请求，不打开任何浏览器。
- OfferU 网页入口仍为 `http://127.0.0.1:7410`，后端仍为 `http://127.0.0.1:8765`。
- `127.0.0.1:8080` 仍只是可选模型 API，不是网页地址；本轮没有访问 8080，也没有启动 Edge 或可见浏览器。

## 未执行

按照 `AGENTS.md`，本切片未运行测试、构建、语法检查或浏览器验收；新增 contract 和真实 Provider/network 矩阵仍待执行。Public Release 继续为 `OFFERU_PUBLIC_RELEASE_NOT_READY`。
