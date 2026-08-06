# OfferU 三 Agent 优化设计文档

> 目标：把 Profile 制作 / 简历定制 / AI 面试三个 Agent 升级到与全网顶级开源项目（career-ops、ResumePRO、Resume-Matcher、TailoredResume.ai、Friday、noamseg/JadeAI）同级的设计水平。

> 2026-07-15 的实施边界曾引用本地文件 `CAREER_OPS_AGENT_MIGRATION.md`，该文件未纳入版本库。本文件是目标设计，不代表所有路线项已经完成。

---

## 0. 设计调研结论（必读）

| 参考项目 | 核心模式 | OfferU 可借鉴点 |
|---|---|---|
| **santifer/career-ops** (44k⭐) | 14 modes 隔离上下文 + A-F 评估 + Story Bank | **Story Bank** 跨三 Agent 共享；Archetype 检测；6-Block 评估 |
| **ResumePRO** (TJ-Neary) | 两阶段管线（Strategy → Bullet Writing） + 6 维匹配 + 证据置信度 | **Two-Phase Pipeline**；**Evidence Chain**；**Verification Gate** |
| **TailoredResume.ai** | Closed-Loop 自评（ATS < 95 自动重写） | **Closed-Loop Optimizer**：内置 ATS Scorer，不达标自动迭代 |
| **ResumeAgent (ApplyU)** | 10+ 命名 Skills 模块化 | **Skills 命名空间**：`jd_analyzer`、`match_scorer`、`ats_scorer`、`quantifier` |
| **zhiweio/resume-as-code** | 3 Agent 分工（Timeline / Resume / Interview） + YAML 单一事实源 | **Timeline Polisher** 作为 Profile Agent 内部子阶段；Interview Agent 复用 Profile 数据 |
| **Friday** (mostofashakib) | LangGraph 5-Agent 面试管道 | **Interview Pipeline**：Interviewer → Grader → {Clarifier \| Followup} → Coach |
| **noamseg/interview-coach** | 5 维评分 + Storybank 检索 + 适应性教练 | **5-Dim Scoring**；**Adaptive Difficulty** |
| **JadeAI** | 6 面试官角色预设（HR/技术/行为/项目深挖/案例/Leader） | **6 Interviewer Personas** |
| **AlignCV** | 4-pass inference + 多 Provider Router + Round-robin | **Provider Router**（已有，需加 cooldown 调度） |
| **VitaeForge** | CAR 格式 + Hexagonal Architecture + 95% 测试覆盖 | **CAR 改写**（已有 STAR，可叠加 CAR 变体） |

**关键设计原则提取**：
1. **HITL-first**：AI 分析 + 提议，人审核 + 决策（career-ops 哲学）
2. **Zero Fabrication**：每条数据可追溯到证据（ResumePRO 哲学）
3. **Two-Phase**：先策略后执行（ResumePRO 哲学）
4. **Closed-Loop**：自评 < 阈值自动重写（TailoredResume.ai 哲学）
5. **Story Bank**：跨 Agent 复用的 STAR 故事库（career-ops 哲学）
6. **Skill Modularity**：每 Skill 一次 LLM 调用，typed I/O（ResumeAgent 哲学）
7. **Adaptive Coaching**：基于表现的动态难度 + 个性化反馈（Friday / noamseg 哲学）

---

## 1. 总体架构：三层 + 一库

