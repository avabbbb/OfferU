from __future__ import annotations

from pathlib import Path


# backend/scripts/e2e/test_*.py -> repository root
ROOT = Path(__file__).resolve().parents[3]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8", errors="replace")


def assert_contains(text: str, required: list[str], label: str) -> None:
    missing = [item for item in required if item not in text]
    if missing:
        raise AssertionError(f"{label} is missing {missing}")


def main() -> None:
    expected_files = [
        "frontend/src/app/resume/components/templates/templateSettings.ts",
        "frontend/src/app/resume/components/templates/resumeTemplate.css",
        "frontend/src/app/resume/components/templates/ResumeReference.tsx",
        "frontend/src/app/resume/components/templates/ResumeSwissSingle.tsx",
        "frontend/src/app/resume/components/templates/ResumeSwissTwoColumn.tsx",
        "frontend/src/app/resume/components/templates/ResumeModernSingle.tsx",
        "frontend/src/app/resume/components/templates/ResumeModernTwoColumn.tsx",
        "frontend/src/app/resume/components/TemplateSelector.tsx",
        "frontend/src/app/resume/components/MatchScorePanel.tsx",
        "frontend/src/app/resume/components/KeywordHighlightView.tsx",
        "frontend/src/app/resume/print/[id]/page.tsx",
    ]
    missing_files = [path for path in expected_files if not (ROOT / path).exists()]
    if missing_files:
        raise AssertionError(f"resume template files are missing: {missing_files}")

    settings = read("frontend/src/app/resume/components/templates/templateSettings.ts")
    assert_contains(
        settings,
        ["reference", "reference-compact", "settingsToCssVars"],
        "template settings",
    )

    template_css = read("frontend/src/app/resume/components/templates/resumeTemplate.css")
    assert_contains(
        template_css,
        ["resume-body", "reference-resume", "reference-section-title", "@media print", "page-break-inside"],
        "template css",
    )

    preview = read("frontend/src/app/resume/components/ResumePreview.tsx")
    assert_contains(
        preview,
        ["ResumeReference", "highlightKeywords", "reference-compact"],
        "resume preview",
    )

    section_editor = read("frontend/src/app/resume/components/SectionEditor.tsx")
    assert_contains(
        section_editor,
        ["DndContext", "SortableContext", "DraggableListItem", "arrayMove"],
        "section item drag",
    )

    print_page = read("frontend/src/app/resume/print/[id]/page.tsx")
    assert_contains(print_page, ["resume-print", "ResumePreview", "useResume"], "print route")

    backend_resume = read("backend/app/routes/resume.py")
    assert_contains(
        backend_resume,
        [
            "_render_resume_pdf_with_playwright",
            "FRONTEND_BASE_URL",
            "/resume/print/",
            "headless=True",
            '@router.post("/{resume_id}/logo")',
            '@router.post("/{resume_id}/logo/resolve")',
            "_resolve_university_logo_url",
            "schoolLogoUrl",
        ],
        "playwright pdf export",
    )
    if "msedge" in backend_resume or "headless=False" in backend_resume:
        raise AssertionError("resume PDF rendering must not probe Edge or launch a visible browser")

    editor = read("frontend/src/app/resume/[id]/page.tsx")
    assert_contains(
        editor,
        ["uploadResumeLogo", "resolveResumeLogo", "handleResolveLogo", "自动获取校徽", "schoolName", "schoolLogoUrl"],
        "resume logo editor",
    )

    print("resume template contract ok")


if __name__ == "__main__":
    main()
