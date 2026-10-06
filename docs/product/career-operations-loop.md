# OfferU Career Operations Loop

Status: CURRENT PRODUCT DETAIL / OWNER-DOGFOOD CONTRACT  
Date: 2026-10-01

This document records the product and interaction direction established during owner dogfood. Higher-level authority remains GOAL.md and docs/product/current-product.md.

Interactive visual blueprint: [OfferU Career OS Product Blueprint](./offeru-career-os-blueprint.html). The HTML is a target-experience/design artifact, not implementation-status evidence.

## 1. Product outcome

OfferU should behave as a continuous career operating system rather than a collection of disconnected tools.

Start → build/refresh Profile → discover jobs daily → score/rank → user chooses targets → research target + comparable JDs → tailor evidence-backed materials → assist with login/form filling when requested → submit/receipt → sync progress → interview prep → debrief → reviewed learning → improve future decisions.

The user should make a few meaningful decisions. They should not approve every internal persistence operation.

## 2. Reference pattern: career-ops

References:
- https://career-ops.org/
- https://career-ops.org/docs
- https://career-ops.org/methodology
- https://career-ops.org/docs/introduction/guides/scan-job-portals
- https://career-ops.org/docs/introduction/guides/apply-for-a-job
- https://career-ops.org/docs/introduction/guides/interview-modes

OfferU should borrow the workflow logic, not the terminal-first UI:

1. Conversational onboarding: resume first, then ask only useful missing context.
2. One source of truth: Profile/goals drive discovery, scoring, tailoring, interview and follow-up.
3. Scan before evaluate: cheap source-native discovery first, model evaluation for survivors.
4. Rank before apply: transparent scored queue instead of manual browsing.
5. Research-backed tailoring: target JD + comparable roles + current public info.
6. Application assistance: inspect/fill/draft while keeping user control of sensitive or irreversible actions.
7. Interview compounding: plan → practice → real interview → debrief → learning.

## 3. OfferU Skill Cluster

User sees one top-level Skill: OfferU.

Internally it may route to:
- initialize: resume discovery, profile interview, authorized Agent-memory import, career goals;
- discover: company/ATS scan, BOSS job sync, web research;
- evaluate: fit, ranking, role benchmark;
- resume: evidence mapping, section strategy, tailored resume, diff review;
- apply: browser capability, login/account assist, form fill, answer drafting, receipt capture;
- progress: email sync, BOSS progress sync, pipeline reconciliation;
- interview: prep, practice, debrief;
- maintain: daily review, stale-data refresh, history distillation.

The user should not need to choose these sub-Skills manually.

## 4. Interaction rules

### Freshness

For current JDs, company/product info, open roles, salary/market signals, application portals and interview/company research, the active Agent should refresh current evidence before substantive recommendations. Pure local editing does not need pointless web calls.

Evidence should be marked as live/current, cached, local, user-provided or unavailable.

### Ask is collaboration, not approval

Use the current host's structured Ask/user-input capability when preference, ambiguity or strategy requires the user:
- product-heavy vs technical-heavy positioning;
- whether to keep/weakly emphasize open-source;
- primary/secondary target roles;
- whether to authorize a local folder;
- whether to continue with a borderline job.

If the host lacks native Ask, OfferU Desktop can render the same request.

Do not create a Proposal merely to ask a question.

### Human-in-the-loop at decision level

Human review should happen at semantic boundaries:
- Profile fact/evidence adoption;
- resume positioning/structure;
- section-level before/after review;
- final application material review;
- account/sign-in handoff;
- sensitive form field;
- final submit/send/contact;
- ambiguous progress association.

Internal operations inside an already agreed scope remain auditable but should not each require a click.

## 5. Minimal onboarding

First-run:
Open OfferU → connect/use one Agent or built-in fallback → find/import resume OR interview user if no resume → build initial Profile → ask target roles/locations/constraints → Today becomes useful.

Do not require Gmail, BOSS, browser automation, Playwright, ATS credentials or every Profile field on first run. Integrations are just-in-time.

## 6. Profile

Profile is the richest user evidence model, not a rewritten resume.

It should include:
- career stage and identity;
- education;
- work history;
- projects;
- open-source;
- creator/community/public work;
- skills/tools/domains;
- measurable outcomes;
- awards/certifications;
- role/location/remote/compensation/timing preferences;
- target role archetypes;
- provenance;
- uncertainty/missing evidence;
- interview learning;
- user corrections.

Inputs:
local resumes/files + user conversation + explicitly authorized Agent memory + reviewed email/interview observations + manual evidence → candidates/observations → review where material → canonical Profile.

Profile UI should clearly show Overview, Goals, Experience, Projects, Open Source/Creator/Other Evidence, Skills, Preferences, Evidence Sources, Missing/Unknown, Recent Learning and History.

