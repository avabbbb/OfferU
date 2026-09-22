# OfferU Zero-Setup Beta — 小白用户首次使用与完整求职闭环

Date: 2026-09-22
Status: product design proposal
Scope: onboarding / local Agent integration / Profile bootstrap / job capture / email progress sync
Non-scope: this document does not change Runtime, Operation Registry, or Eval implementation.

## 1. Why this document exists

OfferU 已经具备较深的本地 Career OS 能力，但当前工程能力和普通用户的实际体验之间仍有明显落差。

当前仓库已经有：

- Tauri desktop shell + Python local runtime；
- 本机 Coding Agent discovery / connection；
- Skill + Agent Tool Surface + Operation Registry；
- Resume / Profile / Career Evidence；
- browser extension 的手动岗位采集与 Smart Fill；
- QQ / 163 / 126 / Gmail / Outlook 等只读邮箱同步；
- ApplicationProgressCandidate / review / stage event；
- Career Memory / Learning Observation / Memory Inbox；
- Today / Pipeline / Job / Resume / Interview 等业务 Surface。

问题不是继续增加更多 Operation。

问题是：一个不懂 Python、Node、MCP、CLI、Provider、端口和 Runtime 的求职用户，目前还不能把这些能力自然地理解成一条简单产品流程。

本设计的目标是把底层复杂度隐藏起来，让 OfferU 从“强工程能力集合”变成“安装后十分钟内能完成第一次价值闭环的求职产品”。

---

## 2. North Star

> 用户下载并安装 OfferU 后，不需要安装开发环境，不需要手动配置 API Key，不需要理解 Agent / MCP / CLI / Operation Registry；OfferU 自动发现用户已经在使用的本地 AI，帮助用户建立可信 Profile、保存第一个岗位、同步第一条求职进度，并最终告诉用户“今天最应该做什么”。

目标用户首先是普通求职者，而不是 Agent 工程师。

用户需要理解的产品语言只有：

- 认识我
- 找机会
- 准备
- 投递
- 跟进
- 面试

工程概念全部隐藏在产品后面。

---

## 3. Product principles

### 3.1 Zero setup before power-user setup

默认用户路径不得要求安装：

- Python
- Node.js
- Git
- npm / pip
- MCP server
- CLI package

这些仍可作为 developer / advanced mode 存在，但不能是消费者首次使用路径。

### 3.2 Reuse the user's existing AI

OfferU 不需要重新要求用户配置一套模型体系。

优先：

1. 自动发现本机已存在的 Codex / WorkBuddy / Claude Code / OMP / OpenCode / Pi 等 Runtime；
2. 检查是否可用；
3. 使用其原生登录 / credential；
4. OfferU 只提供 Career Skills、Tools、Context 和受控执行能力。

如果一个本地 Agent 不可用，OfferU Built-in Agent 可以作为 fallback，而不是主要产品入口。

### 3.3 Profile is proposed, never secretly invented

Resume、Agent Memory、Email、Interview、Conversation 都可以成为 Profile 的来源。

但来源必须进入：

```text
Source
→ Learning Observation / Evidence
→ Candidate
→ Conflict / dedupe
→ user review when required
→ Career Truth
```

禁止：

```text
Agent inferred something
→ directly becomes verified Profile fact
```

### 3.4 User-triggered capture before unattended crawling

消费者默认岗位采集路径：

```text
User opens job page
→ OfferU Extension reads current page DOM
→ preview
→ user clicks Save to OfferU
→ local Job
```

不把大规模 unattended crawling 作为默认路径。

### 3.5 Automation stops before irreversible external action

OfferU 可以：

- 帮用户保存岗位；
- 生成材料；
- 填表；
- 创建投递草稿；
- 识别邮件进度；
- 提议更新阶段。

但默认不能：

- 自动 Submit job application；
- 自动发送邮件；
- 自动给招聘方发消息；
- 将未经确认的推断写入 Career Truth。

---

## 4. Target first-run journey

目标：一个完全不了解 Agent 工程的用户，从下载到第一次价值闭环，主动操作时间尽量控制在 10 分钟级别。

```text
Download OfferU
    ↓
Install
    ↓
Find my AI
    ↓
Know me
    ↓
Save my first job
    ↓
Connect job-search inbox
    ↓
OfferU builds Today
```

成功不是“服务成功启动”。

成功是：

> 用户在 Today 中第一次看到基于自己真实 Profile、真实岗位和真实求职进度生成的下一步行动。

---

## 5. Step 1 — Install OfferU

### User experience

Windows:

```text
OfferU-Setup-x.y.z.exe
→ double click
→ install
→ launch OfferU
```

macOS:

