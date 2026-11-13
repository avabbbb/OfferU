# OfferU Visual System · v1（已归档 2026-11-13，由 ../visual-system.md v2 取代）

> Status: **governance baseline, not a visual redesign**. This file governs all *new or migrated* application UI. Existing screens retain their current appearance until separate, screenshot-reviewed migration PRs.
>
> Product: local-first career workspace. References: **Notion** for information architecture; **Superlist** for quiet task UI; **Apple HIG** for type, motion and functional layers; **Zapier** for a mature warm/Orange/Purple brand palette. This is inspiration, **not a claim of design affiliation**.

## 中文速览（新 Agent 首先读这一节）

- **定位**：Notion 的信息架构 + Apple 的克制交互与空间层级 + Superlist 的任务工作台 + Zapier 已验证的暖纸橙紫配色；整体仍以中性色为主。
- **五个品牌角色**：暖纸 `#FFF3E6`、白色内容面 `#FFFFFF`、墨色 `#201515`、橙色操作 `#FF4F00`、深紫 Agent `#2B2358`（淡紫 `#C1B7FF` 是衍生色）。分隔线、弱文字、错误/成功/警告和岗位状态色是语义扩展，不是新增品牌主色。
- **新组件**：必须复用公共组件并引用 `frontend/src/styles/design-tokens.css`。禁止新写 Hex/RGB、随意 Tailwind 色板、硬编码字号、随机圆角/阴影/z-index。老页面暂不改色，按页迁移。
- **交互**：主任务清晰、低频内容渐进式展开；每个控制要有键盘、加载、失败/恢复、关闭与焦点规则。
- **布局**：优先排查 flex/grid `min-width: 0`、文本换行与截断、侧栏宽度、弹层裁切、独立滚动容器；不要用 `overflow:hidden` 掩盖错位。
- **验收**：UI PR 要跑 `npm run design:audit`、单测、typecheck、build，并用稳定数据截图检查 1440 / 1024 / 768 / 390px、长中英混排与错误状态。本 PR 只建立规范和静态门禁，**不宣称已完成页面重构或浏览器 E2E**。

## 0. Source of truth / precedence

1. Product behavior: `docs/PRD.md`; architecture: `docs/DESIGN.md`.
2. Visual, interaction and responsive constraints: **this file**.
3. Semantic values: `frontend/src/styles/design-tokens.css` (the canonical source for newly built UI).
4. Existing `globals.css`, HeroUI and component-local styles are **legacy implementation**, not a license to invent new values. Keep backward compatibility until each page is migrated.
5. For new components: prefer existing shared components / HeroUI primitives + semantic tokens. Do not swap UI frameworks or refactor business logic for styling.

If these documents disagree on *new UI styling*, follow this file and reconcile the stale reference in the same PR. Resume **output templates** are user documents; their color/font choices stay independent of the app shell.

## 1. Identity: Editorial Workspace

**Notion × Apple × quiet orange/purple brand.** Flat, readable, dense where necessary, with restrained depth. No generic AI-dashboard aesthetics, floating KPI cards, neon gradients, decorative colored panels, excessive pills or repeated nested borders.

- Five **base color roles**, not “exactly five Hex values in the entire app”:
  - **Paper** `#FFF3E6` — warm canvas / very limited large-area warmth.
  - **Surface** `#FFFFFF` — editing surfaces and tables.
  - **Ink** `#201515` — hierarchy through ink opacity/semantic text variants.
  - **Action orange** `#FF4F00` — brand/one clear primary action, *not* a universal fill.
  - **Agent purple** `#2B2358` — Agent-origin / smart-work identity; pale `#C1B7FF` as its quiet derivative.
