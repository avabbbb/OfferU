"""OfferU Agent Bridge machine surface.

`offeru bridge probe --json` reports protocol version, backend/database
reachability, and run constraints without touching business Operations.
`offeru bridge schema --json` emits the full JSON Schema bundle for
conformance tests. `offeru bridge --stdio` runs the persistent JSONL Bridge
session (Slice 1). One-shot commands print exactly one JSON object; the
stdio session streams responses and server events. Diagnostics go to stderr
only and never echo request payloads.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import Any

from app.services.agent_bridge import (
    BRIDGE_VERSION,
    PROTOCOL_VERSION,
    RUN_FORBIDDEN_MESSAGE_TYPES,
    RUN_REQUIRED_MESSAGE_TYPES,
    bridge_schema_bundle,
)


def _probe() -> dict[str, Any]:
    from app.database import engine

    database_reachable = False
    try:
        database_reachable = asyncio.run(_check_database(engine))
    except Exception as exc:  # noqa: BLE001 - probe must report, never crash
        print(f"bridge probe: database check failed: {type(exc).__name__}", file=sys.stderr)
    return {
        "ok": True,
        "protocolVersion": PROTOCOL_VERSION,
        "bridgeVersion": BRIDGE_VERSION,
        "databaseReachable": database_reachable,
        "runConstraints": {
            "runRequiredMessageTypes": list(RUN_REQUIRED_MESSAGE_TYPES),
            "runForbiddenMessageTypes": list(RUN_FORBIDDEN_MESSAGE_TYPES),
        },
    }


async def _check_database(engine: Any) -> bool:
    from sqlalchemy import text

    async with engine.connect() as connection:
        await connection.execute(text("SELECT 1"))
    return True


def _schema() -> dict[str, Any]:
    bundle = bridge_schema_bundle()
    return {"ok": True, **bundle}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="offeru bridge", add_help=True)
    sub = parser.add_subparsers(dest="bridge_command", required=True)

    probe = sub.add_parser("probe", help="Read-only protocol/backend reachability check.")
    probe.add_argument("--json", action="store_true", help="Emit JSON (default output).")

    schema = sub.add_parser("schema", help="Dump the full Bridge JSON Schema bundle.")
    schema.add_argument("--json", action="store_true", help="Emit JSON (default output).")

    stdio = sub.add_parser("stdio", help="Run the persistent JSONL Bridge session.")
    stdio.add_argument("--json", action="store_true", help="Emit JSON (default output).")

    args = parser.parse_args(argv)
    if args.bridge_command == "stdio":
        from app.services.agent_bridge.server import serve_stdio

        asyncio.run(serve_stdio())
        return 0
    payload = _probe() if args.bridge_command == "probe" else _schema()
    json.dump(payload, sys.stdout, ensure_ascii=False, allow_nan=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
