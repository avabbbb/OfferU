> **已归档（2026-10）**：本文不再是当前权威。当前文档：05-module-resume.md（位于 `docs/`）。

# Resume Canvas — Document-first, AI-assisted Resume Experience

Status: **CURRENT PRODUCT DESIGN / OWNER-DOGFOOD TARGET**  
Date: 2026-10-06  
Scope: Resume, Job Workspace, AI tailoring review, direct editing, visual design, history, export.

This document defines the target product experience for OfferU's Resume surface.

The governing principle is:

> **AI-first drafting, human-native editing.**

OfferU may use an Agent to research a role, choose evidence, propose structure and prepare a strong draft. The resulting resume must then behave like a real document: the user can click into it, edit it directly, rearrange it, style it, undo changes, compare versions and export the final artifact without having to keep prompting the Agent.

The Resume surface is not a Proposal administration panel and is not a read-only PDF preview.

---

## 1. Why this redesign exists

The current Resume Workspace already has important foundations:

- structured manual content editing;
- drag-to-reorder sections;
- live A4/Letter preview;
- autosave;
- undo;
- version history;
- Resume-specific AI proposals;
- Before / After data;
- Fact Gate and evidence references;
- template/style controls;
- PDF export.

The problem is not absence of capability. The problem is the **interaction model**.

Today the page behaves too much like:

```text
form editor
+ preview
+ AI proposal review panel
```

This creates several product problems:

1. the finished resume is visually separated from the place where the user edits it;
2. AI changes feel like administrative review items rather than edits to a document;
3. users are asked to edit proposed text inside Proposal textareas instead of editing the actual artifact;
4. the UI exposes too much workflow machinery;
5. visual refinement is secondary, so the result feels like a back-office tool rather than a professional document editor;
6. ordinary manual edits can invalidate AI proposals too broadly;
7. AI is treated as the only route to refinement instead of one collaborator inside an editable document.

A resume is a final deliverable. Users need **direct manipulation and control** after AI generation.

---

## 2. External product references

### Kami — restrained document design

Reference:
- https://github.com/tw93/Kami
- https://github.com/tw93/Kami/blob/main/skills/kami/references/design.md

Kami is valuable as a visual/design reference because it treats document design as a **constraint system**, not a marketplace of decorative templates.

Useful principles to borrow:

- warm paper-oriented canvas;
- restrained accent color;
- strong typographic hierarchy;
- editorial whitespace;
- flat surfaces;
- predictable print behavior;
- a small number of coherent design systems instead of dozens of arbitrary templates.

OfferU should borrow the restraint and print-quality mindset, not copy Kami's exact implementation.

### Lovable Visual Edits — direct control without prompting

Reference:
- https://lovable.dev/th/blog/introducing-visual-edits
- https://test.dwl.lovable.dev/blog/visual-edits

The important lesson is not “visual website editing”. It is:

> When the user wants a precise local edit, do not force them to describe it back to AI.

OfferU Resume should let the user directly select and edit the document surface.

### Cursor — AI edits as inspectable diffs

Reference:
- https://prod.cursor.com/help/ai-features/agent
- https://prod.cursor.com/docs/agent/agent-review

The useful pattern is:

- Agent applies/prepares edits;
- the user reviews visible changes in context;
- the user can keep or reject what they do not want;
- restoration remains available.

AI review belongs close to the object that changed.

### Replit Agent — checkpoints at meaningful milestones

Reference:
- https://docs.replit.com/replit-workspace/workspace-features/version-control
- https://docs.replit.com/references/version-control/checkpoints-and-rollbacks

The useful pattern is:

- automatic checkpoints at meaningful milestones;
- visible history;
- one-click rollback;
- checkpointing whole task states instead of asking for confirmation before every low-risk edit.

For OfferU, a Resume Version / checkpoint should provide the same psychological safety.

---

## 3. Product definition

The target Resume product is:

```text
Career Truth
+ Target Job
+ Role Benchmark
+ current Resume
+ Agent / Skill methodology
        ↓
prepared editable draft
        ↓
Resume Canvas
        ↓
direct human editing + contextual AI
        ↓
visible change provenance
        ↓
checkpoint / version
        ↓
PDF / application artifact
```

The user must be able to complete the final 10% manually.

