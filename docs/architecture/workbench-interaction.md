# Workbench Interaction

Status: **CURRENT PRODUCT INTERACTION**  
Updated: 2026-09-23

OfferU Desktop is the primary Career OS workspace.

A local Agent may be the preferred reasoning environment, but users should not be forced to live inside a Harness UI to use OfferU.

## Default beginner experience

~~~
Install
→ Agent auto-discovery
→ Know Me / Profile
→ Save first Job
→ Connect inbox
→ Today
~~~

The default interaction is Guided, not command-first.

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

Advanced users may open Agent/Skill/CLI controls in Power Mode.

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

## Focus work

Resume deep editing, interview practice and complex evidence review may use focused workspaces, but they remain part of the same Job/Profile truth.

## Design rule

OfferU should minimize both setup burden and decision burden. Do not add a new mode or page when a Next Best Action can safely guide the user instead.