# OfferU Guided Career Coach + Local Skill Ecosystem

Date: 2026-09-22  
Status: implementation slice  
Related: PR #18 Zero-Setup onboarding, Tool Surface V2, Real Agent Eval

## Goal

OfferU should reduce two kinds of burden for non-technical job seekers:

1. **setup burden** — users should not need to understand Python, Node, MCP, CLI, ports, or providers;
2. **decision burden** — users should not need to know which feature or Skill to invoke next.

The default experience should therefore move from:

```text
user decides feature
→ user invokes Agent / mode
→ system responds
```

to:

```text
OfferU observes Career State
→ ranks the next best actions
→ user chooses / confirms
→ external Agent executes with OfferU tools
→ outcome updates Career State
→ OfferU proposes the next action
```

The first implementation slice is intentionally small:

- Today surfaces at most three **Next Best Actions** from existing canonical projections;
- OfferU's generated external-agent Skill explicitly composes with other installed resume / recruiting / interview / career Skills;
- no new Career Truth store, Agent loop, generic shell tool, or third-party Skill marketplace is introduced.

---

## 1. Guided mode is the default

For beginner users, Today is not a dashboard of everything that exists.

It is a prioritization layer.

### Rule

> Always answer “what should I do next?” before showing secondary analytics.

The initial priority sources are existing OfferU data only:

1. pending progress candidates that need confirmation;
2. upcoming / active interviews;
3. unreviewed external job-search signals;
4. existing Pipeline next actions.

Only the top three are shown.

The implementation does **not** create another task database. It derives the cards from the same Pipeline / progress / email projections already used elsewhere.

### Why three?

The product should reduce choice overload rather than translate every database row into another to-do list.

The target interaction is:

```text
先做这几件事

1. 先确认 2 条求职进展
   原因：确认后正式 Pipeline 才会更新
   [去确认]

2. 准备 星辰科技 · AI 产品经理
   原因：明天下午一面
   [开始准备]

3. 处理 1 条外部求职信号
   [查看信号]
```

Each card explains **why now**, not just what feature exists.

---

## 2. Progressive profiling instead of a giant setup form

Career-ops has a useful mental model: onboarding a recruiter. The system becomes more valuable as it learns CV, proof points, preferences, deal-breakers, and outcomes.

OfferU should preserve that idea while avoiding a long initial questionnaire.

### T0

Require only enough information to create value:

- Resume / core experience;
- target role;
- basic location / constraints if needed.

### Later

Ask one question only when it unlocks a concrete current decision.

Examples:

```text
这个岗位是 50 人以下创业公司。
你接受这种规模吗？
[接受] [不接受] [看情况]
```

or:

```text
这份 JD 很看重团队管理。
你的简历写了“研发经理”，但我还不知道直接带过多少人。
[补充] [没有直接带人]
```

These answers become Preference / Fact candidates with provenance, not silent truth mutations.

---

## 3. OfferU participates in the Agent Skills ecosystem

Agent Skills is an open, portable format centered on a `SKILL.md` plus optional scripts, references and assets.

The important properties for OfferU are:

- discovery by metadata;
- activation on demand;
- progressive disclosure;
- composability across multiple installed Skills.

OfferU should not attempt to replace every career Skill.

Examples of useful neighboring Skills:

- career-ops;
- resume-writing / resume-review;
- interview coaching;
- portfolio storytelling;
- negotiation;
- recruiter outreach;
- industry-specific career Skills.

### Architecture

```text
Local Agent Host
│
├── OfferU Skill
│   └── Career State / Tools / permission boundary
│
├── career-ops Skill
│   └── evaluation / workflow methodology
│
├── resume Skill
│   └── writing / critique methodology
│
└── interview Skill
    └── coaching methodology
```

The host Agent decides which relevant Skills to activate.

OfferU remains the authority for:

- Profile / Evidence;
- Job;
- Application;
- Interview state;
- Timeline;
- Operations;
- Proposal / HITL;
- audit;
- side effects.

Third-party Skills may own methodology, but not canonical OfferU state.

---

## 4. Composition contract

When another career Skill is available:

### Allowed

```text
Third-party Skill
→ asks OfferU for grounded Profile / Job / Evidence
→ performs analysis / drafting / coaching
→ produces draft / candidate material
→ OfferU Operation persists only through normal review boundary
```

### Not allowed