Avoid opaque Profile completeness vanity scores; sufficiency is relative to current goals.

## 7. Agent memory

Detect metadata only first. Explain source/scope → Ask permission → preview selected excerpts → import as candidate observations → dedupe → review/promote.

Agent memory is not automatically Career Truth.

## 8. Job discovery and BOSS

OfferU should merge multiple sources into one canonical Job queue.

Prefer source-native ATS/company APIs where reliable; use browser research where no clean source exists. Apply cheap title/location/level/company/duplicate/applied/stale filters before model evaluation.

Current BOSS Agent CLI reference: https://github.com/can4hou6joeng4/boss-agent-cli

Treat `boss schema` as the runtime capability truth instead of hard-coding a frozen command list. The current upstream exposes candidate workflows spanning discovery/details/history/recommendation, interviews and resume/profile helpers, plus candidate actions such as `greet`, `batch-greet`, `apply`, `exchange`, `chat*`, `pipeline` and `digest`. OfferU must still verify the installed version, role/platform availability, authenticated session and real-account behavior before enabling an action.

For OfferU, BOSS is primarily a Job + Progress + Communication Connector:
- discovery/recommendation can feed the daily Job queue;
- detail/history can enrich canonical Job records;
- pipeline/application/interview signals can reconcile existing Application/Interview state;
- chat/greet/apply-style actions remain governed external effects and need OfferU authorization/receipt policy.

Do not create a parallel BOSS career silo. BOSS-derived resume/profile material may contribute observations only when the installed capability actually returns attributable user-owned source material; OfferU Profile remains the canonical evidence-backed Career Truth.

## 9. Job ranking

Users cannot inspect every discovered role manually. OfferU should provide a sorted queue with transparent reasoning.

Dimensions may include:
- hard requirement coverage;
- verified evidence match;
- target-role alignment;
- level fit;
- location/remote constraints;
- compensation if current/known;
- company/product interest;
- growth opportunity;
- application effort;
- legitimacy/staleness/risk;
- user-specific red flags.

The overall score may be rubric-guided model judgment, but must cite JD evidence, Profile evidence, external research where used, and unknowns.

The score is prioritization, not a prediction of interview/offer probability.

## 10. Role Benchmark

For serious targets:

Target JD + comparable current roles + company/product research → common requirements + target-specific requirements → evidence map → resume strategy + interview strategy.

Common signals are table stakes. Target-specific signals show unusual emphasis.

Resume and interview must share the same Role Benchmark rather than duplicating reasoning.

## 11. Tailored resume

Inputs:
canonical Profile + existing resume/style + target Job + Role Benchmark + verified evidence + accepted prior decisions.

Process:
1. positioning;
2. section order;
3. evidence selection;
4. rewrite/reorder using target vocabulary without inventing facts;
5. section-level before/after review;
6. new Resume Version linked to Job;
7. export PDF.

Normal human review should be a few decisions:
1. positioning/structure;
2. evidence emphasis;
3. section-level diff;
4. final resume.

Every accepted change should be visible and reversible. Never overwrite canonical Profile truth.

## 12. Browser automation as lazy capability

References:
- https://playwright.dev/docs/auth
- https://playwright.dev/docs/next/input

Playwright can navigate pages, fill inputs, select options, upload files and reuse authenticated browser state.

Do not make Playwright a first-run dependency.

When the user first requests registration/login/form filling/receipt capture:
- detect browser automation capability;
- if missing, explain why and install/configure it where safe or guide setup;
- for phone, SMS/OTP, QR, CAPTCHA, 2FA or consent, pause and Ask the user;
- never bypass anti-bot/account protections.

## 13. Account/login assistance

Only when needed for a selected application:
user selects Apply → detect portal/account state → reuse authorized session if available → if registration needed, prepare safe fields → Ask for missing phone/email/user choice → user handles OTP/CAPTCHA/2FA → verify login → continue.

Do not pre-register many sites during onboarding.

## 14. Application state

Use explicit states:
discovered → evaluated → shortlisted → materials_ready → form_prepared → user_reviewed → submitted → receipt_verified.

Do not collapse these states.

OfferU may fill verified safe fields, upload the correct tailored resume, draft open-ended answers, flag unknown/sensitive questions and preserve a material snapshot.

A click or model claim is not success evidence.

## 15. Progress synchronization

Email/BOSS/browser receipt/calendar/user statement → classify → associate → dedupe → ambiguity check → progress candidate → review when necessary → canonical stage event → Pipeline + Job Workspace + Today.

Never silently attach an ambiguous email to one of several same-company roles.

## 16. Interview loop

Interview scheduled → round-specific plan → practice → real interview → debrief → learning candidates → reviewed Career Memory/Profile → next-round plan.