```
┌────────────────────────────────────────────────────────────────────┐
│                       Frontend (Next.js 14)                         │
│  ┌──────────┐  ┌──────────────┐  ┌─────────────┐  ┌─────────────┐  │
│  │ Profile  │  │ Optimize     │  │ Interview   │  │ Story Bank  │  │
│  │ Onboard  │  │ Workspace    │  │ Studio      │  │ Viewer      │  │
│  └────┬─────┘  └──────┬───────┘  └──────┬──────┘  └──────┬──────┘  │
└───────┼───────────────┼──────────────────┼─────────────────┼────────┘
        │ SSE/REST      │ SSE/REST         │ SSE/REST        │ REST
┌───────▼───────────────▼──────────────────▼─────────────────▼────────┐
│                    Backend FastAPI                                  │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    Three Agent Layer                          │  │
│  │  ProfileBuilderAgent     OptimizeAgent     InterviewAgent    │  │
│  │  (Two-Phase)            (Closed-Loop)     (5-Agent Pipe)    │  │
│  │      │                      │                   │            │  │
│  │      └───── shared ─────────┴───── shared ──────┘            │  │
│  │                  Story Bank Service                          │  │
│  │                  (跨 Agent 故事库)                            │  │
│  └──────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    Skills Layer (8 Skills)                   │  │
│  │  jd_analyzer | match_scorer | ats_scorer | quantifier        │  │
│  │  archetype_detector | content_rewriter | section_reorder     │  │
│  │  story_extractor | interview_grader                          │  │
│  └──────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │              LLM Abstraction (现有) + Provider Router        │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

**核心抽象**：
- **`StoryBankService`**：三 Agent 共享的 STAR+R 故事库
- **`SkillProtocol`**：所有 Skill 统一 `execute(context: dict) -> dict` 签名
- **`PipelineOrchestrator`**：通用两阶段管线 (Strategy → Execute)
- **`ClosedLoopOptimizer`**：通用自评-重写循环

---

## 2. 共享层：Story Bank

### 2.1 数据模型

```python
class StoryBankEntry(Base):
    """跨 Agent 复用的 STAR+R 故事"""
    __tablename__ = "story_bank_entries"
    id, profile_id, session_id, source_type  # 'profile'|'optimize'|'interview'
    competency            # 'problem_solving' | 'leadership' | 'communication' ...
    situation, task, action, result  # STAR 四段
    reflection            # 反思（R）— 校招/资深都通用
    
    metrics_json          # ['增长 30%', '节省 20 小时/周']
    keywords              # 与 JD 可对齐的关键词
    
    confidence            # 0-1 置信度
    evidence_refs_json    # [{section_id, source: 'user_say'|'ai_extract'|'resume'}]
    
    usage_count, last_used_at
    rating                # 1-5 面试表现自我评估
    transcript_refs_json  # [{interview_session_id, question_id, score}]
    
    created_at, updated_at
```

### 2.2 Story Bank 入口

```python
class StoryBankService:
    async def extract_from_sections(profile_id) -> list[StoryBankEntry]
    async def extract_from_interview(interview_session_id) -> list[StoryBankEntry]
    async def recall(query, profile_id, top_k=5) -> list[StoryBankEntry]
    async def update_from_optimize(section_id, result) -> StoryBankEntry
    async def cross_reference_with_jd(jd_text) -> list[(StoryBankEntry, match_score)]
```

### 2.3 召回策略
- Embedding: `text-embedding-3-small` 或本地 `bge-small-zh`（兜底 jieba + TF-IDF）
- Top-K = 5；按 competency + similarity 排序
- 返回时附带 evidence chain

---

## 3. Profile Builder Agent 升级

### 3.1 现状问题
1. 单一 LLM 调用，prompt 偏长，模型容易跑偏
2. 没有 Story Bank 输出，后续 Optimize / Interview 无法复用
3. 7 个 missing fields 静态检测，无动态优先级
4. 教育/实习/项目/技能问法雷同，没有 per-topic 引导
5. 无 Evidence Chain — LLM 可能改写用户原话而失真

### 3.2 升级后架构：Two-Phase + 主题化

```
Phase A: INGEST（已有 + 增强）
  ├─ PDF/DOCX 解析（已有 parse_resume_file）
  ├─ 结构化提取（已有 _extract_resume_candidates）
  └─ Evidence Pass：每条提取带 confidence + source_span

Phase B: REFINE（多轮对话 + 主题化）
  ├─ Pre-flight: 7 缺口检测 + 动态优先级排序
  ├─ Per-Topic Question Bank（教育/实习/项目/竞赛/技能/社团/科研/作品）
  ├─ Evidence-Locked Extraction: 用户原话 → Bullet → Story Bank
  └─ Self-Verify Loop: 每轮 LLM 输出后做 evidence check
