> 已归档（2026-10-21）：本文不再是当前权威，只用于考古。当前文档：09-quality-and-release.md（位于 docs/）。2026-09-19 对抗评审的历史证据，评分与缺陷只属于当时代码。

# Extension（WXT Chrome 扩展）对抗评审 — 2026-09-19

## 结论（对照 Apple 上线水准一句话定性）

工程骨架认真（签名规则包、按需权限、错误脱敏、防误开浏览器护栏都在），但**「加入购物车→同步」这条主链路存在真实的静默降级与卡死路径**，且 shipped 的 popup 把后端端口写成 8765——离 Apple 水准的「不出错、出错必可见」还有明确差距。

## Findings

| ID | Sev | Type | 位置 | 证据 | 问题 | 建议修法 |
|----|-----|------|------|------|------|---------|
| EXT-01 | P1 | bug | `extension/src/background.ts:1489-1493,1501-1517,1902-1918` | 所有 storage 触底的 handler 用 `.then(sendResponse)` 无 rejection 分支：`mergeJobs(...).then((result)=>{sendResponse(result)})`，无 `.catch` | `chrome.storage.local` 失败（quota/损坏）时 `sendResponse` 永不调用 → popup `sendBackgroundMessage` 挂死 → 「同步中...」「处理中...」按钮永久卡死、无任何错误提示 | 统一给每个 `.then` 链补 `.catch(err=>sendResponse({ok:false,error:safeExtensionError(err)}))`；或包一层 `respond(promise, sendResponse)` helper |
| EXT-02 | P1 | bug | `extension/src/background.ts:1427-1437` + `extension/scripts/sync-root-build.mjs:8-18` + 文件系统 | `chrome.scripting.executeScript({files:["page-agent.js"]})`；根目录无 `page-agent.js`；SYNC_TARGETS/REQUIRED_OUTPUTS 均不含它 | Page Agent 注入永远失败 → `fallback:true` 静默回退旧 content-script 路径。功能上能采集，但「规则包采集」整条新链路在 shipped build 里是死代码，且失败被完全吞掉 | ① 把 `page-agent.js` 加进 SYNC_TARGETS 与 REQUIRED_OUTPUTS；② 注入失败时在 `showMessage` 里带一句「规则包通道不可用，已用兼容模式采集」而不是完全静默 |
| EXT-03 | P1 | ux | `extension/popup.html:148` vs `extension/static/popup.html:92` | 根（=WXT 输入源）placeholder=`http://127.0.0.1:8765`；static 副本=8766；代码 DEFAULT=8766 | shipped popup 设置页提示用户后端是 8765，真实是 8766。虽然 `normalizeOfferUServerUrl` 会纠偏，但文案撒谎是产品级 doc drift | 改根 popup.html placeholder 为 8766；考虑在 sync-root-build 加「端口 marker 一致性」检查 |
| EXT-04 | P1 | ux | `extension/src/popup.ts:2010-2055,2110-2148` + backend 无此路由 | `fetch(.../api/feedback)`、`fetchJson(.../api/extension/version)`；`grep -rn "api/feedback\|extension/version" backend/app/` 零命中 | 两个按钮调的后端端点不存在。反馈失败时写入 `offlineFeedbackQueueV1`（popup.ts:1989-2008），**全代码库无任何读取/重传该队列的地方**——「反馈已离线暂存，后端恢复后可统一上报」是假成功；「检查更新」永远 404→「更新源返回异常」 | 后端补 `/api/feedback` 与 `/api/extension/version`，或前端删除两个入口；离线队列要么加 flush-on-startup，要么改文案为「提交失败」 |
| EXT-05 | P2 | ux | `extension/src/popup.ts:2458-2461` + popup.html:243-248 | `autoSyncToggle` change 只写 `uiSettings.autoSync`；全代码库无消费方 | 「自动同步」开关是纯摆设：打开它什么都不会自动同步 | 实现（listen JOBS_COLLECTED → syncToServer）或删除该开关 |
| EXT-06 | P2 | ux | `extension/src/popup.ts:846-855,1049-1061` | toast 3.6s 自动消失；cart tab 无常驻后端状态指示；`checkServerConnection` 只写 settings tab 里的 dot | 后端宕机时：cart tab 照常显示岗位、可点「一键同步」，失败后只有 3.6s 红色 toast，之后无任何「后端离线」痕迹。用户极易误以为已同步 | cart tab 顶部加一条常驻「后端离线」条；或 sync 失败时把状态钉在 syncBtn 旁边不消失 |
| EXT-07 | P2 | perf | `extension/src/content.ts:3831-3872` + manifest `matches:["<all_urls>"]` | `createFloatingDock(null)` 无条件注入；`MutationObserver(document.body,{subtree:true})` → 220ms debounce `run()` | 每个网页（银行、邮箱、内网）都被塞一个悬浮 dock + 全 DOM 子树 MutationObserver。最小权限原则在「权限」上做到了，在「注入面」上没做到 | content script matches 收敛到 5 个招聘站；或 `run()` 里 `if(!platform && !existingDock) return` 再注入 dock（dock 在非招聘站没有功能意义） |
| EXT-08 | P2 | ux | `extension/src/popup.ts:1326-1333` | `fetchJson` 非 ok 时 `throw new Error(text || HTTP)`——把响应 body（可能是整页 HTML 错误页）塞进 toast；虽有 safeExtensionError 截断 240 字符，用户仍看到一堆 HTML 残渣 | 后端 5xx/404 时错误文案是原始 body 前 240 字符，非人话 | `fetchJson` 对非 JSON 错误统一兜底 `HTTP <status>`，仅 JSON body 取 `detail` |
| EXT-09 | P2 | security | `extension/manifest.json` / `wxt.config.ts:25-29` | `permissions` 静态含 `cookies`；`optional_host_permissions:["https://*/*","http://*/*"]` 全量 | `cookies` 只为「连接 BOSS 登录态」一个可选功能服务，却 install-time 全量授予（可读写所有站点 HttpOnly cookie）；optional_host_permissions 双星过于宽泛，与「按需申请 zhipin」的意图不符 | `cookies` 移入 optional_permissions 随 BOSS 授权一起请求；optional_host_permissions 收敛为 5 个招聘站域名列表 |
| EXT-10 | P3 | doc | `extension/package.json:12-13` + `extension/README.md:52,61` | `build:legacy`/`watch:legacy` 调 `scripts/copy-static.mjs`——文件不存在；README 列 `tests/` 目录——不存在 | 死脚本 + 漂移文档 | 删两条 legacy script 与 README 对应行 |
| EXT-11 | P3 | arch | `extension/offscreen/` vs `extension/public/offscreen/` vs `extension/static/offscreen/` | 三处 identical clipboard.js/html | 三份拷贝，改一处忘另两处 | 保留 `public/offscreen`（WXT 约定），删另两份与 `STATIC_SYNC_TARGETS` 里的 `offscreen` 项 |
| EXT-12 | P3 | ux | `extension/src/popup.ts:2750` + `checkBossSession` 1893-1911 | bootstrap 时 `void checkBossSession()` 每次开 popup 都打 `/api/config/boss-status`；未配置时显示红色 error dot「未连接」 | 「未配置」被渲染成红色错误态，制造假警报；且每次开 popup 多打一次后端 | 未配置用灰/中性态；后端不可达才红；或缓存上次状态仅按需刷新 |
| EXT-13 | P3 | security | `extension/src/rule-packs/remote.ts:11-21` + `extension/scripts/keys/private.jwk` | 私钥在 `scripts/keys/` 但 `.gitignore` 覆盖 `scripts/keys/` 且 `git ls-files` 无记录 | 设计正确（私钥不入库、ECDSA 验签、版本递增、熔断），但公钥 JWK 硬编码、换钥需改代码重发版——运维负担备注 | 无需代码改动；README/ADR 里写清换钥流程即可 |
| EXT-14 | P2 | bug | `extension/src/background/offeru-control-http.ts:99,149-159,162-212` | `plans` 是 service-worker 内存 `Map`；`prepareJobImport` 存 plan → `confirmJobImport` 读 plan | MV3 service worker 随时被回收：prepare 与 confirm 之间 SW 重启 → `plans.get(planId)` 空 → confirm 返回全 0、静默丢整个批次（`perItem:[]`、createdCount:0），popup 显示「已同步 0 条」且 `confirmedHashKeys` 为空 → `syncToServer` 走 `ok:false` 分支报错——错误可见但语义误导 | `syncToServer` 目前 prepare+confirm 在同一调用内（background.ts:1379-1380），风险窗口小但存在；更稳：把 candidates 直接放进 plan 对象经 sendResponse 传回，或合并为单个 `importJobs(candidates)` |
| EXT-15 | P2 | design | `extension/src/background/server-url.ts:16-20` | `LOCAL_HOSTS` 命中即 `return DEFAULT_OFFERU_SERVER_URL` | 用户在设置里填 `http://localhost:9999`（端口转发/远程容器场景）被静默改写成 8766 且提示「设置已保存」——配置不生效无提示 | 保存时若 normalize 改变了用户输入，toast 应说明「已规范化为 127.0.0.1:8766」；或允许非标准本地端口 |
| EXT-16 | P3 | ux | `extension/src/popup.ts:755-767` + popup.html:222 | `desktopDockerPort` input `readonly` + `normalizeOfferUFrontendPort` 永远返回 "7410" | UI 留着一个不可编辑的「端口输入框 + 保存按钮」——保存按钮点了没意义（值永远 7410），是认知噪音 | 删掉保存按钮/输入框改静态文案 |

