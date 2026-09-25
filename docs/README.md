
# OfferU Documentation

Status: **CURRENT NAVIGATION AUTHORITY**  
Updated: 2026-09-25

OfferU has accumulated design documents, audits, eval reports and implementation snapshots across several architecture generations. This page defines which documents are authoritative **now**.

## Current authority order

When documents disagree, use this order:

~~~
GOAL.md
  release goal and durable product constraints
        ↓
docs/product/current-product.md
  current product North Star and interaction model
        ↓
CONTEXT.md
  current domain language and invariants
        ↓
docs/adr/README.md
  accepted decisions and explicit supersession history
        ↓
ARCHITECTURE.md + current architecture topic docs
        ↓
live code / Operation Registry / Host Registry / generated Skill projections
        ↓
current Eval evidence
~~~

Historical audits and dated reports are evidence of what was true when they were produced. They do **not** override current product or architecture authority.

## Start here

| Area | Current document | Purpose |
| --- | --- | --- |
| Product | [Current Product North Star](./product/current-product.md) | Outcome-first Job Workspace, zero-setup App-first UX, Skill-first power-user entry, Guided Today, external-first Agent |
| First use / dogfood | [Entry, Onboarding & Dogfood Contract](./product/entry-onboarding-and-dogfood.md) | Installer/Skill boundary, beginner hosts, current Agent capabilities, owner-dogfood path and marketing evidence |
| Proactivity | [Proactive Career Director](./product/proactive-career-director.md) | Triggered career judgment, campus/experienced Strategy Packs, autonomy levels, proactive Today/interview/re-engagement and eval contract |
| Goal | [GOAL.md](../GOAL.md) | Public-release goal and durable release gates |
| Domain | [CONTEXT.md](../CONTEXT.md) | Career Truth, candidates, evidence, applications, memory and Agent vocabulary |
| Architecture | [ARCHITECTURE.md](../ARCHITECTURE.md) | Short current system boundary |
| Agent | [Agent system](./architecture/agent-system.md) | Agent hosts, Skills, tool surface, Registry and runtime responsibilities |
| Integrations | [Agent host integrations](./architecture/harness-integrations.md) | Local-host discovery, auth ownership and runtime capability contract |
| UX | [Workbench interaction](./architecture/workbench-interaction.md) | Guided Today, progressive onboarding and Power mode |
| Security | [Operation security](./architecture/operation-security.md) | permissions, proposals, confirmation and failure rules |
| Browser | [Browser extension](./architecture/browser-extension.md) | user-triggered job capture and safe Smart Fill |
| Tool surface | [Tool Surface V2](./architecture/2026-09-22-tool-surface-v2.md) | Registry vs Agent Tool Surface vs Active Skill Surface |
| Eval | [Live Eval](./evals/LIVE_EVAL.md) | current Agent eval contract and execution model |
| Status | [STATUS.md](../STATUS.md) | current implementation state and blockers |
| Handoff | [HANDOFF.md](../HANDOFF.md) | latest continuation context for Coding Agents |

## Product design rationale

These explain why current product rules exist; they are references, not higher authority.

- [Skill-first Agent Entry, Job Workspace & Product Story](./product/skill-first-job-workspace-story.md) — rationale and external reference patterns behind the now-adopted App-first / Skill-first dual entry, canonical Job Workspace and outcome-first product story.

## Document status classes

- **CURRENT AUTHORITY** — actively defines current product/architecture.
- **CURRENT EVIDENCE** — current reproducible validation or status; does not define product direction.
- **HISTORICAL SNAPSHOT** — accurate for a dated commit/experiment; not a current spec.
- **SUPERSEDED** — retained only because the decision history is useful.
- **PROPOSAL** — not accepted until promoted by the appropriate authority.

A date in a filename is a strong signal that the file may be a snapshot rather than timeless authority.

## Historical material

Treat these as historical unless a current authority page explicitly adopts their conclusion:

- docs/archive/**;
- docs/evals/reports/**;
- dated operation inventories and audit reports;
- old provider-specific or DSH-specific implementation plans;
- old release scorecards tied to an earlier commit;
- deprecated Main-Agent/Pi architecture notes.

Do not rewrite old eval numbers to make them look current. Preserve the result and mark its scope.

## Rules for future docs

1. Prefer updating an existing current authority page over adding another dated “vNext design”.
2. New long-lived architecture decisions go into docs/adr/README.md with explicit supersession.
3. Product interaction changes update docs/product/current-product.md.
4. Dynamic capability counts come from live Registry/Host/Skill code, not hand-maintained prose.
5. Eval reports state the commit/runtime/model and remain evidence, not architecture.
6. A new Coding Agent should be able to identify current authority without reading historical reports.
7. If a document is kept only for archaeology, move it under docs/archive/ or add a clear historical header.

## Current product summary

~~~
OfferU Desktop = primary Career OS experience
Job Workspace = durable product object for one opportunity
App-first = default normal-user front door
Skill-first = power-user Agent front door
External local Agent = preferred reasoning host
Built-in OfferU Agent = fallback
Agent Skills = composable methodology / Agent entry layer
Operation Registry = execution / permission authority
Career Runtime = canonical truth
Today = guided next-best-action layer
Browser = user-triggered job capture / safe fill
Email = evidence → candidate → reviewed stage event
~~~

See [Current Product North Star](./product/current-product.md) for the complete product contract.
