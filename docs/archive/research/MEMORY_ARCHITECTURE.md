# OfferU Memory 架构设计文档

> 目标：把"career-ops 文件式记忆 + OfferU 结构化记忆"两类范式，与 2026 业界生产级 agent memory 实践（三 tier 分层 + boot/surface/recall 读路径 + Write Guard + supersede 审计 + dream 巩固 + 反事实验证 + 局部 supersede）合成一套可落地方案，覆盖四块：分层思想、检索注入更新、memory 评估、self-improvement。本文档独立可供后续上下文压缩后凭本地继续推进。

---

## 0. 设计调研结论（必读）

| 参考系统 | 关键机制 | OfferU 可借鉴点 |
|---|---|---|
| **santifer/career-ops** (59k⭐) | `cv.md` / `profile.yml` / `pipeline.md` / `modes/*.md` 即记忆；每个 session 读回上下文 | **声明式文件记忆**：modes 作 procedural skill，STAR Story Bank 作 semantic，AGENTS.md 作 L0 rules |
| **qbtrix/soul-protocol** `memory-architecture.md` | 5-tier + ACT-R activation + `superseded_by` + 用户驱动 supersede 双轨审计 + reconcile_fact 三分去重 | **三分去重 skip/merge/create**，**双轨 supersede 审计**，**raw-text 矛盾扫描**，**`include_superseded=True` "我曾以为"查询** |
| **SanctumOS Dream Agent** | 02:00 cron，2h 预算，Hippocampus/Neocortex/Glymphatic 三模块；70–80% 存储削减、<100ms 检索 | **夜间潮汐节律**，**三神经模块流水线**，**supersede 不删轨迹** |
| **smysle/agent-memory** | boot/surface/recall 三动词；Write Guard 语义 dedup + typed merge + 冲突检测；Conflict Override；passive feedback；semantic decay | **三段读路径**，**Write Guard 五阶段**，**被动反馈信号**，**语义过期检测** |
| **APU (Agent Processor Unit)** | 4-tier cache (DLL/working/Weaviate/Letta)，BMJ 路由 L1 命中 78%，Page Fault，12 active blocks 上限，Move-to-Front，异步写回 | **热/冷双路径**，**Page Fault 页入页出**，**LLM-managed paging**，**HUD 中断 override** |
| **Governed Memory** (arxiv 2603.17787) | 双模态记忆 + tiered governance routing + reflection-bounded retrieval（2 轮上限）+ entity-scoped 隔离 + 模式生命周期闭环 | **Progressive Delta Delivery**，**反思轮数封顶**，**实体级零泄漏**，**质量饱和点 ~7 governed memories/entity** |
| **Auto-Dreamer** (arxiv 2605.20616) | 学习型 offline consolidator；选 working region 只读，bounded tool-use 检视，合成紧凑集 supersede 原区域；GRPO 训练；ScienceWorld +7 分，memory 12× 小 | **离线局部 supersede**，**typed region 选择**，**端到端 reward 训练** |
| **Active Dreaming Memory** (engrxiv) | DBSCAN 失败聚类 → 规则抽象 → **反事实验证（合成测试场景）** → 仅 verified 入库；4.2% false consolidation；83% 首学成功率 | **反事实验证防 spurious rule**，对齐 OfferU "防虚构规则"，4 阶段经验提取 |
| **arxiv 2606.24775《Are We Ready》** | 四模块评估（Representation / Extraction / Retrieval / Maintenance），**局部维护成本优于全局重排** | **评估框架** + **局部优先策略** |
| **Memory in the LLM Era** (arxiv 2604.01707) | 四阶段统一框架，paradigms 比较，token cost efficiency / 位置敏感性 / context scalability | **统一四阶段抽象**，**token 成本监控** |

**关键设计原则提取**：

1. **不同层用不同检索**：L1 直查 by URI，L2 时间窗，L3 语义+图，L4 task 路由。"对所有层都 cosine" 是最常被点名的架构错误。
2. **L1/L2 必须有上限 + page out**：Letta 2–4KB / APU 12 active blocks。超过即页出 L3，触发 page fault 页入。
3. **双轨 supersede 审计**：用户显式 supersede 写审计 trail，dream/contradiction 内部 supersede **不写**——否则夜跑淹没用户意图。
4. **局部维护优于全局重排**（arxiv 2606.24775 实证）：但局部 supersede 必须配合 provenance 依赖图，否则不知道动谁。
5. **dream 不可直接改 charter/S00L.md**：dream pass 只能写 dream-journal + decay affect，持久化规则由后续 reflection pass ratify。
6. **反事实验证守住入库闸门**（Active Dreaming Memory）：规则类知识合成测试场景跑通才入库，防 spurious 学习。
7. **existing character: HITL-first + Zero Fabrication**：每条 L3 事实可点回原话（OfferU 防虚构规则的工程实体化）。

