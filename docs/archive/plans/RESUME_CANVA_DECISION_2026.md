# OfferU 简历编辑器 Canva 化决策文档

**决策日期**: 2026-06-30
**状态**: 已确认方向，待进入 Puck 技术调研与原型阶段
**决策人**: 用户（在 Dario 严格反问模式下确认）
**确认等级**: 4 轮反问 + 实地 Playwright 验证 JadeAI 在线 demo + 联网同步 2026.06 开源现状后定稿

---

## 1. 决策一图

```
旧离线讨论:                 Dario 实地调研后确认:
─────────────                ────────────────────
"WYSIWYG inline 改5模板"  →  ✗ 归一化层截断原生字段，回写不干净
"完全自由 Canva 级编辑器" →  ✓ 真实目标，但与"Fork JadeAI"不可兼得
"Fork JadeAI 嵌入"       →  ✗ JadeAI 实测是 form+preview 非 Canva
"基于 Puck 重写"          →  ✓ 最终路线
```

---

## 2. 真相追溯 (为什么不造 JadeAI / 不造 Reactive Resume)

### 2.1 JadeAI 实测（Playwright 探针 https://jadeai.cturing.cn/zh/editor/2219ce19-...）

- 简历编辑器实际架构：**左侧 input/textarea form (20+ 字段) + 右侧只读 React 渲染预览**
- 全页 0 个 `[contenteditable]` 节点；右侧预览为静态 H1/H2/H3，无 inline 编辑入口
- 宣称的 "Drag & Drop" 仅指 @dnd-kit 在左侧 section 排序
- 宣称的 "Inline Editing" 实际是左侧表单 input，不是预览点击编辑
- 后端 PDF：Puppeteer Core + @sparticuz/chromium（与 OfferU 现有 Playwright+系统 Chrome 同套思路）
- 标签比对：JadeAI 架构 ≈ OfferU 现有简历模块架构，**只是更成熟版本，不是 Canva**

### 2.2 Reactive Resume v5（47K stars 同期在线）

- 同赛道标杆：TanStack Start + Drizzle ORM + Puppeteer PDF + Custom CSS 编辑
- WYSIWYG 范畴但同样不是 Canva
- 是 OfferU 简历模块想达到的"成熟 form+preview 演化目标"，不是 Canva 目标

### 2.3 真正 Canva 级开源 React 框架（2026.06）

| 框架 | Stars | License | API 风格 | 适配度 |
|---|---|---|---|---|
| **Puck** | 12.5K | MIT | `<Puck>` + components config + drag&drop | ⭐⭐⭐ 最适配，活跃度高，Next.js 原生支持 |
| Craft.js | 8.7K | MIT | `<Editor><Frame>` + `useNode` API | ⭐⭐ 经典底层，需更多自定义 |
| GrapesJS | 25.9K | NOASSERTION | HTML 模板 builder，向外暴露纯 HTML | ⭐ license 警告，与 React 集成需 wrap |

### 2.4 最终选择 Puck 的理由

- MIT License，无商用风险
- 原生支持 Next.js App Router（recipe 官方提供）
- React 拖拽/属性面板/撤销重做/预览模式/AI 集成全在核心包
- 数据契约由组件 props 自定义 schema，能与 OfferU 现有 content_json 兼容
- 12.5K stars + 文档完整 + 58.3 万月下载，社区稳定

---

## 3. OfferU 简历模块现状基线（重要复述）

### 3.1 关键文件（Puck 重写后将替换的核心）

```
frontend/src/app/resume/components/
├── ResumePreview.tsx              # 5 模板预览分发器（重写）
├── RichTextEditor.tsx             # TipTap 2.6 StarterKit 封装（复用）
├── SectionEditor.tsx              # 段落折叠 form 编辑（删除）
├── StylePanel.tsx, StyleToolbar.tsx  # 边距/字号/配色等样式面板（→ Puck 属性面板融合）
├── TemplateSelector.tsx           # 5 模板切换器（→ Puck 组件切换）
├── KeywordHighlightView.tsx       # JD 关键词高亮（保留）
└── MatchScorePanel.tsx            # JD 匹配分数（保留）
└── templates/
    ├── templateSettings.ts        # ResumeTemplateSettings 类型 + StyleConfig↔CssVars（→ Puck 主题契约）
    ├── ResumeSwissSingle.tsx      # 模板实现之一（→ Puck components 重新实现）
    ├── ResumeSwissTwoColumn.tsx
    ├── ResumeModernSingle.tsx
    ├── ResumeModernTwoColumn.tsx
    ├── ResumeReference.tsx
    └── shared.tsx
└── frontend/src/app/resume/[id]/page.tsx  # 1407 行主页面（重写）
```

### 3.2 后端 PDF 渲染管线（保留不变）

- `backend/app/services/pdf_exporter.py` — Playwright 渲染前端 `/resume/print/[id]` → PDF
- `backend/app/routes/resume.py:1436` `_render_resume_pdf_with_playwright` — 优先系统 Chrome/Edge
- `backend/app/routes/resume.py:1478` `_render_resume_pdf_bytes` — WeasyPrint/ReportLab fallback
- **关键**: Puck 重写后 print 路由仍渲染 React 组件，因此 PDF 引擎**不需要重构**，前端新 layout 一致复用