AI is not the user's only mouse.

---

## 4. Page architecture

The target layout is a three-part document workspace.

```text
┌─────────────────┬───────────────────────────────────────┬──────────────────┐
│ Document Outline│                                       │ Inspector        │
│                 │              Resume Canvas            │                  │
│ Summary         │                                       │ AI               │
│ Experience      │   editable final document             │ Evidence         │
│ Projects        │                                       │ Design           │
│ Open Source     │                                       │ History          │
│ Skills          │                                       │                  │
│                 │                                       │                  │
└─────────────────┴───────────────────────────────────────┴──────────────────┘
```

### Left: Document Outline

Purpose:

- document navigation;
- section order;
- visibility;
- compact structural overview.

Interactions:

- click a section → focus/scroll Canvas;
- drag a section → reorder;
- toggle visibility;
- add section;
- show small indicators for:
  - AI changed;
  - manually changed;
  - evidence warning;
  - target-role importance.

The left rail is not a second full editor.

### Center: Resume Canvas

The Canvas is the source of truth for day-to-day editing.

The rendered document itself must support:

- click-to-edit text;
- selection;
- keyboard editing;
- direct deletion/addition;
- inline list editing;
- section/block reorder;
- content focus;
- live pagination;
- page break visibility;
- A4 / Letter;
- zoom;
- print-safe rendering.

The user should not need to mentally map a left-side form to a separate preview.

### Right: Contextual Inspector

The Inspector is contextual and collapsible.

It may show:

- AI;
- Evidence;
- Design;
- History.

It should display the currently selected block/section context instead of a global wall of controls.

Default state can be collapsed or minimal.

---

## 5. Direct editing is the default

The final document is directly editable.

Examples:

### Text

User clicks:

```text
主导市委 AIGC 工作流培训
```

and edits the text in place.

No separate Proposal textarea.

### Section structure

User drags:

```text
Projects
Open Source
```

into:

```text
Open Source
Projects
```

The Canvas reflows immediately.

### Visibility

The user can hide a section or item without deleting underlying Profile evidence.

### Design

The user can select a block and change available typography / spacing controls directly or through the contextual Design inspector.

Manual edits remain normal Resume edits and produce history/provenance. They are not treated as a failure mode.

---

## 6. AI is contextual, not a separate editor

AI actions appear near the current selection.

Example contextual actions for a selected bullet:

```text
✨ AI
Shorten
More product-focused
More technical
Match this JD
Strengthen evidence
Explain this change
```

The Agent may also receive natural-language instructions:

```text
“这一段保留开源，但放到工作经历后面。”
```

The result should materialize back into the same Canvas.

The user should never need to copy generated text from chat into the resume.

---

## 7. AI changes are inline document diffs

Do not make Proposal Inbox the primary Resume review experience.

When AI prepares changes, the Canvas enters an **AI Changes** state.

Example:

```text
12 AI changes
[Review changes] [Undo AI changes]
```

Within the document:

```diff
- 负责 AI 项目推进
+ 主导 AI 产品从需求拆解、方案设计到落地验收
```

Associated context can include:

- Why;
- target-JD requirement;
- Profile evidence;
- Role Benchmark signal;
- confidence/fact-gate state.

Actions near the change:

- Accept;
- Revise;
- Restore original.

For a coherent batch the user may also:

- Accept all unchanged-safe edits;
- Undo all AI changes;
- review only flagged/low-confidence changes.

### Important

AI Proposal / Decision Plan remains valid infrastructure for:

- provenance;
- authorization;
- audit;
- stale detection;
- receipts;
- recovery.

It must not dictate the primary document interaction.

---

## 8. Manual editing after AI must remain first-class

After AI generates a draft, the user can freely edit it.

The system must not respond:

> “Proposal stale; regenerate everything.”

to an unrelated manual change.

Use block/field-level conflict tracking.

### No conflict

AI touched:

```text
experience.3
```

User touched:

```text
contact.phone
```

Result:

```text
AI change remains valid.
```

### Same-block conflict

AI touched:

```text
experience.3
```

User subsequently edits the same block.

OfferU should offer:

```text
You edited this section after the AI draft.

[Keep my version]
[Compare AI version]
```

