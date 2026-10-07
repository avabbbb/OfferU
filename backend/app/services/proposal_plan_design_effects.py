"""Verify the design adapter's exact revision CAS and authorized image bytes.

Only called within the Registry invocation. Unknown/partial effects retain
their original classification and cannot gain retry permission.
"""
from hashlib import sha256
from pathlib import Path

from app.services import resume_design as design


def verify_design_effect(node, observed, guard):
    evidence = observed.get("source_evidence") or {}
    reference = f"resume:{node['args']['resume_id']}"
    # A generic bulk-DML or unrelated/unbound write can never use this proof.
    if (not evidence.get("verified") or guard.unobserved or guard.transactions
            or getattr(guard, "design_cas_count", 0) != 1
            or evidence.get("unbound_effects") or not evidence.get("effects")
            or set(evidence.get("before_versions") or {}) != {reference}
            or any(effect.get("source") != reference for effect in evidence["effects"])):
        return observed
    row = guard.images.get(reference) or {}
    args = node["args"]
    if row.get("workspace_revision") != args["expected_revision"] + 1:
        return observed
    files = []
    for kind, folder in (("photo", "photos"), ("logo", "logos")):
        if not args.get(kind):
            continue
        expected, extension = design.validate_design_image(design.DesignImage(**args[kind]))
        url = row.get("photo_url") if kind == "photo" else (row.get("contact_json") or {}).get("schoolLogoUrl")
        prefix = f"/uploads/{folder}/"
        if not isinstance(url, str) or not url.startswith(prefix):
            return observed
        name = url.removeprefix(prefix)
        if Path(name).name != name or not name.endswith(f".{extension}"):
            return observed
        root = design.runtime_uploads_dir(folder).resolve()
        path = (root / name).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            return observed
        digest = sha256(expected).hexdigest()
        if sha256(path.read_bytes()).hexdigest() != digest:
            return observed
        files.append({"kind": kind, "sha256": digest})
    return {"effect_state": "committed", "proven_no_effect": False,
            "source_evidence": {**evidence, "complete": True,
                                "adapter": "proposal-plan.resume-design.v1", "files": files}}
