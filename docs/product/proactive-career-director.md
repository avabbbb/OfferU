# Proactive Career Director

Status: **CURRENT PRODUCT DETAIL / IMPLEMENTATION CONTRACT**  
Updated: 2026-09-25

This document defines the product and runtime contract for making OfferU genuinely proactive for non-technical job seekers.

It extends [Current Product North Star](./current-product.md), [Entry, Onboarding & Dogfood Contract](./entry-onboarding-and-dogfood.md), and the existing single Automation model:

~~~text
Event → Rule → CareerTask → Agent / Runtime → Operation
~~~

If this document conflicts with `GOAL.md` or `docs/product/current-product.md`, the higher authority wins.

---

## 1. Problem

OfferU already has many career Skills and Operations, but the current product often behaves like a passive tool router:

~~~text
user knows what to ask
→ user tells Agent what to do
→ Agent selects a Skill
→ OfferU executes
~~~

That is acceptable for expert users. It is not enough for the beginner product.

A beginner often does **not** know:

- whether their Profile is sufficiently useful for the jobs they want;
- whether they should explore broadly or narrow their direction;
- whether they are being evaluated as campus/fresh-graduate or experienced-hire;
- which evidence is weak, missing, or under-expressed;
- whether today should be spent applying, following up, preparing for an interview, or improving evidence;
- whether a new Resume makes an old opportunity worth re-engaging;
- whether repeated interview failures reveal a systematic gap;
- when their application funnel or market position has changed enough to change strategy.

OfferU therefore needs a bounded proactive reasoning layer that continuously asks:

> **Given this user’s current Career State, what matters now, what can OfferU safely prepare, and what decision actually requires the user?**

The goal is not to make the system “more autonomous” in the abstract. The goal is to reduce the amount of career-management knowledge the beginner must already possess.

---

## 2. Current code reality

The current Automation foundation is intentionally strong:

- durable `AutomationEvent`;
- explicit `AutomationRule`;
- durable `CareerTask`;
- Operation Registry execution boundary;
- Automation Inbox / Today projection;
- idempotency, retry/recovery and audit;
- Proposal/HITL for protected mutations.

The event vocabulary already includes signals such as:

- `JOB_SAVED`;
- `JOB_UPDATED`;
- `APPLICATION_SUBMITTED`;
- `APPLICATION_STAGE_CANDIDATE`;
- `INTERVIEW_INVITATION_DETECTED`;
- `REJECTION_DETECTED`;
- `OFFER_DETECTED`;
- `CAREER_FILE_CHANGED`;
- `CAREER_FACT_CANDIDATE_CREATED`;
- `RESUME_UPDATED`;
- `INTERVIEW_COMPLETED`;
- `INTERVIEW_DEBRIEF_CREATED`;
- `ROLE_BENCHMARK_STALE`;
- `DAILY_REVIEW`;
- `WEEKLY_REVIEW`.

But the current built-in automation behavior is much narrower: the main default dispatch is effectively `JOB_SAVED → role_intelligence`; other accepted event types do not yet produce a meaningful career-strategy decision.

This means OfferU has the durable event/task machinery, but not yet the **career judgment layer** between “an event occurred” and “what should happen next”.

---

## 3. Design decision: add a Career Director, not a second Agent loop

OfferU must **not** add another infinite background Agent loop.

Instead, introduce a bounded **Career Director**:

~~~text
Career State / Automation Event / Schedule
                   ↓
          Runtime decides WHEN to think
                   ↓
             Career Snapshot
                   ↓
             Career Director
      (one bounded reasoning turn/run)
                   ↓
         Situation Assessment
                   ↓
          Proactive Career Plan
                   ↓
           Autonomy Policy
       ┌───────────┼────────────┐
       ↓           ↓            ↓
   read/analyze   prepare     user decision
       ↓           ↓            ↓
   CareerTask    Proposal    Today / Inbox
       └───────────┼────────────┘
                   ↓
          Operation Registry
                   ↓
             Career Truth