```text
OfferU-x.y.z.dmg
→ drag to Applications
→ launch OfferU
```

用户不应该看到 Python、sidecar、端口和 shell。

### Runtime behavior

Installer / desktop runtime internally owns:

- local Python sidecar；
- schema migration；
- local data directory；
- health / restart；
- update / rollback；
- Agent discovery helper；
- extension onboarding helper。

### Reference

WorkDaddy demonstrates the target installation ergonomics:

- Windows Setup.exe；
- macOS DMG；
- automatic target detection；
- custom client fallback through a picker；
- no requirement for users to edit config files or environment variables。

Reference:
https://github.com/babygoton/WorkDaddy

### Definition of Done

- clean Windows machine install works without Python / Node / Git；
- clean macOS machine install works without developer tools；
- first launch automatically starts local runtime；
- failed runtime startup produces one user-readable recovery action；
- uninstall does not silently destroy user Career data；
- update preserves user data and Agent selection。

---

## 6. Step 2 — Find my AI

### User experience

First-run page:

```text
找到你的 AI

✓ WorkBuddy        已连接
✓ Codex            已登录
○ Claude Code      未发现

OfferU 会使用你已经登录的 AI，不需要重新填写 API Key。

[继续]
```

If multiple are available:

- pick a recommended default；
- allow user to switch；
- do not ask the user to understand Provider architecture。

### Runtime behavior

```text
detect runtimes
→ probe executable
→ probe authentication / readiness
→ verify OfferU bridge
→ store user's chosen runtime
```

The product should distinguish:

- detected；
- ready；
- blocked auth；
- unavailable；
- unsupported。

Never turn a detected binary into a claim that the Agent has been fully verified.

### Definition of Done

- one-click discovery；
- no manual path editing for standard installs；
- no OfferU API Key required for native-login runtimes；
- failure reason is human-readable；
- user can skip and use fallback Agent。

---

## 7. Step 3 — Know me: Resume + existing AI memory → Profile

This is the most important onboarding step.

### User experience

```text
先让我认识你

[拖入简历 PDF]

我们还发现你的本地 AI 中可能有职业相关记忆。

[允许 OfferU 整理这些记忆]
```

After processing:

```text
整理完成

31 条有简历证据的事实
8 条职业偏好
3 条待确认信息
2 条冲突

[查看并确认]
```

### Data flow

```text
Resume
      \
       → Observation / Evidence
Local Agent Memory
       → normalize
Conversation history
      /
        ↓
dedupe + conflict detection
        ↓
Profile candidates
        ↓
Career Truth
```

### Existing building blocks

Current OfferU already has relevant primitives such as:

- `inspect_resume_document`
- Profile Evidence
- `import_harness_memory`
- `distill_harness_conversation`
- Learning Observation
- Memory Inbox
- Memory Proposal

The missing product layer is a safe source-discovery and review experience that converts these primitives into one onboarding flow.

### Privacy rule

OfferU must never silently scan every local Agent history.

Required flow:

```text
source discovered
→ explain what will be read
→ explicit user permission
→ bounded import
→ preview extracted candidates
→ user control
```

### Definition of Done

- Resume alone can create a usable T0 Profile；
- optional Agent memory import improves Profile without overwriting Resume-backed facts；
- duplicate information collapses into one fact with multiple provenance entries；
- conflict is visible instead of silently resolved；
- inferred facts cannot enter verified truth without required confirmation。

---

## 8. Step 4 — Save my first job

### Default consumer path: browser extension capture

```text
User opens BOSS / Liepin / Zhaopin / LinkedIn / company career page
        ↓
OfferU detects current job
        ↓
[保存到 OfferU]
        ↓
preview
        ↓
dedupe
        ↓
local Job
        ↓
fit / evidence gap / preparation
```

This is intentionally different from unattended crawling.

The extension should read the page the user has already chosen to open and only capture after an explicit action.

### BOSS strategy

Default:

> manual, user-triggered current-page capture.

Do not make reverse-engineered BOSS APIs or automatic bulk crawling a required consumer feature.

A CLI integration can remain an experimental / advanced source adapter if legally and operationally appropriate.

Useful technical reference:
https://github.com/jackwener/boss-cli

That project demonstrates that search, detail, application/history and other BOSS data can be exposed through a CLI, but it relies on reverse-engineered APIs / browser credentials. Therefore it should not define OfferU's default consumer acquisition path.

### Product copy

Bad:

```text
Import JD
Run scraper
Sync source
```

Good:

```text
保存到 OfferU
```

After save:

```text
✓ 已保存
正在结合你的 Profile 分析...
```

### Definition of Done