```

### 3.3 Per-Topic Question Bank

```python
PROFILE_TOPIC_QUESTIONS = {
    "education": [
        {"q": "你最自豪的一门课是什么？它和目标岗位的关系是？", "intent": "course_alignment"},
        {"q": "如果 GPA 不突出，有哪些专业课成绩 / 项目能证明学习能力？", "intent": "academic_proof"},
    ],
    "internship": [
        {"q": "在 {company} 实习期间，你独立负责过的最小完整任务是什么？", "intent": "ownership"},
        {"q": "那段实习里，mentor 给过你什么反馈？", "intent": "growth_signal"},
    ],
    "project": [
        {"q": "{project} 当时为什么用 {tech}？有考虑过其他方案吗？", "intent": "decision_quality"},
        {"q": "如果重做一遍 {project}，你会改哪 1-2 个地方？", "intent": "reflection"},
    ],
    "competition": [
        {"q": "备赛 {competition} 期间，你承担的具体分工是？", "intent": "role_clarity"},
    ],
    "skill": [
        {"q": "{skill} 是在哪里用过的？哪个项目 / 课程？", "intent": "evidence_backed"},
    ],
    "activity": [
        {"q": "{activity} 里你组织的最大一场活动是什么规模？结果如何？", "intent": "leadership_proof"},
    ],
    "research": [
        {"q": "你的研究方向里，最想跟面试官解释清楚的一个概念是？", "intent": "communication"},
    ],
    "portfolio": [
        {"q": "{portfolio_item} 现在还在维护吗？", "intent": "currency"},
    ],
}
```

### 3.4 Evidence-Locked Bullet

```python
@dataclass
class EvidenceLockedBullet:
    text: str                  # 改写后文本
    original_span: str         # 用户原话片段
    confidence: float          # 0-1
    source: Literal["user_say", "resume_parse", "ai_inferred"]
    evidence_refs: list[str]   # ["user_msg_3:42-58", "section_12"]
    metrics: list[str]         # 提取的量化指标
    story_id: int | None       # 关联到 Story Bank
```

### 3.5 Pre-flight 缺口动态优先级

```python
def prioritize_missing_fields(state) -> list[MissingField]:
    # 不只是检查存在性，还按"对简历影响"排序
    impact = {
        "core_experience": 10,  # 没经历 = 简历空
        "impact_metrics": 9,    # 无数字 = 改写难
        "target_role": 8,        # 无目标 = JD 匹配瞎
        "skills": 6,
        "target_city": 4,
        "contact_info": 3,
        "resume": 5,
    }
    # 同一字段内，按缺口深度排序
    # 例：project 有 0 条 vs 1 条 = 优先级不同
```

### 3.6 Profile Strength Score

```python
def compute_profile_strength(profile) -> dict:
    return {
        "overall": 0-100,
        "by_dimension": {
            "coverage": 0-100,        # 7 缺口覆盖
            "evidence_depth": 0-100,  # 有数字 / 有项目细节
            "story_diversity": 0-100, # STAR 故事数量 + 覆盖 competency 数
            "jd_readiness": 0-100,    # 假设 1 个 JD，估算命中率
        },
        "blockers": ["缺 1 段核心经历", "无量化指标"],
    }
```

---

## 4. Optimize Agent 升级

### 4.1 现状（已较强）
- Function-calling + ReAct（10 Tool）
- 5 阶段状态机：confirming → analyzing → framework → rewriting → completed
- 已有 Skills Pipeline（jd_analyzer → matcher → rewriter → reorder）
- 已有 `OptimizeSession` 持久化

### 4.2 升级重点：Closed-Loop + 6-Dim Scoring + Archetype

#### 4.2.1 Closed-Loop Optimizer

```python
async def closed_loop_optimize(rows, jd, threshold=85, max_iters=2):
    """
    借鉴 TailoredResume.ai：生成 → 自评 → < 阈值则定向重写
    """
    pipeline_result = await skills_pipeline.run(...)
    
    for iteration in range(max_iters):
        scorer_result = await ats_scorer.execute({
            "rows": rows, "jd": jd, "pipeline": pipeline_result
        })
        score = scorer_result["overall_score"]
        if score >= threshold:
            return rows, score, iteration
        
        # 定向重写最弱维度
        weakest = scorer_result["weakest_dimension"]
        rows = await targeted_rewrite(rows, weakest, jd)
    
    return rows, score, max_iters