Do not invalidate the entire resume plan.

---

## 9. Before/After belongs on the artifact

Before/After is not a form the user fills.

For every reviewable AI change:

- Before = previous Resume state;
- After = AI-prepared draft;
- Why = Agent rationale;
- Evidence = Career Truth / Role Benchmark references.

OfferU generates these automatically.

The user only evaluates the result.

---

## 10. Revise is natural-language continuation

The Resume Canvas supports:

```text
Accept
Revise
Restore
```

Revise is not Reject.

Example:

```text
User: 这段还是太技术了，保留事实但更偏产品结果。
```

The same task continues.

The Agent receives:

- current block;
- previous proposal;
- user revision feedback;
- target Job;
- Role Benchmark;
- Career evidence.

Only the affected block/change is regenerated.

---

## 11. Design system

OfferU should not become a Canva-style template marketplace.

Start with a small number of coherent design systems.

### Editorial

Kami-inspired direction:

- warm paper;
- restrained ink accent;
- serif-led hierarchy where appropriate;
- generous whitespace;
- print-first;
- minimal ornament.

### Classic

- white paper;
- ATS-first;
- restrained sans/serif;
- high information clarity;
- traditional professional layout.

### Modern

- clean sans;
- more compact;
- suitable for product / engineering / AI roles;
- stronger information density while retaining readability.

Each system exposes controlled tokens:

- page size;
- margins;
- typography scale;
- heading style;
- paragraph spacing;
- section spacing;
- rule/divider style;
- accent;
- bullet spacing;
- photo/logo policy where supported.

Do not expose controls that the selected template cannot actually honor.

---

## 12. Visual quality principles

### Restraint

Resume visual design should never compete with content.

### Print parity

Canvas preview and exported PDF must share the same render model and design tokens.

### Typographic hierarchy

The page needs clearly differentiated:

- identity;
- title;
- section title;
- role/company;
- dates;
- body;
- metadata.

### Density awareness

OfferU may warn:

```text
“第二页只有 3 行内容，是否尝试压缩到 1 页？”
```

or:

```text
“这一页过密，建议增加行距或删减次要 bullet。”
```

These are recommendations, not automatic content deletion.

---

## 13. Motion design

Animation should make state changes understandable, not decorative.

### Good motion

- section reorder uses a short spring transition;
- AI-changed text receives a subtle temporary highlight;
- accepted change settles into normal document styling;
- restored content fades back in;
- Inspector opens from the selected block;
- page reflow animates lightly when spacing changes;
- checkpoint creation briefly confirms “Version saved”.

### Avoid

- constant shimmering;
- long entrance animations;
- animated backgrounds;
- motion that changes document geometry while the user is typing;
- flashy transitions during high-frequency editing.

Respect reduced-motion settings.

---

## 14. AI change visualization

Use three visually distinct but restrained states:

### Added

Temporary inline highlight / margin indicator.

### Removed

Available in diff/review mode, not permanently cluttering normal Canvas.

### Modified

Show concise inline/side marker.

After adoption, markers fade away but remain discoverable through History.

Do not leave the document covered in red/green review UI during normal editing.

---

## 15. Evidence visualization

Evidence should be available without overwhelming the document.

Selecting an AI-changed bullet may show:

```text
Why this changed
Target JD: “负责产品规划及项目落地”

Evidence
Profile → 中国电信 → AIGC 工作流培训

Role Benchmark
Common signal: end-to-end delivery
Target-specific signal: customer-facing product ownership
```

Evidence is inspectable in the right Inspector.

Do not print evidence metadata into the resume itself.

---

## 16. AI changes vs user changes

History/provenance should distinguish:

- imported original;
- AI-generated;
- accepted AI change;
- user direct edit;
- restored version;
- design-only change.

This helps the user understand authorship without turning the UI into an audit console.

---

## 17. Checkpoints and versions

Safety for routine Resume work should come primarily from reversibility.

Recommended checkpoint behavior:

### Automatic checkpoint

Create before:

- a large AI tailoring batch;
- major structural rewrite;
- design-system migration.

Create after:

- user adopts an AI batch;
- material manual edit session;
- major section reorder.

### Named immutable version

Create when:

- exporting for a target Job;
- attaching to an Application;
- explicitly “Save Version”;
- final application material is adopted.