### 3.3 content_json 非均质字段映射（关键解法）

每种 section_type 的原始字段（school/degree/major/gpa 等）通过 Puck component props
直接对应:

```ts
{
  type: "Education",
  props: {
    id: "education-{index}",
    school: "...",
    degree: "...",
    major: "...",
    gpa: "...",
    startDate: "...",
    endDate: "...",
    description: "..."
  }
}
```

归一化层 `normalizeSectionItem` 在 ResumPreview.tsx:38-155 将**废弃**（用户决策）。
Puck 编辑器直接读 content_json 中的原始字段，inline 编辑直接写回原生字段。

---

## 4. Puck 集成方案（待落地）

### 4.1 路径分层

1. **/resume/new** - Puck 编辑器主入口（拖拽 + 属性面板）
2. **/resume/[id]/edit** - 载入简历 + Puck 编辑器
3. **/resume/print/[id]** - 复用后端 PDF 管线（Next.js 直接 render print 静态 layout 出来）
4. **/resume/[id]** (当前 form 编辑主页面) — 重定向到 `/resume/[id]/edit`

### 4.2 Puck components 清单（每个对应预览的一个块）

| Component | Props | 来源 |
|---|---|---|
| `Header` | name, title, photoUrl, contact{email,phone,...} | content_json 顶部 |
| `Summary` | html (TipTap 输出) | resume.summary |
| `ExperienceItem` | position, company, location, startDate, endDate, description | content_json.experience[] |
| `EducationItem` | school, degree, major, gpa, startDate, endDate, description | content_json.education[] |
| `ProjectItem` | name, role, url, startDate, endDate, description | content_json.project[] |
| `SkillGroup` | category, items[] | content_json.skill[] |
| `CertificateItem` | name, scoreOrLevel, issuer, date, url | content_json.certificate[] |
| `AwardItem` | awardName, issuer, awardedAt, description | content_json.awards[] |
| `CustomItem` | title, subtitle, date, description | content_json.custom[] |

### 4.3 模板切换实现

- "Swiss Single" / "Modern Single" / "Reference" 等模板不再是独立组件，而是 Puck 全局主题
- 主题 = 全局 CSS 变量包 + section 排列约束（单栏 / 双栏）
- 切换模板 = 切 Puck config 的 theme preset，**canvas 内容不变**

### 4.4 后端契约扩展

- `PUT /api/resume/{id}/sections` body 改为接受 Puck JSON `{content: { puckDoc: {...}}}`
- 旧 `content_json` 暂存作迁移数据；首次加载时自动迁移为新 Puck 文档
- PDF 渲染走新 print route（同 React 组件树）

---

## 5. 现实评估

| 维度 | 估计 |
|---|---|
| 开发周期 | 6-12 周（原型 2-3 周 / alpha 4-6 周 / 兼容现有数据 + PDF 6-9 周 /上线 9-12 周） |
| 风险 | Puck 0.21 API 演化频繁；Undo/Redo 与 Puck 内嵌可能冲突；多栏布局精度 |
| 依赖升级 | Puck 支持 React 18 / Next.js 14，**不需要升级现有栈** ✓ |
| AI 集成 | Puck 原生支持"AI constrained by your rules"，可对接 OfferU `llm.py` 7 提供商 |
| 备选方案 | Craft.js — 同等可行；万一 Puck 出现新版本阻塞可切换 |
| 必要剪除 | `ResumePreview.tsx` 中 `normalizeSectionItem` 归一化层完全废弃 |

---

## 6. 下一步执行顺序（待用户确认开始）

1. **Puck 原型验证** (1 周) — 安装 `@puckeditor/puck`，跑官方 Next.js recipe，本地能拖拽 + 加载一个 Swiss 单栏模板作为 Puck component 出来
2. **content_json 迁移脚本** (1 周) — 把现有数据库里的 content_json 转 Puck 文档（仅开发环境，不需数据迁移兼容）
3. **Header/Summary/Experience/Education 四个核心 Puck components** (2-3 周)
4. **Skill/Project/Certificate/Award/Custom 五个补充 components** (1 周)
5. **StylePanel → Puck theme preset 切换** (1 周)
6. **整合后端 PDF 管线，验证导出与预览一致** (1 周)
7. **替换 /resume/[id] 主页面为 Puck 编辑器** (1 周)

总计 8-10 周可达成 alpha 可用状态。

---

## 7. 上下文恢复锚点

后续会话如果上下文被压缩，可通过此文件续起：
- 决策已确认 → 用 Puck 重写 OfferU 简历编辑器
- 不再讨论 "Fork JadeAI" / "WYSIWYG inline 改 5 模板" / "完全自由 Canva from scratch"
- 后续所有相关工作从"已确认 Puck 路线"开始
- 联结: docs/ALIGNMENT_2026.md (产品对齐) + docs/UPGRADE_2026.md (升级计划)