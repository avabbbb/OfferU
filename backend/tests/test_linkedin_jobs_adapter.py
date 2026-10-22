"""Offline coverage for the optional LinkedIn jobs adapter."""

from __future__ import annotations

import importlib.util
from pathlib import Path

_PATH = Path(__file__).resolve().parents[1] / "app" / "services" / "scrapers" / "linkedin_jobs_adapter.py"
_SPEC = importlib.util.spec_from_file_location("linkedin_jobs_adapter", _PATH)
assert _SPEC and _SPEC.loader
adapter = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(adapter)


def test_default_actor_and_past_day_search_urls():
    assert adapter.resolve_linkedin_jobs_actor(None) == adapter.DEFAULT_LINKEDIN_JOBS_ACTOR
    assert adapter.resolve_linkedin_jobs_actor("other/actor") == adapter.DEFAULT_LINKEDIN_JOBS_ACTOR
    payload = adapter.jobs_run_input(
        adapter.DEFAULT_LINKEDIN_JOBS_ACTOR,
        ["data scientist"],
        "Austin",
        50,
    )
    assert payload == {
        "count": 50,
        "scrapeCompany": True,
        "urls": [
            "https://www.linkedin.com/jobs/search?keywords=data%20scientist&location=Austin&f_TPR=r86400"
        ],
    }


def test_optional_actor_uses_keyword_location_and_drops_error_rows():
    assert (
        adapter.resolve_linkedin_jobs_actor(adapter.OPTIONAL_LINKEDIN_JOBS_ACTOR)
        == adapter.OPTIONAL_LINKEDIN_JOBS_ACTOR
    )
    payload = adapter.jobs_run_input(
        adapter.OPTIONAL_LINKEDIN_JOBS_ACTOR,
        ["data scientist", "python"],
        "Austin",
        800,
    )
    assert payload == {
        "keyword": "data scientist python",
        "location": "Austin",
        "timeRange": "past-day",
        "maxJobs": 500,
    }
    assert adapter.jobs_run_input(adapter.OPTIONAL_LINKEDIN_JOBS_ACTOR, ["  "], "Austin", 10) is None
    rows = adapter.jobs_rows_for_normalizer(
        adapter.OPTIONAL_LINKEDIN_JOBS_ACTOR,
        [
            {
                "result_type": "job",
                "title": "",
                "companyName": "",
                "jobUrl": "",
                "applyUrl": "",
                "location": "",
                "description": "",
                "postedDate": "",
                "seniorityLevel": "",
                "employmentType": "",
                "industries": [],
                "salary": "",
                "companyLogo": "",
            },
            {"result_type": "error", "error_type": "CollectionError", "error_message": "none"},
        ],
    )
    assert rows == [
        {
            "title": "",
            "companyName": "",
            "link": "",
            "applyUrl": "",
            "location": "",
            "descriptionText": "",
            "postedAt": "",
            "seniorityLevel": "",
            "employmentType": "",
            "industries": "",
            "salary": "",
            "companyWebsite": "",
            "companyDescription": "",
            "companyEmployeesCount": None,
            "companyLogo": "",
        }
    ]
