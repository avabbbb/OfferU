# OfferU Skill-first Agent Entry, Job Workspace & Product Story

Status: **DESIGN RATIONALE / DISTILLED REFERENCE**  
Updated: 2026-09-23

This document records the external reference patterns and reasoning behind the Skill-first / Job Workspace direction. The accepted product rules have now been distilled into `GOAL.md`, `docs/product/current-product.md`, `docs/architecture/agent-system.md` and `docs/architecture/workbench-interaction.md`. Those authority documents override this rationale if wording diverges.

The goal is to borrow useful patterns from successful Agent-first tools without copying their domain model: make the Agent entry extremely easy, materialize Agent work inside an editable workspace, and tell the product story from a repeated user pain rather than from architecture.

## 1. Core distinction: Skill is the Agent entry; Workspace is the user product

OfferU should not turn “install a Skill” into a requirement for ordinary users.

The current Product North Star is correct:

```text
normal user:
Install OfferU
→ auto-detect local AI
→ bootstrap Profile
→ save a real Job
→ OfferU prepares
→ user reviews / acts
```

The pattern worth borrowing is architectural:

```text
Agent entry
OfferU Skill
      ↓
OfferU capabilities
      ↓
Operation Registry
      ↓
Career Runtime
      ↓
same Job / Profile / Application state
      ↑
OfferU Desktop Workspace
User entry
```

So:

- **Skill = knowledge + capability entry for the Agent**
- **OfferU Desktop = primary product surface for the user**
- both converge on the same Career Truth;
- neither creates a hidden parallel project.

For advanced users, a manual Skill install may remain a fast explicit path. For normal users, OfferU should auto-discover the supported Agent and project/register the Skill with minimal interaction.

## 2. Two onboarding lanes, one product state

### Lane A — normal user: App-first, zero-setup

```text
Download / Install
→ Launch OfferU
→ Find supported local AI
→ OfferU prepares its Skill automatically where supported
→ Import resume / core career evidence
→ Save first Job
→ Job Workspace opens with preparation in progress
→ Today shows what needs attention next
```

The user should not need to know:

- what a Skill is;
- MCP;
- Operation Registry;
- provider IDs;
- model endpoints;
- Python / Node / Git.

### Lane B — power user: Skill-first

When a user is already working inside Codex / Claude Code / WorkBuddy / OpenCode / OMP or another supported host:

```text
Install / enable OfferU Skill
→ Agent checks OfferU availability
→ "Analyze this job for me"
→ Agent creates / resolves the canonical Job
→ preparation runs through governed OfferU operations
→ open the same Job Workspace in OfferU
```

Example desired interaction:

```text
/offeru Use this role:
<job URL or pasted JD>

Compare it with my verified profile,
prepare the role intelligence and evidence gaps,
then propose the application materials.
```

The key rule is that this must not become a CLI-only second product. The result must appear in the same Job / Pipeline / Profile state used by the desktop UI.

## 3. The Job Workspace is OfferU's equivalent of an editable production studio

The user should not experience OfferU as “a chat that produced some text”.

A Job should become a durable workspace containing the preparation state for one opportunity:

```text
Job Workspace

Job Snapshot
├─ source / company / role / location
├─ captured description
└─ current application state

Role Intelligence
├─ what this role emphasizes
├─ market / cohort signals when supported
└─ distinctive requirements

Evidence Map
├─ strong evidence
├─ weak evidence
└─ missing / unsupported claims

Application Materials
├─ tailored resume
├─ proposal diffs
├─ application packet
└─ export / version history

Interview
├─ focus areas
├─ practice
├─ transcript-backed debrief
└─ learning candidates

Timeline
└─ canonical events / next action
```

This workspace is the durable artifact. Agent conversations are only one way to modify it.

Recommended product framing:

> Every job becomes an evidence-backed application workspace.

## 4. Narrow entry story: one Job in, a prepared workspace out

“AI Career OS” is a useful category description but is too broad to be the only first-screen story.

Use a concrete input/output story first:

```text
Give OfferU a job
      ↓
What does this role actually care about?
      ×
What can I actually prove?
      ↓
What should I prepare next?
      ↓
Evidence-backed application workspace
```

Candidate copy:

> Give OfferU a job. It shows what the role really asks for, what you can prove, and prepares the application around that evidence.

The broader Career OS story can follow:

- the next Job reuses Profile evidence;
- interviews feed reviewed learning back into Profile;
- Timeline / Pipeline / Today stay synchronized;
- OfferU gets more useful without inventing new career facts.

## 5. Product story should start from repeated user pain

A strong launch narrative should be understandable without architecture terminology.

Recommended story arc:

### Pain 1 — every application starts from zero

Job seekers repeatedly re-explain:

- their experience;
- target role;
- strongest evidence;
- resume context;
- prior interview lessons.

### Pain 2 — the work is fragmented

```text
JD in browser
Resume in a file
Research in another tab
Application tracker in a spreadsheet
Interview notes in a chat
```

There is no persistent application object.

### Pain 3 — generic AI optimizes by inventing

