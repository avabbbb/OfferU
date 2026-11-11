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
