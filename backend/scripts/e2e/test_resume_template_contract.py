"""简历只有一个「纸」模板：编辑器、缩略图和导出 PDF 共用 ResumeSheet，没有表单/预览两套东西。"""
from __future__ import annotations

from pathlib import Path


# backend/scripts/e2e/test_*.py -> repository root
ROOT = Path(__file__).resolve().parents[3]
RESUME = ROOT / "frontend/src/app/resume"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def assert_contains(text: str, required: list[str], label: str) -> None:
    missing = [item for item in required if item not in text]
    if missing:
        raise AssertionError(f"{label} is missing {missing}")


def main() -> None:
    removed = [
        "components/SectionEditor.tsx", "components/ResumePreview.tsx", "components/StyleToolbar.tsx",
        "components/ResumeDesignPanel.tsx", "components/TemplateSelector.tsx",
        "components/templates/ResumeReference.tsx", "components/templates/ResumeSwissSingle.tsx",
        "components/templates/ResumeModernSingle.tsx",
    ]
    back = [path for path in removed if (RESUME / path).exists()]
    if back:
        raise AssertionError(f"old resume templates/editors came back: {back}")

    for path in ["[id]/page.tsx", "print/[id]/page.tsx", "components/ResumeThumbnail.tsx"]:
        assert_contains(read(RESUME / path), ["ResumeSheet"], path)

    assert_contains(read(RESUME / "components/templates/resumeTemplate.css"),
                    ["resume-body", "@media print", "box-decoration-break: clone"], "template css")

    export = read(ROOT / "backend/app/services/resume_export.py")
    assert_contains(export, ["/#/resume/print/", '"headless": True'], "playwright pdf export")
    if "msedge" in export or '"headless": False' in export:
        raise AssertionError("resume PDF rendering must not probe Edge or launch a visible browser")

    print("resume template contract ok")


if __name__ == "__main__":
    main()