---

## 1. 总体架构：六层记忆 + 三动词读路径 + 五阶段写路径

```
┌────────────────────────────────────────────────────────────────────┐
│                          L0 Rules (常驻)                            │
│  AGENTS.md + S00L.md (memory 元规则, agent-writable)                 │
├────────────────────────────────────────────────────────────────────┤
│ L1 Identity (Core 2–4KB)    │ L2 Episodic       │ L3 Semantic       │
│ Profile sections+Bullets    │ chat SSE + batch  │ bullets(STAR) +    │
│ 直查 by URI / DLL HEAD      │ append-only       │ StoryBank + Dossier│
│ 12 active blocks 上限       │ recency_boost     │ BM25+vector hybrid │
│ → page out L3 → page in     │ archive >48h      │ 1000 facts/type    │
├────────────────────────────────────────────────────────────────────┤
│ L4 Procedural Skills       │ L5 Archival                          │
│ agents/skills/*.py +       │ evicted episodics → cold vector      │
│ modes/*.md (career-ops 式) │ fallback page fault only             │
│ skill router 触发          │                                      │
└────────────────────────────────────────────────────────────────────┘
```

### 1.1 五阶段写路径（Write Guard, 对齐 smysle + soul-protocol）

```
observe(interaction)
  → ① 实体抽取         (识别 user / job / pool / batch)
  → ② 事实抽取         (S-P-O 三元 + 置信度 + 原话引用 + 时间戳)
  → ③ 语义去重         (token overlap > 0.7 → skip/merge/create)
  → ④ 冲突检测         (template-prefix 路 + raw-text 路 并发)
  → ⑤ 自反思           (LLM 判: 值得永久化? 置信度<阈 → 入 episodic 不入 semantic)
  → 写入 + provenance.digest  (source_msg_id, observed_at, transform_version)
```

### 1.2 三动词读路径（对齐 smysle/agent-memory）

```
startup    → boot()    : 拉 L0 + L1 identity → 注入 system prompt
pre-reply  → surface(q): 上下文感知 readonly 召回 L2/L3 → 进 working context
explicit Q → recall(q): 用户明确问经历/事实
search miss→ page fault: MMU 检测 L1 miss → 页入 L3
```

热路径（用户等待）：BM25 → L1 DLL → 命中即回（APU 实测 78% L1 cache hit）。
冷路径（后台）：写回 L5 archival 不阻塞响应，asyncio.PriorityQueue 优先级 2，指数退避 3 次。

---

## 2. Memory 分层思想 —— career-ops 文件式 × OfferU 结构化

单一存储是八字形死结：纯文件（career-ops）丢失语义/难去重/难冲突检测；纯 DB（OfferU 现状）丢溯源、规则散在代码里。2026 年共识是 4–5 tier 分层 + 各层不同检索语义。

| Tier | 内容 | 在 OfferU 是什么 | 存储 | 检索语义 | 上限 |
|---|---|---|---|---|---|
| **L0 Rules** | 过程性元规则（memory 怎么用） | `AGENTS.md` + **`S00L.md`**（新增见 §4.1） | git / Md, agent-writable | 始终注入常驻 context | <4KB |
| **L1 Identity** | 当前档案/活跃任务 | Profile sections + Bullets | SQLite, schema-enforced | 直查 by URI（DLL HEAD） | 2–4KB core |
| **L2 Episodic** | 会话/批次原始轨迹 | chat SSE 流 + batch run log | append-only SQLite + archive | 时间窗 + recency_boost | 无界, 归档压缩 |
| **L3 Semantic** | 提取事实/故事库 | Bullets（带 confidence/quote）+ STAR Story Bank + JD Dossier + Company Research | SQLite + 可选向量索引（BM25+vector） | 语义+图遍历（Mem0/Zep Graphiti 模式） | 1000 facts/type |
| **L4 Procedural Skills** | 怎么做 | `agents/skills/*.py` + 移植 career-ops `modes/*.md`（scan/pipeline/pdf/deep/email/contacto） | 代码/Md | skill router 触发 | — |
| **L5 Archival** | 冷历史 | evicted episodics > 48h | 向量库 cold tier | fallback page fault | 无界 |

