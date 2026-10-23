# =============================================
# LinkedIn 数据源适配器 — Apify 版
# =============================================
# 复用 Apify LinkedIn Jobs Scraper
# 通过 Apify API 直接调用
# =============================================

import hashlib
from typing import Optional

import httpx

from app.config import get_settings
from app.services.scrapers.base import JobScraperBase, JobItem, register_scraper


class LinkedInScraper(JobScraperBase):
    source_name = "linkedin"

    def __init__(self):
        self.settings = get_settings()
        self.actor_id = "curious_coder~linkedin-jobs-scraper"

    async def search(
        self,
        keywords: list[str],
        location: str = "China",
        max_results: int = 50,
    ) -> list[JobItem]:
        """通过 Apify Actor 抓取 LinkedIn 岗位"""
        if not self.settings.apify_api_key:
            return []

        # 构建搜索 URL 列表
        urls = [
            f"https://www.linkedin.com/jobs/search?keywords={kw.replace(' ', '%20')}"
            f"&location={location.replace(' ', '%20')}&f_TPR=r86400"
            for kw in keywords
        ]

        payload = {
            "count": max_results,
            "scrapeCompany": True,
            "urls": urls,
        }

        api_url = f"https://api.apify.com/v2/acts/{self.actor_id}/run-sync-get-dataset-items"
        headers = {"Authorization": f"Bearer {self.settings.apify_api_key}"}

        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(api_url, json=payload, headers=headers)
            if resp.status_code != 200:
                return []
            raw_items = resp.json()

        return [self._normalize(item) for item in raw_items if isinstance(item, dict)]

    async def get_detail(self, job_id: str) -> Optional[JobItem]:
        return None  # LinkedIn 详情已包含在搜索结果中

    def _normalize(self, raw: dict) -> JobItem:
        """将 Apify 原始数据转换为统一 JobItem 格式"""
        title = (raw.get("title") or "").strip()
        company = (raw.get("companyName") or "").strip()
        url = (raw.get("link") or raw.get("applyUrl") or "").strip()

        # 生成去重 hash
        hash_str = f"{title}|{company}|{url}"
        hash_key = hashlib.md5(hash_str.encode()).hexdigest()[:16]

        return JobItem(
            title=title,
            company=company,
            location=(raw.get("location") or "").strip(),
            url=url,
            apply_url=raw.get("applyUrl") or "",
            source="linkedin",
            raw_description=str(raw.get("descriptionText") or raw.get("description") or ""),
            posted_at=raw.get("postedAt") or "",
            seniority_level=raw.get("seniorityLevel") or "",
            employment_type=raw.get("employmentType") or "",
            industries=raw.get("industries") or "",
            salary=raw.get("salary") or "",
            hash_key=hash_key,
            company_info={
                "website": raw.get("companyWebsite") or "",
                "description": raw.get("companyDescription") or "",
                "employees": raw.get("companyEmployeesCount"),
                "logo": raw.get("companyLogo") or "",
            },
        )


# 注册到全局适配器表
register_scraper(LinkedInScraper())