~~~

The Career Director is **not**:

- a new database;
- a new source of Career Truth;
- a replacement for Operation Registry;
- a second automation scheduler;
- a hidden process that runs continuously;
- a script with a hard-coded sequence of career Operations;
- a model allowed to approve its own proposals.

Its job is to make a bounded judgment when the Runtime has a reason to reconsider the user’s career situation.

---

## 4. Division of responsibility

### Runtime decides **when to think**

Deterministic code owns trigger policy.

Examples:

- first meaningful use / Profile baseline incomplete;
- `DAILY_REVIEW`;
- `WEEKLY_REVIEW`;
- `PROFILE_CHANGED` or equivalent Profile/evidence change;
- `RESUME_UPDATED`;
- `JOB_SAVED` / `JOB_UPDATED`;
- `APPLICATION_SUBMITTED`;
- no-response/follow-up due;
- `INTERVIEW_INVITATION_DETECTED`;
- interview within a configured time window;
- `INTERVIEW_COMPLETED`;
- `REJECTION_DETECTED`;
- `OFFER_DETECTED`;
- repeated evidence-gap or interview-learning signal.

The Runtime should wake the Career Director **once** for the relevant state transition.

### Career Director decides **what matters now**

The model may:

- interpret the current Career Snapshot;
- classify the user’s current career-search stage;
- detect missing/weak/unknown evidence;
- prioritize competing work;
- choose an appropriate Strategy Pack;
- select relevant OfferU Skills/Operations from the live capability surface;
- decide which questions are worth asking;
- recommend a bounded plan.

### Autonomy Policy decides **what may happen**

The model may recommend an action. It does not decide its own permission.

Operation Registry + product policy decide whether the action:

- executes automatically;
- prepares a reviewable draft;
- pauses for human confirmation;
- is prohibited.

---

## 5. Career Snapshot

The Career Director should reason over one structured, target-relative snapshot instead of reconstructing the user from chat every time.

Suggested shape:

~~~text
CareerSnapshot

identity
  career_stage
  experience_years
  current_role
  employment_state

goals
  primary_roles
  secondary_roles
  locations
  compensation
  timing
  constraints

profile_coverage
  strong_evidence
  weak_evidence
  missing_evidence
  unknowns
  underexpressed_strengths

jobs
  new
  high_fit
  uncertain
  stale
  pending_review

pipeline
  active
  no_response
  interview
  rejected
  offer

calendar
  upcoming_interviews
  deadlines
  followups_due

resume
  current_version
  material_changes
  jobs_using_old_version

learning
  recent_interview_findings
  repeated_questions
  recurring_gaps
  user_corrections

attention
  pending_proposals
  pending_memory_items
  automation_inbox
  blocked_tasks
~~~

Principles:

1. store structured/raw reusable state, not a long model-written biography;
2. derive model context from canonical Career Truth + current evidence;
3. preserve provenance and uncertainty;
4. keep “unknown” different from “weak”;
5. avoid a generic vanity `Profile completeness = 73%` score.

Profile sufficiency is always relative to the user’s current goal.

---

## 6. Career Stage classification

Career Director must not assume every job seeker follows the same playbook.

Suggested first-class state:

~~~text
CareerStageSnapshot

track:
  campus
  experienced

substage:
  internship
  fresh_graduate
  early_career
  experienced_ic
  manager
  executive
  career_switch

confidence:
  high
  medium
  low

basis:
  graduation_date
  full_time_experience
  current_employment
  target_job_seniority
  resume_evidence
~~~

OfferU should infer first, then ask for confirmation when the classification materially changes strategy.

Example:

> “根据你的简历，我目前把你判断为：社招 · Early Career。  
> 这意味着我会更关注岗位定位、项目证据、面试反馈和流程节奏，而不是按应届生海投策略管理。这个判断对吗？”

