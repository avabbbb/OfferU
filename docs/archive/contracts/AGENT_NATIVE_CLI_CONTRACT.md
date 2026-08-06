# Agent-Native CLI Contract

This contract is the reusable rule set for converting any product module into an agent-operable CLI/action system. It is intentionally product-agnostic: the same rules apply to CRM, CMS, analytics, email, recruiting, finance, DevOps, video, knowledge bases, and internal tools.

## 1. Source Of Truth

The operation registry is the source of truth.

Every product capability must be defined once as an operation, then exposed through adapters:

- UI button or form
- REST endpoint
- CLI command
- MCP tool
- Web Agent tool
- Scheduler or automation

Adapters must not reimplement business logic. They parse input, call the operation, return the operation envelope, and map errors to their transport.

## 2. Operation Contract

Every operation must declare:

- `name`: stable operation identifier
- `description`: human and agent readable purpose
- `parameters`: input contract
- `group`: product domain group
- `side_effects`: risk profile
- `supports_dry_run`: whether dry-run is meaningful
- `requires_confirmation`: whether execution must be confirmed after proposal
- `permissions`: required capabilities or roles
- `examples`: known-good invocation examples
- `operation_version`: compatibility marker
- `output_contract`: expected result envelope

Current minimum output envelope:

```json
{
  "ok": true,
  "operation": "entity.action",
  "operation_version": "2026-05-23",
  "inputs": {},
  "outputs": {},
  "warnings": [],
  "errors": [],
  "side_effects": ["read"],
  "elapsed_ms": 12.3
}
```

## 3. Side Effects

Use explicit side-effect labels. Start with these:

- `read`: safe public or low-risk read
- `private_read`: reads private or sensitive user data
- `write`: changes durable state
- `delete`: removes durable state
- `llm`: calls a model or creates model cost
- `external`: calls external systems
- `send_message`: sends email, chat, SMS, notifications, or outreach
- `publish`: publishes externally visible content
- `payment`: moves money or changes billing
- `irreversible`: cannot be fully undone

Read operations must not write. If an operation writes cache, last-seen state, sync marks, or analytics, it is not a pure read and must declare the relevant side effect.

## 4. Dry-Run And Confirmation

Any operation with `write`, `delete`, `llm`, `external`, `send_message`, `publish`, `payment`, or `irreversible` must support dry-run or explicitly explain why it cannot.

Dry-run must do more than skip execution. It should validate inputs, estimate impact, expose risks, and return a proposal when execution needs confirmation.

Recommended flow:

```text
agent calls operation with dry_run=true
system validates and returns proposal_id
human or trusted policy confirms proposal_id
system executes the exact stored proposal
audit log records both dry-run and execution
```

Confirmation must bind to the original proposal. Do not let a client change arguments while confirming.

## 5. CLI Rules

The CLI must be reliable for agents and humans.

- All normal outputs are JSON by default or available with `--json`.
- All error paths return JSON, including missing command, unknown command, missing arguments, unknown flags, and invalid JSON.
- Every command has stable exit codes.
- Windows and PowerShell friendly argument forms must exist.
- Complex values can be passed through repeatable `--arg key=value`, JSON `--args`, or `--input file.json`.
- No command should require interactive prompts in machine mode.
- Human formatting is optional. Machine formatting is mandatory.

Recommended discovery commands:

```bash
app doctor --pretty
app ops --pretty
app schema operation_name --pretty
app run operation_name --arg key=value --dry-run --pretty
```

## 6. Adapter Rules

UI, REST, MCP, and CLI must be thin adapters over operations.

REST route pattern:

```text
request -> validate transport shape -> execute_operation(surface="ui" or "api") -> HTTP response
```

CLI pattern:

```text
argv -> args object -> execute_operation(surface="cli") -> JSON stdout + exit code
```

MCP pattern:

```text
tool args -> execute_operation(surface="mcp", dry_run=true by default) -> envelope
```

Web Agent pattern:

```text
model tool intent -> execute_operation(surface="web_agent", dry_run for side effects) -> proposal -> confirm endpoint
```

## 7. Audit Rules

Every operation execution should write an audit record unless explicitly disabled for tests or bootstrap.

Audit records should include:

- operation name and version
- surface: `ui`, `cli`, `api`, `mcp`, `web_agent`, `web_agent_confirm`, `scheduler`
- actor if available
- inputs
- outputs summary
- warnings
- errors
- side effects
- dry-run flag
- confirmation/proposal id when present
- elapsed milliseconds
- timestamp

Audit logs are product data, not debug logs. They must be queryable by humans and agents.

## 8. Shared Context Rules

Agent-native apps need shared state between UI and agent.

The product should expose operations for:

- current route
- current entity type and id
- selected items
- active filters
- workspace scope
- recent operations
- page-specific context

UI navigation should write context to the backend. Agents should read context instead of guessing what the user is looking at.

## 9. Schema Rules

String descriptions are only a starting point. Mature operations should evolve toward real JSON Schema or typed Pydantic/Zod models.

Every schema should define:

- required fields
- types
- enum values
- minimums and maximums
- default values
- examples
- output shape
- side effects
- permission requirements

Do not maintain separate schemas for CLI, API, MCP, UI, and docs. Generate or import from one source when practical.

## 10. Testing Rules

Test the system as an agent would use it.

Required tests:

- operation registry exposes expected operations
- operation schema includes risk and output metadata
- CLI happy paths return JSON
- CLI syntax errors return JSON
- CLI complex args parse on Windows-friendly forms
- dry-run skips mutation
- Web Agent side-effect calls return proposals, not writes
- confirmation rejects unknown proposals
- shared context round-trips through operations
- read operations work from the real CLI
- frontend build still passes after adapter changes

## 11. Migration Order

For existing systems, migrate in this order:

1. Inventory UI buttons, API endpoints, background jobs, and scripts.
2. Define core entities.
3. Extract read operations first.
4. Add operation registry and discovery.
5. Add CLI `doctor`, `ops`, `schema`, and `run`.
6. Add dry-run for write operations.
7. Add audit logging.
8. Convert high-value REST routes into operation adapters.
9. Add MCP generic `run_operation`.
10. Add Web Agent proposal and confirmation flow.
11. Add shared UI context reporting.
12. Convert remaining UI/API workflows module by module.
13. Add strong schemas and permission policy.
14. Add frontend audit/proposal review UI.

## 12. Anti-Patterns

Avoid these:

- CLI as a thin curl wrapper only
- one giant `auto_run_everything` command
- natural language stdout in machine mode
- write operations without dry-run
- UI and CLI implementing different business logic
- MCP tools bypassing the operation registry
- Agent directly writing SQL or files
- secrets printed in config output
- interactive prompts blocking agents
- batch operations that hide per-item failures
- high-risk actions behind `--yes` only

## 13. Completion Checklist

A module is agent-native CLI ready when all are true:

- UI actions and CLI actions call the same operation.
- Operation is discoverable through `ops`.
- Operation schema exposes parameters, side effects, dry-run support, confirmation requirement, examples, and output contract.
- CLI and API return structured errors.
- Side-effect operations support dry-run.
- High-risk operations require proposal confirmation.
- Execution is audited.
- Agent can read relevant current UI context.
- Tests cover CLI, operation, and adapter behavior.