```

#### 4.2.2 6 维评分（借鉴 ResumePRO）

| 维度 | 权重 | 评分方法 |
|---|---|---|
| keyword_match | 30% | jieba + embedding 混合匹配 |
| competency_alignment | 20% | 必备技能 vs 简历技能覆盖率 |
| recency | 10% | 最新经历时间权重 |
| metrics_strength | 15% | 量化指标数量与质量 |
| semantic_similarity | 15% | sentence-transformers 余弦 |
| evidence_chain | 10% | 每条声明 → Story Bank 证据 |

#### 4.2.3 Archetype Detection（借鉴 career-ops）

```python
ARCHETYPE_TAXONOMY = {
    "AI_Engineer":      {"keywords": ["LLM", "RAG", "Agent", "Transformer", "PyTorch"], "summary_lead": "AI 应用 / 模型工程"},
    "Backend_Engineer": {"keywords": ["高并发", "微服务", "分布式", "Go", "Java"], "summary_lead": "后端 / 分布式系统"},
    "Frontend_Engineer":{"keywords": ["React", "Vue", "TypeScript", "Next.js"], "summary_lead": "前端 / 用户体验"},
    "Data_Engineer":    {"keywords": ["Spark", "Flink", "数仓", "ETL", "Airflow"], "summary_lead": "数据工程"},
    "Data_Scientist":   {"keywords": ["AB 实验", "因果推断", "统计建模"], "summary_lead": "数据科学 / 分析"},
    "Product_Manager":  {"keywords": ["PRD", "需求", "用户研究", "增长", "OKR"], "summary_lead": "产品 / 增长"},
    "Operations":       {"keywords": ["活动运营", "内容运营", "用户增长", "社群"], "summary_lead": "运营 / 用户增长"},
    "Design":           {"keywords": ["Figma", "UI", "UX", "设计系统"], "summary_lead": "设计 / 体验"},
    "Sales_Solution":   {"keywords": ["客户成功", "售前", "商务", "ToB"], "summary_lead": "销售 / 解决方案"},
    "Finance":          {"keywords": ["估值", "财务建模", "审计", "CPA"], "summary_lead": "金融 / 财务"},
    "Supply_Chain":     {"keywords": ["采购", "物流", "供应链", "ERP"], "summary_lead": "供应链 / 运营"},
}
```

每次 optimize 时：先 detect archetype → 决定 summary 引导句 + section 排序权重。

#### 4.2.4 Quantification Engine（借鉴 TailoredResume.ai）

```python
QUANTIFICATION_RULES = """
- 模糊动词（"负责" "参与" "协助"）→ 强制追加 [待量化] 标记
- 已有数字 → 保留 + 标注 metric_strength
- 无数字但可量化（如"团队 5 人"）→ 提示补充
- 不可量化（如"提升代码质量"）→ 改为 [需补 impact 数字]
"""
```

#### 4.2.5 Zero-Verb-Repetition（借鉴 TailoredResume.ai）

Linguistics Diversity 检测：扫描每条 bullet 的起始动词，去重。重复动词给出替换建议。

### 4.3 Optimize Agent 新 Tool 注册

```python
TOOL_REGISTRY["score_resume"] = {           # 6 维评分
    "description": "对当前简历做 6 维评分（keyword/competency/recency/metrics/semantic/evidence）",
    "parameters": {"job_id": "int"},
    "risk_level": "read",
}
TOOL_REGISTRY["detect_archetype"] = {        # 原型检测
    "description": "从 Profile + JD 推断目标岗位原型（PM/Backend/AI/...）",
    "parameters": {"job_id": "int"},
    "risk_level": "read",
}
TOOL_REGISTRY["suggest_quantification"] = {  # 量化建议
    "description": "为模糊动词 / 无数字 bullet 生成量化建议",
    "parameters": {"section_index": "int"},
    "risk_level": "read",
}
TOOL_REGISTRY["recall_stories"] = {          # 召回故事库
    "description": "从 Story Bank 召回与当前 JD 最相关的 STAR 故事",
    "parameters": {"query": "str", "top_k": "int"},
    "risk_level": "read",
}
TOOL_REGISTRY["auto_loop_optimize"] = {      # 闭环自优化
    "description": "调用 ATS Scorer 闭环重写直到分数达标或达到最大迭代",
    "parameters": {"threshold": "int", "max_iters": "int"},
    "risk_level": "confirm",
}
```

### 4.4 OptimizeSession 表扩展

```python
# 已有字段保持
# 新增：
archetype              # str        # 检测到的原型
match_score_json       # JSON       # 6 维评分
ats_iterations         # int        # 闭环重写轮数
last_scorer_version    # str        # 评分器版本
```

---

## 5. Interview Agent 升级（最大设计提升）

### 5.1 现状问题
1. 只是 `extract_questions` + `generate_answer_hint` 两个独立 LLM 调用
2. 没有完整模拟面试循环
3. 无评分 / 难度自适应
4. 无 RAG 召回
5. 无故事库关联
6. 无面试官角色

### 5.2 升级后架构：LangGraph 5-Agent 管道

```
                      ┌──────────────────┐
                      │ InterviewerAgent │ ◀── Start / Next
                      │ (出题)            │
                      └────────┬─────────┘
                               ▼
                      ┌──────────────────┐
                      │ GraderAgent      │ ◀── 用户答案
                      │ (1-5 评分)        │
                      └────────┬─────────┘
                               ▼
                ┌──────────────┴──────────────┐
                ▼                              ▼
        ┌──────────────┐             ┌──────────────────┐
        │ ClarifierAgent│            │ FollowupAgent     │
        │ (score ≤ 2)   │            │ (score 3-4)       │
        │ 探查基础理解   │            │ RAG 找 gap 追问   │
        └──────┬───────┘             └──────┬───────────┘
               └──────────┬─────────────────┘
                          ▼
                  ┌──────────────────┐
                  │ CoachAgent       │
                  │ (出建议 + 决定    │
                  │  下题难度 + 封禁  │
                  │  饱和 competency)│
                  └────────┬─────────┘
                           ▼
                  Loop or End
