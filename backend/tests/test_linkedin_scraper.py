"""The Apify token must travel in the Authorization header, never in the request URL."""

import asyncio
from types import SimpleNamespace

import httpx

from app.services.scrapers import linkedin as linkedin_module


def test_apify_token_sent_in_header_not_url(monkeypatch):
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json=[{"title": "Engineer", "companyName": "Acme", "link": "https://example.com/jobs/1"}],
        )

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        linkedin_module.httpx,
        "AsyncClient",
        lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs),
    )
    scraper = linkedin_module.LinkedInScraper()
    scraper.settings = SimpleNamespace(apify_api_key="canary-apify-token")

    items = asyncio.run(scraper.search(["engineer"], "Remote", 5))

    assert [item.title for item in items] == ["Engineer"]
    (request,) = seen
    assert "canary-apify-token" not in str(request.url)
    assert request.headers["Authorization"] == "Bearer canary-apify-token"