Career Stage is not permanent. It may change over time.

---

## 7. First-party Strategy Packs

Career strategy should not live as scattered prompt conditionals.

Create versioned first-party Strategy Packs interpreted by the Career Director.

### 7.1 `campus_search.v1`

Primary objective:

> Help a student / fresh graduate discover viable directions and manage an uncertain recruiting funnel with disciplined iteration.

Emphasis:

- exploration before premature specialization;
- recruiting calendar / campus hiring windows;
- application funnel and conversion;
- internship/project/course/competition evidence;
- potential discovery from limited experience;
- interview repetition and learning;
- direction testing using market feedback.

Typical proactive questions:

- Is the target direction too broad or too narrow?
- Does the user have enough evidence for the chosen role?
- Which role families are actually producing interviews?
- Is low conversion caused by targeting, Resume expression, or evidence gaps?
- Is a campus deadline approaching?
- Which experience can be reframed as transferable evidence without inventing facts?

The Strategy Pack must not hard-code one universal daily application count. Volume targets should be user-configurable and adapted to market stage, workload, role quality and response data.

### 7.2 `experienced_search.v1`

Primary objective:

> Help an experienced candidate manage market position, evidence packaging, timing, process information and negotiation leverage.

Emphasis:

- selective targeting;
- candidate market position;
- ownership / business result / organization impact;
- under-expressed value discovery;
- recruiter / referral / direct-channel context;
- interview intelligence;
- process timing;
- re-engagement after meaningful Profile/Resume changes;
- compensation / level / joining-window strategy;
- offer overlap and negotiation preparation.

Typical proactive questions:

- What is the candidate’s current market position for this target?
- Which claims need stronger business evidence?
- Is the user underselling scope, ownership or impact?
- What did recent interviews repeatedly probe?
- Is a later interview slot strategically useful without harming intent perception?
- Does a new Resume materially justify re-contacting older opportunities?
- Are multiple processes approaching a timing/negotiation decision?

The Strategy Pack must not impersonate a recruiter, invent candidate-pool information, or infer salary/level facts without evidence.

---

## 8. External strategy references

These sources are **methodology references**, not product authority.

### Graduate / campus reference

The user supplied the Bilibili video:

- 陈一枝，《如何在地狱难度下找工作？》
- https://www.bilibili.com/video/BV1BN411D73i/

The source is explicitly framed around graduation/employment, campus recruiting and practical job-search planning. OfferU should absorb the product-level idea that a beginner benefits from a simple, measurable, iterative job-search system rather than treating each application as an isolated emotional event.

Do not encode a creator’s specific numerical advice as universal policy without independent product evidence.

### Experienced-hire reference

The user supplied 布布糕’s Xiaohongshu/Douyin accounts. Public indexed Douyin material shows recurring experienced-hire topics such as:

- interview scheduling strategy;
- how much interview feedback to share with a headhunter;
- compensation / benefits accounting;
- candidate positioning / Hi-Po;
- timing of resignation;
- salary negotiation.

Examples:

- https://www.douyin.com/video/7404785795132968228
- https://jingxuan.douyin.com/m/video/7361747647050337574

OfferU should absorb these as evidence that experienced hiring involves candidate positioning, information management, timing and negotiation — not only Resume matching.

### Agent architecture references

The Runtime design is also aligned with current agent-engineering guidance:

- Anthropic distinguishes deterministic workflows from agents that dynamically choose tools/processes, and recommends simple composable patterns before adding framework complexity:  
  https://www.anthropic.com/engineering/building-effective-agents
- OpenAI’s agent runtime loop allows the model to choose tool calls until a real stopping point, while approvals pause and resume the same run:  
  https://developers.openai.com/api/docs/guides/agents/running-agents
- OpenAI’s human-review guidance recommends pausing sensitive side effects for approval instead of letting the model execute them directly:  
  https://developers.openai.com/api/docs/guides/agents/guardrails-approvals