```

### 5.3 5-Dimension Scoring（借鉴 noamseg）

| 维度 | 说明 | 1 分 | 5 分 |
|---|---|---|---|
| **directness** | 直接答问 | 答非所问 | 30 秒内切题 |
| **structure** | STAR 结构 | 无结构散讲 | 完整 STAR |
| **specificity** | 具体细节 | 抽象 | 数字 + 名字 + 时间 |
| **impact** | 成果量化 | 无结果 | 数字结果 |
| **evidence** | 故事可信度 | 编的 | 真实细节 + 反思 |

### 5.4 6 Interviewer Personas（借鉴 JadeAI）

```python
INTERVIEWER_PERSONAS = {
    "hr": {
        "label": "HR 面",
        "focus": ["稳定性", "价值观", "团队匹配", "职业动机"],
        "question_types": ["motivation", "behavioral"],
        "difficulty_range": [1, 3],
    },
    "tech": {
        "label": "技术面",
        "focus": ["技术深度", "算法", "系统设计"],
        "question_types": ["technical", "case"],
        "difficulty_range": [2, 5],
    },
    "behavioral": {
        "label": "行为面",
        "focus": ["STAR 故事", "沟通", "抗压", "领导力"],
        "question_types": ["behavioral"],
        "difficulty_range": [2, 4],
    },
    "project_deep_dive": {
        "label": "项目深挖",
        "focus": ["技术选型", "挑战", "数据结果", "反思"],
        "question_types": ["technical", "behavioral"],
        "difficulty_range": [3, 5],
    },
    "case": {
        "label": "案例分析",
        "focus": ["结构化思维", "业务 sense", "拆解能力"],
        "question_types": ["case"],
        "difficulty_range": [2, 5],
    },
    "leader": {
        "label": "Leader 面",
        "focus": ["成长潜力", "全局观", "culture add"],
        "question_types": ["behavioral", "motivation"],
        "difficulty_range": [3, 5],
    },
}
```

### 5.5 Adaptive Difficulty

```python
def adjust_difficulty(rolling_avg, current_diff) -> int:
    if rolling_avg >= 4.0:
        return min(current_diff + 1, 5)
    if rolling_avg <= 2.0:
        return max(current_diff - 1, 1)
    return current_diff
