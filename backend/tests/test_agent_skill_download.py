from __future__ import annotations

import unittest
from unittest.mock import patch

import httpx
from fastapi import FastAPI

from app.routes import main_agent


class AgentSkillDownloadTests(unittest.IsolatedAsyncioTestCase):
    async def test_download_returns_only_the_skill_as_an_attachment(self) -> None:
        test_app = FastAPI()
        test_app.include_router(main_agent.runtime_router, prefix="/api/agent")
        with patch(
            "app.services.agent_integration.installed_skill_content",
            return_value="---\nname: offeru\n---\nSkill instructions",
        ):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=test_app),
                base_url="http://127.0.0.1:8766",
            ) as client:
                response = await client.get("/api/agent/runtime/skill")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"---\nname: offeru\n---\nSkill instructions")
        self.assertTrue(response.headers["content-type"].startswith("text/markdown"))
        self.assertIn('filename="offeru-SKILL.md"', response.headers["content-disposition"])
        self.assertEqual(response.headers["cache-control"], "no-store")


if __name__ == "__main__":
    unittest.main()
