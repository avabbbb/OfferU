# Scroll Ownership

| Surface | Primary scroll owner | Secondary region | Rule |
| --- | --- | --- | --- |
| Workbench page | `.workbench-main` | drawer/panel body | body 不承担第二个页面滚动层 |
| Settings | detail content | table region / modal body | 表格横向滚动只在表格区域 |
| Email | page content | IMAP dialog body | dialog footer 保持可达 |
| Agent conversation | conversation list | ContextRail body | Context 折叠时不挤压 conversation |
| Resume workspace | page/editor column | preview column | 预览可独立滚动，保存/导出在 header 可达 |
| Studio | page content | preview panel | 预览内部裁切，页面不横向滚动 |
| Modal / sheet | modal body | nested code/table region | `max-height` + 内部纵向滚动 |
| Canvas (Flovart) | canvas pan/zoom surface | toolbar/inspector drawer | 二维画布例外不扩散到外围 UI |

禁止没有明确 owner 的三层组合：`body scroll + workspace scroll + panel scroll`。新增表格或长文本时，先在组件级定义 owner，再补 320px/短高度证据。