History should be human-readable:

```text
Today · 16:42
Tencent Agent Runtime tailored resume
12 AI changes + 3 manual edits
[Compare] [Restore]

Today · 15:18
Product Manager base resume
[Compare] [Restore]

Sep 29
Imported original resume
```

Avoid presenting raw revision IDs as the primary history language.

---

## 18. Undo

Undo should be available for normal editing actions:

- text edit;
- section reorder;
- hide/show;
- design change;
- AI batch adoption.

Undo is preferred over pre-approval for reversible local edits.

Irreversible external actions remain governed by the Agentic Interaction Policy.

---

## 19. Relationship with Career Truth

Resume text is an application artifact.

It is not automatically canonical Career Truth.

The user can phrase verified evidence differently in a Resume without mutating Profile facts.

If a user manually adds a **new factual claim** that is not grounded in Profile:

- keep the Resume draft editable;
- flag the claim as unverified;
- offer “Add evidence / add to Profile candidate”;
- do not silently promote it to Career Truth.

This preserves freedom to edit while retaining Fact Gate semantics.

---

## 20. Relationship with Role Benchmark

A tailored Resume should visibly inherit the same research asset used later for Interview.

```text
Target Job
+ comparable current roles
+ company/team intelligence
        ↓
Role Benchmark
        ↓
Resume Strategy
Interview Strategy
```

The Inspector can explain:

- which requirements are common/table-stakes;
- which are target-specific;
- which user evidence maps to them;
- which gaps remain.

This makes Resume tailoring a preview of interview preparation rather than a disconnected writing task.

---

## 21. Third-party Skills

OfferU may use external Skills such as document-design or resume-writing methodology Skills.

A third-party Skill can contribute:

- critique;
- structure ideas;
- drafting;
- layout methodology;
- design-system suggestions.

It cannot directly:

- alter Career Truth;
- approve its own content;
- submit applications;
- bypass evidence/provenance;
- silently replace the user's resume.

One possible composition:

```text
OfferU tailor_resume
→ Career Truth
→ Role Benchmark
→ evidence mapping
→ third-party resume/document methodology Skill
→ draft
→ OfferU Fact Gate
→ Resume Canvas
→ direct user editing
→ adopted Resume Version
```

Kami is a useful example of a Skill that may contribute document-design methodology without owning OfferU career state.

---

## 22. Desktop value

This Resume Canvas illustrates the broader role of OfferU Desktop.

External/local Agent:

- reasons;
- researches;
- proposes;
- uses Skills.

OfferU Desktop:

- materializes;
- visualizes;
- edits;
- compares;
- preserves;
- tracks;
- exports.

If an important result exists only inside Agent chat history, the product is incomplete.

---

## 23. Target user journey

### A. Open a Job-specific Resume

User enters Job Workspace and selects:

```text
Prepare tailored resume
```

### B. Agent prepares

Agent uses:

- Profile;
- existing Resume;
- target Job;
- current research;
- Role Benchmark.

If a strategic decision is materially ambiguous, Ask once.

Example:

```text
This role values product ownership more than implementation depth.

A. Product-led (recommended)
B. Balanced
C. Technical/FDE-led
```

### C. Canvas materializes

The new editable draft appears immediately.

Banner:

```text
AI prepared 12 changes for Tencent Agent Runtime
[Review changes] [Undo]
```

### D. User edits directly

The user:

- changes wording;
- moves Open Source lower;
- shortens a bullet;
- adjusts spacing.

No Prompt required.

### E. Contextual revision

User selects one bullet:

```text
“Make this more product-focused.”
```

Only that block updates.

### F. Final adoption

The user sees the finished document.

One meaningful final action:

```text
[Use this version]
```

Then:

- save Resume Version;
- bind to Job;
- export;
- optionally use in Application flow.

---