**OfferU 现状缺口**：
- L1 Profile 无上限 → 必须补"12 active blocks + page out L3"机制。
- L2 缺归档压缩 → 必须补 >48h episodic 自动 archive。
- L3 缺 STAR Story Bank 这个核心库 → 必须把零散 bullet 升级为可复用故事单元（career-ops 的核心借鉴）。
- L4 `modes/*.md` 缺失 → 直接移植 career-ops 的 mode 体系，让 Web Agent / MCP Agent / CLI Agent 共享同一份 procedural 知识。

---

## 3. 检索 / 注入 / 更新策略（细节重点）

### 3.1 注入策略 —— Progressive Delta Delivery + Reflection-Bounded Retrieval（Governed Memory 算法 5/6）

**Session-aware delta delivery**：维护"本 session 已注入哪些 memory 变量"账本，下一轮只注入**新增或新相关**内容。配套 reflection-bounded retrieval：每次召回后 LLM 低温 0.1 判"证据完整性"，不完整则在 0.3 生成 1–2 条 follow-up 查询，**2 轮封顶**（每轮 = 1 次 LLM 调用 + 0–2 次 embedding search，延迟可预测）。

**实体级 hard isolation**：CRM key scope， Governed Memory 在 3,800 对抗查询拿到零泄漏。映射 OfferU：池子就是 entity scope——"互联网运营"召回时**绝不**带入"银行管培"的 STAR 故事，除非显式跨池查询。

**输出质量饱和点 ~7 governed memories/entity**（Governed Memory 实证）：每个实体注入不超过 7 条 memory 后收益戛然而止。OfferU 应对每岗位/池注入做 token budget 强约束。

### 3.2 更新策略 —— 三分去重 + 双路冲突 + Supersede 双轨审计

**三分去重**（soul-protocol `reconcile_fact()`）：
| 决策 | 触发 | 行为 |
|---|---|---|
| `skip` | 重复且同值 | 直接跳过（防 bloat） |
| `merge` | 同事实新值 | LLM 合并成一条新表述（可选 CognitiveEngine 合并，无则 newer 替换 older） |
| `create` | 全新主题 | 直接建条目 |

**双路冲突检测（必须并发）**：
- **template-prefix 路**：匹配结构化槽位（"用户现居 / 当前求职状态 / 期望薪资 / 目标城市"），命中即 `superseded_by = new_id`（老事实不删，退出检索）。
- **raw-text contradiction 路**：走语义比对，抓 template 没覆盖的人生变更（如"下周去杭州"）。否则未覆盖字段会累积重复事实。
- **Conflict Override 例外**：状态翻转（TODO→DONE / 未筛选→已筛选）**永远不当冲突去重**（smysle F2 规则），否则岗位分拣就废了。

**Supersede 原语 + 双轨审计**（soul-protocol 2026-04-27 核心）：
- `superseded_by` 字段把老事实退出检索，老 entry 仍留盘可查 `facts(include_superseded=True)` → "我曾以为"查询能力。
- **两套审计分离**：
  - 用户显式 `soul.supersede(old, new, reason)` → 写 `supersede_audit` 串行轨迹（可追溯"为什么改"）。
  - 内部 dream-cycle / contradiction detector 自动 supersede **不写**这条 trail（否则夜跑淹没用户意图）。

### 3.3 局部 vs 全局更新（arxiv 2606.24775 实证结论）

**局部维护比全局重排性价高得多**，但前提是有 provenance 依赖图：局部 supersede 一个上游后，不知道下游派生信息就动谁。

- Dream consolidation 应选 **bounded working region** 做只读证据，合成新紧凑集 **supersede 原始 region**（Auto-Dreamer 核心：region 内 read-only → bounded tool-use → 合成 → replace）。
- OfferU 落点：每晚只对"今天新产生的 bullets / JD"那一片做 consolidation，**不要每夜全库重 embedding**。

---

## 4. Memory 评估 —— 2026 公认薄环节，最大工程投入点

