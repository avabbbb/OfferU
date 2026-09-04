"""Managed-Chromium acceptance for a previous-release database upgrade.

The fixture is synthetic and isolated.  The script starts only the backend
process that it owns, points it at a temporary database, and refuses to run if
the fixed local backend port is already occupied.  The browser path uses
Playwright's managed Chromium in headless mode; it never launches Edge or a
system browser.
"""

from __future__ import annotations

from datetime import datetime, timedelta
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from typing import Any
from urllib.error import URLError

from playwright.sync_api import expect, sync_playwright

from release_endpoints import (
    is_offeru_health_payload,
    open_release_url,
    release_api_url,
    release_frontend_url,
    release_version,
)

BACKEND_ROOT = Path(__file__).resolve().parents[2]
BASE_URL = release_frontend_url()
API_URL = release_api_url()
ARTIFACT_DIR = Path(os.getenv("OFFERU_E2E_ARTIFACT_DIR", ".e2e-artifacts"))


def _port_is_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.4):
            return True
    except OSError:
        return False


def _wait_for_http(
    url: str,
    *,
    timeout: float = 45.0,
    expect_offeru_health: bool = False,
    expect_offeru_frontend: bool = False,
    expected_version: str | None = None,
    expected_build_mode: str | None = None,
) -> None:
    deadline = time.monotonic() + timeout
    last_error = "not attempted"
    while time.monotonic() < deadline:
        try:
            with open_release_url(url, timeout=2) as response:
                if 200 <= response.status < 300:
                    if not expect_offeru_health:
                        if expect_offeru_frontend and b"OfferU" not in response.read(8192):
                            last_error = "invalid OfferU frontend identity"
                            time.sleep(0.25)
                            continue
                        return
                    payload = json.loads(response.read(4097))
                    if is_offeru_health_payload(
                        payload,
                        expected_version=expected_version,
                        expected_build_mode=expected_build_mode,
                    ):
                        return
                    last_error = "invalid OfferU health identity"
                    time.sleep(0.25)
                    continue
                last_error = f"HTTP {response.status}"
        except (OSError, URLError) as exc:
            last_error = str(exc)
        time.sleep(0.25)
    raise RuntimeError(f"timed out waiting for {url}: {last_error}")


