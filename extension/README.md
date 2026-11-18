# OfferU Browser Extension (MV3)

## 概述
OfferU 浏览器插件用于在招聘网站页面手动采集岗位信息，并同步到本机 OfferU 服务。

关键约束：
- 岗位采集仅支持用户手动触发，并只读取页面 DOM。
- SmartFill 也必须由用户手动触发，填充结束在用户审核，不自动提交表单。
- SmartFill 现在是「先预览再填」：第一次点「一键智填」只扫描并生成计划，页面每个字段旁出现灰色预览（将填写什么、来自档案哪一条）和「填入」；点单项、卡片或「填写本页」才写入，填完回读，支持逐项/全部撤销。复杂控件无法自动恢复时标「需手动撤销」，不谎报成功。
- 预览浮层挂在独立 Shadow DOM 里，不往表单 DOM 插节点；只作用于飞书招聘、Moka、北森等公开官网，不碰 BOSS 直聘 / 小红书等风控平台。
- 默认后端地址为 `http://127.0.0.1:8766`；网页端口固定为 `7410`，不要把 `8080` 等模型服务端口当作网页入口。
- 扩展顶部的“打开 OfferU 网页”只在用户点击且 `7410` 前端健康检查通过后打开 `http://127.0.0.1:7410`；服务未启动时只显示提示，不创建无法连接的浏览器标签。后端 `8766` 只用于 API 通信。

## 模型直连（代替 Worker /llm-proxy）
网页版（https://offeru.avabbbb.com，及 localhost 开发页）调用不支持浏览器跨域的模型服务时，原本经 Cloudflare Worker 的 `/llm-proxy` 转发，会消耗 Workers 每日共享额度。装了本扩展后，这类请求改由扩展后台直接发给模型服务：
- 只接受 OfferU 网页（`https://offeru.avabbbb.com`、`http://localhost:*`、`http://127.0.0.1:*`）的顶层页面请求：内容脚本 `src/content/llm-bridge.ts` 只在这些来源安装，后台 `src/background/llm-relay.ts` 再按端口 sender.origin 校验一次。
- 目标白名单与 Worker 完全一致（内置模型服务商的 https 域名 + OpenCode 的 `/zen/`、`/inference/` 路径），不是开放代理；`host_permissions` 由同一份列表生成，只列这些域名。单测会读 `packages/core/src/llm-presets.ts` 和 `backend-ts/src/worker.ts` 校验两边一致——新增服务商时两边一起改。
- 流式：每个请求一条长连接 port，响应以文本块逐段回传（SSE 可边到边显示），页面关闭/取消会中止上游请求；只转发固定的几个请求头/响应头，不跟随重定向，请求体 ≤ 8 MB，不记录 URL 参数、Key 或请求体。
- 网页端（`frontend/src/lib/local/extensionLlm.ts`）先握手确认扩展能力；扩展不在、不支持该域名或在首字节前出错时，自动回退 `/llm-proxy`，行为与以前相同。设置 → 模型服务里显示当前通道「直连（扩展）」或「代理」。
- 网页在需要转发但没检测到扩展时（已知需转发的服务商、即将走 `/llm-proxy`、或代理返回额度用尽的 429）会弹出可关闭的安装提示（可选「不再提醒」）。上架后把商店地址填进 `frontend/src/lib/local/extensionPrompt.ts` 的 `EXTENSION_STORE_URL`；未填时提示指向本 README。

## 安装（未上架商店前）
1. 在 `extension` 目录执行 `npm ci && npm run build`（或从 GitHub Release 下载打好的 zip 并解压）。
2. 打开 `chrome://extensions`（Edge：`edge://extensions`），启用开发者模式，「加载已解压的扩展程序」，选择 `extension` 目录（或解压后的目录）。
3. 刷新 OfferU 网页，设置 → 模型服务显示「跨域通道：直连（扩展）」即生效。

商店上传包：`npm run zip`，产物在 `.output/offeru-job-collector-<version>-chrome.zip`（Chrome Web Store 与 Edge Add-ons 用同一个包）。

## 技术栈
- WXT
- TypeScript
- Manifest V3
- Vitest

## 开发与构建
在 `extension` 目录执行：

```bash
npm install
npm run typecheck
npm test
npm run build
```

`npm run build` 会执行两步：
1. `wxt build` 产出 `.output/chrome-mv3`
2. `scripts/sync-root-build.mjs` 将浏览器加载所需文件同步到 `extension` 根目录

Popup 源码入口是 `src/popup.html`，由它引用 `src/popup.ts` 与 `static/popup.css`。构建后的根目录 `popup.html` 和 `chunks/` 是生成产物，WXT 不会把它们重新当作输入；因此干净 checkout 不需要预先包含旧 hash 的 chunk。同步脚本会在新构建校验成功后更新根目录产物。

## 加载方式（Chromium 浏览器）
1. 打开扩展管理页，启用开发者模式。
2. 选择“加载已解压的扩展程序”。
3. 选择目录：`extension`

注意：插件加载依赖 `extension` 根目录的构建产物，构建后应至少存在：
- `manifest.json`
- `background.js`
- `content-scripts/content.js`
- `popup.html`
- `assets/` 与 `chunks/`

## 常用脚本
- `npm run dev`：WXT 开发模式，只启动扩展 dev server，不自动打开 Edge 或其他浏览器；需要时由开发者手动加载生成目录
- `npm run typecheck`：TS 类型检查
- `npm test`：单元测试
- `npm run build`：生产构建并同步到根目录
- `npm run zip`：打包产物
- `npm run build:legacy`：旧构建链路（tsc + 静态复制）

SmartFill fixture 验收使用 Playwright 的**完整 Chromium**（不是 headless shell；headless shell 不加载扩展）。首次运行前执行 `npx playwright install chromium`。夹具服务器固定监听 `127.0.0.1:8766`，因为扩展会把本机后端地址归一化到 8766；跑之前先确认 8766 没被真实后端占用。需要指定浏览器时用 `OFFERU_FIXTURE_CHROME`，需要可见窗口时加 `OFFERU_FIXTURE_HEADLESS=0`：

```bash
node scripts/smartfill-browser-fixture.mjs
OFFERU_FIXTURE_CHROME="C:/path/to/chrome.exe" node scripts/smartfill-browser-fixture.mjs
```

夹具会验证：预览浮层出现、批量填入、原生字段撤销（复杂控件标「需手动撤销」）。

## 目录说明
- `src/`：核心源码（background/content/popup）
- `entrypoints/`：WXT 入口
- `static/`：静态资源与基础 manifest
- `scripts/sync-root-build.mjs`：构建产物同步脚本
- `tests/`：测试用例

## 排障
### 1) 扩展无法加载
优先检查 `extension` 根目录是否存在 `manifest.json`、`popup.html`、`content-scripts/content.js` 和 `chunks/`，然后重新执行构建。不要把 `8080` 当网页打开，也不需要启动 Edge 来排障。

### 2) 报错“无法为脚本加载 JavaScript”
通常是构建产物路径缺失或未同步，重新执行：

```bash
npm run build
```

### 3) 同步失败
确认本机 OfferU 后端服务已启动，且地址可访问：`http://127.0.0.1:8766`。
