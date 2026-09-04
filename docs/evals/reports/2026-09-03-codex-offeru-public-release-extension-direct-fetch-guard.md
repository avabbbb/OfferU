# OfferU Public Release — Extension Direct Fetch Guard

日期：2026-09-03

## 结论

扩展源码的所有已发现直接网络请求现在明确拒绝 HTTP 重定向，避免错误的本地服务或远程规则源把请求自动带到 8080 或其它未授权地址。

## 覆盖范围

- `extension/src/content.ts`：岗位详情补全；
- `extension/src/popup.ts`：简历图片、反馈和已有后端请求；
- `extension/src/rule-packs/remote.ts`：远程规则包；
- `extension/src/background.ts`、`offeru-control-http.ts`：已有共享 HTTP 边界继续保留。

所有请求使用 `redirect: "error"`；失败由现有错误/离线路径处理，不伪造成功，也不创建浏览器标签。

## 当前状态

源码契约已落盘；扩展 typecheck、测试、WXT production build、真实重定向故障和远程 runner 尚未执行，Public Release 仍保持 `NOT_READY`。

本切片未启动 Edge、未创建浏览器窗口、未访问 8080，也未修改真实用户数据库。
