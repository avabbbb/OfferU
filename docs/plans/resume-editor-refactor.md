# 简历编辑器重构

状态：实施中（2026-10-30）。完成后把结论并进 DESIGN.md §6 / §11，这篇移入 archive。

## 0. 目标和验收

对标超级简历：左边写，右边就是导出的 PDF。

- 左：飞书式块编辑器。每一行是一个块（姓名、联系方式、分节、经历标题、要点、段落），/ 唤出块菜单，左侧手柄拖动排序，选中文字浮出格式栏，Ctrl+Z / Ctrl+Shift+Z 撤销重做。
- 右：A4 预览，和 PDF 同一份 HTML。顶部排版栏：智能一页、模板、字体、字号、行距、段距、页边距、主题色、照片、校徽。点预览里的一段，左边跳到对应的块。
- 简历管理：新建（空白 / 从档案生成 / 复制主简历 / 为某岗位定制）、复制、重命名、删除（可撤销）、列表。
- Agent 定制：选岗位，读 JD + 档案，生成一份挂在岗位下的简历。有进度、能取消、有超时，不会卡住；没配模型时走本地规则也能出一版。

验收：新建 → 编辑（/ 菜单、拖动、加粗、撤销）→ 改排版 → 智能一页 → 导出 PDF（和预览一致）→ 为岗位生成（有模型 / 没模型各走一遍，都在 90 秒内结束或可取消）。

## 1. 分层

| 层 | 负责 | 位置 |
| --- | --- | --- |
| 数据 | doc(kind=resume)：body（Markdown，唯一内容来源）+ style（排版）；增删改查和撤销走现有工具 | core/tools.py、core/store.py |
| 排版引擎 | style → CSS 变量；模板 CSS；智能一页 | core/resume.py、core/templates/、前端 lib/resumeStyle.ts |
| 渲染导出 | Markdown + style → HTML（预览）→ PDF（Playwright 打印同一份 HTML） | core/resume.py、POST /api/resume/render |
| 编辑器 | TipTap 块编辑，进出都是 Markdown | components/resume/BlockEditor.tsx |
| 页面 | 列表 + 左编辑 + 右预览 + 排版栏 | app/resume/ |
| Agent | 按 JD + 档案生成简历，SSE 进度 | core/tailor.py、POST /api/resume/tailor |

为什么 body 仍然是 Markdown：Agent（内置和 MCP）只会读写文字，工具不用改；撤销记录是可读的 diff；块只是编辑器里的视图。代价：单段文字不支持任意颜色（Markdown 没法存），颜色只有全局主题色。这和 #106 那轮「颜色超过 2 种提示」的结论一致：简历不该花。

## 2. 数据：doc.style

template 字段废弃，改成 style（JSON 对象，缺省的键用模板默认值）。旧数据里的 template 在读取时映射到 style.template（single→clear、compact→compact、photo→clear + photo），不写迁移。

| 键 | 取值 | 默认（clear） |
| --- | --- | --- |
| template | clear 清晰 / kami 留白 / compact 紧凑 | clear |
| font | sans 黑体 / serif 宋体 / kai 楷体 | sans（kami 为 serif） |
| bodySize | 8–14 pt | 9.5 |
| lineHeight | 1.0–2.0 | 1.45 |
| sectionGap / itemGap | 0–30 / 0–20 pt | 9 / 4.5 |
| margin | top/right/bottom/left，3–30 mm | 11 / 13 / 11 / 13 |
| accent | #RRGGBB | #141413（kami 为 #1B365D） |
| photo | true / false（用档案里的证件照） | false |
| logo | 校徽文件名（POST /api/files 上传）或空 | 空 |

校验在 tools._check：未知键报错，数值越界报错（不静默夹取，Agent 要看到错误）。FIELDS["doc"] 的说明里写清 style 的键，Agent 也能调排版。

## 3. 渲染：预览和 PDF 同源

- resume.render_html(body, style, photo, logo) 是唯一的渲染函数。markdown-it 给每个块加 data-line（token.map 的起始行），用于点击定位。
- POST /api/resume/render {body, style} 返回 HTML；前端停顿 250ms 后请求，放进 iframe srcdoc。请求带序号，过时的响应丢掉。
- PDF 接口和 export_resume_pdf 都调 render_html，所以预览就是 PDF。
- 模板 CSS 只消费 CSS 变量：--body-size、--line-height、--section-gap、--item-gap、--margin-top/right/bottom/left、--accent、--font。base.css 定结构，clear.css / kami.css / compact.css 只改 token。

### Kami 审美 token（留白模板）

来自 Kami 的 resume 版式，沿用 #99 / #108 里量好的数：正文 9.2pt / 行高 1.42，姓名 26.5pt，分节标题 12.5pt，墨蓝 #1B365D，分隔线 #E8E6DC，宋体，分节间距 16pt、条目间距 7pt。「清晰」是同一套结构换黑体、黑色、更紧的间距（对标超级简历）。

