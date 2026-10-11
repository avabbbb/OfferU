"""Browser matrix for actionable empty states in the public-release shell.

The test uses a fresh isolated backend database and checks the user-visible
pages without seeding business records.  It intentionally exercises the same
routes a new user can reach from the primary navigation.
"""

from __future__ import annotations

import json
import time

from playwright.sync_api import expect, sync_playwright

from release_endpoints import assert_release_frontend_ready, release_frontend_url

BASE_URL = release_frontend_url()


def _open(page, path: str) -> None:
    separator = "&" if "?" in path else "?"
    page.goto(f"{BASE_URL}/#/{path.lstrip('/')}"
              f"{separator}empty_state={int(time.time() * 1000)}", wait_until="domcontentloaded")
    page.wait_for_timeout(800)


def main() -> None:
    assert_release_frontend_ready()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 1000})
        page = context.new_page()
        bad_responses: list[str] = []
        console_errors: list[str] = []
        page_errors: list[str] = []
        page.on(
            "response",
            lambda response: bad_responses.append(f"{response.status} {response.url}")
            if response.status >= 400
            else None,
        )
        page.on(
            "console",
            lambda message: console_errors.append(message.text)
            if message.type == "error"
            else None,
        )
        page.on("pageerror", lambda error: page_errors.append(str(error)))

        try:
            page.goto(f"{BASE_URL}/#/?empty_state={int(time.time() * 1000)}", wait_until="domcontentloaded")
            page.evaluate("localStorage.clear()")
            page.reload(wait_until="domcontentloaded")
            skip = page.get_by_role("button", name="跳过", exact=True)
            if skip.count():
                expect(skip).to_be_visible(timeout=20000)
                skip.click()

            expect(page.get_by_text("还没有岗位数据", exact=True)).to_be_visible(timeout=20000)
            expect(page.get_by_text("保存第一个岗位", exact=True)).to_be_visible()
            expect(page.get_by_text("暂无进行中的投递", exact=False)).to_be_visible(timeout=20000)
            expect(page.get_by_text("近 7 天没有安排", exact=False)).to_be_visible(timeout=20000)

            _open(page, "/jobs")
            expect(page.get_by_text("暂无岗位结果", exact=True)).to_be_visible(timeout=20000)
            expect(page.get_by_text("当前筛选", exact=False).first).to_be_visible()
            expect(page.get_by_test_id("empty-add-job")).to_be_visible()

            _open(page, "/applications?view=board")
            expect(page.get_by_text("暂无进行中的投递", exact=False)).to_be_visible(timeout=20000)
            expect(page.get_by_text("从「岗位」页挑选岗位创建投递", exact=False)).to_be_visible()

            _open(page, "/profile")
            expect(page.get_by_text("还没有记录经历", exact=True)).to_be_visible(timeout=20000)
            profile_text = page.locator("body").inner_text()
            for required in ("去补充", "还没有确定目标岗位", "还没有记录经历", "还没有记录技能、证书或奖项"):
                if required not in profile_text:
                    raise AssertionError(f"Profile empty fact guidance missing: {required!r}")

            _open(page, "/resume")
            expect(page.get_by_text("还没有简历", exact=True)).to_be_visible(timeout=20000)
            expect(
                page.get_by_text(
                    "上传一份现有简历最快，OfferU 会把内容拆进档案，由你确认后再使用；也可以从空白开始。",
                    exact=True,
                )
            ).to_be_visible()
            new_resume_button = page.get_by_role("button", name="新建简历", exact=True).last
            expect(new_resume_button).to_be_visible()
            new_resume_button.click()
            create_dialog = page.get_by_role("dialog")
            expect(create_dialog).to_be_visible()
            expect(create_dialog.get_by_role("heading", name="新建简历", exact=True)).to_be_visible()
            create_dialog.get_by_role("button", name="创建并编辑", exact=True).click()
            page.wait_for_function(
                "() => /^#\\/resume\\/\\d+/.test(window.location.hash)",
                timeout=20000,
            )
            expect(page.get_by_test_id("resume-name-input")).to_be_visible(timeout=20000)
            expect(page.get_by_test_id("resume-save-version")).to_be_visible()
            expect(page.get_by_test_id("resume-workspace-error")).to_have_count(0)
            expect(page.get_by_role("alert")).to_have_count(0)
            resume_text = page.locator("body").inner_text().lower()
            raw_json_markers = ('"raw_json"', '"rawjson"', '{"id":', '"resume_id":')
            if any(marker in resume_text for marker in raw_json_markers):
                raise AssertionError("Resume workspace rendered raw API JSON")

            unexpected_responses = [
                response
                for response in bad_responses
                if "/_next/" not in response and "favicon" not in response
            ]
            if unexpected_responses or console_errors or page_errors:
                raise AssertionError(
                    "empty-state browser errors: "
                    f"responses={unexpected_responses}, console={console_errors}, page={page_errors}"
                )

            print(
                json.dumps(
                    {
                        "status": "PASS",
                        "routes": ["/", "/jobs", "/applications?view=board", "/profile", "/resume"],
                        "assertions": [
                            "Today explains empty workspace and next action",
                            "Opportunity offers first-job action",
                            "Pipeline explains how to create the first application",
                            "Profile exposes first-facts onboarding",
                            "Resume empty state opens the editor through its create action",
                            "Resume workspace exposes no raw API JSON or error state",
                        ],
                        "bad_responses": unexpected_responses,
                        "console_errors": console_errors,
                        "page_errors": page_errors,
                    },
                    ensure_ascii=True,
                    indent=2,
                ),
                flush=True,
            )
        finally:
            context.close()
            browser.close()


if __name__ == "__main__":
    main()