def _seed_previous_release_database(database_path: Path) -> dict[str, Any]:
    """Create a v1-shaped current schema with representative user data."""

    sys.path.insert(0, str(BACKEND_ROOT))
    previous_database_url = os.environ.get("DATABASE_URL")
    os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{database_path.as_posix()}"
    try:
        # Importing the model registry after DATABASE_URL is set keeps this
        # fixture completely separate from the user's normal OfferU engine.
        from sqlalchemy import create_engine
        from sqlalchemy.orm import Session

        from app.database import Base
        from app.models.models import (
            Application,
            ApplicationAttempt,
            Batch,
            CalendarEvent,
            Interview,
            Job,
            Pool,
            Profile,
            ProfileSection,
            ProfileTargetRole,
            Resume,
            ResumeSection,
        )

        engine = create_engine(f"sqlite:///{database_path.as_posix()}")
        fixture_job_ids: list[int] = []
        fixture_job_title = ""
        try:
            with engine.begin() as connection:
                Base.metadata.create_all(connection)

            now = datetime.now().replace(microsecond=0)
            with Session(engine) as session:
                profile = Profile(
                    name="Migration Labs 2",
                    school="OfferU Test University",
                    major="Computer Science",
                    degree="硕士",
                    email="migration@example.invalid",
                    phone="000-0000-0000",
                    is_default=True,
                    onboarding_step=4,
                    base_info_json={
                        "job_intention": "AI 产品经理",
                        "current_city": "深圳",
                    },
                )
                session.add(profile)
                session.flush()
                session.add(
                    ProfileTargetRole(
                        profile_id=profile.id,
                        role_name="AI 产品经理",
                        role_level="中级",
                        fit="primary",
                    )
                )
                session.add(
                    ProfileSection(
                        profile_id=profile.id,
                        section_type="experience",
                        title="评测工作流项目",
                        sort_order=0,
                        content_json={
                            "description": "建立模型评测流程并推动两轮体验改进。",
                            "evidence": "legacy fixture",
                        },
                        source="manual",
                        tier="core",
                        status="active",
                    )
                )

                resume = Resume(
                    user_name=profile.name,
                    title="Legacy Master Resume",
                    summary="AI 产品与评测工作流经验。",
                    contact_json={"email": profile.email, "phone": profile.phone},
                    is_primary=True,
                    language="zh",
                    source_mode="manual",
                    source_profile_id=profile.id,
                )
                session.add(resume)
                session.flush()
                session.add_all(
                    [
                        ResumeSection(
                            resume_id=resume.id,
                            section_type="experience",
                            title="工作经历",
                            sort_order=0,
                            visible=True,
                            content_json=[
                                {
                                    "company": "Legacy AI Lab",
                                    "position": "产品经理",
                                    "startDate": "2023-01",
                                    "endDate": "至今",
                                    "description": "负责 AI 产品需求分析和评测流程建设。",
                                }
                            ],
                        ),
                        ResumeSection(
                            resume_id=resume.id,
                            section_type="skill",
                            title="技能",
                            sort_order=1,
                            visible=True,
                            content_json=[
                                {"category": "产品与技术", "items": ["AI 产品", "Python"]}
                            ],
                        ),
                    ]
                )

                pool = Pool(
                    name="Legacy AI targets",
                    description="previous release fixture",
                    scope="screened",
                )
                session.add(pool)
                session.add(
                    Batch(
                        id="legacy-import",
                        source="fixture",
                        keywords=["AI 产品经理"],
                        location="深圳",
                        max_results=5,
                        job_count=5,
                        status="completed",
                        total_fetched=5,
                    )
                )
                jobs: list[Job] = []
                for index in range(5):
                    job = Job(
                        title=f"Migration Role {index + 1}",
                        company=f"Legacy Company {index + 1}",
                        location="深圳",
                        url=f"https://example.invalid/jobs/{index + 1}",
                        apply_url=f"https://example.invalid/apply/{index + 1}",
                        source="fixture",
                        raw_description="负责 AI 产品规划、用户需求分析和评测体系建设。",
                        triage_status="screened",
                        pool=pool,
                        batch_id="legacy-import",
                        hash_key=f"legacy-migration-job-{index + 1}",
                    )
                    session.add(job)
                    jobs.append(job)
                session.flush()
                fixture_job_ids = [int(job.id) for job in jobs]
                fixture_job_title = jobs[0].title

                session.add_all(
                    [
                        Application(
                            job_id=jobs[0].id,
                            status="submitted",
                            notes="legacy submitted application",
                            submitted_at=now - timedelta(days=4),
                        ),
                        Application(
                            job_id=jobs[1].id,
                            status="interview",
                            notes="legacy interview stage",
                            submitted_at=now - timedelta(days=8),
                        ),
                        ApplicationAttempt(
                            job_id=jobs[0].id,
                            resume_id=resume.id,
                            status="submitted",
                            notes="legacy attempt",
                            created_at=now - timedelta(days=4),
                        ),
                        ApplicationAttempt(
                            job_id=jobs[1].id,
                            resume_id=resume.id,
                            status="interview",
                            notes="legacy interview attempt",
                            created_at=now - timedelta(days=8),
                        ),
                        Interview(
                            title="Legacy interview",
                            target_company=jobs[1].company,
                            target_position=jobs[1].title,
                            target_job_id=jobs[1].id,
                            resume_id=resume.id,
                            profile_id=profile.id,
                            status="active",
                            questions_json=[{"question": "请介绍一个 AI 产品项目。"}],
                            focus_plan_json={"source": "previous-release-fixture"},
                        ),
                        CalendarEvent(
                            title="Legacy interview schedule",
                            description="Synthetic previous-release calendar event",
                            event_type="interview",
                            start_time=now + timedelta(days=1),
                            end_time=now + timedelta(days=1, hours=1),
                            location="Online",
                            related_job_id=jobs[1].id,
                        ),
                    ]
                )
                session.commit()

            with engine.begin() as connection:
                connection.exec_driver_sql("PRAGMA user_version = 1")
        finally:
            engine.dispose()
    finally:
        if previous_database_url is None:
            os.environ.pop("DATABASE_URL", None)
        else:
            os.environ["DATABASE_URL"] = previous_database_url

    return {
        "profile_name": "Migration Labs 2",
        "job_ids": fixture_job_ids,
        "job_title": fixture_job_title,
    }


def _start_backend(
    database_path: Path,
    data_dir: Path,
    log_path: Path,
) -> tuple[subprocess.Popen[str], Any]:
    if _port_is_open(8765):
        raise RuntimeError(
            "127.0.0.1:8765 is already occupied; refusing to stop or reuse an "
            "existing OfferU process. Stop it manually before this isolated smoke."
        )

    environment = os.environ.copy()
    environment.update(
        {
            "DATABASE_URL": f"sqlite+aiosqlite:///{database_path.as_posix()}",
            "OFFERU_DATA_DIR": str(data_dir),
            "OFFERU_PORT": "8765",
            "OFFERU_BUILD_MODE": "local-development",
            "OFFERU_RUNTIME_MODE": "local",
            "OFFERU_ENABLE_MCP": "false",
            "OFFERU_INTERVIEW_RUNTIME": "replay",
            "MEMORY_DISTILL_INTERVAL_SECONDS": "0",
            "WORK_SOURCE_AUTO_SYNC_INTERVAL_SECONDS": "0",
            "CORS_ORIGINS": "http://127.0.0.1:7410,http://localhost:7410",
            "PYTHONUNBUFFERED": "1",
        }
    )
    python_path = str(BACKEND_ROOT)
    existing_python_path = environment.get("PYTHONPATH", "")
    environment["PYTHONPATH"] = (
        python_path
        if not existing_python_path
        else python_path + os.pathsep + existing_python_path
    )
    log_handle = log_path.open("w", encoding="utf-8")
    process = subprocess.Popen(
        [sys.executable, "run_server.py"],
        cwd=str(BACKEND_ROOT),
        env=environment,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        text=True,
    )
    return process, log_handle


