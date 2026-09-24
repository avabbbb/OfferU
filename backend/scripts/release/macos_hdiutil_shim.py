#!/usr/bin/env python3
"""Run Tauri 2.11.4's macOS hdiutil path with one verified detach recovery.

This recovery depends on its `rw.<bundle script PID>.<DMG filename>` staging
name. Recheck it whenever the Tauri CLI/bundler version changes.
"""

from __future__ import annotations

import hashlib
import os
import plistlib
import re
import subprocess
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path

REAL_HDIUTIL = "/usr/bin/hdiutil"
_DEVICE = re.compile(r"/dev/disk[0-9]+\Z")
_DEVICE_ENTRY = re.compile(r"/dev/disk[0-9]+(?:s[0-9]+)?\Z")
_DISKARBITRATION_TIMEOUT = (
    "hdiutil: detach: timeout for DiskArbitration expired",
    "hdiutil: detach: drive not detached",
)
_INFO_TIMEOUT_SECONDS = 15
_FORCE_DETACH_TIMEOUT_SECONDS = 45


def _entry_belongs_to_device(entry: str, device: str) -> bool:
    return (
        entry == device
        or re.fullmatch(re.escape(device) + r"s[0-9]+", entry) is not None
    )


def _as_text(value: str | bytes) -> str:
    return (
        value.decode("utf-8", errors="replace") if isinstance(value, bytes) else value
    )


def _emit(
    result: subprocess.CompletedProcess[str] | subprocess.CompletedProcess[bytes],
) -> None:
    if result.stdout:
        sys.stdout.write(_as_text(result.stdout))
        sys.stdout.flush()
    if result.stderr:
        sys.stderr.write(_as_text(result.stderr))
        sys.stderr.flush()


