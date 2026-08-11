# BOSS 直聘 fixtures（脱敏合成）

本目录为 `portal.boss-job-detail` 规则包的脱敏 fixture，全部为公司虚构的
"Example Co"，只模仿 BOSS 详情页的公开结构标记（`.job-detail`、`.info-primary .name`、
`.salary`、`.job-sec-text`、`.company-info`），不含任何真实岗位、公司或人员数据。

## 页面类型

- `detail.html`：job-detail 正例（`/job_detail/*` + `.job-sec-text` 命中）
- `list.html`：job-detail 近似反例（`.job-list-box` 触发 veto）
- `conflict.html`：job-detail 冲突例（详情与推荐列表同页，veto 应拒绝）

## 选择器理由

选择器迁移自 OfferU 自有 `src/content/platforms/boss.ts`（first-party 配置），
未参考或复制任何第三方插件规则数据。稳定性标注：长期公开结构标
`vendor-stable`，其余为 `fragile`；规则包当前为 `experimental`，未经真实浏览器验收。

## 未覆盖

- BOSS 移动端/其他子域（web 之外的路径变体）
- 登录墙、城市切换页等变形页面
- 详情页中薪资为"面议"、JD 为空等边界（读取层返回 null，由调用方降级）

## 采集授权

fixture 全部为合成 HTML，不涉及真实页面抓取。