def _stop_backend(process: subprocess.Popen[str], log_handle: Any) -> None:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    log_handle.close()


def _copy_failure_artifacts(log_path: Path, fixture_dir: Path) -> list[str]:
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    copied: list[str] = []
    if log_path.is_file():
        target = ARTIFACT_DIR / "public-release-migration-backend.log"
        shutil.copyfile(log_path, target)
        copied.append(str(target))
    if fixture_dir.is_dir():
        target = ARTIFACT_DIR / "public-release-migration-fixture.db"
        database_path = fixture_dir / "previous-release.db"
        if database_path.is_file():
            shutil.copyfile(database_path, target)
            copied.append(str(target))
    return copied


def _verify_migrated_database(database_path: Path, data_dir: Path) -> dict[str, Any]:
    connection = sqlite3.connect(str(database_path))
    try:
        version = int(connection.execute("PRAGMA user_version").fetchone()[0])
        integrity = str(connection.execute("PRAGMA integrity_check").fetchone()[0])
        foreign_keys = list(connection.execute("PRAGMA foreign_key_check"))
        triage_values = [
            str(row[0])
            for row in connection.execute(
                "SELECT DISTINCT triage_status FROM jobs ORDER BY triage_status"
            )
        ]
        pool_scopes = [
            str(row[0])
            for row in connection.execute("SELECT DISTINCT scope FROM pools ORDER BY scope")
        ]
        counts = {
            "profiles": int(connection.execute("SELECT COUNT(*) FROM profiles").fetchone()[0]),
            "jobs": int(connection.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]),
            "applications": int(
                connection.execute("SELECT COUNT(*) FROM applications").fetchone()[0]
            ),
            "interviews": int(
                connection.execute("SELECT COUNT(*) FROM interviews").fetchone()[0]
            ),
        }
    finally:
        connection.close()

    backup_dir = data_dir / "data" / "data_safety" / "backups"
    backup_count = len(list(backup_dir.glob("*.offeru-backup"))) if backup_dir.is_dir() else 0
    if version != 2 or integrity != "ok" or foreign_keys or triage_values != ["picked"]:
        raise AssertionError(
            "migration verification failed: "
            f"version={version}, integrity={integrity!r}, foreign_keys={foreign_keys}, "
            f"triage={triage_values}, pools={pool_scopes}"
        )
    if pool_scopes != ["picked"]:
        raise AssertionError(f"legacy pool was not normalized: {pool_scopes}")
    if backup_count < 1:
        raise AssertionError("startup did not create a pre-migration backup")
    return {
        "schema_version": version,
        "integrity": integrity,
        "foreign_key_errors": len(foreign_keys),
        "triage_values": triage_values,
        "pool_scopes": pool_scopes,
        "backup_count": backup_count,
        "record_counts": counts,
    }


