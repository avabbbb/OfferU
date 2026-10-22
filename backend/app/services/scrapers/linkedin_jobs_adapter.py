"""Optional LinkedIn jobs input and row adapter.

The scraper stays on curious_coder/linkedin-jobs-scraper unless
OFFERU_LINKEDIN_JOBS_ACTOR is exactly johnvc/linkedin-jobs-api.
"""

from __future__ import annotations

DEFAULT_LINKEDIN_JOBS_ACTOR = "curious_coder/linkedin-jobs-scraper"
OPTIONAL_LINKEDIN_JOBS_ACTOR = "johnvc/linkedin-jobs-api"
ENV_NAME = "OFFERU_LINKEDIN_JOBS_ACTOR"
MAX_JOBS = 500


def resolve_linkedin_jobs_actor(env_value: str | None) -> str:
    if env_value == OPTIONAL_LINKEDIN_JOBS_ACTOR:
        return OPTIONAL_LINKEDIN_JOBS_ACTOR
    return DEFAULT_LINKEDIN_JOBS_ACTOR


def actor_path(actor_id: str) -> str:
    return actor_id.replace("/", "~")


def _search_urls(keywords: list[str], location: str) -> list[str]:
    return [
        "https://www.linkedin.com/jobs/search?keywords="
        f"{kw.replace(' ', '%20')}&location={location.replace(' ', '%20')}&f_TPR=r86400"
        for kw in keywords
    ]


def jobs_run_input(
    actor_id: str,
    keywords: list[str],
    location: str,
    max_results: int,
) -> dict | None:
    if actor_id == OPTIONAL_LINKEDIN_JOBS_ACTOR:
        keyword = " ".join(part.strip() for part in keywords if part and part.strip())
        if not keyword:
            return None
        cap = max(1, min(MAX_JOBS, int(max_results)))
        return {
            "keyword": keyword,
            "location": location,
            "timeRange": "past-day",
            "maxJobs": cap,
        }
    return {
        "count": max_results,
        "scrapeCompany": True,
        "urls": _search_urls(keywords, location),
    }


def _industries(value: object) -> str:
    if isinstance(value, list):
        return ", ".join(str(part) for part in value if part)
    return str(value or "")


def _optional_row(item: dict) -> dict:
    return {
        "title": item.get("title") or "",
        "companyName": item.get("companyName") or "",
        "link": item.get("jobUrl") or "",
        "applyUrl": item.get("applyUrl") or "",
        "location": item.get("location") or "",
        "descriptionText": item.get("description") or "",
        "postedAt": item.get("postedDate") or "",
        "seniorityLevel": item.get("seniorityLevel") or "",
        "employmentType": item.get("employmentType") or "",
        "industries": _industries(item.get("industries")),
        "salary": item.get("salary") or "",
        "companyWebsite": "",
        "companyDescription": "",
        "companyEmployeesCount": None,
        "companyLogo": item.get("companyLogo") or "",
    }


def jobs_rows_for_normalizer(actor_id: str, items: list) -> list[dict]:
    if actor_id != OPTIONAL_LINKEDIN_JOBS_ACTOR:
        return [item for item in items if isinstance(item, dict)]
    rows: list[dict] = []
    for item in items:
        if isinstance(item, dict) and item.get("result_type") == "job":
            rows.append(_optional_row(item))
    return rows