```

### 5.6 RAG Follow-up（借鉴 Friday）

- 每次评分后 embedding 当前答案
- `text-embedding-3-small` 或 `bge-small-zh` 入库
- FollowupAgent 检索相似 ≥ 0.85 的旧答案，识别"反复出现的缺口"
- 若发现缺口：定向追问
- 否则：交给 Coach 决定下一题

### 5.7 Story Bank 召回（借鉴 career-ops）

- InterviewerAgent 出题时，从 Story Bank 召回 Top-3 故事作为答题素材
- 提示用户："你可能用得上：{story.title}"
- 答题后用 `extract_from_interview` 把高表现答案入 Story Bank

### 5.8 数据模型

```python
class InterviewSession(Base):
    id, profile_id, job_id (nullable)
    persona              # 'hr' | 'tech' | 'behavioral' | ...
    target_role          # 模拟岗位
    company              # 模拟公司
    difficulty_start, current_difficulty
    status               # 'active' | 'completed' | 'aborted'
    competency_coverage_json  # 已考察的 competency 集合
    aggregate_score_json # 5 维总分
    started_at, ended_at

class InterviewTurn(Base):
    id, session_id
    turn_index
    question_text, question_type, question_competency
    user_answer
    grader_json          # {score, dimensions: {directness, ...}, feedback, strengths, gaps}
    route                # 'clarifier' | 'followup' | 'next'
    story_ids_used_json  # 用了哪些故事
    elapsed_seconds
    created_at

class InterviewScoreboard(Base):
    id, session_id
    dimension_averages_json  # {directness: 3.2, structure: 4.1, ...}
    competency_averages_json
    radar_data_json
    top_strengths_json
    top_gaps_json
    improvement_plan_json
```

### 5.9 前端：Interview Studio

- 左侧：面试官头像 + 当前问题 + Persona
- 中间：答案输入（可语音，可文字，可让 AI 提示）
- 右侧：5 维评分雷达 + 上一题反馈 + Story Bank 提示
- 底部：完成 → 报告（雷达图 + 改进计划 + Story Bank 写入）

---

## 6. 三个 Agent 共享接口

```python
# backend/app/agents/shared/__init__.py

class AgentProtocol(Protocol):
    """所有 Agent 共用的协议"""
    name: str
    async def start(state: AgentState) -> AgentResponse: ...
    async def step(state: AgentState, user_input: Any) -> AgentResponse: ...
    async def stream(state: AgentState, user_input: Any) -> AsyncIterator[AgentEvent]: ...

class AgentState(TypedDict):
    session_id: str
    profile_snapshot: dict
    story_bank_snapshot: list[dict]   # 共享
    shared_context: dict              # 跨 Agent 共享

class AgentEvent(TypedDict):
    type: Literal["message", "tool_call", "tool_result", "phase_change", "score", "error"]
    payload: dict
