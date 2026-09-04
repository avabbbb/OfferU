# OfferU Browser Extension (MV3)

## 概述
OfferU 浏览器插件用于在招聘网站页面手动采集岗位信息，并同步到本机 OfferU 服务。

关键约束：
- 岗位采集仅支持用户手动触发，并只读取页面 DOM。
- SmartFill 也必须由用户手动触发，填充结束在用户审核，不自动提交表单。
- 默认后端地址为 `http://127.0.0.1:8765`；网页端口固定为 `7410`，不要把 `8080` 等模型服务端口当作网页入口。
- 扩展顶部的“打开 OfferU 网页”只在用户点击且 `7410` 前端健康检查通过后打开 `http://127.0.0.1:7410`；服务未启动时只显示提示，不创建无法连接的浏览器标签。后端 `8765` 只用于 API 通信。

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

根目录的 `popup.html` 是 WXT 的源码入口桥接；构建会把 `src/popup.ts` 打包成实际的 popup 脚本。同步脚本发现 `popup.html` 或 `chunks/` 缺失时会直接失败，不会保留旧的、可能指向不存在脚本的根目录产物。

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

SmartFill fixture 验收只使用 Playwright 自带的 managed Chromium 与临时隔离 profile；首次运行前请执行 `npx playwright install chromium`。浏览器未安装时应直接报告缺失，不会回退到系统 Chrome/Edge，也不会打开可见窗口。

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
确认本机 OfferU 后端服务已启动，且地址可访问：`http://127.0.0.1:8765`。
