from __future__ import annotations

import importlib.util
import plistlib
import subprocess
import sys
from pathlib import Path

MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "release"
    / "macos_hdiutil_shim.py"
)
_SPEC = importlib.util.spec_from_file_location("macos_hdiutil_shim", MODULE_PATH)
assert _SPEC is not None and _SPEC.loader is not None
SHIM = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = SHIM
_SPEC.loader.exec_module(SHIM)

DEVICE = "/dev/disk7"
TIMEOUT_OUTPUT = (
    "hdiutil: detach: timeout for DiskArbitration expired\n"
    "hdiutil: detach: drive not detached\n"
)


def _result(
    returncode: int, stdout: str = "", stderr: str = ""
) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess([], returncode, stdout, stderr)


def _info(image_path: Path | None) -> str:
    images = []
    if image_path is not None:
        images.append(
            {
                "image-path": str(image_path),
                "system-entities": [{"dev-entry": DEVICE}],
            }
        )
    return plistlib.dumps({"images": images}).decode("utf-8")


def _setup(tmp_path: Path, monkeypatch) -> tuple[Path, dict[str, str]]:
    bundle_dir = tmp_path / "bundle"
    image_dir = bundle_dir / "macos"
    image_dir.mkdir(parents=True)
    image_path = image_dir / "rw.1234.OfferU_1.0.0_x64.dmg"
    image_path.write_bytes(b"staging image")
    marker_dir = tmp_path / "markers"
    marker_dir.mkdir()
    env = {
        "OFFERU_DMG_TEMP_DIR": str(image_dir),
        "OFFERU_DMG_TEMP_NAME": "OfferU_1.0.0_x64.dmg",
        "OFFERU_HDIUTIL_FALLBACK_MARKER_DIR": str(marker_dir),
    }
    monkeypatch.setattr(SHIM, "REAL_HDIUTIL", "/usr/bin/hdiutil")
    return image_path, env


def test_non_detach_hdiutil_commands_are_delegated(monkeypatch, capsys) -> None:
    calls: list[tuple[list[str], dict[str, object]]] = []

    def fake_run(command, **kwargs):
        calls.append((command, kwargs))
        return _result(0)

    monkeypatch.setattr(SHIM.subprocess, "run", fake_run)

    assert SHIM.main(["verify", "OfferU.dmg"]) == 0
    assert calls == [(["/usr/bin/hdiutil", "verify", "OfferU.dmg"], {"check": False})]
    assert capsys.readouterr().out == ""


def test_exact_timeout_force_detaches_only_verified_offeru_staging_image(
    tmp_path, monkeypatch, capsys
) -> None:
    image_path, env = _setup(tmp_path, monkeypatch)
    calls: list[list[str]] = []
    info_outputs = [_info(image_path), _info(None)]

    def fake_run(command, **kwargs):
        calls.append(command)
        if command[1] == "detach" and "-force" not in command:
            return _result(1, stderr=TIMEOUT_OUTPUT)
        if command[1:] == ["info", "-plist"]:
            return _result(0, stdout=info_outputs.pop(0))
        if command[1:3] == ["detach", "-force"]:
            return _result(0)
        raise AssertionError(command)

    monkeypatch.setattr(SHIM.subprocess, "run", fake_run)

    assert SHIM.main(["detach", DEVICE], env=env, parent_pid=1234) == 0
    assert calls == [
        ["/usr/bin/hdiutil", "detach", DEVICE],
        ["/usr/bin/hdiutil", "info", "-plist"],
        ["/usr/bin/hdiutil", "detach", "-force", DEVICE],
        ["/usr/bin/hdiutil", "info", "-plist"],
    ]
    assert "verified the staging device is detached" in capsys.readouterr().err


def test_non_matching_detach_error_is_not_recovered(monkeypatch, capsys) -> None:
    calls: list[list[str]] = []

    def fake_run(command, **kwargs):
        calls.append(command)
        return _result(16, stderr="hdiutil: detach: Resource busy\n")

    monkeypatch.setattr(SHIM.subprocess, "run", fake_run)

    assert SHIM.main(["detach", DEVICE], env={}) == 16
    assert calls == [["/usr/bin/hdiutil", "detach", DEVICE]]
    assert capsys.readouterr().err == "hdiutil: detach: Resource busy\n"


def test_timeout_for_non_offeru_image_stays_failed(
    tmp_path, monkeypatch, capsys
) -> None:
    image_path, env = _setup(tmp_path, monkeypatch)
    other_path = image_path.with_name("rw.1234.OtherApp.dmg")
    other_path.write_bytes(b"other image")
    calls: list[list[str]] = []

    def fake_run(command, **kwargs):
        calls.append(command)
        if command[1] == "detach":
            return _result(1, stderr=TIMEOUT_OUTPUT)
        if command[1:] == ["info", "-plist"]:
            return _result(0, stdout=_info(other_path))
        raise AssertionError(command)

    monkeypatch.setattr(SHIM.subprocess, "run", fake_run)

    assert SHIM.main(["detach", DEVICE], env=env, parent_pid=1234) == 1
    assert calls == [
        ["/usr/bin/hdiutil", "detach", DEVICE],
        ["/usr/bin/hdiutil", "info", "-plist"],
    ]
    assert "recovery refused" in capsys.readouterr().err


