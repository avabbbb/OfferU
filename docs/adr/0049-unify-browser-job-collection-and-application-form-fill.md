# ADR-0049：用一个 OfferU 浏览器扩展统一岗位采集与安全网申填表

- Status: accepted
- Date: 2026-08-10
- Related: ADR-0005、ADR-0007、ADR-0020、ADR-0029、ADR-0034

## Context

仓库当前存在两套浏览器扩展材料：

1. `extension/` 是 OfferU 自有的 WXT/TypeScript 项目，已经包含岗位采集、岗位购物车、ATS 适配器和 SmartFill；
2. `Niuke/` 是“牛客网申助手 1.0.5”的已发布压缩产物，只有打包后的 JavaScript、完整性元数据和商店更新地址，没有可维护源码、许可证或公开接口契约。

牛客扩展证明了用户确实需要“选择简历、识别字段、显示匹配/填写进度、补充填写”的一体化体验，也展示了按用户点击使用 `activeTab + scripting` 注入、通过版本化站点选择器持续适配 ATS 的价值。但其发布包会调用牛客私有的简历和表单匹配接口，并包含牛客登录、Cookie、验证码、遥测和云端简历依赖；OfferU 不能把这些实现、资产或私有协议直接并入自己的产品。

OfferU 自有扩展也尚未形成可信入口：README 指向的根目录构建产物与源码不同步，popup 引用缺失的 chunk，源码和文档存在多个错误端口，岗位入库绕开 Operation Registry，插件还持久化独立模型 API Key 并在所有网页常驻内容脚本。继续维护两套插件会复制权限、数据源、设置、构建和审计语义。

## Decision

### 1. 只保留一个 OfferU 自有扩展

OfferU 使用一个 WXT 扩展承载岗位采集、投递表单填写和提交候选证据。`Niuke/` 只作为本地行为参考，不复制其打包代码、图片、CSS、私有接口、登录流程、验证码逻辑或遥测协议，也不随 OfferU 发布。

所有从牛客获得的产品启发必须以 clean-room 方式重新实现，并由 OfferU 自己的类型、测试和安全契约证明。

### 2. 用版本化站点规则包统一两套适配

现有岗位平台配置与 ATS Adapter 收敛到一个 `SiteRuleRegistry`。每个 `SiteRulePack` 是自包含、不可变、带版本和验证状态的数据包，可以分别声明 `job-list`、`job-detail`、`application-form`、`submission-receipt` 能力。运行时只能选中一个已经扁平化的规则包，不执行任意继承链或站点条件分支。

规则包只描述识别信号、CSS 选择器、字段别名、结构定位、能力和扩展内置 `driverId`；复杂下拉框、日期、级联等行为由随扩展打包并接受测试的 `ControlDriver` 代码实现。规则数据不得包含 JavaScript、WASM、动态模块地址、`eval` 表达式或牛客私有接口。`experimental` 规则只能扫描和生成脱敏诊断，只有 fixture 与真实浏览器验收均通过的 `verified` 规则才能进入填表预览。

第一阶段所有规则随扩展构建发布。未来如需远程更新 JSON 数据，必须另立 ADR 解决签名、schema 校验、来源、回滚和商店政策，且远程数据仍不能成为可执行逻辑。

### 3. 扩展只暴露三个求职动作

统一扩展的外部 Interface 只允许：

1. **岗位采集**：从当前岗位详情页生成可审核的岗位导入计划；
2. **投递表单填写**：从 OfferU 已确认职业事实生成填写预览，并在使用者再次确认后填写空白、非敏感字段；
3. **提交候选证据**：在使用者亲自提交后读取成功页或回执的最小证据，形成待确认候选。

扩展不存在“提交申请”动作。表单填写完成、岗位收藏和岗位入库都不等于已经投递。

### 4. OfferU 是唯一简历事实源

扩展只读取 OfferU 后端提供的当前岗位职业投影。它不登录牛客、不读取牛客云简历、不保存独立简历副本，也不保存或直连第三方模型 API Key。需要模型匹配时由 OfferU 后端按现有 provider 和数据授权规则执行。

扩展只接收当前填写计划所需的最小字段投影；完整职业模型、敏感身份字段和 provider 凭据不进入浏览器存储。

### 5. 填表采用预览与二次确认

第一次动作只扫描页面并返回 `FillPlan`，不得修改 DOM。使用者确认同一页面、同一计划后才允许应用；计划必须绑定页面 URL、字段指纹和短期有效期。

第一阶段只填空白、非敏感、高置信字段，并保护网页已有值。身份证明、密码、薪资、工作许可、背景调查、家庭/联系人、推荐/内推、授权同意、隐私条款、文件上传和开放题均不自动填写。任何实现都不得调用最终提交按钮、`form.submit()` 或 `requestSubmit()`。

### 6. 正式投递事实采用候选确认门

使用者亲自点击外部最终提交后，扩展最多生成一条最小提交候选证据。候选在使用者确认前不能创建 `ApplicationAttempt` 或阶段事件；确认后由 Operation Registry 原子创建一次投递尝试和初始 `Submitted` 阶段事件。拒绝候选或误识别不得留下正式投递状态。