## 24. Target UI sketch

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ ← Tencent Agent Runtime          Saved ✓       V4     Export PDF      •••   │
├────────────────┬──────────────────────────────────────────┬──────────────────┤
│ DOCUMENT       │                                          │ AI / INSPECTOR   │
│                │        李凯风                            │                  │
│ Summary      ● │        AI Product Manager                │ 12 AI changes    │
│ Experience  ✦ │                                          │                  │
│ Projects     ✦ │        EXPERIENCE                        │ Selected bullet  │
│ Open Source    │                                          │                  │
│ Skills         │        中国电信                           │ Why              │
│                │        主导 AI 产品……                    │ JD evidence      │
│                │        └ AI changed                      │ Profile evidence │
│                │                                          │                  │
│                │        PROJECTS                           │ [Shorten]        │
│                │        OfferU…                            │ [More product]   │
│                │                                          │ [Restore]        │
│                │                                          │                  │
│                │                                          │ Design           │
│                │                                          │ History          │
├────────────────┴──────────────────────────────────────────┴──────────────────┤
│ AI changed 12 items                         [Review changes] [Undo AI batch] │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 25. What should disappear from the primary UX

Do not make the main Resume workflow revolve around:

- a wall of Proposal cards;
- one textarea per proposed change;
- raw change IDs;
- Proposal state names;
- “fill in Before/After”;
- per-database-operation approval;
- global stale warnings for unrelated edits;
- separate “content form” and “real resume” mental models.

These may remain as diagnostics/audit internals where needed.

---

## 26. Current implementation reuse

This redesign should preserve and reuse existing foundations wherever possible.

Likely reusable:

- Resume model and section schema;
- Resume Workspace API;
- direct manual update;
- workspace revision;
- autosave;
- undo foundation;
- Resume Version model;
- existing React preview/templates;
- design tokens;
- PDF export;
- AI optimization Proposal data;
- Before/After diff generation;
- Fact Gate;
- evidence references;
- target Job binding.

The goal is **not** to throw away the backend and rebuild a document product from zero.

The primary work is:

- editor surface;
- inline AI-change materialization;
- conflict granularity;
- contextual Inspector;
- checkpoint/history UX;
- visual system.

---

## 27. Implementation slices

Do not implement everything in one giant PR.

### Slice 1 — Canvas shell

Outcome:

- center document becomes primary editable surface;
- outline navigation;
- Inspector shell;
- existing manual edits and preview preserved.

Non-goal:
- no new AI semantics yet.

### Slice 2 — Inline AI changes

Outcome:

- Proposal changes appear on Canvas;
- Accept / Revise / Restore;
- batch Undo;
- Proposal textarea is no longer the primary editor.

### Slice 3 — Conflict/rebase granularity

Outcome:

- unrelated manual edits no longer stale the whole AI batch;
- block-level conflict UX.

### Slice 4 — Design system

Outcome:

- Editorial / Classic / Modern;
- print-parity tokens;
- contextual visual controls;
- refined typography and whitespace.

### Slice 5 — Checkpoints / History

Outcome:

- meaningful automatic checkpoints;
- human-readable timeline;
- Compare / Restore.

### Slice 6 — Evidence-aware Inspector

Outcome:

- Why / JD / Profile evidence / Role Benchmark available from selected change.

---

## 28. Owner-dogfood acceptance

A real user must be able to:

1. open a Job-specific Resume;
2. see a polished document immediately;
3. click any editable text and change it;
4. reorder sections directly;
5. ask AI to improve one selected block;
6. see the change in place;
7. understand why it changed;
8. accept/revise/restore without leaving the document;
9. manually edit the AI result afterward;
10. undo the AI batch;
11. restore a previous checkpoint;
12. change visual style without breaking print output;
13. export the exact visible version to PDF.

Acceptance metrics:

- no Proposal textarea required to finish a Resume;
- user can finish a Resume with AI turned off after initial draft;
- user can finish a Resume without reading raw Proposal/Operation terminology;
- unrelated manual edit does not invalidate the entire AI batch;
- one normal tailoring workflow needs at most one final adoption action after strategy decisions;
- visible document and exported PDF have the same layout model;
- all AI factual claims remain evidence-checkable;
- current Job/Role Benchmark rationale is reachable from changed content;
- undo/restore works without database/manual recovery.

---

## 29. Design phrase

The Resume surface should feel like:

> **Kami's restraint + Lovable's direct editing + Cursor's contextual diff + Replit's checkpoint safety, grounded by OfferU's Career Truth and evidence model.**

The product should make AI fast without making the human powerless.

> **AI prepares the document. The user owns the document.**
