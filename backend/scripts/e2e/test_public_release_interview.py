"""Portable browser acceptance for the targeted Interview learning loop.

The scenario creates its own profile and job through the visible UI, uses the
explicit replay providers, and then exercises Focus Plan -> Interviewer Mode
-> transcript-backed Debrief -> reviewed Learning Candidate.  It assumes the
isolated backend/frontend are already running, just like the other release
browser gates.
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

BASE_URL = release_frontend_url()
API_URL = release_api_url()
ARTIFACT_DIR = Path(os.getenv("OFFERU_E2E_ARTIFACT_DIR", ".e2e-artifacts"))


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
    expect(page.get_by_role("button", name="生成求职画像", exact=True)).to_be_visible(
        timeout=20000
    )
    for label in (
        "先拆目标和节奏",
        "能被看见的内容",
        "把资源和人拉起来",
        "数字结果",
        "愿意冲成长方向",
    ):
        page.get_by_role("button", name=label, exact=False).click()
    page.get_by_role("button", name="生成求职画像", exact=True).click()
    page.get_by_role("button", name="跳过", exact=True).click()
    page.get_by_text("快速创建", exact=True).wait_for(timeout=10000)
    page.get_by_text("快速创建", exact=True).click()

    page.get_by_label("姓名", exact=True).fill("OfferU Interview User")
    page.get_by_label("目标方向", exact=True).fill("AI 产品经理")
    page.get_by_label("学校", exact=True).fill("OfferU Interview University")
    page.get_by_label("专业", exact=True).fill("Computer Science")
    page.get_by_label("素材 1", exact=True).fill(
        "负责 AI 产品需求分析，协调设计与工程完成首版交付。"
    )
    page.get_by_label("素材 2", exact=True).fill(
        "建立模型评测流程，整理用户反馈并推动两轮体验改进。"
    )
    page.get_by_label("素材 3", exact=True).fill(
        "组织跨团队项目复盘，沉淀可复用的工作方法。"
    )
    page.get_by_role("button", name="创建简历", exact=True).click()
    expect(page.get_by_text("简历已就绪", exact=True)).to_be_visible(timeout=30000)

    page.get_by_role("button", name="保存第一个岗位", exact=True).click()
    page.get_by_test_id("open-add-job").wait_for(timeout=20000)
    page.get_by_test_id("open-add-job").click()
    title = "AI 产品经理"
    company = f"Interview Orbit {suffix}"
    page.get_by_test_id("add-job-title").fill(title)
    page.get_by_test_id("add-job-company").fill(company)
    page.get_by_test_id("add-job-description").fill(
        "负责 AI 产品规划、用户需求分析、评测体系建设与跨团队交付；关注 Agent 工作流和产品增长。"
    )
    page.get_by_test_id("add-job-submit").click()
    page.wait_for_url("**/jobs/*", timeout=30000)

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
            job_id, job = _create_profile_and_job(page, suffix)
            benchmark = _wait_for_role_benchmark(page, job_id)
            run_id = str(benchmark["run_id"])

            page.goto(
                f"{BASE_URL}/#/interview/ai?job_id={job_id}&benchmark_run_id={run_id}",
                wait_until="domcontentloaded",
            )
            focus_plan = page.get_by_test_id("interview-focus-plan")
            expect(focus_plan).to_be_visible(timeout=30000)
            expect(page.get_by_text("Interviewer Mode", exact=False).first).to_be_visible()
            page.get_by_role("checkbox").check()
            page.get_by_role("button", name="生成专项问题并开始", exact=True).click()

            answer_count = 0
            follow_up_seen = False
            while not page.get_by_text("本场模拟面试报告", exact=True).is_visible():
                textarea = page.locator("textarea[aria-label='输入本题回答']")
                expect(textarea).to_be_visible(timeout=30000)
                if answer_count == 0:
                    answer = "我做过评测。"
                else:
                    answer = (
                        "我在项目中负责模型评测流程设计，先定义评测指标和样本，再和工程团队复盘结果，"
                        "根据用户反馈推动两轮改进；当指标与交付速度冲突时，我会记录取舍并验证结果。"
                    )
                textarea.fill(answer)
                submit = page.get_by_role("button", name="提交并", exact=False)
                expect(submit).to_be_enabled(timeout=30000)
                submit.click()
                answer_count += 1
                if answer_count == 1:
                    expect(page.get_by_test_id("interviewer-mode-status")).to_contain_text(
                        "Adaptive follow-up", timeout=30000
                    )
                    expect(page.get_by_text("请继续补充", exact=False)).to_be_visible(timeout=30000)
                    active_text = page.get_by_test_id("interviewer-mode-status").inner_text()
                    if "做得好" in active_text or "参考答案" in active_text:
                        raise AssertionError("Interviewer Mode exposed praise or answer coaching")
                    follow_up_seen = True
                if answer_count > 8:
                    raise AssertionError("targeted interview did not complete within eight answers")
                page.wait_for_timeout(250)

            expect(page.get_by_test_id("role-interview-debrief")).to_be_visible(timeout=15000)
            page.get_by_test_id("role-interview-debrief").locator("details").first.click()
            report_body = page.locator("body").inner_text()
            if "评价引用（实际回答）" not in report_body:
                raise AssertionError("debrief did not expose transcript-backed evidence citation")
            if "我在项目中负责模型评测流程设计" not in report_body:
                raise AssertionError("debrief did not cite the submitted answer")

            interviews_response = page.request.get(f"{API_URL}/api/interviews/?limit=100")
            if not interviews_response.ok:
                raise AssertionError("interview list request failed")
            interviews = interviews_response.json()
            interview = next(
                item
                for item in interviews
                if item.get("target_job_id") == job_id and item.get("status") == "completed"
            )
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

            memory_item = _wait_for_learning_candidate(page, str(job["title"]))
            page.goto(f"{BASE_URL}/#/profile", wait_until="domcontentloaded")
            page.get_by_text("职业模型", exact=True).click()
            page.get_by_text("记忆收件箱 · 待审核", exact=True).wait_for(timeout=20000)
            page.get_by_text(memory_item["title"], exact=True).first.wait_for(timeout=15000)
            accept_buttons = page.get_by_role("button", name="接受", exact=True)
            target_accept = accept_buttons.last
            target_accept.click()
            expect(page.get_by_text("没有待审核提案", exact=True)).to_be_visible(timeout=15000)

            accepted_inbox = _json_response(page, f"{API_URL}/api/memory/inbox?status=all&limit=100")
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
            if final_detail.get("report", {}).get("learning_candidate", {}).get("status") != "accepted":
                raise AssertionError("Interview report did not reflect accepted Learning Candidate")
            if bad_responses or console_errors or page_errors:
                raise AssertionError(
                    f"browser errors: responses={bad_responses}, console={console_errors}, page={page_errors}"
                )

            result = {
                "status": "PASS",
                "job_id": job_id,
                "benchmark_run_id": run_id,
                "interview_id": interview["id"],
                "answers_submitted": answer_count,
                "interview_status": interview["status"],
                "focus_plan_visible": True,
                "interviewer_mode_follow_up": follow_up_seen,
                "debrief_visible": True,
                "transcript_message_count": len(messages),
                "learning_candidate_id": memory_item["id"],
                "learning_candidate_status": accepted.get("status"),
                "profile_section_id": accepted.get("applied_profile_section_id"),
                "report_has_evidence_review": True,
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