行业现状：LoCoMo / LongMemEval **只测对话式召回**，既测不出 procedural memory 质量、跨 agent 一致性，也测不出抗投毒。四块都得**自建 instrumentation**。

### 4.1 召回合理性（不是 recall@k）

两层都要测：
- **Hit 率与使用率**：surface 命中后，被命中的 memory **是否真的被 LLM 用进回答**（不只是检出）。做法（smysle F4 passive feedback）：每次召回 top-3 自动打正反馈，限速 3 次/memory/24h，防刷分。更严：对回答做 **source attribution 反查**——"这条 bullet 是否出现在最终 tracing"。OfferU "溯源标记"已做到 resume 级，要下沉到 bullet 级。
- **反思闭环合理性**（Governed Memory 算法 6）：每轮召回后低温 LLM 判"证据完整性"，不完整就生成 follow-up query，**2 轮封顶**。评估指标 **context defect rate**：多少比例的回复需要 >1 轮召回才完整。

### 4.2 冲突解决质量

两路并发冲突检测的评估分两类：
- **冲突召回率**：raw-text 矛盾抓取 → 合成"用户改了城市/薪资/婚育状态"用例集跑。
- **冲突精度**：是否把合法状态翻转误判为冲突（§3.2 例外）→ 测一批 TODO→DONE / 未筛选→已筛选 翻转用例，要求零误去重。
- **零跨实体泄漏**（Governed Memory 在 3,800 对抗查询拿到 0 泄漏）：两池塞交叉对抗 JD，验证 entity-scope 过滤。

### 4.3 更新的局部问题（最大工程坑）

Supersede 一条 bullet 后，所有派生 artifact 怎么办？
- 一份简历的某 bullet 基于"腾讯-内容运营"用旧 Profile 生成，用户改了"只接受一线、不接受 996"后，那份简历是否过期？OfferU 现状没联动 = 简历带陈旧约束。
- 解法 = **provenance graph**：每个 derived artifact 反向追溯到 source memory ID，supersede 触发 **needs-refresh** 标记写入下游 artifact。
- 评估指标：supersede 上游后 24h 内**下游错配率（stale-derived-ratio）**。
- 学术背书：arxiv 2606.24775 明确"局部维护本就更优"，但前提是有依赖图，否则局部 supersede 是瞎动。

### 4.4 溯源问题（与 §3.2 防虚构是一对镜面）

- 每条 L3 事实必须带：`source_msg_ids[]`、`observed_at`、`transform_version`、`confidence`、**原话引用 `quote`**（与 README 防虚构规则对齐）。
- OfferU 应在 Bullet 表加 `source_quote` + `source_chat_turn_id` 两个 NOT NULL 列；STAR bullet 级溯源一律可点回"用户说的原话那一句"——这是 README "防虚构规则"的**工程实体化**，比规则文本硬。
- 评估 = **provenance coverage**：抽样 N 条 L3 facts，多少能追到具体 chat turn。>95% 合格。

---

## 5. Self-Improvement —— S00L.md / 夜间潮汐 / Dreaming / 经验提取

### 5.1 `S00L.md` 这类 memory-rule 机制（元层记忆）

它**不是存知识的记忆，是存"怎么管记忆"的规则**：
- dedup 阈值（conflict token overlap）
- 冲突检测双路开关
- TTL by type（identity 永不过期 / emotion 半衰 / event 90 天 / knowledge 见 supersede）
- entity scope 隔离表
- tier 上限
- reflection 上界轮数
- recall token budget

**agent-writable**（对齐 Claude Code auto-memory / LangMem `update_system_prompt`），但被 §5.2 的"dream 不可直接改 charter"护栏守住：dream pass **只能写 dream-journal surface + decay affect，不能直接改 S00L.md**；持久化规则必须由后续 reflection pass **ratify** 才能 promote 进 S00L.md。

这条护栏（dream-consolidation 模式）是 2026 最关键的安全线——开放的自我编辑 = uncontrolled self-edit，几个月项目就烂掉。

### 5.2 夜间潮汐（低活时段离线巩固）

照 SanctumOS Dream Agent 运行册，按 OfferU 节奏改：

```yaml
DREAM_AGENT_ENABLED: true
DREAM_AGENT_SCHEDULE: "0 2 * * *"      # 02:00 用户基本不动
DREAM_AGENT_BUDGET_HOURS: 2
DREAM_AGENT_MAX_THREADS: 3
DREAM_AGENT_QUALITY_THRESHOLD: 0.8      # <0.8 不入 semantic, 留 episodic
```

