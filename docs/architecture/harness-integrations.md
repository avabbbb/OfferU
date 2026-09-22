# Agent Host Integrations

Status: **CURRENT ARCHITECTURE**  
Updated: 2026-09-23

This document replaces the old DSH/Codex-first integration plan as the default architecture.

The previous detailed DSH-era design is preserved at [historical harness integration design](../archive/architecture/harness-integrations-dsh-era-2026-09.md).

## Goal

Connect OfferU to local Agents the user already has without forcing duplicate model/API setup.

Current product principle: **Connect → Auto Detect → Verify → Ready**.

## Canonical host declaration

Use the repository's Agent Host Registry and runtime definitions as the live source of truth. Documentation must not hard-code a host as fully supported merely because an adapter exists.

A host record should distinguish executable detection, Skill capability, authentication/readiness, runtime/executor capability, tested behavior and known limitations.

## Preferred integration order

For a host that supports portable Agent Skills:

1. project/install OfferU Skill;
2. preserve the host's native account/model;
3. let the host discover OfferU and other Career Skills;
4. access OfferU business context through the Agent Tool Surface / CLI bridge;
5. keep protected mutations behind OfferU Proposal/HITL.

For a host with a richer native runtime protocol, an adapter may additionally support session lifecycle, streaming, cancellation and resume.

Those lifecycle capabilities are useful, but they do not redefine OfferU's UI as a host plugin.

## Auth ownership

OfferU should not edit another Agent's auth files or silently redirect its provider.

Report concrete readiness states such as READY, BLOCKED_AUTH, BLOCKED_EXTERNAL_AUTH, INCOMPATIBLE, NOT_INSTALLED or ERROR. Provider failure is not Agent task failure.

## Runtime adapters

Runtime adapters must be thin. They may map probe/version, start/resume/steer, stream, interrupt/cancel, terminal result and execution metadata.

They may not contain career business logic or parallel truth.

## Host parity

Treat WorkBuddy, Codex, Claude Code, OpenCode, OMP, Pi, Gemini and future hosts as capability-discovered peers.

Do not encode permanent first-class vs second-class product truth in prose. Let current code/tests report what is actually ready.

## Historical DSH integration

DSH-specific bundle/profile/client-slot research remains useful as an integration experiment but is not the current product shell design. Consult the archived document only when working specifically on that integration.

## Verification

Before claiming a host works with OfferU, verify connection/readiness, OfferU Skill discovery, at least one grounded read task, at least one safe Proposal/HITL task where applicable, recovery/error classification, and relevant live Eval cases.

Installed is not equivalent to verified.