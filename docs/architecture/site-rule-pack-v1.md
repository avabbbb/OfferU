# SiteRulePack v1 规范

> 状态：normative draft，供 `EXT-FRAME-001` 实现  
> 日期：2026-08-10  
> 上位架构：[OfferU 浏览器扩展](browser-extension.md)  
> 安全决策：[ADR-0049](../adr/README.md#adr-0049)、[ADR-0050](../adr/README.md#adr-0050)

## 1. 规范目标

`SiteRulePack` 把岗位平台配置与 ATS 页面配置统一成一种受限、版本化、可验证的数据格式。它回答五个问题：

1. 当前页面属于哪个已知页面类型；
2. 岗位信息在哪里读取；
3. 表单字段、分组和复杂控件如何描述；
4. 哪些提交成功/失败信号可以形成候选证据；
5. 这组规则依据什么 fixture 和浏览器证据被允许使用。

它不回答“用户的值是什么”“是否应该投”“如何生成回答”或“何时点击提交”。这些属于 OfferU 职业事实、工作流和人工决定。

本文中的“必须”“不得”“只能”是实现约束。示例 host 使用保留的 `.invalid` 域名，不能直接用于真实网站。

## 2. 顶层模型

```ts
type RulePackStatus = "experimental" | "verified" | "disabled";
type PageKind =
  | "job-list"
  | "job-detail"
  | "application-form"
  | "submission-receipt";

interface SiteRulePackV1 {
  schemaVersion: "1";
  id: string;
  version: string;
  status: RulePackStatus;
  displayName: string;
  hosts: HostRule[];
  pages: PageRuleV1[];
  fixtures: FixtureRefV1[];
  provenance: ProvenanceV1;
}
```

所有 object 必须拒绝未知字段，相当于 JSON Schema 的 `additionalProperties: false`。这样 `script`、`hook`、`endpoint`、`eval` 等未授权能力不会被静默忽略后进入运行时。

### 2.1 顶层字段

| 字段 | 约束 | 说明 |
|---|---|---|
| `schemaVersion` | 固定为 `"1"` | schema 破坏性变化才升级 |
| `id` | `^(portal|ats|employer|fixture)\.[a-z0-9-]+(?:\.[a-z0-9-]+)*$` | 稳定 ID，不含版本 |
| `version` | 严格 SemVer | 规则内容变化必须变更 |
| `status` | 三选一 | `experimental` 只能诊断，`verified` 才可按声明能力运行，`disabled` 不参与解析 |
| `displayName` | 1–80 个可见字符 | 只用于 UI，不参与检测 |
| `hosts` | 1–20 条 | 先做 host 预过滤，不允许正则 |
| `pages` | 1–8 条，`id` 唯一 | 一个 pack 可描述同源的多个页面类型 |
| `fixtures` | 至少 1 条 | `verified` 的每个 page kind 都必须有正例、近似反例和冲突证据 |
| `provenance` | 必填 | 证明由 OfferU 自主维护 |

如果同一站点的 job detail 已验证、application form 仍实验，必须拆成两个 pack。一个 pack 内所有 page rule 共用同一验证状态，不能让一个 `verified` 标记掩盖未验收能力。

## 3. Host 与 URL 规则

```ts
type HostRule =
  | { kind: "exact"; value: string }
  | { kind: "suffix"; value: string };
```

- `value` 必须是小写 ASCII hostname，不含 scheme、port、path、query、fragment、`*` 或 `/`；
- `exact` 只匹配完全相同 hostname；
- `suffix` 匹配自身及其子域，但必须按 label 边界匹配，`jobs.invalid` 不能匹配 `eviljobs.invalid`；
- localhost OfferU 地址不进入规则包，始终由 `OfferUControl` 固定配置；
- URL path 使用下文受限的 `path-glob` signal，不允许任意正则。

## 4. PageRule 与检测信号

```ts
interface PageRuleV1 {
  id: string;
  kind: PageKind;
  match: MatchRuleV1;
  capabilities: CapabilityId[];
  jobList?: JobListRuleV1;
  jobDetail?: JobDetailRuleV1;
  form?: FormRuleV1;
  receipt?: ReceiptRuleV1;
}

interface MatchRuleV1 {
  minScore: number;
  minPositiveSignals: number;
  ambiguityMargin: number;
  signals: DetectionSignalV1[];
}
```

每个 `kind` 只能出现对应配置：

| `kind` | 必须字段 | 禁止字段 |
|---|---|---|
| `job-list` | `jobList` | `jobDetail/form/receipt` |
| `job-detail` | `jobDetail` | `jobList/form/receipt` |
| `application-form` | `form` | `jobList/jobDetail/receipt` |
| `submission-receipt` | `receipt` | `jobList/jobDetail/form` |

### 4.1 DetectionSignal

```ts
type DetectionSignalV1 = {
  id: string;
  type:
    | "path-glob"
    | "title-token"
    | "meta-token"
    | "script-host"
    | "css-exists";
  polarity: "positive" | "negative";
  value: string;
  weight: number;
  veto?: boolean;
};
```

约束：

- `id` 在当前 page rule 内唯一；
- `weight` 为 1–100 的整数；
- `veto=true` 只允许 negative signal；
- `path-glob` 只允许 `/`、字母数字、`-_.`、单段 `*` 与多段 `**`，不得包含正则元字符；
- `title-token`、`meta-token` 是规范化后的 literal token/短语，不执行正则；
- `script-host` 只读取 `<script src>` 的 hostname，不下载或执行额外资源；
- `css-exists` 只判断是否存在，不读取整页 HTML；
- `verified` 规则不能仅靠 title token、脆弱 class 或一个低权重信号命中。

## 5. SelectorSet

所有 DOM 定位都使用同一格式：

```ts
type SelectorStability = "semantic" | "vendor-stable" | "fragile";
type SelectorScope = "document" | "page-root" | "item" | "section" | "field";

interface SelectorCandidateV1 {
  css: string;
  stability: SelectorStability;
}

interface SelectorSetV1 {
  scope: SelectorScope;
  candidates: SelectorCandidateV1[];
  required: boolean;
  maxMatches: number;
}
```

### 5.1 选择器顺序

Resolver 按数组顺序选择第一组符合 `maxMatches` 的 candidate：

1. `semantic`：role、aria、label 关联、name、稳定 data attribute；
2. `vendor-stable`：ATS/招聘站长期公开的结构 class；
3. `fragile`：前缀/包含 class、层级位置或构建产物 class。

`verified` 规则中的必填关键字段不能只有 `fragile` candidate。不得使用 XPath、文本执行器、Playwright selector engine、`:contains()`、影子脚本或任意函数表达式。

### 5.2 查询预算

- 单个 SelectorSet 最多 8 个 candidate；
- 单个 CSS 最长 300 字符；
- `maxMatches` 为 1–500；
- 单页全部 selector 查询有统一时间与节点预算；
- selector 语法错误是规则错误，不是“零匹配”；
- 超过 `maxMatches` 视为不稳定，不能默默截断。

## 6. 读取与归一化

```ts
type ReadMode = "text" | "href" | "datetime" | "attribute" | "texts";
type AttributeName = "content" | "data-id" | "data-job-id" | "aria-label";
type NormalizerId =
  | "trim"
  | "collapse-space"
  | "absolute-url"
  | "strip-label-prefix"
  | "iso-date-if-unambiguous";

interface ReadRuleV1 {
  selectors: SelectorSetV1;
  mode: ReadMode;
  attribute?: AttributeName;
  normalize: NormalizerId[];
}
```

- `attribute` 只在 `mode=attribute` 时存在，并且只能取白名单属性；
- normalizer 必须是扩展内置纯函数，不得由规则包携带参数化代码；
- 日期不明确时保留原文并标记 unresolved，不猜时区/年份；
- `href` 只能变为当前页面 origin 可解析的绝对 URL，不跟随请求。

## 7. 岗位规则

### 7.1 Job list

```ts
interface JobListRuleV1 {
  root?: SelectorSetV1;
  item: SelectorSetV1;
  itemId?: ReadRuleV1;
  fields: JobFieldRulesV1;
}
```

`item` 是唯一跨字段边界。每个岗位字段必须在当前 item scope 内解析，不能从整页抓到另一张卡片的公司或薪资。

旧 `listActionTargets` 不进入 v1：岗位动作统一放在 Side Panel，规则包不负责向招聘页面插入按钮或悬浮 UI。

### 7.2 Job detail

```ts
interface JobDetailRuleV1 {
  root?: SelectorSetV1;
  fields: JobFieldRulesV1;
}

interface JobFieldRulesV1 {
  title: ReadRuleV1;
  company: ReadRuleV1;
  description: ReadRuleV1;
  location?: ReadRuleV1;
  salary?: ReadRuleV1;
  applyUrl?: ReadRuleV1;
  postedAt?: ReadRuleV1;
  tags?: ReadRuleV1;
  companyTags?: ReadRuleV1;
  sourceId?: ReadRuleV1;
}
```

title、company、description 是入库预览的最低字段门。缺任一项仍可生成诊断，但不能默认进入“可同步”组；使用者补充或规则修复后再确认。

## 8. FormRule

```ts
interface FormRuleV1 {
  root: SelectorSetV1;
  fieldCandidates: SelectorSetV1;
  fieldContainer?: SelectorSetV1;
  labels: SelectorSetV1[];
  sections?: SectionRuleV1;
  repeats?: RepeatRuleV1;
  ignore?: SelectorSetV1;
  aliases: IntentAliasRuleV1[];
  controls: ControlBindingV1[];
}
```

### 8.1 结构规则

```ts
interface SectionRuleV1 {
  section: SelectorSetV1;
  heading: SelectorSetV1;
}

interface RepeatRuleV1 {
  item: SelectorSetV1;
  heading?: SelectorSetV1;
  countMarker?: SelectorSetV1;
  order: "dom" | "reverse-dom";
}
```

- `labels` 按顺序尝试，可描述 label、aria 与同容器标题；
- `repeats` 只识别现有重复项，不允许规则包描述“新增经历”按钮；
- preview 不能通过点击或展开页面来补充扫描；
- ignore 只排除明显非申请表单 UI，不能用来隐藏敏感字段或失败字段。

### 8.2 Intent aliases

```ts
interface IntentAliasRuleV1 {
  canonicalIntent: string;
  aliases: string[];
  sectionHint?: string;
}
```

alias 只帮助识别字段含义，不能携带值，不能覆盖 OfferU 的敏感性分类，也不能把身份证、薪资、工作许可、同意项等降级为可自动填写。

### 8.3 Control binding

```ts
type DriverId =
  | "native"
  | "antd"
  | "element"
  | "moka"
  | "beisen"
  | "feishu";

type ControlSelectorRole =
  | "host"
  | "display-input"
  | "popup"
  | "option"
  | "search-input"
  | "tree-root"
  | "tree-node"
  | "tree-label"
  | "tree-expander"
  | "calendar-panel"
  | "date-cell";

interface ControlBindingV1 {
  id: string;
  when: SelectorSetV1;
  driverId: DriverId;
  selectors: Partial<Record<ControlSelectorRole, SelectorSetV1>>;
}
```

实现必须把 `ControlBindingV1` 做成按 `driverId` 区分的严格 union：

| Driver | 必需 selector role | 说明 |
|---|---|---|
| `native` | 无额外 role | 原生 input/textarea/select；禁止 file/submit/password |
| `antd` / `element` | `host`、`popup`、`option` | search input 可选 |
| `moka` / `beisen` | `host`、`popup`、`option` | 特殊写入只在内置 Driver |
| `feishu` | `host`、`popup`、`option` | tree/date 需要相应完整 role 集 |

未知 Driver、缺少必需 role 或多余 role 都必须 schema 失败。规则包不能定义事件序列、等待脚本、点击提交或任意自定义 Writer。

## 9. ReceiptRule

```ts
interface ReceiptRuleV1 {
  requiresActiveFillSession: true;
  minScore: number;
  minPositiveGroups: number;
  positiveGroups: ReceiptSignalGroupV1[];
  negativeSignals: ReceiptSignalV1[];
  evidence: {
    applicationId?: ReadRuleV1;
    company?: ReadRuleV1;
    role?: ReadRuleV1;
  };
}

interface ReceiptSignalGroupV1 {
  id: string;
  anyOf: ReceiptSignalV1[];
}

type ReceiptSignalV1 =
  | { type: "path-glob"; value: string; weight: number; veto?: boolean }
  | { type: "title-token"; value: string; weight: number; veto?: boolean }
  | { type: "css-exists"; value: SelectorSetV1; weight: number; veto?: boolean }
  | { type: "visible-token"; value: string; weight: number; veto?: boolean };
```

约束：

- 必须有当前未过期填写会话和明确关联岗位；
- 至少命中两个独立 positive group，单一“谢谢”文本或 URL 不够；
- 校验错误、草稿、取消、登录、验证码和未完成页面应作为 negative veto；
- evidence 只读取最小文本，预览时脱敏；
- 规则只创建 pending candidate，不创建 `ApplicationAttempt`；
- 不保存整页 HTML、截图、Cookie 或表单值。

## 10. Capability vocabulary

v1 只允许以下 capability：

```text
read-job-list
read-job-detail
scan-form
write-native-text
write-native-select
write-known-combobox
write-known-date
read-submission-receipt
```

能力声明不是授权：

- `experimental` pack 的所有写能力运行时降为 diagnostic-only；
- `verified` pack 仍受全局敏感性、已有值、计划绑定和人工确认门限制；
- v1 没有 upload、consent、open-question、add-repeat-item、submit 或 captcha 能力；
- Driver 实际能力必须是 pack 声明与核心安全能力的交集。

## 11. Fixture 与 provenance

```ts
interface FixtureRefV1 {
  id: string;
  pageKind: PageKind;
  role: "positive" | "near-negative" | "conflict";
  path: string;
  sanitized: true;
  expectedRuleId?: string;
}

interface ProvenanceV1 {
  owner: "offeru";
  method: "first-party" | "clean-room";
  capturedFrom: "public-page" | "user-authorized-page" | "synthetic";
  notesPath: string;
  lastVerifiedAt?: string;
}
```

- fixture 必须位于仓库允许的脱敏目录，不得指向 `Niuke/`；
- `sanitized` 固定为 true；schema 通过不代替人工脱敏复核；
- notes 必须说明页面类型、选择器理由、未覆盖控件和采集授权；
- `verified` 必须有 `lastVerifiedAt` 和真实浏览器证据路径；
- 不得把“另一个插件可以填写”写成 provenance。

## 12. 精确解析算法

```text
INPUT: normalized URL + budgeted PageSnapshot + all valid packs

1. 丢弃 disabled 或 schema 无效 pack。
2. 用 exact/suffix host rule 预过滤。
3. 对每个 page rule：
   a. 命中 negative veto -> candidate rejected。
   b. score = positive matched weight - negative matched weight。
   c. 检查 minPositiveSignals 与 minScore。
4. 按 score 降序；相同分数按更高 semantic signal 数排序。
5. 无候选 -> unsupported。
6. 前两名分差 < winner.ambiguityMargin -> ambiguous。
7. winner pack=experimental -> diagnostic-only。
8. winner pack=verified -> 返回唯一 ResolvedSiteAdapter。
9. 任何 query 超预算、selector 语法错误或结构漂移 -> diagnostic-only，不能放宽规则重试。
```

输出必须保留脱敏 detection evidence：pack ID/version、page rule、命中 signal ID、分数、冲突候选和降级原因。不得记录页面正文。

## 13. 版本规则

- `PATCH`：修正不改变声明能力的 selector/fixture；
- `MINOR`：新增 page rule、字段、已知 Driver 绑定或能力；
- `MAJOR`：同 schemaVersion 下改变已有规则语义；应尽量避免；
- `schemaVersion`：格式或安全语义破坏性变化；
- 同一个 `id + version` 的内容必须不可变；构建生成 hash，发现同版本不同内容就失败；
- v1 规则可以随扩展内置，也可以包含在 ADR-0050 定义的固定来源、签名远程 bundle 中；两种来源进入同一个 validator/resolver，远程来源不能扩大 schema 或携带代码。
- 不支持用户导入未签名规则；远程 bundle 的签名、单调版本、防重放、熔断和回滚由上位浏览器扩展契约约束。

## 14. Validator 必须拒绝的输入

至少覆盖以下反例：

1. 任意未知字段，包括 `script`、`endpoint`、`hook`、`transformCode`；
2. host 中的 scheme、path、wildcard 或大小写；
3. path glob 中的正则元字符；
4. selector 语法错误、过长、过多或 `maxMatches` 越界；
5. 未知 Driver 或 Driver 缺少/多出 selector role；
6. page kind 与配置字段不一致；
7. duplicate pack/page/signal/binding/fixture ID；
8. `verified` 缺 fixture、near-negative、conflict 或 provenance；
9. receipt 不要求 active session 或只有一个 positive group；
10. capability 包含 upload、consent、submit、captcha；
11. fixture 指向 `Niuke/`、绝对路径或仓库外路径；
12. alias/value/selector 配置中出现表单真实值或疑似 secret。

秘密检测不能只靠 schema；构建与 Eval 仍需单独扫描，但不得在错误输出中回显疑似 secret 原文。

## 15. 完全虚构的岗位详情示例

```json
{
  "schemaVersion": "1",
  "id": "fixture.acme-job-detail",
  "version": "1.0.0",
  "status": "experimental",
  "displayName": "Acme fixture job detail",
  "hosts": [{ "kind": "exact", "value": "jobs.fixture.invalid" }],
  "pages": [
    {
      "id": "detail",
      "kind": "job-detail",
      "match": {
        "minScore": 70,
        "minPositiveSignals": 2,
        "ambiguityMargin": 20,
        "signals": [
          { "id": "detail-path", "type": "path-glob", "polarity": "positive", "value": "/jobs/*", "weight": 40 },
          { "id": "detail-root", "type": "css-exists", "polarity": "positive", "value": "[data-testid='job-detail']", "weight": 40 },
          { "id": "search-page", "type": "css-exists", "polarity": "negative", "value": "[data-testid='job-search']", "weight": 80, "veto": true }
        ]
      },
      "capabilities": ["read-job-detail"],
      "jobDetail": {
        "root": {
          "scope": "document",
          "candidates": [{ "css": "[data-testid='job-detail']", "stability": "semantic" }],
          "required": true,
          "maxMatches": 1
        },
        "fields": {
          "title": {
            "selectors": { "scope": "page-root", "candidates": [{ "css": "[data-testid='job-title']", "stability": "semantic" }], "required": true, "maxMatches": 1 },
            "mode": "text",
            "normalize": ["trim", "collapse-space"]
          },
          "company": {
            "selectors": { "scope": "page-root", "candidates": [{ "css": "[data-testid='company-name']", "stability": "semantic" }], "required": true, "maxMatches": 1 },
            "mode": "text",
            "normalize": ["trim", "collapse-space"]
          },
          "description": {
            "selectors": { "scope": "page-root", "candidates": [{ "css": "[data-testid='job-description']", "stability": "semantic" }], "required": true, "maxMatches": 1 },
            "mode": "text",
            "normalize": ["trim", "collapse-space"]
          }
        }
      }
    }
  ],
  "fixtures": [
    { "id": "detail-positive", "pageKind": "job-detail", "role": "positive", "path": "fixtures/acme/detail.html", "sanitized": true, "expectedRuleId": "detail" },
    { "id": "detail-near-negative", "pageKind": "job-detail", "role": "near-negative", "path": "fixtures/acme/search.html", "sanitized": true },
    { "id": "detail-conflict", "pageKind": "job-detail", "role": "conflict", "path": "fixtures/acme/conflict.html", "sanitized": true }
  ],
  "provenance": {
    "owner": "offeru",
    "method": "first-party",
    "capturedFrom": "synthetic",
    "notesPath": "fixtures/acme/README.md"
  }
}
```

## 16. 完全虚构的 ATS 表单示例

为保持篇幅，示例只展示关键字段；真实对象仍必须满足所有严格 union 与 provenance 条件。

```json
{
  "schemaVersion": "1",
  "id": "fixture.acme-application-form",
  "version": "1.0.0",
  "status": "experimental",
  "displayName": "Acme fixture application form",
  "hosts": [{ "kind": "exact", "value": "apply.fixture.invalid" }],
  "pages": [
    {
      "id": "application",
      "kind": "application-form",
      "match": {
        "minScore": 80,
        "minPositiveSignals": 2,
        "ambiguityMargin": 20,
        "signals": [
          { "id": "apply-path", "type": "path-glob", "polarity": "positive", "value": "/applications/*", "weight": 40 },
          { "id": "form-root", "type": "css-exists", "polarity": "positive", "value": "[data-testid='application-form']", "weight": 50 },
          { "id": "receipt-page", "type": "css-exists", "polarity": "negative", "value": "[data-testid='application-success']", "weight": 100, "veto": true }
        ]
      },
      "capabilities": ["scan-form", "write-native-text", "write-known-combobox"],
      "form": {
        "root": { "scope": "document", "candidates": [{ "css": "[data-testid='application-form']", "stability": "semantic" }], "required": true, "maxMatches": 1 },
        "fieldCandidates": { "scope": "page-root", "candidates": [{ "css": "input, textarea, select, [role='combobox']", "stability": "semantic" }], "required": true, "maxMatches": 200 },
        "labels": [
          { "scope": "field", "candidates": [{ "css": "label", "stability": "semantic" }], "required": false, "maxMatches": 2 },
          { "scope": "field", "candidates": [{ "css": "[aria-label]", "stability": "semantic" }], "required": false, "maxMatches": 1 }
        ],
        "aliases": [
          { "canonicalIntent": "full_name", "aliases": ["姓名", "name"] },
          { "canonicalIntent": "email", "aliases": ["邮箱", "email"] }
        ],
        "controls": [
          {
            "id": "fixture-combobox",
            "when": { "scope": "field", "candidates": [{ "css": "[data-testid='fixture-combobox']", "stability": "semantic" }], "required": false, "maxMatches": 20 },
            "driverId": "antd",
            "selectors": {
              "host": { "scope": "field", "candidates": [{ "css": "[data-testid='fixture-combobox']", "stability": "semantic" }], "required": true, "maxMatches": 1 },
              "popup": { "scope": "document", "candidates": [{ "css": "[data-testid='fixture-options']", "stability": "semantic" }], "required": true, "maxMatches": 1 },
              "option": { "scope": "document", "candidates": [{ "css": "[role='option']", "stability": "semantic" }], "required": true, "maxMatches": 100 }
            }
          }
        ]
      }
    }
  ],
  "fixtures": [
    { "id": "form-positive", "pageKind": "application-form", "role": "positive", "path": "fixtures/acme/form.html", "sanitized": true, "expectedRuleId": "application" },
    { "id": "form-near-negative", "pageKind": "application-form", "role": "near-negative", "path": "fixtures/acme/login.html", "sanitized": true },
    { "id": "form-conflict", "pageKind": "application-form", "role": "conflict", "path": "fixtures/acme/conflict.html", "sanitized": true }
  ],
  "provenance": {
    "owner": "offeru",
    "method": "clean-room",
    "capturedFrom": "synthetic",
    "notesPath": "fixtures/acme/README.md"
  }
}
```

## 17. EXT-FRAME-001 的最小验收

DeepSeek 的第一轮只实现框架，不迁移真实站点。完成声明必须映射到以下结果：

| 用例 | 预期 |
|---|---|
| 合法 synthetic pack | 成功加载且内容不可变 |
| 未知顶层/嵌套字段 | schema 拒绝 |
| `script`/`endpoint`/未知 Driver | schema 拒绝 |
| 正例唯一命中 | 返回唯一 resolved adapter 与脱敏 evidence |
| 低分 | `unsupported` |
| 两规则分差不足 | `ambiguous` |
| experimental 命中 | `diagnostic-only` |
| negative veto 命中 | 候选直接拒绝 |
| selector 错误/超预算 | `diagnostic-only`，不放宽重试 |
| 同 id/version 内容变化 | 构建/加载失败 |

此任务不创建 side panel、不迁移 BOSS/Moka、不接 OfferU 后端，也不执行任何表单写入。

## 18. 覆盖矩阵与迁移起点

兼容性按 `pack + version + page kind + capability` 记录，不能按网站名整体打勾：

| Pack 候选 | 当前来源 | 待迁移能力 | v1 状态 |
|---|---|---|---|
| `portal.boss.*` | `src/content/platforms/boss.ts` | job-list、job-detail | legacy candidate，未验证 |
| `portal.zhaopin.*` | `src/content/platforms/zhaopin.ts` | job-list、job-detail | legacy candidate，未验证 |
| `portal.liepin.*` | `src/content/platforms/liepin.ts` | job-list、job-detail | legacy candidate，未验证 |
| `portal.shixiseng.*` | `src/content/platforms/shixiseng.ts` | job-list、job-detail | legacy candidate，未验证 |
| `portal.linkedin.*` | `src/content/platforms/linkedin.ts` | job-list、job-detail | legacy candidate，未验证 |
| `ats.moka.*` | 现有 Moka Adapter/Writer | application-form | legacy candidate，未验证 |
| `ats.beisen.*` | 现有北森 Adapter/Writer | application-form | legacy candidate，未验证 |
| `ats.feishu.*` | 现有飞书 Adapter/Writer | application-form | legacy candidate，未验证 |
| `ats.dayee.*` | 现有大易 Adapter | application-form | legacy candidate，未验证 |
| `ats.atsx.*` | 现有 ATSX Adapter | application-form | legacy candidate，未验证 |
| `ats.hotjob.*` | 现有 Hotjob Adapter | application-form | legacy candidate，未验证 |
| `ats.alibaba-kuma.*` | 现有 Alibaba/Kuma Adapter | application-form | legacy candidate，未验证 |
| `ats.netease.*` | 现有网易 Adapter | application-form | legacy candidate，未验证 |
| `employer.*` | 现有中国电信/自建站 Adapter 线索 | application-form | legacy candidate，必须逐站拆分 |

每一行迁移后还必须拆成实际 pack ID，并记录：

```text
pack_id | version | page_kind | capabilities | status
fixture_positive | fixture_near_negative | fixture_conflict
edge_result | chrome_result | last_verified_at | known_gaps
```

只有某一行的某项 capability 完成质量门，README 才能写对应能力。例如 Moka 的 `scan-form` 通过，不代表 `write-known-date` 或提交回执也通过；某家公司使用 Moka，也不代表它自动继承另一个公司的 employer overlay。
