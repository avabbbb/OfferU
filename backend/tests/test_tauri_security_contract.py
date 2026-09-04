from __future__ import annotations

import json
from pathlib import Path
import unittest


REPO_ROOT = Path(__file__).resolve().parents[2]
TAURI_ROOT = REPO_ROOT / "frontend" / "src-tauri"


class TauriSecurityContractTests(unittest.TestCase):
    def test_capability_manifest_matches_minimal_desktop_contract(self) -> None:
        capability_files = sorted((TAURI_ROOT / "capabilities").glob("*.json"))
        self.assertEqual([path.name for path in capability_files], ["default.json"])

        manifest = json.loads(capability_files[0].read_text(encoding="utf-8"))
        self.assertEqual(manifest["windows"], ["main"])
        self.assertEqual(manifest["permissions"], ["core:default"])
        self.assertNotIn("shell", json.dumps(manifest).lower())

        tauri_config = json.loads(
            (TAURI_ROOT / "tauri.conf.json").read_text(encoding="utf-8")
        )
        self.assertEqual(tauri_config["build"]["frontendDist"], "../dist")
        self.assertEqual(tauri_config["build"]["devUrl"], "http://127.0.0.1:7410")
        self.assertEqual(tauri_config["bundle"]["externalBin"], ["binaries/offeru-backend"])
        self.assertEqual(
            tauri_config["bundle"]["resources"],
            {
                "../../.tmp/p/": "agent-runtime/",
                "../../.tmp/offeru-node-runtime.exe": "node.exe",
            },
        )
        csp = str(tauri_config["app"]["security"]["csp"])
        self.assertTrue(csp.strip())
        self.assertNotIn("unsafe-eval", csp)
        self.assertIn("object-src 'none'", csp)
        self.assertIn("frame-ancestors 'none'", csp)

        rust_sources = "\n".join(
            path.read_text(encoding="utf-8")
            for path in (TAURI_ROOT / "src").rglob("*.rs")
        )
        self.assertNotIn("tauri_plugin_shell", rust_sources)
        self.assertIn("OFFERU_AGENT_RUNTIME_DIR", rust_sources)
        self.assertIn("OFFERU_NODE_PATH", rust_sources)
        self.assertIn('.env("OFFERU_BUILD_MODE", "local-development")', rust_sources)
        self.assertIn('.env("OFFERU_RUNTIME_MODE", "local")', rust_sources)
        self.assertIn('.env("OFFERU_VERSION", env!("CARGO_PKG_VERSION"))', rust_sources)
        self.assertIn(".no_proxy()", rust_sources)
        self.assertIn("reqwest::redirect::Policy::none()", rust_sources)
        cli_source = (REPO_ROOT / "backend" / "app" / "cli.py").read_text(encoding="utf-8")
        self.assertIn("ProxyHandler({})", cli_source)
        self.assertIn("_open_local_url", cli_source)
        self.assertIn("serde_json::from_str", rust_sources)
        self.assertIn('object.get("status")', rust_sources)
        self.assertIn('object.get("service")', rust_sources)
        self.assertIn('Some("OfferU")', rust_sources)
        self.assertIn('object.get("runtime")', rust_sources)
        self.assertIn('Some("python")', rust_sources)
        self.assertIn('object.get("build_mode")', rust_sources)
        self.assertIn('Some(expected_build_mode)', rust_sources)
        self.assertIn('object.get("version")', rust_sources)
        self.assertIn('Some(expected_version)', rust_sources)
        self.assertNotIn('body.contains("\\"runtime\\":\\"python\\"")', rust_sources)
        self.assertNotIn("spawning Python backend on :8765: {}", rust_sources)
        self.assertNotIn("project root:", rust_sources)


if __name__ == "__main__":
    unittest.main()