Prep should use target JD, Role Benchmark, submitted Resume Version, evidence gaps, prior interview learning and round type.

Debrief should ask a few high-value questions: what was asked, what was difficult, where the interviewer probed, what differed from expectation and which answer needs improvement.

Debrief produces evidence-linked learning, not a generic summary.

## 17. Daily Career Director

Daily Review combines Profile + Goals + new Jobs + ranked queue + Pipeline + Email/BOSS signals + upcoming interviews + follow-ups + learning + pending decisions.

It should return only a few meaningful priorities, e.g. 3 high-fit new roles, 1 follow-up due, interview tomorrow, 1 resume review.

The product reduces decision burden; it must not create another inbox of 70 actions.

## 18. History/cache/stale data

Users may return after days/weeks or several OfferU versions.

Provide two modes:

### Clean reset
For owner dogfood: back up current data, clear OfferU test/local state, preserve external user files, start fresh.

### Distill and continue
For normal users: detect stale/duplicate history, summarize old transient tasks/conversations into short historical nodes, preserve decisions/receipts/evidence/outcomes, reduce obsolete cache, refresh live external facts.

Historical nodes should keep period, context, important decisions, accepted facts/evidence, outcomes, lessons, superseded artifacts and source refs.

Never silently delete canonical Career Truth because it is old.

## 19. Visibility contract

A normal user must be able to answer:
- What does OfferU know about me?
- Why is this job ranked here?
- Which evidence is it using?
- What changed in this resume?
- What did it do automatically?
- What needs my decision?
- What happened to this application?
- What did I learn from the last interview?

If this requires raw JSON, SQL, logs or Operation names, the UX is incomplete.

## 20. Owner dogfood acceptance

Fresh OfferU → real resume + conversation + optional authorized Agent memory → goals → daily company/ATS discovery + BOSS if authorized → ranked queue → choose real Job → Role Benchmark → tailored Resume with visible diffs → application preparation → browser/login handoff if needed → user submit/receipt → progress sync → interview prep → debrief → learning → next Daily Review.

Every stage: WORKS / PARTIAL / BROKEN / NOT IMPLEMENTED / NOT TESTED.

Code existence or unit tests do not count as WORKS unless a normal user can reach the capability through the intended product surface.


## 21. Skill ecosystem and composition

OfferU should be maintainable as an ecosystem of Skills rather than one giant prompt file.

A future dedicated repository such as `offeru-skills` may contain:
- the top-level OfferU router/orchestrator Skill;
- first-party sub-Skills for profile, discovery, ranking, resume, application, interview and maintenance;
- versioned shared conventions;
- test fixtures and evals for each Skill.

OfferU Desktop remains the Career Truth/runtime product. The Skill repository contains methodology and orchestration, not a second database or business authority.

The active local Agent may also call independently installed third-party Skills when useful, for example:
- resume-writing methodology;
- interview coaching;
- web/company research;
- BOSS CLI;
- browser automation;
- other user-selected career Skills.

Third-party Skills may contribute analysis/drafts, but adopted output must still pass OfferU provenance/evidence/governance rules. A Skill may not silently upgrade an inference into Career Truth.

Skill composition should therefore look like:

```text
User intent
→ OfferU top-level Skill
→ choose OfferU sub-Skill
→ optionally call external methodology/tool Skill
→ normalize result into OfferU evidence/artifact
→ Desktop shows result/decision
→ canonical Career Truth changes only through governed OfferU operations
```

This keeps OfferU extensible without forcing every capability into the core repository.

## 22. BOSS re-engagement lifecycle

BOSS job discovery, recommendation, pipeline/application sync, interview sync and communication state should feed the same canonical Job/Application queue.

Current upstream exposes candidate-side `greet`, `batch-greet`, `apply`, `exchange`, `chat*`, `pipeline` and `digest`, but OfferU must not translate command existence into unconditional automation. Availability is version/role/platform dependent and real-account semantics such as duplicate greet behavior, conversation continuation, cooldown and platform risk still require capability probing and acceptance.

Therefore OfferU should model **re-engagement intent** rather than blindly re-running greet on a timer.

Suggested policy:
- read current connector capability from `boss schema`;
- detect whether a role was already greeted/applied/communicated;
- track last-contact time, channel, outcome and receipt;
- detect whether the job changed/reopened or the user's resume materially changed;
- surface a re-engagement candidate;
- let the Agent choose the best supported action from current context;
- require OfferU's normal external-action authorization/receipt boundary before sending;
- keep cooldown, dedupe and platform-risk handling explicit.

Never treat repeated greetings as a guaranteed messaging channel or assume a command succeeded without attributable evidence.

## 23. Counterparty intelligence: Company / Org / Team / Interviewer

OfferU should model not only the candidate but also the counterparty around each serious Job.