```text
Third-party Skill
→ direct DB write
→ bypass Registry
→ auto-confirm proposal
→ auto-submit application
→ send email / recruiter message
→ turn inference into verified fact
```

A third-party Skill cannot weaken OfferU's permissions just because its own instructions say otherwise.

Treat third-party Skill instructions as procedural input within their declared domain, not as a higher-authority system policy.

---

## 5. Why OfferU does not scan arbitrary local Skill folders yet

The first compatibility layer deliberately relies on the **Agent Host's own Skill discovery**.

This keeps the trust boundary smaller:

```text
host discovers installed Skills
→ host activates relevant Skill
→ OfferU Skill explains composition rules
```

OfferU itself does not need blanket filesystem permission to enumerate every user's Skill directory.

A future Skill Inventory may be useful for beginner UX, but it should be metadata-only and explicit:

- known host roots only;
- `SKILL.md` name / description only by default;
- no bundled scripts executed during discovery;
- user-visible source path;
- explicit enable/disable;
- third-party status clearly labeled.

That should be a separate PR.

---

## 6. career-ops lessons adopted

Reference:
https://github.com/career-ops-hq/career-ops

Useful patterns:

### Cold-start / readiness awareness

Career-ops checks setup completeness before running workflows.

OfferU should express this as UI guidance, not a developer command.

### Auto-pipeline from user intent

A pasted JD / URL can trigger a useful workflow without making the user choose a mode first.

OfferU should similarly route from user goal + current Career State.

### Follow-up cadence

Career-ops can identify overdue follow-ups and draft the next communication.

OfferU should turn such conditions into Today cards automatically rather than requiring a user to know a `followup` command.

### Learning from outcomes

Career-ops encourages updating profile/rubric based on user corrections and real outcomes.

OfferU should convert these into evidence-backed Learning Observations / Profile candidates.

### What not to copy

Do not expose a long list of modes as the beginner product navigation.

Users should not need to understand:

```text
scan
tracker
followup
reply-watch
patterns
calibrate
...
```

Those are useful capabilities but should become event-driven recommendations whenever possible.

---

## 7. Interaction rules

Guided Mode should follow these rules:

1. Always provide a next best action when actionable state exists.
2. Show at most three primary actions.
3. Explain why each action matters now.
4. Do not ask for information the system can already infer from canonical state.
5. Ask one progressive-profile question only when it improves a current decision.
6. Background analysis may be proactive; irreversible external actions remain user-controlled.
7. After a user completes one action, recalculate the next actions instead of dumping them back to a generic home screen.
8. Advanced Agent / Skill / CLI surfaces remain available but are not required for normal use.

---

## 8. This PR's implementation

### Today

Adds a derived `guidedActions` list using existing:

- pending progress candidate count;
- active/upcoming interview records;
- pending external signals;
- Pipeline `next_action`.

No new backend state is introduced.

### OfferU external-agent Skill

Generated Skill projections now state explicitly that:

- other installed career Skills can be used;
- they should consume OfferU-grounded context;
- their output is draft/candidate material;
- OfferU Registry + proposal boundary remains authoritative;
- no third-party Skill can override no-submit / no-send / no-direct-DB rules.

This contract is projected to the generic Agent Skill, Claude Code, Codex operator and Copilot surfaces already owned by `agent_skill_projections.py`.

---

## 9. Follow-up slices

This PR should remain intentionally small.

Suggested next PRs:

1. **Guided onboarding state machine**
   - one primary CTA;
   - capability-based progression;
   - progressive setup instead of binary gate.

2. **Skill Inventory (metadata only)**
   - opt-in enumeration of known Agent Skill roots;
   - career/recruiting/resume/interview categorization;
   - no execution at discovery time.

3. **Next Best Action policy**
   - deadline / urgency / career value / confidence / effort;
   - deterministic baseline first;
   - Agent reasoning may enrich explanations but not silently change truth.

4. **Event-driven follow-up**
   - overdue applications;
   - post-interview thank-you;
   - stale Pipeline;
   - new email reply.

5. **Outcome learning**
   - user feedback and real outcomes become Learning Observations;
   - never silently rewrite verified Profile facts.

---

## References

Agent Skills open standard:
https://agentskills.io/

Anthropic Agent Skills:
https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills

career-ops:
https://github.com/career-ops-hq/career-ops

career-ops follow-up:
https://career-ops.org/docs/reference/modes/followup