```

---

## 7. 实施路线图（按价值/依赖排序）

### Phase 1：Story Bank 共享底座（先做，后两个依赖它）
- [ ] 模型：`StoryBankEntry`
- [ ] 服务：`StoryBankService`（extract / recall / update / cross_ref）
- [ ] API：`/api/story-bank/*` CRUD
- [ ] 前端：Story Bank Viewer 组件

### Phase 2：Profile Agent 升级
- [ ] 7 缺口动态优先级
- [ ] Per-Topic Question Bank
- [ ] Evidence-Locked Bullet
- [ ] Profile Strength Score
- [ ] 完成后自动 extract → Story Bank

### Phase 3：Optimize Agent 升级
- [ ] `archetype_detector` skill
- [ ] `match_scorer` skill（6 维）
- [ ] `ats_scorer` skill
- [ ] `quantifier` skill
- [ ] Closed-Loop Optimizer
- [ ] OptimizeSession 扩展
- [ ] 4 个新 Tool 注册

### Phase 4：Interview Agent 全新
- [ ] 3 个新模型：`InterviewSession` / `InterviewTurn` / `InterviewScoreboard`
- [ ] 5 个新 Skill：interviewer / grader / clarifier / followup / coach
- [ ] 5-Dim Scoring
- [ ] 6 Personas
- [ ] Adaptive Difficulty
- [ ] RAG Follow-up
- [ ] Story Bank 集成
- [ ] API：`/api/interview/session/*`
- [ ] 前端：Interview Studio

### Phase 5：横切优化
- [ ] Provider Router（多 Provider round-robin + 429 cooldown）— 借鉴 AlignCV
- [ ] 统一 Audit Log（每个 Agent 决策记录）— 已有 OperationAuditLog
- [ ] 三 Agent 互操作：Profile → Optimize → Interview 一键流

---

## 8. 风险与权衡

| 风险 | 缓解 |
|---|---|
| Story Bank 提取可能误把 AI 推断当事实 | 强制带 `source: "user_say"\|"ai_inferred"`，后者的 confidence 上限 0.7 |
| 6 维评分与最终面试结果相关性未知 | 提供 A/B 测试入口，记录实际面试反馈校准 |
| 闭环重写可能陷入死循环 | `max_iters=2`，超时降级为单次生成 |
| RAG Follow-up 召回可能不相关 | cosine 阈值 0.85 + 关键词匹配双重过滤 |
| 5-Dim 评分可能不一致 | temperature=0.2 + 强示例 prompt + 二次 prompt 校验 |
| Interview Agent 计算成本 | 用 fast tier，premium 只在最终报告生成时用 |

---

## 9. 参考实现对照

| 设计点 | 本项目 | career-ops | ResumePRO | TailoredResume.ai | Friday |
|---|---|---|---|---|---|
| 故事库 | 新增 Story Bank | ✅ Story Bank | ❌ | ❌ | ❌ |
| 6 维评分 | 新增 | ❌ | ✅ | 部分（4 维） | ❌ |
| 闭环重写 | 新增 | ❌ | 部分（verification gate）| ✅ | N/A |
| 原型检测 | 新增 | ✅ | ❌ | ❌ | ❌ |
| 5-Agent 面试 | 新增 | ❌ | ❌ | N/A | ✅ |
| 自适应难度 | 新增 | ❌ | N/A | N/A | ✅ |
| RAG Follow-up | 新增 | ❌ | N/A | N/A | ✅ |
| 6 Personas | 新增 | ❌ | N/A | N/A | ❌（JadeAI ✅） |
| 量化引擎 | 已有待增强 | ❌ | ✅ | ✅ | N/A |
| Zero-Verb-Rep | 新增 | ❌ | ❌ | ✅ | N/A |

---

## 10. 完成定义（DoD）

- [ ] 三 Agent 全部接入 Story Bank
- [ ] Optimize Agent 6 维评分 + 闭环重写上线，E2E 通过
- [ ] Interview Agent 5-Agent 管道跑通，5 维评分稳定
- [ ] 6 Personas 可切换，难度自适应
- [ ] 所有 Agent 决策写入 `OperationAuditLog`
- [ ] 前端 Story Bank Viewer 上线
- [ ] 前端 Interview Studio 上线
- [ ] 文档：本设计文档 + 各 Agent 子文档 + AGENTS.md
- [ ] 测试：每个 Agent 至少 3 个 E2E 用例
