"""OfferU-owned local career artifacts included in a fresh reset and backup."""

RESET_DATA_DIRECTORIES = (
    "agent_integration_probe_workspace",
    "application_events",
    "artifacts",
    "batch_evaluations",
    "batch_workers",
    "executor-smoke",
    "executor-smoke-pi",
    "exports",
    "follow_ups",
    "job_research_workers",
    "pi_sessions",
    "pre_application_decisions",
    "python_agent_sessions",
    "resume_drafts",
    "role_benchmark_workers",
    "run_workspaces",
    "work-source-runs",
)

RESET_DATA_FILES = (
    "harness_agent_conversations.json",
    "harness_agent_memory.json",
    "harness_agent_runs.json",
)

RESET_DATA_FILE_DEFAULTS = {
    "harness_agent_conversations.json": {
        "schema_version": "offeru.harness_conversations.v1",
        "conversations": [],
    },
    "harness_agent_runs.json": {
        "schema_version": "offeru.agent_runs.v2",
        "runs": [],
    },
    "harness_agent_memory.json": {
        "schema_version": "offeru.agent_memory.v1",
        "user_stage": "unknown",
        "confidence": 0.0,
        "facts": [],
        "preferences": [],
        "goals": [],
        "risks": [],
        "events": [],
    },
}
