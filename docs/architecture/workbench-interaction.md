# Workbench Interaction

Status: **CURRENT PRODUCT INTERACTION**  
Updated: 2026-09-23

OfferU Desktop is the primary Career OS workspace.

A local Agent may be the preferred reasoning environment, but users should not be forced to live inside a Harness UI to use OfferU.

## Default beginner experience

~~~
Install
→ Agent auto-discovery
→ OfferU Skill projected automatically where supported
→ Know Me / Profile
→ Save first Job
→ Open Job Workspace
→ Connect inbox
→ Today
~~~

The default interaction is Guided, not command-first. The user enters through OfferU Desktop; Skill installation and tool routing stay behind the product unless the user explicitly enters Power Mode.

## Today

Today answers: **What should I do next?**

It should show at most a few primary actions derived from existing Career State. Priority inputs include pending progress review, upcoming interviews, deadlines, high-value job preparation, stale follow-up and failed/blocked work that requires attention.

Each recommendation explains why now. Completing one action should recalculate the next actions.

## Progressive onboarding

Do not show a configuration wall. If the system is missing several prerequisites, request only the next useful one.

Example: if Agent is ready but Resume, Email and Extension are not, the UI should first ask for the resume rather than presenting three setup panels.

## Progressive Profile questions

Do not ask every preference on day one. Ask small contextual questions only when useful to a live decision, then persist the answer as a sourced preference/fact candidate.

## Agent interaction

Normal users should not have to choose Agent Skills manually. Natural-language goals and current Career State should route to the relevant Skill.

Advanced users may open Agent/Skill/CLI controls in Power Mode, including a Skill-first lane from a supported external Agent. A Skill-first action must create or update the same canonical Job Workspace visible in OfferU Desktop; it must never create a parallel Agent-only project.

A useful mental model is:

~~~
Skill = Agent entry
Job Workspace = user product
Career Runtime = shared truth
~~~

## Skill ecosystem UX

OfferU may tell the user that their local Agent already has compatible resume/interview/recruiting Skills, but the default integration relies on the host's native Skill discovery.

A future Skill Inventory should be opt-in and metadata-only by default.

## Browser capture

~~~
open job page
→ click 保存到 OfferU
→ preview/dedupe
→ Job appears in OfferU
→ OfferU recommends the next preparation action
~~~

## Email progress

After inbox connection, OfferU may proactively detect likely career updates but presents ambiguous or important changes for review. The user should see a human-readable card, not IMAP/UID/cursor terminology.

## Job Workspace

A Job is not merely a detail page. It is the durable workspace for one opportunity.

It should progressively collect:

- Job Snapshot;
- Role Intelligence;
- Evidence Map;
- application materials and versions;
- interview preparation / debrief;
- canonical Timeline and next action.

Agent work should materialize into these visible objects as it completes. If the user closes the Agent conversation, the work remains understandable and reviewable in the Workspace.

## Focus work

Resume deep editing, interview practice and complex evidence review may use focused sub-workspaces, but they remain projections of the same Job/Profile truth.

## Design rule

OfferU should minimize both setup burden and decision burden. Do not add a new mode or page when a Next Best Action can safely guide the user instead.