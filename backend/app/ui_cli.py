"""
UI Automation CLI — let Agent drive the frontend like a real user.

Commands:
    offeru ui open <url>           — navigate to URL
    offeru ui click <text>         — click element by text
    offeru ui fill <selector> <v>  — fill input by selector
    offeru ui eval <js>            — execute JavaScript
    offeru ui screenshot <path>    — take screenshot
    offeru ui content              — get page text
    offeru ui wait <seconds>       — wait for page load
    offeru ui batch <script>       — run a JSON script of commands

Batch script format (JSON):
    [
        {"cmd": "open", "args": ["http://127.0.0.1:7410/#/jobs/1"]},
        {"cmd": "click", "args": ["打开 Resume Workspace"]},
        {"cmd": "wait", "args": [3]},
        {"cmd": "screenshot", "args": ["step1.png"]}
    ]

Uses Playwright managed Chromium (headless by default per AGENTS.md).
Set OFFERU_UI_HEADLESS=0 for visible browser (user-driven only).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Optional

from playwright.sync_api import sync_playwright, Browser, Page, BrowserContext


# ── Config ──────────────────────────────────────────────────────────────

DEFAULT_FRONTEND = "http://127.0.0.1:7410"
DEFAULT_BACKEND = "http://127.0.0.1:8766"
HEADLESS = os.environ.get("OFFERU_UI_HEADLESS", "1") != "0"
VIEWPORT = {"width": 1400, "height": 900}
TIMEOUT = 15000


# ── Browser Session ─────────────────────────────────────────────────────

class UISession:
    """Browser session for UI automation."""

    def __init__(self, headless: bool = HEADLESS):
        self.headless = headless
        self._playwright = None
        self._browser: Optional[Browser] = None
        self._context: Optional[BrowserContext] = None
        self._page: Optional[Page] = None

    def start(self):
        """Launch browser and create page."""
        self._playwright = sync_playwright().start()
        self._browser = self._playwright.chromium.launch(
            headless=self.headless,
            args=["--start-maximized"] if not self.headless else [],
        )
        self._context = self._browser.new_context(viewport=VIEWPORT)
        self._page = self._context.new_page()
        return self

    def stop(self):
        """Clean up browser resources."""
        if self._browser:
            self._browser.close()
        if self._playwright:
            self._playwright.stop()

    @property
    def page(self) -> Page:
        if not self._page:
            raise RuntimeError("Browser not started. Call start() first.")
        return self._page

    def __enter__(self):
        return self.start()

    def __exit__(self, *args):
        self.stop()


# ── Commands ─────────────────────────────────────────────────────────────

def cmd_open(url: str, session: UISession) -> dict:
    """Navigate to URL."""
    page = session.page
    page.goto(url, wait_until="domcontentloaded", timeout=TIMEOUT)
    page.wait_for_timeout(2000)
    return {
        "ok": True,
        "url": page.url,
        "title": page.title(),
        "content_preview": page.evaluate("document.body.innerText.slice(0, 500)"),
    }


def cmd_click(text: str, session: UISession) -> dict:
    """Click element containing text."""
    page = session.page
    result = page.evaluate(f"""
        (function() {{
            var els = Array.from(document.querySelectorAll('button, a, [role="button"], [role="link"]'));
            var t = els.find(e => e.innerText.trim().includes('{text}') && !e.disabled);
            if (t) {{
                t.click();
                return {{ clicked: true, text: t.innerText.trim().slice(0, 50), tag: t.tagName }};
            }}
            return {{ clicked: false, available: els.map(e => e.innerText.trim()).filter(t => t.length > 0 && t.length < 50).slice(0, 20) }};
        }})()
    """)
    page.wait_for_timeout(1000)
    return {"ok": result.get("clicked", False), **result}


def cmd_fill(selector: str, value: str, session: UISession) -> dict:
    """Fill input field by selector."""
    page = session.page
    result = page.evaluate(f"""
        (function() {{
            var el = document.querySelector('{selector}');
            if (!el) {{
                el = Array.from(document.querySelectorAll('input, textarea')).find(e => 
                    e.placeholder && e.placeholder.includes('{selector}')
                );
            }}
            if (el) {{
                el.value = '{value}';
                el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                return {{ filled: true, tag: el.tagName, type: el.type }};
            }}
            return {{ filled: false, available: Array.from(document.querySelectorAll('input, textarea')).map(e => ({{
                tag: e.tagName, type: e.type, placeholder: e.placeholder, id: e.id
            }})).slice(0, 10) }};
        }})()
    """)
    return {"ok": result.get("filled", False), **result}


def cmd_eval(js: str, session: UISession) -> dict:
    """Execute JavaScript in page context."""
    page = session.page
    try:
        result = page.evaluate(js)
        return {"ok": True, "result": result}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def cmd_screenshot(path: str, session: UISession) -> dict:
    """Take screenshot."""
    page = session.page
    page.screenshot(path=path, full_page=False)
    return {"ok": True, "path": path}


def cmd_content(session: UISession) -> dict:
    """Get page text content."""
    page = session.page
    return {
        "ok": True,
        "url": page.url,
        "title": page.title(),
        "content": page.evaluate("document.body.innerText"),
    }


def cmd_wait(seconds: float, session: UISession) -> dict:
    """Wait for page to settle."""
    page = session.page
    page.wait_for_timeout(int(seconds * 1000))
    return {"ok": True, "waited": seconds}


def cmd_batch(script_path: str, session: UISession) -> dict:
    """Run a batch of commands from JSON script."""
    script_file = Path(script_path)
    if not script_file.exists():
        return {"ok": False, "error": f"Script not found: {script_path}"}
    
    try:
        commands = json.loads(script_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        return {"ok": False, "error": f"Invalid JSON: {e}"}
    
    if not isinstance(commands, list):
        return {"ok": False, "error": "Script must be a JSON array of commands"}
    
    results = []
    for i, cmd in enumerate(commands):
        cmd_name = cmd.get("cmd")
        cmd_args = cmd.get("args", [])
        result = _run_command(cmd_name, cmd_args, session)
        results.append({"step": i, "cmd": cmd_name, "args": cmd_args, **result})
        if not result.get("ok"):
            break
    
    return {"ok": all(r.get("ok") for r in results), "steps": results}


def _run_command(command: str, args: list, session: UISession) -> dict:
    """Run a single command in the given session."""
    try:
        if command == "open":
            url = args[0] if args else DEFAULT_FRONTEND
            return cmd_open(url, session)
        elif command == "click":
            return cmd_click(args[0] if args else "", session)
        elif command == "fill":
            return cmd_fill(args[0] if args else "", args[1] if len(args) > 1 else "", session)
        elif command == "eval":
            return cmd_eval(args[0] if args else "", session)
        elif command == "screenshot":
            return cmd_screenshot(args[0] if args else "screenshot.png", session)
        elif command == "content":
            return cmd_content(session)
        elif command == "wait":
            return cmd_wait(float(args[0]) if args else 1.0, session)
        elif command == "batch":
            return cmd_batch(args[0] if args else "", session)
        else:
            return {"ok": False, "error": f"Unknown command: {command}"}
    except Exception as e:
        return {"ok": False, "error": str(e), "type": type(e).__name__}


# ── CLI Entry ────────────────────────────────────────────────────────────

def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(json.dumps({"ok": False, "error": "Usage: offeru ui <command> [args]"}, ensure_ascii=False))
        return 2

    command = argv[1]
    args = argv[2:]

    with UISession() as session:
        result = _run_command(command, args, session)

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
