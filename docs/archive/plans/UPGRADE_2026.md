# OfferU 2026 技术栈升级方案

> 编写日期: 2026-06-29  
> 前置文档: `docs/ALIGNMENT_2026.md`  
> 执行顺序: Phase 1 (React 19) → Phase 2 (Next.js 16) → Phase 3 (FastMCP 3) → Phase 4 (LLM 运行时配置) → Phase 5 (前端 LLM 设置页)

---

## 0. 当前状态

| 组件 | 当前版本 | 目标版本 | 风险 |
|------|---------|---------|------|
| React | 18.3.0 | 19.2.x | 🟡 中 — 需验证 NextUI/TipTap/dnd-kit/FullCalendar/framer-motion 兼容 |
| Next.js | 14.2.0 | 16.2.x | 🟢 低 — 全站 `"use client"`，无 server component params，无 middleware |
| MCP SDK | mcp>=1.27.0 | fastmcp>=3.0 | 🟡 中 — import 路径变更 + 构造器 kwargs 移除 |
| Tailwind CSS | 3.4.0 | 保持 3.4.x | 🟢 不动 — HeroUI v3/Tailwind v4 迁移是独立决策，不在本次范围 |
| NextUI | @nextui-org/react ^2.4.0 | 保持 ^2.4.x | 🟢 不动 — v2.4+ 已合并 React 19 支持(PR #4010) |
| TipTap | ^2.6.0 | 保持 ^2.6+ | 🟢 已支持 React 19 |
| SQLAlchemy | 2.0.35 | 保持 2.0.35 | 🟢 2.1.0b3 仍为 beta，不急 |

### 代码库扫描结论（降低风险的关键发现）

1. **Next.js 16 async params: 零影响** — 全站 41 个页面均为 `"use client"`，使用 `useParams()` / `useSearchParams()` hooks，不存在 server component 接收 `params`/`searchParams` props 的情况
2. **middleware→proxy: 零影响** — 项目中无 `middleware.ts` / `proxy.ts` 文件
3. **next.config.js: 极简** — 仅 `output: "standalone"` + `distDir` phase 切换，无自定义 webpack/Turbopack 配置
4. **layout.tsx: server component 但仅接收 `children`** — 不涉及 `params`/`searchParams` props
5. **FastMCP: 3 个精确触点** — import 路径、构造器 kwargs、main.py 挂载逻辑

---

## Phase 1: React 18 → 19

### 1.1 依赖升级

```bash
cd frontend
npm install react@^19.2.0 react-dom@^19.2.0
npm install -D @types/react@^19 @types/react-dom@^19
```

### 1.2 兼容性验证矩阵

| 库 | 当前版本 | React 19 兼容 | 备注 |
|----|---------|--------------|------|
| @nextui-org/react | ^2.4.0 | ✅ | PR #4010 已合并 React 19 支持，`^2.4.0` 会拉取最新 v2.x patch |
| @tiptap/react | ^2.6.0 | ✅ | 2.6+ 已更新 peer dep 支持 React 19 |
| @dnd-kit/core | ^6.3.1 | ✅ | 使用 refs，不依赖 React 内部 API |
| @fullcalendar/react | ^6.1.10 | ✅ | 标准 wrapper，无 React 版本耦合 |
| framer-motion | ^11.0.0 | ✅ | 11.x 已支持 React 19 |
| @react-pdf/renderer | ^3.4.5 | ⚠️ 需验证 | 3.x peer dep 可能未更新，构建时看是否有 peer warning |
| recharts | ^2.12.0 | ✅ | 2.12+ 兼容 |
| swr | ^2.2.0 | ✅ | 2.2+ 兼容 |
| html2canvas / jspdf | N/A | ✅ | 非 React 库 |

### 1.3 预期破坏性变更（影响本项目）

- **`ref` 作为 prop**: React 19 中 `ref` 可直接作为 prop 传递，但不会破坏现有 `forwardRef` 用法（仅废弃警告）
- **`useEffectEvent`**: 新增 API，不影响现有代码
- **React Compiler**: 可选启用，本次不启用

### 1.4 验证步骤

```bash
npm run build   # 无 TS 错误 + 无 peer dep warning
npm run dev     # 手动验证: 简历编辑(TipTap)、拖拽(dnd-kit)、日历(FullCalendar)、图表(recharts)
```

---

## Phase 2: Next.js 14 → 16

### 2.1 执行 codemod

```bash
cd frontend
npx @next/codemod@latest upgrade
```

codemod 会自动处理:
- `next/image` 默认参数变更
- 旧 API 迁移
- package.json 中 `next` 版本升级

### 2.2 手动处理项

#### 2.2.1 Node 版本
Next.js 16 要求 Node 20.9+。确认 `.nvmrc` 或开发环境 Node 版本。

#### 2.2.2 Turbopack
Next.js 16 默认使用 Turbopack。`next.config.js` 无自定义 webpack 配置，应平滑过渡。  
如果构建有问题，可临时回退: `next dev --no-turbopack` / `next build --no-turbopack`

#### 2.2.3 async request APIs (本项目零影响)
全站 `"use client"`，无 server component `params`/`searchParams` props → 无需修改。

#### 2.2.4 middleware → proxy (本项目零影响)
项目中无 `middleware.ts`，无需重命名。

#### 2.2.5 PPR (Partial PrereNDERING) 移除
项目未使用 PPR，无需处理。

### 2.3 验证步骤

```bash
npm run build   # 关注是否有 deprecation warning
npm run dev     # 验证: 所有路由可访问、API 路由正常、静态资源加载
```

---

## Phase 3: FastMCP 1.27 → 3.x

### 3.1 依赖变更

```bash
cd backend
pip install fastmcp>=3.0
# 从 requirements.txt 移除 mcp>=1.27.0，替换为 fastmcp>=3.0
```

### 3.2 代码变更（3 个文件）

#### 3.2.1 `backend/app/mcp_server.py` — import + 构造器

**变更前:**
```python
# import (line 23-24)
try:
    from mcp.server.fastmcp import FastMCP
    HAS_MCP_SERVER = True
except ImportError:
    ...

# 构造器 (line 58-67)
mcp = FastMCP(
    "OfferU Resume AI",
    instructions=(...),
    stateless_http=True,      # ❌ v3 移除
    json_response=True,       # ❌ v3 移除
)
```

**变更后:**
```python
# import
try:
    from fastmcp import FastMCP
    HAS_MCP_SERVER = True
except ImportError:
    ...

# 构造器 — 仅保留 identity + instructions
mcp = FastMCP(
    "OfferU Resume AI",
    instructions=(...),
)
```

Fallback 类也需同步更新: 移除 `stateless_http` / `json_response` 相关逻辑。

#### 3.2.2 `backend/app/main.py` — 挂载 + lifespan

**变更前:**
```python
# lifespan (line 34-38)
async with mcp_server.session_manager.run():
    yield

# 挂载 (line 87-89)
mcp_server.settings.streamable_http_path = "/"
app.mount("/mcp", mcp_server.streamable_http_app())
```

**变更后:**
```python
# 在文件顶部或 lifespan 前创建 app 实例
_mcp_http_app = mcp_server.streamable_http_app(
    streamable_http_path="/",
    json_response=True,
    stateless_http=True,
)

# lifespan — session_manager 由 streamable_http_app 的 lifespan 管理
# 但 FastAPI mount 不一定传播 lifespan，需保留手动管理
async with _mcp_http_app.session_manager.run():
    yield

# 挂载
app.mount("/mcp", _mcp_http_app)
```

> **注意**: FastMCP 3.x 的 `streamable_http_app()` 返回的 Starlette app 自带 lifespan（包含 `session_manager.run()`）。  
> 但 FastAPI `app.mount()` 不保证传播子 app 的 lifespan，因此保留手动 `_mcp_http_app.session_manager.run()`。  
> 如果 FastAPI 版本支持子 app lifespan 传播，可移除手动管理。

#### 3.2.3 `backend/requirements.txt`

**变更前:**
```
mcp>=1.27.0
```

**变更后:**
```
fastmcp>=3.0
```

### 3.3 `@mcp.tool()` 装饰器变更

FastMCP 3.x 中 `@mcp.tool()` 默认返回原函数（不再返回 Component 对象）。  
当前代码所有 `@mcp.tool()` 用法都是标准模式（装饰函数、直接调用），无需修改。

### 3.4 验证步骤

```bash
# 后端启动
uvicorn app.main:app --reload

# 测试 MCP endpoint
curl http://localhost:8000/mcp/ -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}},"id":1}'

# 通过 Claude Desktop 连接
claude mcp add --transport http offeru http://localhost:8000/mcp
```

---

## Phase 4: LLM 运行时配置化

### 4.1 现状

`backend/app/agents/llm.py` 已有 7-provider 抽象:
- `DEFAULT_BASE_URLS` — 各 provider 默认 API endpoint
- `TIER_MODEL_MAP` — 各 tier (lite/fast/strong) 的默认 model ID（硬编码占位符）
- `_get_client()` — 按 active config 动态创建 OpenAI client
- `chat_completion()` — 统一调用入口

`backend/app/config.py` 已有 `tier_model_map: str` 字段（JSON），可运行时覆盖 `TIER_MODEL_MAP`。

### 4.2 变更内容

1. **`llm.py` `TIER_MODEL_MAP`**: 确认默认值仅作占位符，实际使用 `config.tier_model_map` 覆盖逻辑已正确
2. **`config.py`**: 确认 `tier_model_map` 字段可被前端 API 设置
3. **`routes/config.py`**: 确认已有 LLM 配置 CRUD endpoint（或新增）

### 4.3 不做的事

- 不重构 7-provider 架构（已足够）
- 不绑定任何特定 provider/model
- 不移除 `TIER_MODEL_MAP` 默认值（作为 fallback）

---

## Phase 5: 前端 LLM 设置页

### 5.1 新增页面: `frontend/src/app/settings/llm/page.tsx`

功能:
- 选择 active provider（7 选 1）
- 输入对应 provider 的 API key
- 为每个 tier (lite/fast/strong) 指定 model ID
- 测试连接按钮

### 5.2 后端 API

复用 `routes/config.py` 已有的配置 CRUD，或新增:
- `GET /api/config/llm` — 获取当前 LLM 配置（脱敏 API key）
- `PUT /api/config/llm` — 更新 LLM 配置
- `POST /api/config/llm/test` — 测试当前配置连通性

---

## 执行顺序与检查点

| 步骤 | 内容 | 检查点 | 可回滚 |
|------|------|--------|--------|
| 1 | Phase 1: React 19 | `npm run build` 通过 | `git checkout -- frontend/` |
| 2 | Phase 2: Next.js 16 | `npm run build` + `npm run dev` 通过 | `git checkout -- frontend/` |
| 3 | 提交前端升级 | git commit | `git revert` |
| 4 | Phase 3: FastMCP 3 | `uvicorn` 启动 + MCP endpoint 响应 | `git checkout -- backend/` |
| 5 | 提交后端升级 | git commit | `git revert` |
| 6 | Phase 4: LLM 运行时配置 | config API 读写正确 | — |
| 7 | Phase 5: 前端 LLM 设置页 | 页面可操作 + 保存生效 | `git checkout` |
| 8 | 提交 LLM 配置功能 | git commit | `git revert` |

---

## 回滚方案

### 前端回滚
```bash
cd frontend
git checkout -- package.json package-lock.json
npm install
```

### 后端回滚
```bash
cd backend
git checkout -- requirements.txt app/mcp_server.py app/main.py
pip install -r requirements.txt
```

### 完全回滚
```bash
git revert <commit-hash>
```

---

## 风险登记

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| NextUI v2.4 与 React 19 有 runtime 警告 | 中 | 低 | 不影响功能，console 警告可接受 |
| @react-pdf/renderer peer dep 冲突 | 中 | 中 | 如冲突则 `--legacy-peer-deps` 或升级到兼容版本 |
| Turbopack 构建差异 | 低 | 中 | 可 `--no-turbopack` 回退到 webpack |
| FastMCP 3.x lifespan 传播问题 | 中 | 高 | 保留手动 `session_manager.run()`，已在上文处理 |
| FastMCP 3.x 工具签名变更 | 低 | 中 | 所有 tool 返回 dict，v3 需要类型化返回 — 逐个检查 |

---

## 不在本次升级范围

- HeroUI v3 / Tailwind CSS v4 迁移（独立决策，涉及全站样式重写）
- SQLAlchemy 2.1（仍为 beta）
- React Compiler 启用
- Server Components 迁移（当前全站 client components，是更大的架构决策）