层级只靠字号、字重、颜色和留白：姓名 > 分节标题 > 经历标题（加粗，右侧时间灰色）> 要点。不用色块、图标、进度条。

## 4. 智能一页

沿用 #108 的做法，搬到 lib/resumeStyle.ts 的 fitOnePage(measure, style)：

- 参与的 8 个量：bodySize、lineHeight、sectionGap、itemGap、四个页边距。
- 超过一页：从当前值向下限（8.5pt / 1.25 / 5 / 2 / 7mm / 9mm）分 12 档插值，取第一个放得下的。
- 不到 90%：向上限（10.5pt / 1.55 / 10 / 5）插值，只放大到 94%，给打印留余量。
- 测量在预览 iframe 里做（改 CSS 变量、读高度、还原），结果一次 save 到 style，可撤销。下限仍放不下时提示「内容超过一页，建议删减」，不硬压。

## 5. 编辑器

- TipTap（已在依赖里）+ @tiptap/markdown 进出 Markdown。块类型即 Markdown 结构：H1 姓名、首段联系方式、H2 分节、H3 经历（公司 | 职位 | 时间）、列表要点、段落。
- / 菜单：分节、经历、要点、段落，以及常用分节模板（教育 / 实习 / 项目 / 技能 / 获奖），插入带占位的块。
- 拖动：左侧手柄（悬停显示），拖分节时连同下面的内容一起走。
- BubbleMenu：加粗、斜体、链接、转成要点 / 段落。
- 撤销：编辑器内用 TipTap history（停顿分组）；保存在停顿 800ms 后写 body，后端 10 分钟内合并成一条 change。排版改动也进最近改动，可撤销。
- 外部改动（Agent / 撤销）：编辑器没有未存内容且未聚焦时跟上新 body。
- 源码切换保留（textarea），给想直接写 Markdown 的人。

## 6. 页面和增删改查

- /resume：左栏简历列表（主简历在前，岗位版显示公司 · 岗位），中间编辑器，右侧预览。窄屏时预览变成可切换的标签。
- 新建菜单：空白、从档案生成（resumeFromProfile，不调 AI）、复制当前、为岗位定制（走 §7）。
- 行内操作：重命名（点标题直接改）、复制、挂到岗位 / 取消挂靠、删除（可撤销，删完跳到下一份）。全部用现有 save / delete / get，不加新工具。
- 导出 PDF 按钮在排版栏右侧。

## 7. Agent：按 JD + 档案生成

目标是「稳定跑完」，效果后调。不走多步工具循环（不可控、易卡），而是固定流水线，每步有超时：

1. 读岗位：JD 为空且有链接时调 fetch_page（15s）。仍为空就报错结束。
2. 读档案和全部职业记忆。
3. 提取 JD 关键词（本地：英文词 + 中文技术词表 + 高频词），给每条记忆打分。
4. 有模型：一次调用，输入 JD、按分排好的记忆、主简历，要求只用给定经历、输出约定的 Markdown。流式接收，总超时 90s，失败不重试，直接进第 5 步的本地版并告诉用户原因。没模型：跳过。
5. 本地版 / 兜底：按分数重排分节内条目和要点，把命中关键词的要点加粗，去掉 0 分且超过一页的条目。
6. 事实闸：模型输出里每个经历标题必须能对上一条记忆或档案学校，对不上的条目删掉并在结果里列出。
7. 保存：新建 doc（kind=resume，job_id，标题「公司 · 岗位」，style 复制主简历），actor=内置 Agent，可撤销。

接口：POST /api/resume/tailor {job_id, source_id?} 返回 SSE：step（第几步、说明）、delta（模型文字）、done（doc_id、用了模型还是本地、删掉的条目）、error。客户端断开即取消（服务端每步前和每个流块检查）；整体 asyncio.wait_for 120s。同一岗位同时只跑一个，第二个直接返回「已在生成」，不排队。

模型配置复用设置里已有的 OpenAI 兼容 base_url / key / model。后续可以把同一流水线包成 MCP 工具 tailor_resume。

## 8. 删掉的东西

- doc.template 和 RESUME_TEMPLATE（改为 style.template）。
- core/templates/single.css、photo.css（并进 clear.css + base.css 的照片样式）。
- 页面内的 Markdown 语法提示行（块编辑器不再需要）。

## 9. 分步

一个分支 feat/resume-editor。顺序：数据 + 渲染 → 编辑器 + 预览 + 排版栏 + 增删改查 → Agent 定制。每步后端一条走真实 HTTP 的测试：渲染含 data-line 和 style 变量、style 校验、tailor 在无模型和假模型下都能完成、取消不留半成品。