三神经模块流水线：
1. **Hippocampus（蒸馏）**：扫当天 chat + batch 运行，出 facts（S-P-O+时间+源+置信度）、themes、open loops、per-segment embedding。**只读 raw，不改 raw。**
2. **Neocortex（整合）**：组合候选并入 dossiers / timelines / ledgers / relationship maps。**做冲突解决 + 知识融合。**
3. **Glymphatic（压实 + supersede）**：压索引、生成多级摘要、**打 supersession 标记**（不删，标过期）。SanctumOS 实测 70–80% 存储削减、索引压到 10–15%、检索 <100ms。

### 5.3 Dreaming 巩固（三流派，选最贴）

| 流派 | 核心做法 | 适合 OfferU 的点 |
|---|---|---|
| **Claude Platform "Dreams"** | 异步 job 吃 memory_store + 1–100 个 session transcript，产出**另一个 dedup+reorg 过的 store**，**绝不改 input**，失败也留 partial 供排查 | 最易上手：不动现库，每夜产 `memory_store_v{N}` 第二天切流量 |
| **Auto-Dreamer** (arxiv 2605.20616) | 选 typed memory bank 的 working region 作只读证据，bounded tool-use 检视，合成紧凑集 supersede 原始 region；GRPO 训练，端到端 reward | 比 ad-hoc prompt 稳，但要训练成本 |
| **Active Dreaming Memory** (engrxiv) | **反事实验证**——抽规则后**合成测试场景**，跑 simulate，**只解决问题"类"才入库**，否则拒；4.2% false consolidation；95% retention after 500 episodes | **最贴 OfferU "防虚构"**，杜绝 spurious pattern 入库 |

### 5.4 经验提取（从 episodic 失败抽 verified rules）

四阶段（ADM 实战流程，套到简历生成失败用例）：

1. **DBSCAN 聚类失败**：按 embedding 把"被用户反复拒稿的 bullet 生成结果"分簇。
2. **规则抽象**：每簇 LLM 抽一条候选规则（"含具体数字的 bullet 比泛化 bullet 拒稿率低 60%"）。
3. **反事实验证（关键）**：LLM 合成 1 条该规则适用但与原簇不同 的假想 JD，跑简历生成，看规则是否改善结果。
4. **仅 verified 提交 semantic memory**，带 `τ_verified` 时间戳。通不过丢弃，防"迷信学习"。

四件叠加才是 self-improvement：S00L.md = **元规则层**，夜间潮汐 = **触发节律**，dreaming = **巩固引擎（pipeline）**，经验提取 = **学习算法**。缺一件就只是"定时跑脚本"。

---

## 6. OfferU 落点映射与实施切片

### 6.1 三阶段切片

| 阶段 | 范围 | 改动 | 验收 |
|---|---|---|---|
| **Phase 1（2 周）** | L1 上限 + L0/L3 溯源列 | Profile 12 active blocks + page out；Bullet 表加 `source_quote`NOT NULL + `source_chat_turn_id` + `transform_version`；新增 `superseded_by` WWII 字段；新增 `S00L.md` 骨架 | provenance coverage >95%；L1 不会无限长 |
| **Phase 2（3 周）** | 五阶段 Write Guard + boot/surface/recall 读路径 | 抽 `MemoryService.observe/surface/recall/boot`；三分去重；双路冲突检测（template-prefix + raw-text）；Conflict Override 例外规则；passive feedback（限速 3 次/memory/24h） | 冲突召回率 ≥90%；状态翻转零误去重；池间零泄漏 500 对抗查询 |
| **Phase 3（4 周）** | 夜间潮汐 + Dreaming + 经验提取 | 02:00 cron；Hippocampus/Neocortex/Glymphatic 三模块；选 Claude Platform Dreams 模式作为首版（最低风险）；反事实验证守住入库闸门 | 一夜 dedup 率 >20%；70%+ 存储削减；规则 false consolidation <5%；dream 不直接改 S00L.md（护栏单测） |

### 6.2 数据模型补丁（仅 Phase 1 必须）