## Save-job 链路故障点清单（网页抓取 → 后端 → 反馈）

```
content.ts collectFromCurrentContext ──► mergeJobs(JOBS_COLLECTED) ──► popup "已加入"
        │                                    │
        │ ① 平台未识别→文案提示 ✔            │ ② storage 写失败→sendResponse 永不调用→popup 挂死 [EXT-01]
        │                                    │
        ▼                                    ▼
popup "+ 加入购物车" ──► COLLECT_VIA_PAGE_AGENT ──► page-agent.js 不存在→fallback 旧路径（静默）[EXT-02]
        │
        ▼
popup "一键同步" ──► SYNC_TO_SERVER ──► prepareJobImport（内存 Map）[EXT-14]
        │                                    │
        │                                    ▼
        │                          confirmJobImport → POST /api/jobs/ingest
        │                                    │ ③ 后端宕→AbortError 15s→"同步超时"toast 3.6s 消失 [EXT-06]
        │                                    │ ④ HTTP 非 ok→"HTTP <status>（错误ID）"可见 ✔
        │                                    │ ⑤ 200 但无 per-key 确认→"已保留本地队列" ✔
        │                                    │ ⑥ perItem 部分 failed→无逐条失败原因透出 [INFERENCE: 后端只回 key 列表，无原因字段]
        │                                    ▼
        │                          retainUnsynced → saveJobs → "已同步 N 条"
        ▼
   全程无持久化 sync 状态/重试队列：失败的岗位留在本地购物车靠用户再点一次
```