- user can install the extension without developer mode；
- capture is one primary click；
- repeated capture of the same job does not create duplicates；
- source URL / source identity / JD evidence are preserved；
- SPA navigation does not capture stale content；
- unsupported sites fail gracefully；
- capture does not submit forms or send external requests beyond the local OfferU ingest flow。

---

## 9. Step 5 — Connect job-search inbox

### User experience

```text
连接求职邮箱

[QQ 邮箱]
[163 邮箱]
[Gmail]
[其他]
```

QQ example:

```text
邮箱
[____________]

应用授权码
[____________]

[在哪里获取授权码？]

[连接]
```

Do not expose the words IMAP UID, BODY.PEEK, cursor, candidate or signal in the normal UI.

### Existing backend flow

OfferU already has a strong basis:

```text
read-only mailbox
→ incremental sync
→ relevance filtering
→ deterministic stage classifier
→ optional LLM classifier
→ application matching
→ ApplicationProgressCandidate
→ user review
→ ApplicationStageEvent
```

For IMAP, the implementation already uses read-only inbox access and non-mark-read fetching.

### Target UI

After first sync:

```text
正在整理最近的求职邮件...

读取 286 封
求职相关 17 封
识别出 9 个岗位
发现 12 条进度
4 条需要确认
```

Review card:

```text
字节跳动 · AI 产品经理

发现新的面试进展
建议：一面
时间：9 月 25 日 14:00
置信度：96%

依据：
“邀请您参加第一轮面试……”

[确认] [修改] [忽略]
```

### Principle

Email intelligence creates candidates, not truth.

```text
mail
→ candidate
→ review
→ event
```

not:

```text
mail
→ AI guess
→ silently mutate Pipeline
```

### Definition of Done

- QQ real read-only sync verified；
- unread/read state remains unchanged；
- irrelevant mail precision/recall measured with a user-labeled sample；
- job association accuracy measured；
- ambiguous association requires review；
- accepted candidate updates Timeline / Pipeline / Today consistently；
- revoke stops future sync and respects privacy lifecycle。

---

## 10. Step 6 — First Today

Onboarding is complete only when the user reaches a useful Today state.

Example:

```text
今天

明天 14:00
字节跳动 · AI 产品经理
一面
[开始准备]

今天截止
腾讯 · 产品经理
在线测评
[查看]

你刚保存了
小红书 · AI 产品经理
证据缺口：用户研究 / 指标
[开始准备]
```

The user should now understand OfferU's value without understanding its architecture.

---

## 11. The complete consumer journey

After onboarding, OfferU should support this continuous loop:

```text
Profile
  ↓
Capture Job
  ↓
Evaluate / Research
  ↓
Prepare tailored Resume
  ↓
Smart Fill
  ↓
USER SUBMIT
  ↓
Application record
  ↓
Email / user / browser progress signal
  ↓
Progress candidate
  ↓
Confirmed stage event
  ↓
Interview preparation
  ↓
Interview debrief
  ↓
Learning Observation
  ↓
Profile evolution
  ↓
better next decision
```

This is the product loop.

Individual tools are implementation details.

---

## 12. UX information architecture

Normal users should see:

```text
Today
Pipeline
Job
Profile
```

They should not see a top-level navigation made of:

```text
Agent
MCP
Operations
Provider
Memory Runtime
CareerTask
```

Those belong in Settings / Advanced / diagnostics when necessary.

### First-run CTAs

Only one primary CTA per stage:

1. 安装完成 → `开始设置`
2. Agent found → `继续`
3. Resume imported → `整理我的 Profile`
4. Extension → `保存第一个岗位`
5. Email → `连接求职邮箱`
6. Today → `开始今天的任务`

---

## 13. Current capability map

This document does not claim all of the following are production-ready. It distinguishes existing primitives from consumer readiness.

| Journey capability | Existing basis | Main product gap |
| --- | --- | --- |
| Desktop runtime | Tauri + Python sidecar + release pipeline | clean-machine consumer release / signing / macOS parity |
| Agent discovery | local Agent detection / connection | first-run automatic selection + zero-config recovery |
| Resume → Profile | resume inspection + Profile Evidence | single onboarding flow + human-readable review |
| Agent Memory import | harness memory import / distillation | source adapters + permission + candidate merge |
| Job capture | browser extension + local ingest | store distribution + polished one-click onboarding |
| BOSS capture | extension page-rule path | live compatibility evidence + store delivery |
| Smart Fill | field mapping / adapters / review boundary | live ATS compatibility and release verification |
| Email read | Gmail readonly + IMAP presets including QQ | consumer authorization guidance + live acceptance |
| Email classification | rule + optional LLM | calibrated relevance / stage quality |
| Progress matching | ApplicationProgressCandidate | simplified review UX |
| Manual progress | existing application update primitives, but Eval found a candidate-path gap | unified user-statement → candidate/event flow |
| Today projection | existing Today / Career state | first-run journey that reliably reaches a useful Today |

