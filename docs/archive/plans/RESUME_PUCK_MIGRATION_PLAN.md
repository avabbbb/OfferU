# 简历编辑器 Puck 化迁移方案（2026-06-30 定稿）

## 决策

| 决策点 | 选择 |
|---|---|
| 替换策略 | **原地跳栈**：直接重写 `/resume/[id]`，旧 1871 行代码不保留 |
| 功能取舍 | **保** AI 优化 + StyleToolbar + Undo + Photo；**砍** MatchScore + @dnd-kit 段落拖拽（Puck 自带） |
| Schema 时机 | **打开页实时迁移 + onPublish 反迁移**，后端 / DB schema 不动 |
| 保存粒度 | **只用 `updateResume(id, payload)` 汇总 PUT**；`updateSection`/`createSection`/`deleteSection` 在旧页未删，但新页不再调用 |

## 数据模型对照

### 现状（后端 `/api/resume/{id}`）

```ts
ResumeDetail {
  id, title, ...
  summary: string
  contact_json: Record<string, any>   // Header data
  style_config: Record<string, any>   // CSS 变量 / 字体 / 间距
  sections: ResumeSectionBlock[]
}

ResumeSectionBlock {
  id, resume_id,
  section_type: "education" | "workExperiences" | "internshipExperiences"
              | "projects" | "skills" | "certificates" | "awards"
              | "personalExperiences"
  sort_order: number
  title: string
  visible: boolean
  content_json: any[]                // 条目数组
}
```

### Puck 目标（InitialData）

```ts
{ content: Array<{ type: ComponentName; props: {...} }> }
```

### 双向映射

| section_type | Puck component | props 来自 content_json[i] 的字段 |
|---|---|---|
| `contact_json` (顶层) | `Header` | name / title / email / phone / location |
| `summary` (顶层) | `Summary` | text |
| `workExperiences` / `internshipExperiences` | `ExperienceEntry` | company / position / location / startDate / endDate / description |
| `education` | `EducationItem` | school / degree / major / startDate / endDate / gpa |
| `projects` | `ProjectItem` | name / role / link / startDate / endDate / description |
| `skills` | `SkillGroup` | category / items |
| `certificates` | `CertificateItem` | name / issuer / date |
| `awards` | `AwardItem` | name / level / date / description |
| `personalExperiences` | `CustomItem` | title / content |

> `sort_order` → Puck content 数组顺序；`visible=false` 的 section 迁移时仍写入但无需 Puck 隐藏机制（visible 概念直接迁移为 content 中存在即可，前端不显示的逻辑由 Puck 自带 Drawer 删除而非 visible 标记）

## 模块拆分

### M1：迁移转换器 `frontend/src/lib/puckMigration.ts`
- `migrateResumeToPuck(resume: ResumeDetail): InitialData`
- `unMigratePuckToResume(puckData: InitialData, base: ResumeDetail): ResumeUpdatePayload`
- 关键：保留 base.sections 的 id/section_type（已有段落不重建 id），新组件的 section 走 `createSection` 不存在路径——但 onPublish 一次性汇总，即 PUT 整个 sections 数组，后端按 `id` 存在判断 update/create/delete
- 字段名映射详见上表

### M2：9 组件提取 `frontend/src/app/resume/components/puckComponents.tsx`
- 从 `puck-demo/page.tsx` 抽出 9 个 component 定义（fields + render + Props type）
- 共享 `Config` 实例，供 `/resume/[id]` 与 `puck-demo` 共用

### M3：`/resume/[id]/page.tsx` 重写
**保留组件/路径**：
- `StyleToolbar` + `DEFAULT_STYLE_CONFIG` + `MIN_STYLE_CONFIG`
- `RichTextEditor`（用于 Puck 内的富文本字段——但首次迁移先用 textarea，富文本接入下一轮）
- `useResume` / `updateResume` / `uploadResumePhoto` / `uploadResumeLogo` / `resolveResumeLogo` / `useConfig`
- `aiOptimizeResume` / `aiApplySuggestion` / `AiSuggestion` / `AiOptimizeResult`
- `useResumeTemplates` / `applyTemplate`
- `useHistory`（包装 onPublish 做 Undo/Redo）

**砍掉组件**：
- `SectionEditor` / `createEmptySectionItem`
- `ResumePreview`（被 Puck `<Puck>` 编辑器替代）
- `MatchScorePanel`
- 旧 SECTION_TYPES / `getSectionMeta` / sectionNormalization / profileSchema 转换
- @dnd-kit 全套

**布局**：
- 顶部工具栏：返回 / 标题 / StyleToolbar 按钮触发抽屉 / AI 优化按钮 / Photo 上传 / 模板切换 / Undo / Redo / 保存 / 导出 PDF
- 主体：`<Puck config={puckConfig} data={puckData} onPublish={handlePublish} />`

**Undo/Redo 实现**：`useHistory<InitialData>(initialData)`，每次 `onPublish` 调 `record(currentData)`；undo → `setPuckData(history.back())`。

### M4：PDF / print 管线适配
- 现状：`pdf_exporter.py` 只吃 HTML 字符串
- 调用方待确认（搜 `export_resume_to_pdf` 调用点）→ 应该是某个 resume 路由拼 HTML
- 拼装方式有两条路：
  - **A：复用现有 print/[id] 路由**——print 页改用 `ResumePreview` 模板渲染（旧 sections schema，由反迁移数据填回）。**风险**：ResumePreview 归一化层之前 handoff 已经确认要废弃
  - **B：print 页改用 Puck `<Render>` 渲染**——和编辑器共享组件。**优点**：所见即所得，无需归一化层
- **选 B**：print/[id] 改成读 `useResume(id) → migrateResumeToPuck → <Render config={puckConfig} data={puckData} />`，再调 `export_resume_to_pdf(html)` 生成 PDF。后端不动。

### M5：AI 优化对接
- `aiOptimizeResume(resumeId, target)` 现状接受整 resume 上下文返回 `AiSuggestion[]`
- Puck 化后 AI 优化对象变 Puck content：返回对某个 `{type, props}` 的修改建议
- `aiApplySuggestion` 接受 suggestion id 应用到 Puck data
- **本轮不动**，落入下一轮细化——避免一次改动过大

## 进度

- [x] 决策落盘
- [ ] M1 `puckMigration.ts` 雏形
- [ ] M2 9 组件共享
- [ ] M3 `/resume/[id]` 重写
- [ ] M4 print 适配
- [ ] M5 AI 优化接入