def _run_captured(
    command: Sequence[str], timeout: int | None, *, text: bool = True
) -> subprocess.CompletedProcess[str] | subprocess.CompletedProcess[bytes] | None:
    try:
        return subprocess.run(
            command,
            capture_output=True,
            check=False,
            text=text,
            timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        print(f"OfferU hdiutil recovery command failed: {error}", file=sys.stderr)
        return None


def _load_hdiutil_info() -> Mapping[str, object] | None:
    result = _run_captured(
        [REAL_HDIUTIL, "info", "-plist"], _INFO_TIMEOUT_SECONDS, text=False
    )
    if result is None:
        return None
    if result.returncode != 0:
        _emit(result)
        print(
            "OfferU hdiutil recovery could not inspect attached images.",
            file=sys.stderr,
        )
        return None
    try:
        raw_output = result.stdout
        if isinstance(raw_output, str):
            raw_output = raw_output.encode("utf-8")
        payload = plistlib.loads(raw_output)
    except (plistlib.InvalidFileException, UnicodeEncodeError) as error:
        print(
            f"OfferU hdiutil recovery received invalid plist output: {error}",
            file=sys.stderr,
        )
        return None
    return payload if isinstance(payload, dict) else None


def _device_is_attached(info: Mapping[str, object], device: str) -> bool | None:
    images = info.get("images")
    if not isinstance(images, list):
        return None
    for image in images:
        if not isinstance(image, dict):
            return None
        entities = image.get("system-entities")
        if not isinstance(entities, list):
            return None
        for entity in entities:
            if not isinstance(entity, dict):
                return None
            entry = entity.get("dev-entry")
            if not isinstance(entry, str):
                return None
            if _DEVICE_ENTRY.fullmatch(entry) is None:
                return None
            if _entry_belongs_to_device(entry, device):
                return True
    return False


def _verified_offeru_scratch_image(
    info: Mapping[str, object],
    device: str,
    env: Mapping[str, str],
    parent_pid: int,
) -> Path | None:
    expected_root_value = env.get("OFFERU_DMG_TEMP_DIR", "").strip()
    expected_name = env.get("OFFERU_DMG_TEMP_NAME", "").strip()
    if not expected_root_value or not expected_name:
        return None
    try:
        expected_root = Path(expected_root_value).resolve(strict=True)
    except OSError:
        return None
    if (
        not expected_root.is_dir()
        or expected_root.name != "macos"
        or expected_root.parent.name != "bundle"
        or not expected_name.startswith("OfferU_")
        or not expected_name.endswith("_x64.dmg")
    ):
        return None

    images = info.get("images")
    if not isinstance(images, list):
        return None
    matched_paths: list[Path] = []
    for image in images:
        if not isinstance(image, dict):
            return None
        image_path_value = image.get("image-path")
        if not isinstance(image_path_value, str) or not image_path_value:
            return None
        if "system-entities" not in image:
            return None
        entities = image["system-entities"]
        if not isinstance(entities, list):
            return None
        entries: list[str] = []
        for entity in entities:
            if not isinstance(entity, dict):
                return None
            entry = entity.get("dev-entry")
            if not isinstance(entry, str) or _DEVICE_ENTRY.fullmatch(entry) is None:
                return None
            entries.append(entry)
        if device not in entries:
            continue
        try:
            image_path = Path(image_path_value).resolve(strict=True)
        except OSError:
            return None
        if (
            image_path.parent != expected_root
            or not image_path.is_file()
            or image_path.name != f"rw.{parent_pid}.{expected_name}"
        ):
            return None
        matched_paths.append(image_path)
    return matched_paths[0] if len(matched_paths) == 1 else None


def _image_is_attached(info: Mapping[str, object], image_path: Path) -> bool | None:
    images = info.get("images")
    if not isinstance(images, list):
        return None
    expected_path = str(image_path)
    for image in images:
        if not isinstance(image, dict):
            return None
        attached_path = image.get("image-path")
        if not isinstance(attached_path, str):
            return None
        try:
            if str(Path(attached_path).resolve(strict=True)) == expected_path:
                return True
        except OSError:
            return None
    return False


def _claim_single_recovery(image_path: Path, env: Mapping[str, str]) -> bool:
    marker_root_value = env.get("OFFERU_HDIUTIL_FALLBACK_MARKER_DIR", "").strip()
    if not marker_root_value:
        return False
    try:
        marker_root = Path(marker_root_value).resolve(strict=True)
        if not marker_root.is_dir():
            return False
        marker_name = (
            hashlib.sha256(str(image_path).encode("utf-8")).hexdigest() + ".used"
        )
        marker_path = marker_root / marker_name
        descriptor = os.open(marker_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except (OSError, ValueError):
        return False
    os.close(descriptor)
    return True


def _timeout_was_reported(result: subprocess.CompletedProcess[str]) -> bool:
    output = f"{result.stdout or ''}\n{result.stderr or ''}"
    return result.returncode != 0 and all(
        message in output for message in _DISKARBITRATION_TIMEOUT
    )


def main(
    argv: Sequence[str] | None = None,
    env: Mapping[str, str] | None = None,
    parent_pid: int | None = None,
) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] != "detach":
        try:
            return subprocess.run([REAL_HDIUTIL, *args], check=False).returncode
        except OSError as error:
            print(f"Could not run {REAL_HDIUTIL}: {error}", file=sys.stderr)
            return 127

    initial = _run_captured([REAL_HDIUTIL, *args], timeout=None)
    if initial is None:
        return 1
    _emit(initial)
    if initial.returncode == 0 or not _timeout_was_reported(initial):
        return initial.returncode

    devices = [argument for argument in args[1:] if _DEVICE.fullmatch(argument)]
    if len(devices) != 1:
        print(
            "OfferU hdiutil recovery refused: detach target is not one whole disk device.",
            file=sys.stderr,
        )
        return initial.returncode
    device = devices[0]
    current_env = os.environ if env is None else env
    info = _load_hdiutil_info()
    if info is None:
        return initial.returncode
    expected_parent_pid = os.getppid() if parent_pid is None else parent_pid
    image_path = _verified_offeru_scratch_image(
        info,
        device,
        current_env,
        expected_parent_pid,
    )
    if image_path is None:
        print(
            f"OfferU hdiutil recovery refused: {device} did not uniquely map to "
            f"rw.{expected_parent_pid}.{current_env.get('OFFERU_DMG_TEMP_NAME', '<unset>')} "
            "in the configured OfferU staging directory.",
            file=sys.stderr,
        )
        return initial.returncode
    if not _claim_single_recovery(image_path, current_env):
        print(
            "OfferU hdiutil recovery refused: the one recovery attempt was already used "
            "or its marker could not be written.",
            file=sys.stderr,
        )
        return initial.returncode

    print(
        f"OfferU hdiutil: attempting one force detach for verified staging image {image_path}",
        file=sys.stderr,
    )
    forced = _run_captured(
        [REAL_HDIUTIL, "detach", "-force", device],
        _FORCE_DETACH_TIMEOUT_SECONDS,
    )
    if forced is None:
        return 1
    _emit(forced)
    if forced.returncode != 0:
        return forced.returncode

    after = _load_hdiutil_info()
    still_attached = None if after is None else _device_is_attached(after, device)
    image_still_attached = (
        None if after is None else _image_is_attached(after, image_path)
    )
    if still_attached is not False or image_still_attached is not False:
        print(
            f"OfferU hdiutil recovery failed: {device} or {image_path} remains attached "
            "or attachment state is unknown.",
            file=sys.stderr,
        )
        return 1
    print(
        "OfferU hdiutil: verified the staging device is detached; Tauri must still finish and verify the DMG.",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