### 7. 扩展是 Operation Registry 的浏览器 Adapter

岗位导入、职业投影读取、填写审计、提交候选写入和候选确认都通过同一 Python Operation Registry。扩展不得直接写数据库，也不得为浏览器另建业务接口或状态机。

用户在 popup/侧栏中看到完整计划并点击确认，可以作为该浏览器 UI 动作的显式确认；Operation 仍负责 schema、幂等、审计和错误语义。外部页面 DOM 写入由内容脚本执行，但必须绑定后端生成或审核过的计划，并把可脱敏结果回写审计。

### 8. 权限、入口和构建按最小面收敛

- 默认不声明 `<all_urls>` 静态内容脚本；使用者点击扩展后，以 `activeTab + scripting` 在当前页面注入。
- 主交互使用 WXT `sidepanel` entrypoint；工具栏点击只负责授予当前 tab 临时权限、打开侧边栏并注入本次页面 Agent，不再依赖点击页面即关闭的 popup 承载长流程。
- 后端 host permission 只覆盖本机 OfferU 的 `7410/8765` 契约所需地址；额外站点权限按需申请。
- `chrome.storage.local` 只保存非敏感设置和未同步岗位队列；职业资料、API Key 和提交回执正文不得持久化其中。
- WXT 的 `entrypoints/` 是入口事实源，`.output/chrome-mv3` 是唯一可加载/打包产物。不得再把生成物复制并跟踪到 `extension/` 根目录。
- 第一阶段随扩展发布版本化 ATS 适配器和选择器；任何联网热更新机制另行评审签名、来源和回滚，不默认依赖牛客配置服务。

## Target module seams

- **ExtensionWorkflow Module**：外部 Interface 为 `prepare(action, pageContext)` 与 `confirm(planId)`；UI 和测试只通过此 Interface 观察计划、确认和结果。
- **SiteRuleRegistry Module**：把岗位采集配置与 ATS Adapter 元数据收敛为一个带 schema、版本、状态和 fixture 的规则入口；只返回一个已验证、已扁平化的 `ResolvedSiteAdapter`。
- **Page Adapter seam**：岗位页 Adapter 与 ATS Adapter 将不同站点 DOM 归一化为岗位候选、字段描述或提交证据；新增站点不改变工作流调用方。
- **FillEngine Module**：Interface 为 `prepare(fields, projection)` 与 `apply(plan)`；现有 `smartfill-v2` 作为 Implementation，复杂 Writer 保持内部 seam。
- **OfferUControl port**：OfferU 是远程但自有依赖；生产使用本机 HTTP Adapter，测试使用内存 Adapter。它只投影允许的 Registry Operations，不暴露 raw DB 或任意 HTTP。

## Consequences

- 用户只安装、配置和信任一个扩展；岗位、简历与投递事实不再分叉。
- 牛客的成熟交互可以借鉴，但 ATS 适配和回归样本需要 OfferU 自己持续维护。
- 移除全网页常驻脚本和浏览器内 API Key 会显著缩小权限及凭据暴露面。
- “填写完成”不会立即出现在投递看板；使用者需要在成功证据候选上再确认一次。
- 现有 `ApplicationAttempt(status="prepared")`、`ApplicationRecord(待投递)` 与正式投递事实的重叠必须在实现切片中收敛，不能由扩展继续放大。
- 合并完成前，README 不得宣称插件已经支持可靠填表或投递记账。

## Rejected alternatives

- **直接合并牛客发布包**：缺少源码和复用授权，依赖私有接口且无法建立可信测试、升级和数据边界。
- **保留两个扩展**：重复权限、设置、简历来源和状态语义，用户无法判断哪个是事实入口。
- **把牛客账号作为可选简历源**：没有稳定公开接口与授权契约，并破坏 OfferU 本地职业事实源。
- **一次点击立即填写全部字段**：无法审核敏感值和误匹配，也与已确认的安全边界冲突。
- **成功页自动写入已投递**：页面误识别会直接污染正式事实，违反候选进展确认规则。
- **插件代替使用者最终提交**：改变外部账号状态，违反 OfferU 不自动提交申请的系统不变量。

## Evidence and references

- [Chrome extension permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
- [Chrome activeTab permission](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
- [Chrome scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [Chrome sidePanel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
- [Chrome remote hosted code boundary](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)
- [Chrome storage areas and access levels](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [WXT entrypoints](https://wxt.dev/guide/essentials/entrypoints)
- [WXT scripting](https://wxt.dev/guide/essentials/scripting)
- [WXT project structure](https://wxt.dev/guide/essentials/project-structure)
- [牛客对网申助手的产品说明](https://www.nowcoder.com/discuss/864183883103772672)
- [ADR-0005：外部消息先形成候选进展](0005-confirm-application-progress-signals.md)
- [ADR-0007：一行代表一次投递尝试](0007-one-row-per-application-attempt.md)
- [ADR-0029：统一 Operation Registry](0029-one-operation-registry-for-gui-cli-tui-and-slash-skills.md)
- [ADR-0034：投前决策事实门](0034-require-a-reviewed-pre-application-decision-before-the-hero-resume-proposal.md)