---

## 9. Profile Discovery and potential mining

The Profile system should become proactive.

The Career Director has an ongoing responsibility to ask:

> “Do I understand this person well enough to make the next important decision?”

Not:

> “Are all Profile fields filled?”

### For campus users

Prefer **Potential Discovery**:

- coursework that demonstrates capability;
- internships;
- campus organizations;
- projects;
- competitions;
- research;
- portfolio work;
- transferable skills;
- unexplored adjacent roles.

The Agent should help find credible evidence in limited experience without inflating weak evidence into verified facts.

### For experienced users

Prefer **Value Extraction**:

- scale;
- ownership;
- decision authority;
- business impact;
- measurable results;
- cross-functional influence;
- hard trade-offs;
- failure/recovery;
- promotions;
- scarce technical/domain capability;
- customer/stakeholder impact.

Example follow-up:

> “你写的是‘负责 AI 项目’，但这还不足以支撑社招定位。我更想确认：需求是谁定义的、你本人做了哪些关键判断、项目规模/客户/预算是什么、最终产生了什么结果？”

### Question budget

Proactivity must not become interrogation.

Rules:

- ask only questions that unlock a current decision;
- prefer 1–3 high-value questions;
- never re-ask known information;
- explain why the question matters;
- allow “以后再说”;
- convert inferred potential into Candidate/Hypothesis, not verified truth.

---

## 10. First-run proactive behavior

First run should feel like “OfferU is trying to understand me”, not “fill in every field”.

After Resume import, Career Director may produce:

~~~text
I currently understand you as:

- 社招 · Early Career
- current strength: AI product / Agent workflow / AIGC delivery
- likely target: AI Product / Agent Product / FDE-adjacent

I already have enough evidence for:
✓ ...
✓ ...

Three things would materially improve later decisions:
1. ...
2. ...
3. ...

Answer these three first. We can learn the rest when it becomes useful.
~~~

The first-run Agent must use real OfferU reads/tools. A script may bootstrap installation, migration, detection or health checks, but **must not impersonate career judgment**.

---

## 11. Daily Career Brief

`DAILY_REVIEW` should become a Career Director trigger, not only a Todo refresh.

Desired output:

~~~text
Today

1. Interview tomorrow at 15:00
   Why now: repeated weakness in commercial-metric answers.
   Prepared: 20-minute focused practice.

2. Two high-priority applications have had no response for 6 days.
   Why now: follow-up window reached.
   Prepared: two reviewable follow-up drafts.

3. Your Resume changed materially yesterday.
   Why now: three old opportunities used the previous version.
   Prepared: re-engagement candidates for review.
~~~

Rules:

- maximum a few primary actions;
- every recommendation has `why_now`;
- due interviews/deadlines can outrank Profile polishing;
- completed/rejected items should stop resurfacing;
- repeated ignored suggestions should decay in priority;
- user corrections should influence future prioritization.

Today is the user-facing surface for Career Director output, not a separate source of truth.

---

## 12. Weekly Career Review

`WEEKLY_REVIEW` should produce strategy-level feedback.

### Campus example

~~~text
This week
applications 63
tests 8
interviews 4
offers 0

AI Product is producing more interviews than Data Product.
Recommendation:
↑ AI Product
→ Product Operations
↓ Data Product until Profile/evidence changes
~~~

### Experienced example

~~~text
This week

- Agent/AIGC roles are advancing more often than generic platform-PM roles.
- Three recent interviews independently probed commercial metrics.
- Two processes are entering late stages next week.

Recommendation:
1. prioritize Agent/AIGC roles;
2. mine one stronger commercial-impact evidence story;
3. align interview timing before salary negotiation starts.
~~~

The Weekly Review may recommend a strategy change, but changes to saved preferences / Career Truth require normal review.

---

## 13. Interview lifecycle should be proactive

### Invitation detected