For each target Job maintain a structured intelligence view:

```text
Company
→ business/product/current strategy
→ hiring org / business group
→ team
→ role owner / hiring manager when known
→ recruiter / HR
→ interviewers by round
```

Evidence may come from:
- official company/career pages;
- current JD and related JDs;
- public team/product pages;
- reliable public profiles/posts;
- user-provided recruiter/interviewer information;
- interview invitations;
- community interview experiences (clearly labeled as anecdotal);
- previous rounds in the same hiring process.

Do not invent private preferences or personality traits. Separate:
- sourced fact;
- public signal;
- user observation;
- inference/unknown.

Desktop should show a compact Company/Team Intelligence panel:
- business group/team;
- what the team appears to build;
- role-specific priorities;
- hiring process/rounds when known;
- people/roles involved;
- open questions to verify;
- evidence links and freshness.

## 24. Round-specific interview intelligence and questions-to-ask

Every interview round has a different information goal.

OfferU should prepare both:
1. likely questions the user may receive;
2. high-value questions the user should ask.

Examples:

Recruiter / HR:
- remaining process and timeline;
- role ownership/reporting line;
- hiring location/contract details;
- compensation process when appropriate;
- team/round information that can be shared.

Hiring manager / direct manager:
- current team priorities;
- success criteria in 3–6 months;
- what distinguishes strong performers;
- team composition and collaboration;
- biggest current bottleneck/risk;
- what this role owns vs supports.

Peer / cross-functional / technical round:
- real workflow and interfaces;
- decision-making boundaries;
- quality/review expectations;
- production/tooling constraints;
- examples of recent problems the team solved.

Final / leadership round:
- business priority;
- org direction;
- scope/growth trajectory;
- why the role exists now;
- major tradeoffs expected from the hire.

Questions should be personalized from the current unknowns in Company/Team Intelligence rather than shown as a generic static checklist.

Answers learned during interviews become new sourced observations attached to the Job/team, not automatically universal Career Truth.

## 25. Interview Intelligence Memory

OfferU needs a durable interview-learning model, not only per-interview summaries.

Maintain:
- question bank;
- story/evidence bank;
- round history;
- interviewer/team observations;
- answer performance;
- user corrections;
- repeated weak areas;
- repeated high-frequency themes;
- company/team-specific learned facts;
- unanswered questions for the next round.

After each real interview:

```text
recall actual questions
→ capture interviewer reaction/follow-ups
→ evaluate answer against evidence
→ mark strong/uncertain/weak
→ identify missing story/knowledge
→ update question/story bank after review
→ feed the next round's preparation
```

Future prep should combine:
- target Job + Role Benchmark;
- current round;
- submitted Resume Version;
- company/team intelligence;
- public interview reports from current sources when available;
- the user's previous interview history;
- questions frequently appearing across the user's recent search;
- answers/stories that previously performed poorly.

Community sources such as interview forums may provide useful current signals, but they must remain attributed/anecdotal and should not be treated as facts about a specific interviewer.

## 26. Desktop is the Career Operations Cockpit

The Desktop is not an embedded replacement for the user's Agent.

Its job is to make durable career work visible and controllable.

The user should see structured, persistent outputs rather than searching old conversations:

- Profile/evidence map;
- ranked Job queue;
- Company/Team Intelligence;
- Role Benchmark;
- resume strategy + animated/visible before-after diffs;
- accepted Resume Versions;
- application state/receipts;
- recruiter/contact/re-engagement state;
- interview timeline;
- round-specific preparation;
- interview question/story bank;
- debrief/learning changes;
- Today's priorities;
- history/distillation.

Agent conversations are execution/control surfaces. Desktop is the inspectable system of record.

Important work should produce a visible state change:
- newly discovered evidence highlights;
- a resume section diff animates/highlights what changed;
- a Job score explains what moved;
- a new interview signal appears on the timeline;
- accepted learning visibly updates the interview/profile intelligence.

The design goal is not decorative animation. Motion/highlight is used to answer: "what just changed, why, and what needs my attention?"


## 27. Immediate priorities

P0:
1. understandable Profile + evidence/provenance;
2. Decision-level HITL and Ask separation;
3. resume section-level diff/review;
4. ranked Job queue;
5. shared Role Benchmark for resume/interview;
6. fresh-user and history-distillation flows.

P1:
1. BOSS Job/Progress connector verification;
2. company/ATS daily discovery;
3. lazy Playwright/browser capability;
4. application receipt loop;
5. real Interview Debrief UI flow.

P2:
1. broader ATS coverage;
2. account-registration assistance;
3. outcome-based score calibration;
4. cross-Agent continuation verification.

> One Profile, one Career Truth, one ranked work queue, a few meaningful user decisions, and every outcome feeds the next decision.