---

## 14. Delivery phases

### Phase A — Zero-Setup shell

Goal:

```text
install → launch → Agent found
```

Deliver:

- Windows installer release；
- macOS DMG release；
- bundled runtime；
- automatic Agent discovery；
- first-run wizard skeleton；
- clean-machine E2E。

### Phase B — Know Me

Goal:

```text
Resume + optional Agent memory → trustworthy Profile T0
```

Deliver:

- Resume drag/drop；
- source discovery；
- permission screen；
- Profile candidate review；
- conflict / dedupe UI；
- onboarding metrics。

### Phase C — First Opportunity

Goal:

```text
browser → Save to OfferU → Job → preparation
```

Deliver:

- extension store package；
- BOSS / Liepin / Zhaopin / LinkedIn / supported ATS page coverage；
- save preview；
- duplicate handling；
- SPA navigation verification。

### Phase D — Progress Sync

Goal:

```text
mailbox → relevant career signals → review → Pipeline
```

Deliver:

- QQ guided auth；
- Gmail guided auth；
- first 30-day sync；
- progress review inbox；
- application matching；
- Timeline / Today consistency。

### Phase E — Golden Path Beta

Freeze a single consumer acceptance journey:

```text
install
→ connect local Agent
→ import real Resume
→ optional memory import
→ save real Job
→ prepare
→ Smart Fill
→ user submits
→ connect real mailbox
→ recognize progress
→ confirm stage
→ prepare interview
→ debrief
→ Profile evolves
```

Only after this journey is repeatably successful should major new feature work resume.

---

## 15. Product metrics

The primary metrics are not Operation counts.

### Activation

- installer completion rate；
- Agent-ready rate；
- Profile T0 completion rate；
- first Job saved rate；
- mailbox connected rate；
- first useful Today reached rate。

### Friction

- active onboarding minutes；
- number of manual config fields；
- number of terminal / developer steps: target = 0；
- number of unexpected permission prompts；
- number of times a user must leave OfferU to read technical docs。

### Quality

- Profile fact precision / unsupported facts；
- Job capture field accuracy；
- duplicate Job rate；
- email relevance precision / recall；
- application association accuracy；
- critical Smart Fill field error；
- external auto-submit count: target = 0。

### Reliability

- clean first-run pass rate；
- same journey repeatability；
- restart recovery；
- upgrade / migration success。

---

## 16. Explicit non-goals

This initiative is not:

- another internal Agent rewrite；
- an excuse to add more model providers；
- a goal to reduce 112 Agent tools to an arbitrary smaller number；
- a BOSS crawler project；
- auto-submit automation；
- automatic Profile mutation from unverified Agent memory；
- a new parallel backend。

Tool Surface V2 and real Agent Eval should continue independently: the objective here is consumer productization of already existing capabilities.

---

## 17. References

### Installation / local app onboarding

WorkDaddy
https://github.com/babygoton/WorkDaddy

Relevant lessons:

- native installer packages；
- automatic local client detection；
- fallback file picker；
- persistent user selection；
- no config-file / environment-variable onboarding。

### Career workflow UX

career-ops
https://career-ops.org/

Useful conceptual flow:

```text
profile
→ scan / capture
→ evaluate
→ apply
→ tracker
```

Its apply mode also keeps the user in the loop instead of claiming to submit an application automatically.

### Current-page capture pattern

Career Ops Capture
https://chromewebstore.google.com/detail/career-ops-capture/emnnnnjlecidladmnnjopelhipkomnaa

Useful pattern:

> user opens the page, user explicitly captures it, local career system receives the job.

### Experimental BOSS CLI reference

boss-cli
https://github.com/jackwener/boss-cli

Use as a technical research reference, not as the default consumer acquisition architecture.

---

## 18. Decision requested

Before starting another broad feature wave, align on these product decisions:

1. OfferU Consumer Beta is distributed as native installers, not a developer setup guide.
2. External local Agents are the default reasoning layer; built-in Agent is fallback.
3. First-run Profile combines Resume with explicitly authorized local AI memory, but all unverified learning stays candidate/evidence-first.
4. Manual current-page browser capture is the default job acquisition path for consumer users.
5. Email sync creates reviewable progress candidates instead of silently mutating the Pipeline.
6. The next product milestone is a repeatable Zero-Setup Golden Path, not a larger tool catalog.

If these six decisions are accepted, implementation should be sliced by the phases above and evaluated against one frozen end-to-end consumer journey.