~~~text
INTERVIEW_INVITATION_DETECTED
→ Career Director
→ read Job / Role Intelligence / Profile / prior interview learning
→ prepare Interview Plan
→ surface deadline and gaps in Today
~~~

### Before interview

Time-window trigger may prepare:

- focus areas;
- likely evidence gaps;
- relevant previous questions;
- concise practice plan.

### After interview

A completed/calendar-passed interview should trigger a debrief prompt while memory is fresh.

Example:

> “这场面试应该已经结束了。花 5 分钟记录一下：实际问了什么、哪个回答最弱、对方透露了哪些岗位/团队信息、下一步是什么？”

The debrief flows into:

~~~text
Interview Debrief
→ Learning Candidate
→ review
→ Profile / Interview Memory when accepted
→ later interview preparation
~~~

The user should not need to remember that “OfferU has an interview-debrief feature”.

---

## 14. Resume update and re-engagement

`RESUME_UPDATED` should trigger a bounded re-engagement review.

Candidate selection may consider:

- old opportunity used an older Resume;
- no explicit rejection;
- role remains relevant;
- fit was high enough;
- meaningful Resume evidence changed;
- enough time has passed;
- re-contact is not a duplicate/spam pattern.

Output:

> “新版简历增加了两条强证据。我找到 5 个过去使用旧版简历、且没有明确拒绝的机会，其中 3 个值得重新接触。”

This produces **re-engagement candidates**, not automatic messages.

---

## 15. Job Search Campaign

For users who want more automation, OfferU may define a bounded `JobSearchCampaign`.

Possible fields:

~~~text
target_roles
locations
compensation_floor
seniority
exclusions

daily_discovery_limit
daily_prepare_limit

channel_policy
reengagement_window
dedupe_policy
rate_limit

external_action_policy
~~~

A Campaign may autonomously:

- discover through explicitly supported connectors;
- dedupe;
- triage;
- analyze;
- prepare materials;
- create an application/re-engagement queue.

Default behavior stops before irreversible external action.

If a future connector supports automated submit/contact, L3 execution requires:

- explicit user opt-in;
- bounded campaign scope;
- platform/connector support;
- rate limits;
- duplicate protection;
- audit;
- clear pause/kill switch;
- product policy permitting that specific action.

“Anti-crawl is solved” is not, by itself, permission to auto-submit or repeatedly contact people.

---

## 16. Autonomy levels

### L0 — Observe

Examples:

- read Profile / Job / Pipeline / calendar;
- compute follow-up due;
- identify evidence gaps;
- detect repeated interview topics.

Default: automatic.

### L1 — Prepare

Examples:

- research;
- Job assessment;
- interview plan;
- Resume proposal;
- follow-up draft;
- re-engagement candidate;
- weekly strategy suggestion.

Default: may run automatically within bounded cost/scope; result remains reviewable.

### L2 — Commit Career State

Examples:

- accept Profile evidence;
- change application stage;
- adopt a Resume version;
- commit a strategy preference.

Default: Proposal/HITL or an explicit reversible policy.

### L3 — External Action

Examples:

- submit application;
- send email;
- message recruiter;
- contact third party.

Default: explicit user approval.

Future automatic L3 requires an explicit campaign policy and connector-specific safety contract.

The Career Director may recommend L0–L3 actions. It never upgrades its own permission.

---

## 17. Career Director output contract

Use a structured output instead of free-form “career advice”.

Suggested schema:

~~~text
CareerBriefing

career_stage
strategy_pack

situation_summary

priorities[]
  priority
  why_now
  evidence_refs
  deadline
  confidence

actions[]
  objective
  skill
  suggested_operations
  autonomy_level
  expected_outcome
  requires_user
  dedupe_key

questions[]
  question
  why_needed
  unlocks
  optional

risks[]
opportunities[]
~~~

The Runtime compiles this plan into CareerTasks, Proposals, Inbox items and Today actions.

The plan itself is not Career Truth.

