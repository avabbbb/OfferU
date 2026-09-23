"""Collect consistently named desktop installers and their verification metadata."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil


def collect_artifacts(source: Path, output: Path, *, version: str, target: str, signed: bool) -> None:
    repo = Path(__file__).resolve().parents[3]
    patterns = {"*-setup.exe": f"OfferU-Setup-{version}.exe", "*.msi": f"OfferU-{version}-x64.msi"} if target == "windows-x64" else {
        "*.dmg": f"OfferU-{version}-{target.removeprefix('macos-')}.dmg",
    }
    sources = []
    for pattern, name in patterns.items():
        found = list(source.rglob(pattern))
        if len(found) != 1:
            raise ValueError(f"Expected exactly one {pattern} in {source}, found {len(found)}")
        sources.append((found[0], name))
    output.mkdir(parents=True, exist_ok=True)
    manifest = []
    for path, name in sources:
        destination = output / name
        shutil.copy2(path, destination)
        with destination.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        manifest.append({"name": name, "bytes": destination.stat().st_size, "sha256": digest})
    (output / "artifacts.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (output / "SHA256SUMS.txt").write_text("".join(f"{item['sha256']}  {item['name']}\n" for item in manifest), encoding="utf-8")
    (output / "version.json").write_text(json.dumps({
        "product": "OfferU", "version": version, "target": target,
        "installers": [item["name"] for item in manifest], "signed": signed,
    }, indent=2) + "\n", encoding="utf-8")
    for name in ("RELEASE_NOTES.md", "THIRD_PARTY_NOTICES.md", "LICENSE"):
        shutil.copy2(repo / name, output / name)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--target", choices=("windows-x64", "macos-arm64", "macos-x64"), required=True)
    parser.add_argument("--signed", action="store_true", help="Use only after native signature verification.")
    args = parser.parse_args()
    collect_artifacts(args.source, args.output, version=args.version, target=args.target, signed=args.signed)
