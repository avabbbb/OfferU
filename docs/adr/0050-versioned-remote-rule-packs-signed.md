# ADR-0050：版本化远程规则包（签名校验）

- Status: accepted
- Date: 2026-08-14
- Related: ADR-0049

## Context

ADR-0049 决定「第一阶段所有规则随扩展构建发布」，并预留：*未来如需远程更新 JSON 数据，必须另立 ADR 解决签名、schema 校验、来源、回滚和商店政策，且远程数据仍不能成为可执行逻辑*。

牛客扩展的实践（从发布包逆向）：`platform-selectors.json` 静态云文件 + `fill-selector` 实时接口，站点改版后**后台热更新、所有用户即时生效**。对照 OfferU：站点规则（`rule-packs/packs/*.json`）、ATS 适配器、平台配置全部构建内置，**新增或修正选择器必须发新版本扩展**，周期 = 商店审核时长。

价值：规则修复/新站点支持可以小时级生效，不需要等商店审核；同时保留构建内置于包作为离线兜底。

约束（继承 ADR-0049）：
1. **远程数据只能是 JSON 规则数据**（选择器、字段映射、能力声明），不携带执行逻辑；
2. 远程包必须**签名校验**（防劫持投毒选择器）；
3. **schema 校验**（复用 `validator.ts`）与**版本回滚**（坏包不应用、可回退）；
4. 驱动代码（reader/writer/registry/resolver）仍在扩展内，远程规则不能引用任意代码或远程脚本地址；
5. 不复制牛客私有接口（`fill-selector` 等）——远程包只承载规则数据。

## Decision

### 1. 规则包 bundle 格式（单一 JSON 文件）

```
{
  "schemaVersion": "1",
  "bundleVersion": 3,          // 单调递增；扩展只应用比已应用版本新的 bundle
  "packages": [ SiteRulePackV1, ... ],
  "signature": "base64url"
}
```

- `packages` 数组元素必须是合法 `SiteRulePackV1`（走现有 `validatePack`；单个包失败不会拖垮整个 bundle——有效包照常加载，无效包记录诊断）。
- `signature` 由发布者持有私钥生成，覆盖**规范化字节**（递归键排序后的 JSON）的 SHA-256 摘要。

### 2. 签名：ECDSA P-256 + SHA-256（Web Crypto）

- 选 P-256 而非 Ed25519：Web Crypto 的 Ed25519 支持较新（Chrome 137+），P-256 全版本可用，且 Chrome Web Store 与各环境兼容性最好。
- 公钥以 **JWK 内置于扩展**（`remote.ts` 常量）；私钥仅存在于发布者本机（`scripts/keys/private.jwk`，gitignore）。
- 验签失败（篡改/密钥不匹配）→ 整个 bundle 拒绝，保留现有规则。

### 3. 拉取与缓存

- 远端地址常量：`https://offeru-rule-packs.pages.dev/bundle.json`（CF Pages 静态托管，见发布流程）。
- 扩展启动/采集时**异步拉取**（fire-and-forget，不阻塞注入与采集主流程）：
  - 拉取失败（离线/404）→ 静默，用内置规则；
  - 验签失败 → 记录诊断（脱敏），用内置规则；
  - `bundleVersion <= 已应用版本` → 跳过（防重放）；
  - 通过 → `registry.loadPacks(有效包)` 增量合并（内置包仍在，远程包按 id 覆盖）。
- 已应用版本存 `chrome.storage.local`（`offeru_remote_rule_version`）；bundle 原文**不持久化**（每次拉取重验，避免存储投毒）。

### 4. 回滚

- 远程包按 `id` 覆盖内置同名包；**降级发布** = 发布低 `bundleVersion` 或移除包 id（扩展退回内置/旧版远程缓存不在——不缓存原文，天然回滚）。
- 若新版本导致规则损坏（运行时异常），诊断计数连续多次失败后**停止拉取升级**（熔断：3 次失败后 24h 内不再尝试），保持最后已知良好版本。

### 5. 发布流程

- `scripts/sign-rule-pack.mjs`：验签自检 → 组装 bundle（内置 packs 目录 + 可选新增包）→ 规范化 → 签名 → 输出 `dist-rule-packs/bundle.json`。
- 部署：`npx wrangler pages deploy dist-rule-packs --project-name offeru-rule-packs`。
- 隐私：bundle 只含规则数据（选择器/字段描述），不含用户职业事实；`SECRET_PATTERNS` 校验继续禁止敏感模式入包。

## Consequences

- 站点选择器修复/新站点支持：签名发布后数分钟内所有用户生效；无需商店审核。
- 安全边界不破：远程数据非执行逻辑、ECDSA 验签、schema 校验、熔断回滚。
- 本地内置规则保留为兜底，离线/攻击场景不劣于现状。
- 商店政策：远程 JSON 数据 + 内置驱动属于允许的 remote configuration（策略与现有做法一致），发布前仍需商店合规复核。
- 不引入牛客私有接口与云简历依赖（ADR-0049 不变）。

## Rejected alternatives

- **无签名远程规则**：劫持/中间人可注入任意选择器（钓鱼、数据外泄），不可接受。
- **Ed25519**：Web Crypto 支持窗口较新，P-256 兼容性更稳。
- **bundle 持久化缓存**：存储内旧 bundle 可被投毒并绕过网络验签；每次拉取重验成本可接受（bundle < 100KB）。
- **按包远程拉取（每站点一个 URL）**：增加失败面与请求次数；单一 bundle 更简单且能整体原子验证。