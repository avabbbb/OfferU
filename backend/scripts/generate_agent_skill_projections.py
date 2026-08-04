from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = BACKEND_DIR.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.services.agent_skill_projections import projection_drift, write_skill_projections


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate thin external-Agent projections from OfferU's Skill Registry.")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true", help="Write all generated projection files.")
    mode.add_argument("--check", action="store_true", help="Fail when a generated projection is missing or stale.")
    args = parser.parse_args()

    if args.write:
        print(json.dumps({"ok": True, "written": write_skill_projections(PROJECT_ROOT)}, ensure_ascii=False))
        return 0
    drift = projection_drift(PROJECT_ROOT)
    print(json.dumps({"ok": not drift, "drift": drift}, ensure_ascii=False))
    return 1 if drift else 0


if __name__ == "__main__":
    raise SystemExit(main())