```sql
-- Bullet 表新增
ALTER TABLE bullets ADD COLUMN source_quote TEXT NOT NULL DEFAULT '';
ALTER TABLE bullets ADD COLUMN source_chat_turn_id BIGINT;
ALTER TABLE bullets ADD COLUMN transform_version INT NOT NULL DEFAULT 1;
ALTER TABLE bullets ADD COLUMN superseded_by BIGINT;        -- NULL = active
ALTER TABLE bullets ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5;
ALTER TABLE bullets ADD COLUMN memory_type TEXT NOT NULL DEFAULT 'identity';
                                                                  -- identity/emotion/knowledge/event
CREATE INDEX idx_bullets_supersede ON bullets(superseded_by) WHERE superseded_by IS NOT NULL;

-- 派生依赖图（解决 §4.3 局部更新问题）
CREATE TABLE memory_provenance_edge (
  derived_id BIGINT NOT NULL,
  source_id  BIGINT NOT NULL,
  derived_kind TEXT NOT NULL,  -- 'bullet' | 'resume' | 'dossier'
  needs_refresh BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (derived_id, source_id)
);
CREATE INDEX idx_prov_source ON memory_provenance_edge(source_id);
```

### 6.3 与 career-ops 的对照（minimal but explicit）

| career-ops 元素 | OfferU 对应物 | 借鉴方式 |
|---|---|---|
| `cv.md` | Profile sections + Bullets（SQLite） | 保留 SQLite，但补"12 active blocks + page out" |
| `modes/*.md` | `agents/skills/*.py` | **移植 career-ops modes 体系为 `.md` 声明**，与代码 skill 同 registry |
| STAR Story Bank | Bullet 已有，但未组织"story"概念 | 新增 `star_stories` 抽象层，bullet 归属 story |
| `ARCHITECTURE.md / AGENTS.md` | `AGENTS.md` | **新增 `S00L.md` 作 memory 元规则** |

---

## 7. 出处与引用

| 来源 | URL | 关键贡献 |
|---|---|---|
| santifer/career-ops | https://github.com/santifer/career-ops | 文件式记忆骨架 + modes 体系 + STAR Story Bank + AGENTS.md 标准 |
| santifer/career-ops case study | https://santifer.io/career-ops-system | 740+ 评估 / 100+ CV 实证背景 |
| qbtrix/soul-protocol memory-architecture.md | https://github.com/qbtrix/soul-protocol/blob/main/docs/memory-architecture.md | 5-tier + ACT-R activation + supersede 双轨审计 + reconcile_fact 三分去重 + raw-text 矛盾扫描 |
| SanctumOS Dream Agent | https://sanctumos.org/docs/components/dream-agent | 夜间三神经模块 + 70-80% 削减实测 |
| smysle/agent-memory | https://github.com/smysle/agent-memory | boot/surface/recall 三动词 + Write Guard + passive feedback |
| Deven Goratela APU | https://devengoratela.com/2026/04/from-agent-os-to-agent-processor-unit/ | 4-tier cache + BMJ + Page Fault + 12 blocks + 78% L1 hit |
| Governed Memory | https://www.arxiv.org/pdf/2603.17787 | Progressive Delta Delivery + reflection-bounded + entity 零泄漏 + 7 memories/entity 饱和点 |
| Auto-Dreamer | https://arxiv.org/html/2605.20616 | 离线局部 supersede + GRPO 训练 + 12× memory 缩减 |
| Active Dreaming Memory | https://engrxiv.org/preprint/download/5919/9826 | 反事实验证 + 4.2% false consolidation + 95% retention |
| Are We Ready (arxiv 2606.24775) | https://arxiv.org/html/2606.24775 | 四模块评估框架 + 局部维护优于全局重排实测 |
| Memory in the LLM Era (arxiv 2604.01707) | https://arxiv.org/pdf/2604.01707v2 | 四阶段统一框架 + token cost efficiency + 位置敏感性 |
| Claude Platform Dreams | https://platform.claude.com/docs/en/managed-agents/dreams | 异步 dream job + 输入 store 不可变 + partial-on-fail |
| dream-consolidation-cycle pattern | https://github.com/agentpatternscatalog/patterns/blob/main/patterns/dream-consolidation-cycle.md | dream 不可改 charter 护栏 |
| Zylos Research Memory Survey | https://zylos.ai/research/2026-04-05-ai-agent-memory-architectures-persistent-knowledge/ | episodic/semantic/procedural 收敛 + 评估空白点 |