"""Shared visibility predicates for excluding internal/test jobs.

UI routes and agent/CLI surfaces must hide the same internal-test jobs.
These were previously triplicated in ``routes/jobs.py``,
``agent_operations.py`` and ``application_workspace.py`` and had already
diverged (agent ops saw fixture jobs the UI hid). One source of truth here.

NOTE: this filter excludes *internal-test* jobs only. Whether to hide
``triage_status == "ignored"`` is a per-call decision (the jobs route keeps
the ignored tab reachable, so it applies that predicate separately); callers
add it themselves when they want the default list view.
"""

from __future__ import annotations

from sqlalchemy import and_, or_

from app.models.models import ApplicationRecord, Job

INTERNAL_TEST_BATCH_PREFIXES = ("test-", "test_", "ui-ext-", "mock-")
INTERNAL_TEST_COMPANY_PREFIX = "OfferU "
INTERNAL_TEST_URL_MARKERS = (
    "example.com/jobs/test-",
    "example.com/apply/test-",
)


def public_job_filter():
    """Job-table visibility: exclude internal-test jobs.

    Applies to every surface that lists jobs to a user or an agent
    (routes/jobs.py, agent_operations.py, progress stats). Callers add
    ``Job.triage_status != "ignored"`` on top when they want the default
    (non-recycle-bin) listing.
    """
    batch_filters = [
        or_(Job.batch_id.is_(None), ~Job.batch_id.ilike(f"{prefix}%"))
        for prefix in INTERNAL_TEST_BATCH_PREFIXES
    ]
    url_filters = [
        or_(Job.url.is_(None), ~Job.url.ilike(f"%{marker}%"))
        for marker in INTERNAL_TEST_URL_MARKERS
    ] + [
        or_(Job.apply_url.is_(None), ~Job.apply_url.ilike(f"%{marker}%"))
        for marker in INTERNAL_TEST_URL_MARKERS
    ]
    return and_(
        *batch_filters,
        or_(
            Job.company.is_(None),
            ~Job.company.ilike(f"{INTERNAL_TEST_COMPANY_PREFIX}%"),
        ),
        *url_filters,
    )


def public_application_record_filter():
    """ApplicationRecord + joined-Job visibility (application workspace).

    Same internal-test exclusion, applied across both the record and its
    linked job row.
    """
    batch_filters = [
        or_(Job.batch_id.is_(None), ~Job.batch_id.ilike(f"{prefix}%"))
        for prefix in INTERNAL_TEST_BATCH_PREFIXES
    ]
    url_filters = [
        or_(
            ApplicationRecord.job_link.is_(None),
            ~ApplicationRecord.job_link.ilike(f"%{marker}%"),
        )
        for marker in INTERNAL_TEST_URL_MARKERS
    ] + [
        or_(Job.url.is_(None), ~Job.url.ilike(f"%{marker}%"))
        for marker in INTERNAL_TEST_URL_MARKERS
    ] + [
        or_(Job.apply_url.is_(None), ~Job.apply_url.ilike(f"%{marker}%"))
        for marker in INTERNAL_TEST_URL_MARKERS
    ]
    return and_(
        *batch_filters,
        or_(
            ApplicationRecord.company_name.is_(None),
            ~ApplicationRecord.company_name.ilike(f"{INTERNAL_TEST_COMPANY_PREFIX}%"),
        ),
        or_(
            Job.company.is_(None),
            ~Job.company.ilike(f"{INTERNAL_TEST_COMPANY_PREFIX}%"),
        ),
        *url_filters,
    )
