# Acme fixtures（完全虚构）

本目录是 EXT-FRAME-001 的合成脱敏 fixture，全部页面为虚构的 `acme.invalid` 域名，
不含任何真实公司、人员或表单数据。禁止把真实招聘网站 DOM 结构直接复制进本目录；
新增 fixture 必须来自 clean-room 采集并保持脱敏。

## 页面类型

- `detail.html`：job-detail 正例（`[data-testid='job-detail']` + `/jobs/*`）
- `search.html`：job-detail 近似反例（`[data-testid='job-search']` 触发 veto）
- `conflict.html`：job-detail 冲突例（详情与搜索控件同页，veto 应拒绝）
- `form.html`：application-form 正例（原生 input/textarea + 虚构 antd combobox 结构）
- `login.html`：application-form 近似反例（无 `application-form` 根标记）
- `conflict-form.html`：application-form 冲突例（表单与成功页同页，veto 应拒绝）

## 选择器理由

全部使用 `data-testid` 语义标记，避免依赖构建产物 class；fixture 仅用于证明框架
检测与裁决逻辑，不代表任何真实站点的兼容性声明。

## 未覆盖控件

无真实 ATS 控件；复杂控件（日期、树、级联）由后续切片以独立 fixture 覆盖。
