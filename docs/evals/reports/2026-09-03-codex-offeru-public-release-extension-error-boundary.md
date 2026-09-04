# OfferU Public Release — Extension Error Boundary

日期：2026-09-03  
状态：`PARTIAL`

## 变更

扩展的 `HttpOfferUControl` 在后端返回非 2xx 时不再读取或拼接响应正文。错误提示只保留 HTTP 状态码，以及后端明确提供的 `X-OfferU-Error-Id`。这样后端错误正文中的简历、邮箱、Provider 响应或 canary secret 不会被复制到扩展状态或用户可见错误。

同时增加了扩展单元测试和 release architecture contract，验证错误正文不会出现在错误消息中。

## 边界

- 没有改变扩展的网页导航逻辑；OfferU 网页仍只使用 `http://127.0.0.1:7410`。
- 没有访问 `8080`，没有启动 Edge，也没有创建浏览器窗口。
- 根目录生成的旧 `extension/background.js` 未手工修改；正式 WXT 产物仍需通过正式构建链刷新。

## 未执行

按照 `AGENTS.md`，本切片未运行测试、构建、语法检查或浏览器验收。因此该 contract 仍是待执行证据，不能提升 Public Release 动态 Gate。