**链路验证结论**：契约本身（IngestJobPayload↔JobPayload、created/skipped/accepted_hash_keys）与后端 `job_ingest.py` 完全对齐；失败可见性断在 EXT-01（挂死）、EXT-02（静默降级）、EXT-06（toast 即逝）三处。

## Top-5 修复优先级

1. **EXT-01** background 所有 `.then(sendResponse)` 补 `.catch` —— 消除「永久卡死无提示」这一最伤信任的失败模式。
2. **EXT-02** 把 `page-agent.js` 纳入 sync 校验与产物，注入失败时显式降级提示 —— 修好「新采集链路从未上线」。
3. **EXT-04** 砍掉或接通 `/api/feedback`、`/api/extension/version` —— 消灭两处假成功/死按钮。
4. **EXT-03+EXT-05+EXT-16** 清理设置页谎言文案（8765 placeholder、假「自动同步」开关、无用端口输入框）—— 低成本高感知。
5. **EXT-07** content script 注入面收敛到招聘站 —— 最小权限真正落地，顺带消掉每页 MutationObserver 开销。

## 已达标的点（简短）

- 权限模型设计正确：站点权限按需申请（zhipin 仅点「连接 BOSS」时 request），smoke 脚本实测验证 `zhipinGranted===false`。
- 后端 URL 单点归一化 + 健康检查要求 `service==="OfferU"&&runtime==="python"`——防指错本地服务。
- BOSS cookie 三条硬约束执行到位：不写存储、缺 wt2 直接失败、以后端回读为准。
- 规则包 ECDSA P-256 验签 + 版本递增 + 熔断回滚 + 私钥 gitignore（未入库）。
- ingest 幂等键/hashKey 契约与后端完全一致；`X-OfferU-Error-Id` 透传。
- 剪贴板复制有 focus/permission-policy 多级回退（popup.ts:1635-1687），是认真做过的。
- AGENTS.md 合规：`extension/scripts/` 全部 Playwright managed Chromium `headless:true` + 隔离 profile + 拒绝 C: 临时目录，无系统浏览器残留。
