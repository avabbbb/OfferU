# Responsive Matrix

## Automated route probe

脚本：`H:\tmp\offeru\adaptive-route-matrix-20260910.py`

浏览器：Playwright managed Chromium，`headless=true`，浏览器运行时和所有产物均位于 `H:\tmp\offeru`。

路由：Today、Jobs、Resume、Applications、Interview、Calendar、Email、Profile、Settings、Studio、Optimize。

视口：

| Bucket | Viewport |
| --- | --- |
| Compact | 320×800、390×844 |
| Medium | 768×1024 |
| Wide | 1440×1000 |

最新结果：`44/44 PASS`，页面级横向溢出 `0`，page error `0`，console error case `0`，未预期 API 响应 `0`。逐页 JSON 和截图位于：

- `H:\tmp\offeru\adaptive-route-matrix-20260910.json`
- `H:\tmp\offeru\adaptive-route-matrix-20260910-artifacts`
- `H:\tmp\offeru\adaptive-route-matrix-foundation-rerun-20260910-result.log`

## Live resize probe

脚本：`H:\tmp\offeru\adaptive-resize-20260910.py`

同一 Email 页面连续调整：`1440×1000 → 1024×768 → 768×1024 → 600×900 → 480×800 → 390×844 → 320×800 → 1440×1000`。

结果：动态 shell 高度始终等于 viewport 高度；文档横向溢出 `0`；同意状态保持；resize 期间 `/api/` 请求 `0`；console/page error `0`。证据：

- `H:\tmp\offeru\adaptive-resize-20260910.json`
- `H:\tmp\offeru\adaptive-resize-20260910-artifacts`

## Known evidence limits

这是空状态/Replay UI 探针。它证明布局、滚动和状态保持契约，不能证明真实 Resume、Gmail OAuth、真实 Provider 模型或真实 Career Profile 长期演化已经完成。严格 Local Agent Golden Path 仍由真实外部输入决定。