def test_timeout_for_another_tauri_process_stays_failed(
    tmp_path, monkeypatch, capsys
) -> None:
    image_path, env = _setup(tmp_path, monkeypatch)
    calls: list[list[str]] = []

    def fake_run(command, **kwargs):
        calls.append(command)
        if command[1] == "detach":
            return _result(1, stderr=TIMEOUT_OUTPUT)
        if command[1:] == ["info", "-plist"]:
            return _result(0, stdout=_info(image_path))
        raise AssertionError(command)

    monkeypatch.setattr(SHIM.subprocess, "run", fake_run)

    assert SHIM.main(["detach", DEVICE], env=env, parent_pid=5678) == 1
    assert calls == [
        ["/usr/bin/hdiutil", "detach", DEVICE],
        ["/usr/bin/hdiutil", "info", "-plist"],
    ]
    assert "recovery refused" in capsys.readouterr().err


def test_malformed_hdiutil_info_fails_closed(tmp_path, monkeypatch, capsys) -> None:
    image_path, env = _setup(tmp_path, monkeypatch)
    malformed_info = plistlib.dumps(
        {
            "images": [
                {
                    "image-path": str(image_path),
                    "system-entities": [{"dev-entry": 7}],
                }
            ]
        }
    ).decode("utf-8")
    calls: list[list[str]] = []

    def fake_run(command, **kwargs):
        calls.append(command)
        if command[1] == "detach":
            return _result(1, stderr=TIMEOUT_OUTPUT)
        if command[1:] == ["info", "-plist"]:
            return _result(0, stdout=malformed_info)
        raise AssertionError(command)

    monkeypatch.setattr(SHIM.subprocess, "run", fake_run)

    assert SHIM.main(["detach", DEVICE], env=env, parent_pid=1234) == 1
    assert calls == [
        ["/usr/bin/hdiutil", "detach", DEVICE],
        ["/usr/bin/hdiutil", "info", "-plist"],
    ]
    assert "recovery refused" in capsys.readouterr().err


def test_missing_system_entities_fails_closed(tmp_path, monkeypatch, capsys) -> None:
    image_path, env = _setup(tmp_path, monkeypatch)
    malformed_info = plistlib.dumps(
        {"images": [{"image-path": str(image_path)}]}
    ).decode("utf-8")
    calls: list[list[str]] = []

    def fake_run(command, **kwargs):
        calls.append(command)
        if command[1] == "detach":
            return _result(1, stderr=TIMEOUT_OUTPUT)
        if command[1:] == ["info", "-plist"]:
            return _result(0, stdout=malformed_info)
        raise AssertionError(command)

    monkeypatch.setattr(SHIM.subprocess, "run", fake_run)

    assert SHIM.main(["detach", DEVICE], env=env, parent_pid=1234) == 1
    assert calls == [
        ["/usr/bin/hdiutil", "detach", DEVICE],
        ["/usr/bin/hdiutil", "info", "-plist"],
    ]
    assert "recovery refused" in capsys.readouterr().err


def test_invalid_device_entry_fails_closed(tmp_path, monkeypatch, capsys) -> None:
    image_path, env = _setup(tmp_path, monkeypatch)
    malformed_info = plistlib.dumps(
        {
            "images": [
                {
                    "image-path": str(image_path),
                    "system-entities": [{"dev-entry": "/dev/not-a-disk"}],
                }
            ]
        }
    ).decode("utf-8")
    calls: list[list[str]] = []

    def fake_run(command, **kwargs):
        calls.append(command)
        if command[1] == "detach":
            return _result(1, stderr=TIMEOUT_OUTPUT)
        if command[1:] == ["info", "-plist"]:
            return _result(0, stdout=malformed_info)
        raise AssertionError(command)

    monkeypatch.setattr(SHIM.subprocess, "run", fake_run)

    assert SHIM.main(["detach", DEVICE], env=env, parent_pid=1234) == 1
    assert calls == [
        ["/usr/bin/hdiutil", "detach", DEVICE],
        ["/usr/bin/hdiutil", "info", "-plist"],
    ]
    assert "recovery refused" in capsys.readouterr().err


def test_force_recovery_is_attempted_once_per_staging_image(
    tmp_path, monkeypatch, capsys
) -> None:
    image_path, env = _setup(tmp_path, monkeypatch)
    calls: list[list[str]] = []

    def fake_run(command, **kwargs):
        calls.append(command)
        if command[1] == "detach" and "-force" not in command:
            return _result(16, stderr=TIMEOUT_OUTPUT)
        if command[1:] == ["info", "-plist"]:
            return _result(0, stdout=_info(image_path))
        if command[1:3] == ["detach", "-force"]:
            return _result(16, stderr="hdiutil: detach: drive not detached\n")
        raise AssertionError(command)

    monkeypatch.setattr(SHIM.subprocess, "run", fake_run)

    assert SHIM.main(["detach", DEVICE], env=env, parent_pid=1234) == 16
    assert SHIM.main(["detach", DEVICE], env=env, parent_pid=1234) == 16
    assert sum(command[1:3] == ["detach", "-force"] for command in calls) == 1
    assert "recovery refused" in capsys.readouterr().err


def test_force_detach_must_be_followed_by_verified_unmount(
    tmp_path, monkeypatch, capsys
) -> None:
    image_path, env = _setup(tmp_path, monkeypatch)
    calls: list[list[str]] = []

    def fake_run(command, **kwargs):
        calls.append(command)
        if command[1] == "detach" and "-force" not in command:
            return _result(1, stderr=TIMEOUT_OUTPUT)
        if command[1:] == ["info", "-plist"]:
            return _result(0, stdout=_info(image_path))
        if command[1:3] == ["detach", "-force"]:
            return _result(0)
        raise AssertionError(command)

    monkeypatch.setattr(SHIM.subprocess, "run", fake_run)

    assert SHIM.main(["detach", DEVICE], env=env, parent_pid=1234) == 1
    assert calls[-1] == ["/usr/bin/hdiutil", "info", "-plist"]
    assert "remains attached" in capsys.readouterr().err
