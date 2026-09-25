"""Frozen Python entrypoint used by the Tauri desktop release sidecar."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys

from app.runtime_paths import OFFERU_BACKEND_PORT


def configure_runtime() -> Path:
    configured = str(os.environ.get("OFFERU_DATA_DIR") or "").strip()
    data_dir = (
        Path(configured).expanduser().resolve()
        if configured
        else Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "OfferU"
    )
    data_dir.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("OFFERU_DATA_DIR", str(data_dir))
    os.environ.setdefault(
        "DATABASE_URL",
        f"sqlite+aiosqlite:///{(data_dir / 'djm.db').as_posix()}",
    )
    os.environ.setdefault("OFFERU_BUILD_MODE", "release")
    os.environ.setdefault("OFFERU_RUNTIME_MODE", "desktop-sidecar")
    os.environ["OFFERU_PORT"] = str(OFFERU_BACKEND_PORT)
    return data_dir


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--data-dir", type=Path)
    parser.add_argument("command", nargs="?", choices=("serve", "cli"), default="serve")
    parser.add_argument("command_args", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)

    if args.data_dir is not None:
        os.environ["OFFERU_DATA_DIR"] = str(args.data_dir.expanduser().resolve())
    configure_runtime()

    if args.command == "cli":
        from app.cli import main as cli_main

        return cli_main(args.command_args)
    if args.command_args:
        parser.error("serve mode does not accept additional arguments")

    import uvicorn
    from app.main import app

    uvicorn.run(
        app,
        host="127.0.0.1",
        port=OFFERU_BACKEND_PORT,
        reload=False,
        access_log=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