---

## 18. Initial implementation slice

Do **not** implement every event at once.

First proactive slice:

1. `FIRST_RUN / PROFILE_BASELINE_REQUIRED → Profile Discovery`
2. `DAILY_REVIEW → Daily Career Brief`
3. `JOB_SAVED → Job Assessment Plan`
4. `INTERVIEW_INVITATION / INTERVIEW_COMPLETED → Prep / Debrief`
5. `RESUME_UPDATED → Re-engagement Review`

This is enough to validate whether OfferU feels meaningfully more proactive in owner dogfood.

---

## 19. Proactivity evaluation

Do not evaluate this feature by “number of automations”.

Track:

### Core product metrics

- **User-directed task rate** — how often the user still has to tell OfferU what the obvious next step is.
- **Proactive action acceptance rate** — accepted / viewed proactive suggestions.
- **Useful-first-action rate** — first suggested action judged useful without correction.
- **Question yield** — questions that materially improve a subsequent decision.
- **Escape rate** — times the user leaves OfferU for another tool because OfferU failed to guide the next step.

### Annoyance / quality metrics

- duplicate suggestion rate;
- stale suggestion rate;
- repeated ignored suggestion rate;
- user correction rate;
- wrong Career Stage / wrong Strategy Pack rate.

### Safety invariants

Must remain zero:

- Agent self-confirm;
- unreviewed Career Truth writes;
- unauthorized local-memory read;
- direct DB mutation;
- external action without required approval;
- scripted workflow misreported as model judgment.

### Owner-dogfood target

After several days of real use, the user should not need to manually initiate the obvious next action most of the time.

Do not set a permanent launch KPI from one user. During owner dogfood, use the metrics to discover failure modes first.

---

## 20. Eval cases

Minimum deterministic/model-assisted scenario set:

1. **Campus first run**
   - sparse Resume;
   - unclear target;
   - Agent should explore and ask only high-value questions.

2. **Experienced first run**
   - clear full-time experience;
   - Agent should focus on ownership, impact and market position.

3. **Interview tomorrow**
   - interview prep outranks low-value Profile polishing.

4. **Interview just finished**
   - debrief is proactively requested;
   - learning remains Candidate until review.

5. **Resume materially updated**
   - old non-rejected opportunities become bounded re-engagement candidates.

6. **No response / follow-up due**
   - draft prepared;
   - no automatic send.

7. **Repeated rejection / repeated interview gap**
   - Weekly Review detects a pattern;
   - suggests a strategy/evidence change with supporting data.

8. **User rejects repeated suggestion**
   - priority decays;
   - same suggestion does not reappear unchanged the next day.

9. **Career Stage correction**
   - user corrects campus/experienced classification;
   - Strategy Pack changes without rewriting historical truth.

10. **L3 request**
    - model recommends external action;
    - Runtime pauses at HITL.

---

## 21. Acceptance criteria

The proactive Runtime is not accepted merely because a scheduled message appears.

Acceptance requires:

- real Career State is read through OfferU tools/operations;
- Career Stage and Strategy Pack are visible/explainable;
- Career Director produces a structured plan;
- Runtime turns that plan into durable Today/Inbox/Task/Proposal state;
- L0/L1 can proceed within policy;
- L2/L3 stop at the correct approval boundary;
- closing chat does not lose proactive work;
- restart does not duplicate the same proactive task;
- ignored/rejected suggestions influence later planning;
- scripts are not used to fake career judgment;
- campus and experienced scenarios demonstrably behave differently.

---

## 22. Product principle

The target experience is:

> **The user should not need to know which OfferU feature exists before OfferU can help them.**

A beginner should increasingly experience:

~~~text
OfferU notices
→ OfferU understands why it matters
→ OfferU prepares the safe part
→ OfferU asks only for the decision that needs me
→ OfferU learns from the outcome
~~~

That is the meaning of proactivity in OfferU.
