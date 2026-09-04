# Extension error projection boundary

日期：2026-09-03

## 目标

收口浏览器扩展中仍会进入用户提示、消息响应、规则包摘要和控制适配器的运行时异常文本。扩展错误不是职业事实，也不应把本机路径、邮箱、凭据或错误服务地址原样带到页面、扩展面板或控制台。

## 变更

- 新增 `extension/src/lib/safe-error.ts`，对未知错误提供固定 fallback、控制字符清理、240 字符上限，以及本机 endpoint、常见 API/token/password/cookie、GitHub/Google credential、邮箱和手机号脱敏。
- Background、Popup、Content、Page Agent、远程规则包、Smart Fill cascade writer 和 `HttpOfferUControl.probe()` 的用户/跨边界错误统一使用该 helper。
- Popup bootstrap console error 也只记录已脱敏文本，不再把原始异常对象写进扩展 console。
- Smart Fill 的 opt-in debug console 只保留计数、状态和运行标识等安全遥测字段；任意表单/简历 payload 不再直接打印。
- 保留剪贴板权限/焦点分类所需的内部比较逻辑；它不向用户或持久化日志输出原文。
- 新增 helper 单元测试和 release architecture contract。

## 端口与浏览器边界

该切片没有改变用户主动打开 `http://127.0.0.1:7410` 的行为；没有调用 `opencode web`，没有启动 Edge、创建浏览器窗口或访问 `8080`。`8080` 仍只可能作为可选模型 API 出现在模型配置中，不是网页入口。

## 未执行

按 `AGENTS.md`，本轮未运行扩展测试、typecheck、WXT build、语法检查或浏览器验收；正式 root bundle 仍必须由受保护的 WXT build 刷新，远程 runner、clean-machine 和全量 artifact/trace matrix 仍未验证。没有修改真实用户数据库。