- Neutral borders, muted ink, hover fills, feedback states and data-driven job status colors are **semantic extensions** and **do not count as additional brand roles**.
- Avoid side-by-side competing saturated orange and purple buttons. Most screens should appear neutral at a glance.
- Orange primary button: dark ink text, **not small white text by default**. Validate contrast in actual context, including hover/focus/dark theme. Never rely on color alone for status.
- Purple indicates an AI/Agent action's *provenance*; it must not imply confidence or success. Warnings / success / errors use specific feedback roles.
- Data colors for pipeline status are allowed **only in status-specific primitives**, charts and timelines, with text/icon alternatives. Tag coloring must stay consistent across surfaces.

This is an adapted use of Zapier's published brand palette. Do not copy Zapier trademarks or recreate their marketing layout.

## 2. Typography, spacing and geometry

Use the named design tokens rather than one-off sizes. For a new UI component, choose one of these text roles:

| Role | Token | Typical use |
| --- | --- | --- |
| Meta | `--ou-type-xs` | auxiliary date, shortcut |
| Detail | `--ou-type-sm` | quiet labels, metadata |
| Body | `--ou-type-body` | tables, forms, Agent reply |
| Section | `--ou-type-section` | section / dialog headings |
| Page | `--ou-type-page` | major page title |

- Body typically 13–15px at default zoom; do **not** hide critical information in very faint 11px text. Keep a readable line height (body ~1.5).
- Use system UI fonts with Chinese fallback; monospace only for values/code; no random serif headline accents.
- Space from `--ou-space-1/2/3/4/6/8`, radii from `--ou-radius-1/2/3`; shadows from `--ou-shadow-1/2/3`. Shadow communicates elevation only, not visual grouping for every card.
- Borders and whitespace establish most hierarchy. A surface should rarely need both a heavy border and a large shadow.
- z-index via `--ou-layer-*` role tokens; do not use increasing magic z-index numbers to fix occlusion.

## 3. Progressive disclosure is task-driven

Prioritize **current state → one next action → secondary exploration**.

- Each page has a clear primary job and one visually dominant primary action. Several secondary actions are fine where an expert workflow needs them; group by purpose.
- Show the minimum information required to make the current decision. Put full JD, advanced evaluation settings, history, internal Agent trace and bulk operations behind tabs, disclosures, menus or an inspector **without obscuring their discoverability**.
- Do not blindly apply numerical rules (e.g. “more than seven fields always collapse”). Split by task, user intent and dependencies; do not hide blocking errors, pending approvals or safety-relevant details.
- Empty/loading/error/success/partial-result states are designed, not omitted. Empty state: actionable headline + one useful next step; optional illustration in a separate presentation layer.
- Hover-only affordances also appear on `:focus-visible` or can be reached through keyboard/touch equivalents. Never hide the sole critical action on hover.
- App-level Agent controls should stay quiet until the user invokes them; progress may be summarized in one line and expanded for trace/debug.

## 4. Interaction contract for every new control

Record the applicable states: **idle, hover, focus-visible, disabled, loading, expanded, error, success**. Also define:

- Click and keyboard behavior (Tab, Enter/Space, Escape, arrows when relevant), touch target, focus return after dismiss.
- Async action: pending indicator, cancellation semantics, retry/error recovery and **draft preserved on save failure**.
- Overlays: trigger, anchor, collision handling, focus trap for modal dialogs, backdrop click, stacking layer, scroll lock and dismissal.
- Form: explicit labels, IME composition-safe Enter handling, validation and in-context error text.
- Mutations: undo where supported; irreversible outbound actions require the existing product confirmation policy.
- Motion: purposeful, brief, interruptible; respect `prefers-reduced-motion`.

The minimum acceptance test is completing the primary task, one failure/retry, keyboard-only controls and reopening the result.

## 5. Layout robustness (must pass before visual polish)

