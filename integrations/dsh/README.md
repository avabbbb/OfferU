# OfferU DeepSeek Harness integration (Slice 2)

Status: Slice-2 host/client implementation; requires exact `@deepseek-ai/dsh@0.1.0-rc.8` install and runtime verification.

## Layout

```text
packages/
  bundle/     @offeru/dsh-bundle  — cordis.patch.yml + presets/offeru (agent preset)
  plugin/     @offeru/dsh-plugin  — host half (bridge client) + browser half (slots UI)
```

## Mechanism (probed against rc8 tarballs)

- Profile = ordered bundle stack in `$DSH_HOME/profiles/<name>/dsh.profile`,
  each bundle contributes a `cordis.patch.yml`; profile `cordis.patch.yml`
  applies last, then `--patch` overlays.
- Host rows are Cordis composition rows (`- id/name/config`); browser surface
  is a `dsh.client` roster row (`@deepseek-ai/dsh-client-modules`) that scans
  installed packages' `package.json.dsh.client` manifests and serves
  `/plugins/<id>/client.js`; the browser half registers via
  `window.__ModuleLoader__.load({id, factory})`.
- Client plugins declare `{ inject: [...], apply(ctx) }`, use
  `ctx.slots.inject('<slot>', () => ctx.slots.register(...))`, and call the host
  half through `host.call(method, args)` ↔ `harness.handle(method, handler)`.
- Agent preset = one directory under `$DSH_HOME/.agent-presets/<id>/` with
  `preset.yml` + `agent.cordis.yml` (rows: persona, tools...). The `offeru`
  preset disables native shell/fs/web/subagent tools for the read-only tracer.

## Bridge contract (Slice 1, verified live)

`offeru bridge --stdio` (backend/app/services/agent_bridge): envelope
`{v:1,type,id,payload}`; first message must be `hello` with full capabilities;
then pairing.request with a one-shot bootstrap token bound to an active Run,
run.attach (single-writer lease), read-only operation.list/schema/invoke
(get_pre_application_state / get_job / list_jobs / get_profile), events.

## Slice-2 projection

The host half exposes the Bridge through `harness.handle` for the browser
client and registers only three model-facing tools through `ctx.tools`:

- `offeru_context` — versioned minimal Run context;
- `offeru_operations` — the current Run's granted read-only Operation schemas;
- `offeru_run` — one allowlisted read-only Operation invocation.

The browser half uses `host.call` for status, context, operations and event
mirroring. It never calls the OfferU HTTP API directly. Proposal creation,
confirmation and exactly-once commit remain the next slice and are not exposed
by this tracer.

Bootstrap tokens are issued by `create_bridge_pairing(run_id=...)` — Slice 2
exposes it on the workbench API so the DSH plugin can fetch a token without DB
access.
