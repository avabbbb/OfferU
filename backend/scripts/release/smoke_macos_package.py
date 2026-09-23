"""Check a copied macOS app's bundled runtime without opening any UI."""

import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
from urllib.request import HTTPRedirectHandler, ProxyHandler, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def smoke(app: Path, *, version: str) -> None:
    opener = build_opener(ProxyHandler({}), NoRedirect())
    try:
        connection = socket.create_connection(("127.0.0.1", 8766), timeout=1)
    except OSError:
        pass
    else:
        connection.close()
        raise RuntimeError("Port 8766 already has a service; refusing to reuse it as package evidence.")
    # CI runner temp is used only on macOS; local Windows acceptance uses H:/tmp/offeru.
    with tempfile.TemporaryDirectory(prefix="offeru-package-", dir=os.environ["RUNNER_TEMP"]) as temporary:
        root = Path(temporary)
        installed = root / "OfferU.app"
        shutil.copytree(app, installed, symlinks=True)
        binary_dir = installed / "Contents/MacOS"
        data = root / "data"
        environment = {**os.environ, "PATH": "/usr/bin:/bin", "OFFERU_VERSION": version}
        for key in ("DATABASE_URL", "OFFERU_DATA_DIR", "OFFERU_NODE_PATH", "OFFERU_AGENT_RUNTIME_DIR"):
            environment.pop(key, None)
        # These calls must work without a system Python/Node on PATH.
        subprocess.run([str(binary_dir / "offeru-node"), "--version"], env=environment, check=True, timeout=30)
        command = [str(binary_dir / "offeru-backend"), "--data-dir", str(data)]
        manifest = subprocess.run(command + ["cli", "manifest"], env=environment, capture_output=True, text=True, check=True, timeout=120)
        if not json.loads(manifest.stdout).get("ok"):
            raise RuntimeError("Packaged CLI did not return a successful manifest.")
        with (root / "backend.log").open("w", encoding="utf-8") as log:
            process = subprocess.Popen(command + ["serve"], env=environment, stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + 90
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        raise RuntimeError("Packaged backend exited before it became healthy.")
                    try:
                        with opener.open("http://127.0.0.1:8766/api/health", timeout=2) as response:
                            health = json.load(response)
                        if all(health.get(key) == value for key, value in {
                            "status": "ok", "service": "OfferU", "runtime": "python", "build_mode": "release", "version": version,
                        }.items()):
                            print("Packaged macOS backend, Node, and CLI smoke passed; UI and Agent acceptance remain separate.")
                            return
                        raise RuntimeError("Runtime identity does not match the package.")
                    except OSError:
                        time.sleep(1)
                raise RuntimeError("Packaged backend did not become healthy within 90 seconds.")
            except Exception:
                log.flush()
                failure_log = Path(os.environ["RUNNER_TEMP"]) / "offeru-macos-backend.log"
                shutil.copyfile(root / "backend.log", failure_log)
                print(f"Backend failure log: {failure_log}")
                raise
            finally:
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()
    smoke(args.app, version=args.version)