A model can make a resume “match” a JD by overstating or fabricating evidence unless the product maintains a separate truth/evidence boundary.

### Product insight

The unit of work should not be “a chat”.

It should be:

```text
verified Career Profile
        +
target Job
        =
reviewable Job Workspace
```

The Agent reasons over it. OfferU controls evidence, side effects and persistent state.

Only after this user story is clear should launch material explain:

- Reasoning authority;
- Operation Registry;
- Career Runtime;
- proposals / approvals;
- local-first architecture.

## 6. Plan → Review → Execute

Before a large preparation run or any external side effect, OfferU should summarize what it intends to do.

Example preparation plan:

```text
Prepare this job

Research
- analyze the saved JD
- compare against relevant roles if a live source is available

Evidence
- map 8 requirements against verified Profile evidence
- flag unsupported claims instead of filling them in

Materials
- propose a tailored resume version
- prepare an application packet
- prepare interview focus areas

External actions
- no application will be submitted
- no recruiter message will be sent

[Prepare]
```

For a provider-backed action, show account/cost/rate information when materially relevant and known.

The important interaction is not “approval everywhere”. It is a compact contract before work that materially changes scope, cost or external side effects.

## 7. Progressive results should appear in the Workspace, not only in chat

Long-running preparation should progressively materialize:

```text
Job saved
→ Job Snapshot ready
→ Role Intelligence ready
→ Evidence Map ready
→ Resume proposals ready
→ Interview focus ready
```

Today can summarize:

- completed automatically;
- needs review;
- blocked / failed;
- next best action.

The Job Workspace provides the detailed state.

This lets a user close the Agent chat and still understand what OfferU did.

## 8. “Keep what is already good” applies to career work too

Creative tools reuse accepted generated assets. OfferU has a parallel principle: preserve accepted facts and edits.

Examples:

- a tailored resume version should not overwrite the Master Resume;
- a user manual edit makes an older AI proposal stale;
- accepted evidence remains stable unless explicitly superseded;
- re-analysis of a Job should update affected intelligence without resetting unrelated application state;
- interview learning should enter as a candidate, not silently rewrite Profile truth.

User-facing principle:

> Change the target job or evidence; OfferU updates the affected preparation without erasing work you already accepted.

This is a product-level expression of existing truth/version boundaries.

## 9. Hero demo contract

Target launch demo (roughly 20–35 seconds):

```text
1. Save / paste one real-looking Job
2. OfferU immediately creates the Job Workspace
3. Role Intelligence extracts what matters
4. Evidence Map shows:
   Strong / Weak / Missing
5. Resume Workspace shows a proposal:
   Before → After → Why → Evidence
6. User rejects one unsupported suggestion and accepts another
7. Application Packet becomes ready
8. Today shows the next action
```

Optional second beat:

```text
Open the same Job from an external Agent
→ ask one question / request a revision
→ return to OfferU
→ the same Workspace has changed
```

That second beat proves the real differentiator: external Agent + OfferU workspace share one governed truth.

## 10. README / launch information order

Recommended order:

```text
Concrete promise
→ one complete Job-to-Workspace demo
→ why normal job-search AI breaks
→ Role × Evidence formula
→ Job Workspace
→ Quickstart
→ local Agent / Skill entry
→ Today / Pipeline / Profile compounding loop
→ evidence + approval model
→ architecture / security / current status
```

Do not lead with Operation Registry or the authority model. Those are the explanation for why the experience is trustworthy, not the first reason a user cares.

## 11. Product language

Prefer user language:

- Job Workspace
- what this role cares about
- what I can prove
- evidence gap
- proposal
- review
- next action
- application packet

Keep implementation language mostly in technical sections:

- Harness
- MCP
- Operation Registry
- Capability Gateway
- side-effect schema
- provider topology

## 12. What to borrow, and what not to copy

Borrow:

- one-step Agent capability entry;
- Skill supplies domain knowledge while executable/product owns governed actions;
- reference/input-first onboarding;
- progressive preparation;
- explicit plan before meaningful paid / external work;
- editable workspace as the durable artifact;
- keep accepted work and update only what changes;
- outcome-first marketing story.

Do not copy:

- a domain-specific markup language OfferU does not need;
- growth claims not controlled by the product;
- terminal-first onboarding for normal users;
- Agent-owned truth;
- a Studio that duplicates the canonical OfferU Desktop state.

## 13. External reference patterns

Reviewed references:

- Hypit Agent Quickstart: https://hypit.ai/quickstart/
- Hypit Agent usage guide: https://hypit.ai/guide/skill/
- Hypit Studio: https://hypit.ai/zh/quickstart/preview/
- Hypit repository: https://github.com/hypit-ai/hypit

The relevant pattern is:

```text
Skill makes the Agent capable
→ Agent works on a durable project
→ user inspects/edits the result in a dedicated workspace
→ subsequent requests update the same project
```

For OfferU, adapt that to:

```text
OfferU Skill makes the Agent career-aware
→ Agent works through governed OfferU capabilities
→ user inspects/edits the same Job Workspace
→ accepted evidence and outcomes compound into Profile
```
