---
name: offeru-shared-job-research-method
description: Shared source-grounded research method for OfferU company_research and role_intelligence.
method_version: 1.0.0
---

# Shared company and role research method

This method serves the live OfferU Skills `company_research` and `role_intelligence`. First check the active Skill ID. Follow only that Skill's Operations and the matching branch below; shared methodology does not widen either tool allowlist or create another research state store.

## Inputs

- For both branches: the exact canonical Job from `get_job`, including its company, title, location, saved JD, URL, and retrieval/source details; and the requested question or scope.
- For `role_intelligence`: the current benchmark, comparability inputs, Profile evidence and delta signals when exposed by its live Operations.
- For `company_research`: any existing company/role dossier and research run, plus public web results or a user-authorized read-only research session actually exposed by the host.

If the Job has a blank or placeholder company/title/URL, do not infer identity from a neighboring listing. Ask for the company name or exact Job link if needed for this task. Read each selected Operation's current schema before use.

## Method

1. State the research question and scope. Separate facts already present in the saved Job from claims that need fresh external evidence. Refresh claims about current products, teams, hiring, process, compensation, or market conditions before advising; store retrieval date and exact URL with each source.
2. Search public HTTP(S) sources. Prefer official company, careers, role, product, and government pages for hard claims; use independent public sources for softer team/process signals when available. Do not log in, bypass a CAPTCHA or access control, scrape private data, or include Profile/resume PII in public search queries. Use a local browser only through an explicitly authorized, live OfferU read-only research Operation.
3. Register each source once with a stable run-local `source_ref` (`S1`, `S2`, ...), exact URL, title, publisher, source class, published date when known, and a short evidence excerpt. Every concrete finding cites only source refs present in that same result. Keep direct evidence, corroboration, single-source signals, and inference distinct.
4. For `company_research`, build the company and target-role dossiers together: business/product/org and hiring-process findings go to the appropriate dossier scope. Preserve disagreement and gaps; a single community post is one signal, not a company-wide fact. A `resume_pattern` must be anonymous and contain only `pattern`, `applicable_when`, and `constraints`; never copy a person's identity, employer, results, credentials, or full resume.
5. For `role_intelligence`, define comparability before describing a cohort: role family, specialization, seniority, and region must match the target well enough to compare. Retain each comparator's source and date. Report only counts, sample size, date range, confidence, and Delta actually returned by OfferU's deterministic benchmark Operations. Do not calculate market percentages, invent frequency, equate missing evidence with zero, or call an adjacent role equivalent.
6. Use one focused Ask only when scope or a user preference changes which cohort/company evidence matters. The answer narrows research; it is not approval to write or adopt findings. If research source, provider, login, or retrieval is unavailable, stop that source path and record what is missing rather than substituting a scripted result.
7. Persist or review through the current Skill's Operations only. An Agent's findings are candidate research until OfferU returns the stored run/dossier/benchmark and its current review state. Never write a second dossier or claim review acceptance from an Ask response.

## Result and visibility

For raw company/role research, use the live operation's schema. Its existing research result is shaped as `sources[]` (`source_ref`, `dossier_scope`, `url`, `title`, `publisher`, `source_class`, `published_at`, `excerpt`), `findings[]` (`dossier_scope`, `finding_type`, `statement`, constrained `details`, `source_refs`), and `gaps[]`. Keep each claim traceable to exact refs. For role intelligence, return the actual benchmark and Delta readback with target, comparables, sample/date/confidence fields available from the Operation, source refs, and gaps; do not fabricate missing fields.

The visible result belongs to the existing Job Workspace research dossier or Role Intelligence surface and names its true status (`completed`, `candidate`, `needs review`, `partial`, `blocked`, or `failed`) from the readback. If a source is inaccessible or too weak, say so in `gaps` and keep the relevant conclusion partial. Third-party research Skills can add method, synthesis, or critique, but their output remains candidate material until the same OfferU review path accepts it.

