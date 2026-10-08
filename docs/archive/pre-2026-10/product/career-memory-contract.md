> **已归档（2026-10）**：本文不再是当前权威。当前文档：03-module-profile.md（位于 `docs/`）。

# Career Memory & Context Contract

Status: **CURRENT PRODUCT DETAIL / IMPLEMENTATION CONTRACT**  
Updated: 2026-09-29

OfferU is a local-first Career OS. Its memory design must make the product feel like it knows the user over time without turning model-generated summaries into unreviewable truth.

This contract separates five things that are often incorrectly collapsed into one “memory” concept.

## 1. Career Truth

Career Truth is the structured, user-editable source of record for facts and workflow state.

Examples:

- Profile identity, education, employment, projects, skills and verified preferences;
- Evidence and provenance;
- Jobs and Job Workspaces;
- Applications, stages and timeline events;
- Resumes, versions and accepted proposals;
- Interviews, schedules and confirmed outcomes;
- CareerTasks, proposals and approval state.

Career Truth belongs to OfferU's local persistent store. Today that store is SQLite/files. The storage technology may evolve, but there must remain one canonical truth layer that both the UI and Agents use.

Career Truth is not an Agent memory file.

## 2. Curated Career Memory

Curated Career Memory is the compact, long-lived model of what OfferU has learned about how to help this user.

Good examples:

- stable role/company preferences;
- communication and working-style preferences;
- repeated user corrections;
- accepted career hypotheses;
- durable interview/job-search lessons;
- recurring strengths or friction patterns supported by reviewed evidence;
- confirmed outcome learnings that should influence future decisions.

It should be small, current, user-visible and correctable. It is not a dump of every conversation.

A future OfferU “Career Memory Summary” should behave like a high-level editable synthesis: it may omit detail, should state when it was last refreshed, and must allow the user to correct or suppress outdated information.

## 3. Episodic Learning

Detailed history belongs in an episodic layer:

- interview debriefs;
- LearningObservations;
- rejected/deferred MemoryProposals;
- conversation-derived observations;
- application outcomes;
- daily/weekly reviews;
- historical agent/session evidence.

This layer is searchable/on-demand context, not something injected into every Agent run.

Promotion from episodic learning into Curated Career Memory or Profile requires provenance, dedupe/supersession and the existing review/evidence gates.

“Asked three times” is not automatically “weak three times”.
“Observed once” is not “repeated”.
Pending/rejected observations do not become durable truths.

## 4. Prospective Memory

Remembering what should happen later is different from remembering facts.

Examples:

- follow up after N days;
- interview tomorrow;
- Resume re-engagement window;
- recurring Daily/Weekly review;
- pending user decision.

These belong in explicit structured lifecycle state — Calendar/Event/CareerTask/Automation/Proposal — with due time, status, dedupe and completion/cancellation semantics.

Do not store future obligations only as prose in Career Memory and hope a model remembers to act.

## 5. External Agent Memory

Codex, OMP, Claude Code, WorkBuddy and other hosts may have their own memory/history.

That memory is an **optional source**, never OfferU's truth authority.

Rules:

- do not read host memory without explicit user authorization;
- import only relevant excerpts, not the entire host history by default;
- imported content enters OfferU as Observation/Candidate/MemoryProposal;
- claims about employment, achievements, metrics or authorship require OfferU evidence/review before they can become Career Truth;
- host memory may remember process preferences such as “OfferU is my career truth store”, but must not become a shadow Profile database.

After onboarding, external Agents should normally read the career context that OfferU assembles, rather than independently searching their own memory for career facts.

## Context assembly

An Agent should receive the **minimum sufficient career context** for the current goal, not a database dump.

Conceptually:

~~~text
Career Context
  = relevant Career Truth
  + compact Curated Career Memory
  + relevant episodic evidence/learning
  + current Job/Application/Interview state
  + current pending decisions
~~~

The selected Skill/Operation surface decides what is relevant.

The Agent does not need to know which SQLite tables produced that context.

## Storage boundaries

Use the right layer for the right job:

| Data | Canonical location |
| --- | --- |
| Profile / Evidence | local Career Truth |
| Jobs / Applications / Pipeline | local Career Truth |
| Resume versions / proposals | local Career Truth + files |
| Interviews / Calendar / Timeline | local Career Truth |
| CareerTasks / Automation / Proposals | local Career Truth |
| Curated Career Memory | OfferU memory records / accepted profile evolution |
| Detailed debriefs / observations | episodic learning records |
| Raw resume/PDF/export assets | files |
| UI tab / panel / transient form state | UI-local storage |
| Static Showcase demo state | browser IndexedDB/localForage |
| Codex/OMP/Claude memory | external optional source |

The normal desktop product must never require the user to understand SQLite, ports, Python, MCP or memory internals.

## Write path

New career knowledge follows:

~~~text
Source
  Resume / user statement / interview / email / authorized Agent memory
        ↓
Observation / Candidate
        ↓
provenance + validation
        ↓
MemoryProposal / Evidence gate
        ↓
user/policy review when required
        ↓
Curated Career Memory and/or verified Profile
~~~

No model can promote its own inference into verified Career Truth simply because it appeared repeatedly in chat.

## Recall path

For a normal career task:

1. connect to the installed OfferU product;
2. resolve the relevant live Skill;
3. read the smallest relevant Profile/Evidence/Job/Application/Interview/Memory context exposed by that Skill;
4. reason over that grounded context;
5. prepare safe work;
6. route persistent changes through Operation Registry / Proposal / HITL.

Do not:

- dump all memory/history into every prompt;
- read raw SQLite directly;
- treat host Agent memory as canonical;
- clone/start the OfferU development stack for a normal user task;
- create a second persistent Career Truth inside the Agent host.

## External reference patterns

This contract borrows principles, not implementation details, from:

- ChatGPT Memory (2026): synthesized high-level memory that stays current and can be reviewed/corrected, while relevant source context may come from prior chats, files and connected apps.
- Hermes Agent: a bounded always-available user/profile memory plus a separate on-demand full session search.
- OpenClaw: curated core vs episodic memory vs prospective intents, provenance-gated promotion, and structured lifecycle for future actions.
- career-ops: explicit separation between user facts and auto-memory; memory steers behavior/process but does not invent CV claims.
- Hypit: Skill = domain knowledge, executable/runtime = tools; authored project/result state remains durable outside the Skill and outside the tool source checkout.

OfferU differs because it has a GUI-editable Career Truth model, so its curated memory must compound **into** that model through reviewable evolution rather than compete with it.