def _browser_acceptance(fixture: dict[str, Any], suffix: str) -> dict[str, Any]:
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        # Let Playwright resolve its managed Chromium; headless=True prevents
        # any Edge/system window.
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={"width": 1440, "height": 1000},
            accept_downloads=True,
        )
        context.add_init_script(
            "localStorage.setItem('offeru_onboarding', "
            "JSON.stringify({wizardCompleted:true,wizardSkipped:false," 
            "apiKeyConfigured:false,resumeCreated:true,jobsScraped:true}));"
        )
        context.tracing.start(screenshots=True, snapshots=True, sources=True)
        page = context.new_page()
        console_errors: list[str] = []
        page_errors: list[str] = []
        bad_responses: list[str] = []
        page.on(
            "console",
            lambda message: console_errors.append(message.text)
            if message.type == "error"
            else None,
        )
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on(
            "response",
            lambda response: bad_responses.append(f"{response.status} {response.url}")
            if response.status >= 400 and "favicon" not in response.url
            else None,
        )
        trace_stopped = False
        try:
            page.goto(f"{BASE_URL}/#/?migration={suffix}", wait_until="domcontentloaded")
            expect(page.get_by_role("heading", name="今日", exact=True)).to_be_visible(
                timeout=30000
            )

            page.goto(
                f"{BASE_URL}/#/applications?view=board&migration={suffix}",
                wait_until="domcontentloaded",
            )
            expect(page.get_by_role("heading", name="Pipeline", exact=True)).to_be_visible(
                timeout=30000
            )

            page.goto(
                f"{BASE_URL}/#/jobs/{fixture['job_ids'][0]}?migration={suffix}",
                wait_until="domcontentloaded",
            )
            expect(page.get_by_text(fixture["job_title"], exact=True).first).to_be_visible(
                timeout=30000
            )
            expect(page.get_by_text("岗位情报", exact=False).first).to_be_visible(
                timeout=30000
            )

            page.goto(f"{BASE_URL}/#/profile?migration={suffix}", wait_until="domcontentloaded")
            expect(page.get_by_text("档案总览", exact=True)).to_be_visible(timeout=30000)
            expect(page.get_by_role("heading", name=fixture["profile_name"], exact=True)).to_be_visible(
                timeout=30000
            )

            unexpected_responses = [
                response
                for response in bad_responses
                if "/_next/" not in response and "source-map" not in response
            ]
            if unexpected_responses or console_errors or page_errors:
                raise AssertionError(
                    "migration browser errors: "
                    f"responses={unexpected_responses}, "
                    f"console={console_errors}, page={page_errors}"
                )
            context.tracing.stop()
            trace_stopped = True
            return {
                "routes": ["/", "/applications?view=board", "/jobs/1", "/profile"],
                "assertions": [
                    "Today loads migrated state",
                    "Pipeline loads migrated applications",
                    "Job Detail loads a migrated job",
                    "Profile loads the migrated user",
                ],
                "bad_responses": unexpected_responses,
                "console_errors": console_errors,
                "page_errors": page_errors,
            }
        except Exception:
            screenshot_path = ARTIFACT_DIR / "public-release-migration-failure.png"
            trace_path = ARTIFACT_DIR / "public-release-migration-failure.zip"
            try:
                page.screenshot(path=str(screenshot_path), full_page=True)
            except Exception:
                pass
            try:
                context.tracing.stop(path=str(trace_path))
                trace_stopped = True
            except Exception:
                pass
            raise
        finally:
            if not trace_stopped:
                try:
                    context.tracing.stop()
                except Exception:
                    pass
            context.close()
            browser.close()


def main() -> int:
    _wait_for_http(f"{BASE_URL}/", expect_offeru_frontend=True)
    expected_version = release_version()
    suffix = str(int(time.time() * 1000))
    fixture_dir: Path | None = None
    log_path: Path | None = None
    process: subprocess.Popen[str] | None = None
    log_handle: Any = None
    failure_artifacts: list[str] = []
    try:
        with tempfile.TemporaryDirectory(prefix="offeru-public-release-migration-") as root:
            fixture_dir = Path(root)
            database_path = fixture_dir / "previous-release.db"
            data_dir = fixture_dir / "runtime-data"
            log_path = fixture_dir / "backend.log"
            try:
                fixture = _seed_previous_release_database(database_path)
                process, log_handle = _start_backend(database_path, data_dir, log_path)
                try:
                    _wait_for_http(
                        f"{API_URL}/api/health",
                        expect_offeru_health=True,
                        expected_version=expected_version,
                        expected_build_mode="local-development",
                    )
                    migration = _verify_migrated_database(database_path, data_dir)
                    browser = _browser_acceptance(fixture, suffix)
                finally:
                    _stop_backend(process, log_handle)
                    process = None
                    log_handle = None
            except Exception:
                failure_artifacts.extend(_copy_failure_artifacts(log_path, fixture_dir))
                raise
            result = {
                "status": "PASS",
                "mode": "previous_release_migration",
                "browser": "playwright_managed_chromium_headless",
                "web_url": BASE_URL,
                "api_url": API_URL,
                "fixture": fixture,
                "migration": migration,
                "browser_acceptance": browser,
            }
            print(json.dumps(result, ensure_ascii=True, indent=2), flush=True)
            return 0
    except Exception as exc:
        if process is not None and log_handle is not None:
            _stop_backend(process, log_handle)
        result = {
            "status": "FAIL",
            "mode": "previous_release_migration",
            "browser": "playwright_managed_chromium_headless",
            "web_url": BASE_URL,
            "api_url": API_URL,
            "error": str(exc),
            "artifacts": [
                *failure_artifacts,
                *(
                    [
                        str(path)
                        for path in (
                            ARTIFACT_DIR / "public-release-migration-failure.png",
                            ARTIFACT_DIR / "public-release-migration-failure.zip",
                        )
                        if path.is_file()
                    ]
                ),
            ],
        }
        print(json.dumps(result, ensure_ascii=True, indent=2), flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
