# OfferU Entry, Onboarding & Dogfood Contract

Status: **CURRENT PRODUCT DETAIL**  
Updated: 2026-09-30

This document expands the first-use and distribution contract defined by [Current Product North Star](./current-product.md). If wording conflicts, `GOAL.md` and `current-product.md` win.

The [owner's 2026-10-02 journey clarification](./owner-career-journey.md) refines the first-use target: prepare the installed app and a visible Profile first, support both resume and no-resume interviews, and configure email/BOSS/browser dependencies when used. The four-step wizard described below is the existing implementation checkpoint, not proof that this entire target is satisfied. Use the [two dogfood Goals](../evals/OWNER_DOGFOOD_GOALS.md) to verify installed-product and real-Agent behavior separately.

The immediate product goal is not “add more features”. It is:

> **A real job seeker can install OfferU, connect the AI they already use, give OfferU a real job, and keep working from one durable Job Workspace without understanding the technical stack.**

## 1. Product pattern we are borrowing

Agent-first products such as Hypit use a useful pattern:

~~~text
install / enable one Skill
→ Agent discovers or prepares its executable/runtime
→ user gives a real input or brief
→ work persists outside the conversation
→ user reviews and edits the result in a dedicated workspace
~~~

For Hypit, the public Quickstart starts with one Skill install; the Skill teaches the Agent the domain, while the executable provides Runtime and Studio. The Agent helps prepare missing tools, so the user does not clone the repository or manually understand the implementation stack.

OfferU should borrow the **interaction logic**, not the exact terminal-first onboarding.

References:

- https://hypit.ai/guide/agents/
- https://hypit.ai/guide/skill/
- https://github.com/hypit-ai/hypit/blob/main/docs/quickstart.md

## 2. OfferU adaptation: two front doors, one product

### Front door A — normal user: App-first

The normal user should experience:

~~~text
Download OfferU
→ install
→ open OfferU
→ import resume
→ optional authorized AI memory
→ save one real Job
→ canonical Job Workspace
→ Today tells the user what needs attention next
→ connect/update an existing Agent through Desktop when needed
→ verify access with a real read-only Operation
~~~

The user must not be asked to install or understand:

- Python;
- Node.js;
- Git;
- FastAPI;
- MCP;
- Operation Registry;
- model IDs;
- Skill folders or provider-specific setup screens;
- CLI commands.

OfferU's canonical Skill is publicly available as a bootstrap contract. Desktop installs/updates the runtime-bound projection through a supported host adapter; ordinary users never copy connection prompts or manage Skill folders. The external Agent owns its account/login/model. Discovery, Skill installation and real Operation readback remain distinct. Consumer Agents use officially supported connectors only when the actual transport/auth and account capabilities are accepted; manual material collaboration is an explicit fallback, not a connection.

If no supported external Agent is ready, the user may continue setup and use the OfferU fallback path. “External-first” must not become “external-Agent-required”.

### Front door B — power user: Skill-first

A user already inside a supported coding Agent may start from the Agent:

~~~text
OfferU Skill available in host
→ “Use OfferU to analyze this job: <JD/URL>”
→ Agent reads the live OfferU manifest
→ Agent selects a Skill / Operation
→ read operations execute
→ mutations become OfferU proposals
→ user reviews them in OfferU Desktop
→ the same Job Workspace updates
~~~

This is not a second CLI product. It is another front door into the same Career Runtime.

OfferU does not claim a published `npx skills add offeru` package. The canonical Skill is the public GitHub `main` file at `https://raw.githubusercontent.com/avabbbb/OfferU/main/.agents/skills/offeru/SKILL.md`; the local runtime endpoint is used only to resolve the CLI command for the running installation.

## 3. Generic local-Agent setup contract

The beginner UI does not ask the user to choose a named host. `backend/app/services/agent_host_registry.py` remains the internal capability source for diagnostics and supported automatic integration, while the user-facing flow starts from one provider-neutral prompt.

The prompt points to the canonical Skill in the public GitHub repository. The Agent must identify its current host, install only the OfferU Skill in a documented Skills directory, and follow the setup instructions shipped inside that Skill. If it needs the CLI for a packaged OfferU install, the local backend may return an installation-specific projection; this is runtime binding, not Skill distribution. The Agent must not change account/login, model, credentials, proxy or unrelated settings. If the current host has no documented Skill loader, it reports the limitation instead of guessing.

The Skill may document common host-specific Skills directories because that is setup reference material for the Agent, not a provider choice the user must make. The ordinary OfferU interface does not list provider names or ask the user to pick one.

Copying a prompt is only a handoff. The Agent must download the Skill, execute the connection check and read the current view before OfferU or the user describes it as connected. Skill and Operation capabilities continue to come from the live Registry; host name alone is not evidence of support.

## 4. Current first-use UI contract

The implemented beginner wizard is intentionally short:

1. **准备你的 Agent** — optional during first value
   - Desktop discovers supported installed hosts;
   - install/update runtime-bound Skill through the existing adapter;
   - verify with a real model-issued read-only Operation;
   - show detected, installed, verified and blocked separately; advanced host details do not gate Profile/Job setup;
   - users may continue with the built-in Agent without changing any authority or permission rule.

2. **导入简历**
   - local extraction;
   - show provenance;
   - only reviewed evidence becomes Career Truth.

3. **整理 AI 记忆** — optional
   - explicit authorization;
   - selected excerpts only;
   - imported claims enter observations/candidates first;
   - no automatic promotion to verified Profile facts.

4. **保存目标岗位**
   - browser capture or manual JD paste;
   - saving a Job does not mean it was applied to;
   - open the canonical Job Workspace.

After Agent work starts, protected mutations are surfaced in Desktop as **Pending Proposal Review**. The user can approve or reject individual actions. The Agent must never self-confirm.

## 5. What the Agent can do today

Do not describe OfferU as “one generic AI assistant”. The live Skill Registry already exposes concrete career capabilities.

### Strong / native current surfaces

**Profile and evidence**
- discover current Profile;
- review evidence;
- add evidence through governed operations;
- Profile onboarding;
- Memory Inbox review;
- permissioned work-source sync.

**Job understanding and decision**
- evaluate one Job;
- compare Jobs;
- pre-application decision;
- batch evaluation;
- evidence-backed prioritization.

**Application materials**
- tailor Resume from verified evidence;
- review Resume proposals;
- export Resume PDF;
- generate/persist cover-letter artifacts;
- prepare application-email drafts.

**Application management**
- create/update application records through proposals;
- track application state;
- calculate follow-up cadence;
- review progress candidates;
- sync supported email signals into reviewable candidates.

**Research**
- company / job research through supported, authorized evidence paths;
- Role Intelligence / benchmark / Delta when the required live capability exists.

**Interview**
- interview preparation;
- role-specific focus planning;
- mock interview;
- scoring rubric support;
- debrief;
- reviewed learning back into the Career system.

**Career development**
- funnel/pattern analysis;
- title discovery;
- skill-gap analysis;
- course/certificate review;
- portfolio/project review.

**System**
- Agent task inbox;
- automation inbox;
- current state / progress inspection.

## 6. What is partial or intentionally not done

These are capability boundaries, not automatically product bugs.

### Partial

- job scanning: local Job library works, but broad job-source crawling / live-page health is incomplete;
- application assistant: preparation exists, but the external ApplicationActionConnector execution layer is incomplete;
- contact outreach: no trustworthy contact-search/source-verification layer yet;
- interview risk review: no complete live employer-reputation research;
- market calibration: no complete current market/policy data source;
- Offer review: can structure risks/questions, but does not provide legal conclusions.

### Explicit safety boundaries

The Agent must not:

- silently submit a job application;
- send recruiter/email/DM messages automatically;
- approve its own protected mutation;
- write the database directly;
- convert unverified AI inference into Career Truth;
- read unauthorized local files/memory;
- pretend fixture/replay research is live;
- claim a host capability only because the host executable exists.

## 7. Owner dogfood phase

The next product phase is:

~~~text
OFFERU_OWNER_DOGFOOD
~~~

The owner should now use OfferU for real job-search work before adding another top-level feature.

### First dogfood sequence

Use one real machine, one real user Profile, one verified Agent (prefer Codex first), and a dedicated dogfood data directory.

For the first Job:

~~~text
launch OfferU
→ Agent connection ready
→ import real resume
→ review Profile evidence
→ paste/save a real JD
→ open Job Workspace
→ ask Agent to evaluate the Job
→ inspect Role / Evidence / gaps
→ request tailored Resume proposal
→ approve/reject/edit in Desktop
→ export PDF
→ update Pipeline manually after a real-world action
→ close OfferU
→ reopen
→ verify state persisted
~~~

Then repeat with two more real Jobs:

- one highly matched role;
- one role with obvious evidence gaps;
- one aspirational role with meaningful uncertainty.

The goal is not three successful applications. The goal is to find where OfferU causes the owner to leave OfferU and return to ChatGPT, Excel, Word, browser notes, or manual tracking.

Those escapes become the next product backlog.

## 8. Dogfood issue rule

During dogfood, classify friction before opening implementation work.

### Product blocker

Examples:

- “I cannot tell what OfferU did.”
- “The Job Workspace does not show the output I need.”
- “I have to re-explain my career history.”
- “The proposal is correct but review is painful.”
- “Today tells me the wrong next action.”
- “I still need Excel to know application state.”

These should create product work.

### Capability boundary

Examples:

- live employer reputation is unavailable;
- contact-search is not implemented;
- automatic final application submit is prohibited.

These should not automatically create bug work.

### Release-only blocker

Examples:

- unsigned/notarized installer;
- store listing;
- release-tag-only audit;
- clean-machine public distribution requirement.

These should not block owner dogfood if the owner can safely run the current development/internal package.

## 9. Dogfood → marketing evidence

Do not write the launch story from mocks. Capture it from real use.

The target launch evidence is one complete real-looking flow:

~~~text
real Job
→ “what this role cares about”
→ “what I can prove”
→ Agent prepares governed proposals
→ Desktop shows review
→ user accepts/rejects/edits
→ durable Job Workspace
→ next action in Today
~~~

Good marketing material should show:

- one concrete Job rather than a feature menu;
- one visible Agent action;
- one visible human review/rejection;
- one persisted result in Job Workspace;
- one later return where the previous work is still there.

The product story is:

> **Give your Agent a career workspace. Give OfferU a Job. Keep the truth, work and decisions in one place.**

## 10. First-use acceptance target

For owner dogfood:

- no manual Python/Node/Git configuration after the local development environment is already prepared;
- no direct database edits;
- no manual Skill file copying for the recommended Codex path;
- one real Resume and one real Job reach a usable Job Workspace;
- at least one Agent read and one governed proposal are visible;
- approve and reject both work;
- restart preserves accepted state.

For future public beginner release, raise the bar:

> On a clean computer with no Python/Node/Git, a user receives only the OfferU installer and already has a supported Agent account. Within roughly ten minutes, they can connect that Agent, import a Resume, save the first Job and reach a useful Job Workspace without opening a terminal.

This public-release target is stricter than owner dogfood and remains subject to signing, packaging, privacy and clean-machine release gates.
