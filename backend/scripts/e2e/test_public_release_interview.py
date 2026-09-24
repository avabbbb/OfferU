"""Portable browser acceptance for the fixture-backed Interview safety gate.

The scenario creates its own profile and job through the visible UI, uses the
explicit replay providers, and verifies that fixture-only Role Intelligence
cannot start real interview training. It assumes the isolated backend/frontend
are already running, just like the other release browser gates.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from release_endpoints import (
    assert_release_backend_ready,
    assert_release_frontend_ready,
    release_api_url,
    release_frontend_url,
)
from temp_paths import test_temp_root
from test_public_release_smoke import (
    _complete_new_user_onboarding,
    _use_replay_provider,
)

BASE_URL = release_frontend_url()
API_URL = release_api_url()
ARTIFACT_DIR = Path(os.getenv("OFFERU_E2E_ARTIFACT_DIR") or test_temp_root("e2e-artifacts"))


def _json_response(page, url: str) -> dict:
    response = page.request.get(url)
    if not response.ok:
        raise AssertionError(f"request failed: {response.status} {url}")
    payload = response.json()
    if not isinstance(payload, dict):
        raise AssertionError(f"expected object response: {url}")
    return payload


def _create_profile_and_job(page, suffix: str) -> tuple[int, dict]:
    page.goto(f"{BASE_URL}/#/?interview_smoke={suffix}", wait_until="domcontentloaded")
    page.evaluate("localStorage.clear()")
    page.reload(wait_until="domcontentloaded")
    _complete_new_user_onboarding(page, suffix)
    title = "AI 产品经理"
    company = f"Interview Orbit {suffix}"
    page.get_by_test_id("add-job-title").fill(title)
    page.get_by_test_id("add-job-company").fill(company)
    page.get_by_test_id("add-job-description").fill(
        "负责 AI 产品规划、用户需求分析、评测体系建设与跨团队交付；关注 Agent 工作流和产品增长。"
    )
    page.route("**/api/jobs/ingest", _use_replay_provider)
    try:
        page.get_by_test_id("add-job-submit").click()
        page.wait_for_function(
            "() => window.location.hash.startsWith('#/jobs/')",
            timeout=30000,
        )
    finally:
        page.unroute("**/api/jobs/ingest", _use_replay_provider)

    jobs = _json_response(page, f"{API_URL}/api/jobs/?page_size=100")
    matching = [item for item in jobs.get("items", []) if item.get("company") == company]
    if len(matching) != 1:
        raise AssertionError(f"expected one interview smoke job, got {len(matching)}")
    job = matching[0]
    job_id = int(job["id"])
    return job_id, job


def _wait_for_role_benchmark(page, job_id: int) -> dict:
    for _ in range(120):
        benchmark_response = page.request.get(
            f"{API_URL}/api/research/role-benchmarks/job/{job_id}"
        )
        if benchmark_response.ok:
            benchmark = benchmark_response.json()
            if (
                isinstance(benchmark, dict)
                and benchmark.get("status") == "completed"
                and benchmark.get("sample_sufficient") is True
                and benchmark.get("run_id")
            ):
                return benchmark
            if isinstance(benchmark, dict) and benchmark.get("status") in {"failed", "blocked"}:
                raise AssertionError(f"role benchmark did not complete: {benchmark}")
        page.wait_for_timeout(500)
    raise AssertionError(f"role benchmark was not ready for job {job_id}")


def _wait_for_learning_candidate(page, target_position: str) -> dict:
    for _ in range(40):
        inbox = _json_response(page, f"{API_URL}/api/memory/inbox?status=pending&limit=100")
        item = next(
            (
                candidate
                for candidate in inbox.get("items", [])
                if target_position in str(candidate.get("title") or "")
            ),
            None,
        )
        if isinstance(item, dict):
            return item
        page.wait_for_timeout(500)
    raise AssertionError("completed interview did not create a pending Learning Candidate")


def main() -> None:
    suffix = str(int(time.time() * 1000))
    assert_release_frontend_ready()
    assert_release_backend_ready()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={"width": 1440, "height": 1000},
            accept_downloads=True,
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
            if response.status >= 400
            else None,
        )

        trace_stopped = False
        try:
            job_id, _job = _create_profile_and_job(page, suffix)
            page.wait_for_function(
                "jobId => window.location.hash.slice(1).split('?')[0] === `/jobs/${jobId}`",
                arg=job_id,
                timeout=20000,
            )
            benchmark = _wait_for_role_benchmark(page, job_id)
            tasks = _json_response(
                page,
                f"{API_URL}/api/agent/runtime/career-tasks"
                f"?target_type=job&target_id={job_id}&limit=10",
            )
            role_tasks = [
                item
                for item in tasks.get("tasks", [])
                if item.get("task_type") == "role_intelligence"
            ]
            if len(role_tasks) != 1:
                raise AssertionError(
                    f"interview smoke expected one role intelligence task, got {len(role_tasks)}"
                )
            task = role_tasks[0]
            if task.get("status") != "completed" or task.get("runtime_provider") != "replay":
                raise AssertionError(f"interview smoke must use a completed replay task: {task}")
            if benchmark.get("data_mode") not in {"fixture", "fixture_plugin"}:
                raise AssertionError(
                    "replay Interview smoke expected an explicitly fixture-backed benchmark: "
                    f"{benchmark.get('data_mode')}"
                )
            run_id = str(benchmark["run_id"])

            page.goto(
                f"{BASE_URL}/#/interview/ai?job_id={job_id}&benchmark_run_id={run_id}",
                wait_until="domcontentloaded",
            )
            block_message = (
                "当前岗位基准来自 fixture 数据，仅用于产品验收；"
                "请先采集真实岗位基准再生成专项训练。"
            )
            expect(page.get_by_role("alert")).to_contain_text(block_message, timeout=30000)
            expect(page.get_by_role("button", name="生成专项问题并开始", exact=True)).to_be_disabled()
            expect(page.get_by_test_id("interview-focus-plan")).to_have_count(0)
            expect(page.locator("textarea[aria-label='输入本题回答']")).to_have_count(0)

            focus_failures = [
                response
                for response in bad_responses
                if response.startswith("400 ") and "/api/interviews/focus-plan?" in response
            ]
            unexpected_bad_responses = [
                response for response in bad_responses if response not in focus_failures
            ]
            expected_console_errors = [message for message in console_errors if "400" in message]
            unexpected_console_errors = [
                message for message in console_errors if message not in expected_console_errors
            ]
            if len(focus_failures) != 1 or unexpected_bad_responses:
                raise AssertionError(
                    f"fixture Interview should make one explicit focus-plan rejection: {bad_responses}"
                )
            if len(expected_console_errors) != 1 or unexpected_console_errors or page_errors:
                raise AssertionError(
                    "browser errors beyond the expected fixture guard: "
                    f"console={console_errors}, page={page_errors}"
                )

            interviews_response = page.request.get(f"{API_URL}/api/interviews/?limit=100")
            if not interviews_response.ok:
                raise AssertionError("interview list request failed")
            interviews = interviews_response.json()
            if any(item.get("target_job_id") == job_id for item in interviews):
                raise AssertionError("fixture-only benchmark created an Interview")

            # The deterministic CI runtime can cover the generic interview
            # learning loop without treating replay role signals as live market
            # evidence. Keep the targeted fixture path blocked above, then
            # exercise interview completion and review without a Job benchmark.
            page.goto(f"{BASE_URL}/#/interview/ai", wait_until="domcontentloaded")
            interview_company = f"Interview Orbit {suffix}"
            interview_position = "AI 产品经理"
            page.get_by_label("目标公司（可选）", exact=True).fill(interview_company)
            page.get_by_label("目标岗位", exact=True).fill(interview_position)
            consent = page.get_by_role("checkbox")
            expect(consent).to_be_enabled(timeout=30000)
            consent.check()
            create_button = page.get_by_role("button", name="生成面试并进入房间", exact=True)
            expect(create_button).to_be_enabled(timeout=30000)
            create_button.click()

            answer_count = 0
            while not page.get_by_text("本场模拟面试报告", exact=True).is_visible():
                textarea = page.locator("textarea[aria-label='输入本题回答']")
                expect(textarea).to_be_visible(timeout=30000)
                textarea.fill(
                    "我负责模型评测流程设计，先定义指标和样本，再和工程团队复盘结果，"
                    "根据用户反馈推动两轮改进；指标和交付速度冲突时，我会记录取舍并验证结果。"
                )
                submit = page.get_by_role("button", name="提交并", exact=False)
                expect(submit).to_be_enabled(timeout=30000)
                submit.click()
                answer_count += 1
                if answer_count > 8:
                    raise AssertionError("generic replay interview did not complete within eight answers")
                page.wait_for_function(
                    """
                    () => {
                        const reportReady = Array.from(document.querySelectorAll("h1"))
                            .some((node) => node.textContent?.includes("本场模拟面试报告"));
                        const textarea = document.querySelector("textarea[aria-label='输入本题回答']");
                        const submitting = Array.from(document.querySelectorAll("button"))
                            .some((node) => node.textContent?.includes("AI 正在评估"));
                        return reportReady || Boolean(textarea && !submitting);
                    }
                    """,
                    timeout=30000,
                )

            interviews_response = page.request.get(f"{API_URL}/api/interviews/?limit=100")
            if not interviews_response.ok:
                raise AssertionError("interview list request failed")
            interviews = interviews_response.json()
            interview = next(
                (
                    item
                    for item in interviews
                    if item.get("target_company") == interview_company
                    and item.get("target_position") == interview_position
                    and item.get("status") == "completed"
                ),
                None,
            )
            if not isinstance(interview, dict):
                raise AssertionError("generic replay interview did not complete")
            interview_detail_response = page.request.get(
                f"{API_URL}/api/interviews/{interview['id']}?detail=full"
            )
            if not interview_detail_response.ok:
                raise AssertionError("interview detail request failed")
            interview_detail = interview_detail_response.json()
            messages = interview_detail.get("messages") or []
            candidate_messages = [item for item in messages if item.get("role") == "candidate"]
            if len(candidate_messages) != answer_count:
                raise AssertionError(
                    f"transcript count mismatch: UI={answer_count}, API={len(candidate_messages)}"
                )
            if not isinstance(interview_detail.get("report"), dict):
                raise AssertionError("completed interview has no report")
            if not interview_detail["report"].get("learning_candidate"):
                raise AssertionError("completed interview has no Learning Candidate reference")

            memory_item = _wait_for_learning_candidate(page, interview_position)
            page.goto(f"{BASE_URL}/#/profile", wait_until="domcontentloaded")
            page.get_by_text("职业模型", exact=True).click()
            page.get_by_text("记忆收件箱 · 待审核", exact=True).wait_for(timeout=20000)
            page.get_by_text(memory_item["title"], exact=True).first.wait_for(timeout=15000)
            accept_buttons = page.get_by_role("button", name="接受", exact=True)
            accept_buttons.last.click()
            expect(page.get_by_text("没有待审核提案", exact=True)).to_be_visible(timeout=15000)

            accepted_inbox = _json_response(
                page, f"{API_URL}/api/memory/inbox?status=all&limit=100"
            )
            accepted = next(
                item
                for item in accepted_inbox.get("items", [])
                if item.get("id") == memory_item["id"]
            )
            final_detail = _json_response(
                page, f"{API_URL}/api/interviews/{interview['id']}?detail=full"
            )
            if accepted.get("status") != "accepted":
                raise AssertionError(f"Learning Candidate was not accepted: {accepted}")
            if not accepted.get("applied_profile_section_id"):
                raise AssertionError("accepted Learning Candidate did not return a Profile section")
            if (
                final_detail.get("report", {})
                .get("learning_candidate", {})
                .get("status")
                != "accepted"
            ):
                raise AssertionError("Interview report did not reflect accepted Learning Candidate")

            focus_failures = [
                response
                for response in bad_responses
                if response.startswith("400 ") and "/api/interviews/focus-plan?" in response
            ]
            unexpected_bad_responses = [
                response for response in bad_responses if response not in focus_failures
            ]
            expected_console_errors = [message for message in console_errors if "400" in message]
            unexpected_console_errors = [
                message for message in console_errors if message not in expected_console_errors
            ]
            if len(focus_failures) != 1 or unexpected_bad_responses:
                raise AssertionError(
                    f"unexpected browser responses after the expected fixture guard: {bad_responses}"
                )
            if len(expected_console_errors) != 1 or unexpected_console_errors or page_errors:
                raise AssertionError(
                    "browser errors beyond the expected fixture guard: "
                    f"console={console_errors}, page={page_errors}"
                )

            result = {
                "status": "PASS",
                "scenario": "fixture-guard-and-generic-replay-learning",
                "job_id": job_id,
                "benchmark_run_id": run_id,
                "benchmark_data_mode": benchmark.get("data_mode"),
                "runtime_provider": task["runtime_provider"],
                "job_targeted_training_blocked": True,
                "targeted_interview_created": False,
                "generic_interview_id": interview["id"],
                "generic_answers_submitted": answer_count,
                "learning_candidate_id": memory_item["id"],
                "learning_candidate_status": accepted.get("status"),
                "profile_section_id": accepted.get("applied_profile_section_id"),
                "console_errors": console_errors,
                "page_errors": page_errors,
                "bad_responses": bad_responses,
            }
            print(json.dumps(result, ensure_ascii=True, indent=2), flush=True)
            context.tracing.stop()
            trace_stopped = True
        except Exception:
            ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
            screenshot_path = ARTIFACT_DIR / "public-release-interview-failure.png"
            trace_path = ARTIFACT_DIR / "public-release-interview-failure.zip"
            try:
                page.screenshot(path=str(screenshot_path), full_page=True)
            except Exception:
                pass
            try:
                context.tracing.stop(path=str(trace_path))
                trace_stopped = True
            except Exception:
                pass
            print(
                json.dumps(
                    {
                        "status": "FAIL",
                        "screenshot": str(screenshot_path),
                        "trace": str(trace_path),
                        "bad_responses": bad_responses,
                        "console_errors": console_errors,
                        "page_errors": page_errors,
                    },
                    ensure_ascii=True,
                    indent=2,
                ),
                flush=True,
            )
            raise
        finally:
            if not trace_stopped:
                try:
                    context.tracing.stop()
                except Exception:
                    pass
            context.close()
            browser.close()


if __name__ == "__main__":
    main()