1. Main shell uses `min-width: 0` / `min-height: 0` at flex/grid shrink boundaries, not hard widths.
2. For grid tracks use `minmax(0, 1fr)`; for flexible children use `min-w-0` / `min-h-0`.
3. Long company names, URLs, CJK/Latin mixes: deliberately choose `overflow-wrap: anywhere`, wrapping or truncation **with an accessible full-text route**.
4. Avoid using `overflow-x: hidden` to conceal a broken layout or unreachable actions.
5. Distinguish document scroll from nested table/timeline scroll; local horizontal scrolling is allowed for genuine two-dimensional data, not for the entire app.
6. Popovers/drawers must fit viewport and reposition or scroll. Avoid tooltip or dropdown clipping by parent `overflow: hidden`.
7. Agent rail min/max and persisted width must leave a usable main pane; test with rail open and closed.
8. Do not use fixed pixel offsets for layout repairs unless the value is a documented geometry token and verified at other widths.
9. Validate 200% zoom, long localized strings, Chinese IME, Emoji, no-data, error and asynchronous updates.
10. Ensure focus indicators and high-priority operations are not covered by sticky bars, sidebars or virtual keyboard.

Use the *existing* shell & components where possible; fix root cause, not a local `z-[9999]` or another `overflow-hidden`.

## 6. Liquid Glass & pop illustration

Apple positions Liquid Glass as a functional layer for **navigation and controls**, not general content. In the Web UI use a restrained translucent **floating** command palette, popover or toolbar only when legibility is preserved. Solid backgrounds should remain the default for content, tables, resume editor and data panels.

- Use `--ou-glass-bg`, `--ou-glass-blur`, a single subtle border and appropriate elevation.
- Under `prefers-reduced-transparency`, or where blur unsupported, use an opaque neutral background. Do not make key text readable only because a backdrop is present.
- Pop / hand-drawn touches: onboarding, thoughtful empty states, offer celebration. Never scatter illustrations across tables, toolbars, filters or Agent conversation.

## 7. Accessibility & localization

Target **WCAG 2.2 AA**. Ordinary text contrast at least 4.5:1; large text and non-text indicators follow their relevant criteria. Test actual rendered combinations rather than counting Hex colors. Support reduced motion and keyboard focus. For data tables and timelines, apply reflow exceptions only where two-dimensional layout is necessary.

All display strings must be valid UTF-8 and support Chinese, English, long names, emoji and user-entered content. Distinguish *encoding bugs* from *font fallback* and *layout wrapping* bugs.

## 8. Quality gates for any UI PR

1. **Before implementation:** identify page task, visible information hierarchy, existing reusable components and intended Token roles.
2. **Static checks:** `npm run design:audit` checks the added/modified source lines against the semantic-token policy; it also reports historic debt without auto-failing it. `npm run design:audit:test` tests the detector itself.
3. **Code tests:** `npm run typecheck`, `npm test`, `npm run build`.
4. **Visual evidence (on page migration PRs):** baseline and after screenshots at **1440 / 1024 / 768 / 390 CSS px**, with sidebar and Agent rail states where applicable. Test keyboard focus, popovers, long JD, no data and an error/retry.
5. **Regression:** introduce Playwright screenshot assertions once the page has stable fixtures and a reproducible CI browser environment. Do not commit unstable screenshots from live/private job data.
6. **Report:** include per-file audit results, before/after images, which states were exercised and any unverified behavior. A reduced count alone does not prove better UX.

The repository's old browser-smoke job is currently paused. This governance PR **does not pretend** to establish the end-to-end screenshot baselines; later migrations must restore a stable fixture-driven browser validation path.

## 9. Migration order

**PR 1** governance (this doc, importable tokens, agent instructions, diff-aware audit / CI; no page restyle). **PR 2** common shell (sidebar, main, ContextRail, overlays). Then **Today → Job → Pipeline → Resume → Settings** in separate, reviewable PRs. Do not rewrite resume PDF templates along with the app shell.

Do not relax checks or silently update a baseline to make CI green. Review exceptions must be explicit and narrow.

## References

- [Apple HIG · Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- [Playwright visual comparisons](https://playwright.dev/docs/test-snapshots)
- [Zapier press & brand links](https://zapier.com/press)
