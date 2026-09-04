# OfferU Public Release — E2E Endpoint Guard

日期：2026-09-02  
状态：静态实现完成，运行证据待执行

## 目标

阻止 public-release 验收脚本把 `8080` 或其它地址误当成 OfferU 网页/后端，避免错误导航、错误服务复用和无法连接的浏览器窗口。

## 变更

- 新增 `backend/scripts/e2e/release_endpoints.py`，统一解析网页 `127.0.0.1:7410` 与 API `127.0.0.1:8765`；
- smoke、empty-state、Interview、worker soak、previous-release migration 五个入口移除直接读取任意 endpoint 环境变量；
- 端口、协议、主机、路径、query、fragment 和 credentials 任一不符合固定 loopback 合约时，在网络请求前抛出明确错误；
- `audit_architecture.py` 现在会拒绝 public-release E2E 直接读取 endpoint 环境变量；新增隔离 contract 覆盖默认地址、8080、非本机、错误协议、路径、query 和凭据误配。
- 扩展根目录同步脚本在复制 popup 前检查 7410 readiness guard、AbortController 和不可连接提示，缺少任一标记就拒绝同步潜在旧 bundle。
- 后续收紧：endpoint guard 的拒绝错误不再回显传入 URL，避免凭据、错误端口（包括 `8080`）或外部主机进入 CI/诊断文本；对应回归契约已落盘。

## 验收映射

- GOAL：10–11、64–70、71–79、103–104；
- Release Checklist：R68、R70、R71、R72、R79、R96、R103；
- AGENTS：固定 7410/8765、8080 非网页、managed Chromium/headless-only 边界。

## 尚未执行

按 `AGENTS.md`，本轮没有运行测试、构建、语法检查、扩展构建、远程 runner 或浏览器。没有启动 Edge、没有打开任何浏览器窗口、没有访问 `8080`，也没有修改真实用户数据库。因此该切片不能单独提升 Public Release Gate；远程 E2E、clean-machine 和正式扩展构建仍待后续验收。
