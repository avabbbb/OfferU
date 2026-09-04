# =============================================
# 智联招聘 数据源适配器
# =============================================
# 爬取策略：
#   主路径：fe-api.zhaopin.com JSON API（搜索列表）
#   补充：并发请求详情页 HTML 获取完整 JD
#   认证：可选 Cookie（设置页配置），无 Cookie 时尝试匿名访问
#
# 反爬现状 (2025)：
#   - 搜索 API 可能需要有效 Cookie 才能返回数据
#   - 高频请求触发滑块验证
#   - 详情页 HTML 可用 requests 直接解析（SSR）
#
# 用户操作流程（高级）：
#   1. 在浏览器登录 zhaopin.com
#   2. 复制 Cookie 粘贴到「设置 → 智联招聘」
#   3. 后端自动携带 Cookie 调用 API
# =============================================

import asyncio
import hashlib
import logging
import random
from pathlib import Path
from typing import Optional

import httpx
from bs4 import BeautifulSoup

from app.services.scrapers.base import (
    JobScraperBase,
    JobItem,
    register_scraper,
)
from app.services.security_redaction import safe_error_message
from app.services.runtime_credentials import load_scraper_cookie

logger = logging.getLogger(__name__)

def _load_zhilian_cookie() -> str:
    return load_scraper_cookie("zhilian_cookie")


class ZhilianScraper(JobScraperBase):
    """
    智联招聘适配器
    source_name: "zhilian"

    双路径搜索：
      1. API: fe-api.zhaopin.com/c/i/sou → JSON 列表
      2. 详情: jobs.zhaopin.com/{number}.htm → HTML 解析完整 JD
    """

    source_name = "zhilian"

    # 智联招聘搜索 API（前端 SPA 调用的后端 API）
    SEARCH_URL = "https://fe-api.zhaopin.com/c/i/sou"

    # 城市码映射（智联编码体系）
    CITY_CODES = {
        "全国": "0",
        "北京": "530",
        "上海": "538",
        "深圳": "765",
        "广州": "763",
        "杭州": "653",
        "成都": "801",
        "南京": "635",
        "武汉": "736",
        "西安": "854",
        "苏州": "639",
        "长沙": "749",
        "重庆": "551",
        "天津": "531",
        "郑州": "736",
        "合肥": "664",
        "厦门": "682",
        "大连": "600",
        "青岛": "570",
        "济南": "567",
        "珠海": "766",
        "东莞": "773",
        "佛山": "771",
        "无锡": "636",
        "宁波": "654",
        "福州": "681",
        "哈尔滨": "622",
        "沈阳": "599",
        "昆明": "809",
        "贵阳": "814",
    }

    # 每页最大 90 条
    PAGE_SIZE = 90

    def _city_code(self, location: str) -> str:
        return self.CITY_CODES.get(location, "0")

    def _make_hash(self, title: str, company: str, url: str) -> str:
        raw = f"{title}|{company}|{url}"
        return hashlib.md5(raw.encode()).hexdigest()

    def _build_headers(self, cookie: str = "") -> dict:
        """构造请求头"""
        h = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/131.0.0.0 Safari/537.36"
            ),
            "Referer": "https://sou.zhaopin.com/",
            "Origin": "https://sou.zhaopin.com",
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        }
        if cookie:
            h["Cookie"] = cookie
        return h

    async def _delay(self):
        """随机延迟（1-3 秒高斯分布）"""
        delay = max(0.8, random.gauss(1.5, 0.4))
        await asyncio.sleep(delay)

    async def search(
        self,
        keywords: list[str],
        location: str = "全国",
        max_results: int = 50,
    ) -> list[JobItem]:
        """
        搜索智联招聘岗位
        1. 通过 JSON API 获取列表
        2. 并发请求详情页补全 JD
        """
        cookie = _load_zhilian_cookie()
        results: list[JobItem] = []
        seen_hashes: set[str] = set()
        city = self._city_code(location)
        headers = self._build_headers(cookie)

        # 绕过 Windows 系统代理（Clash 等）
        transport = httpx.AsyncHTTPTransport(proxy=None)
        async with httpx.AsyncClient(
            timeout=20.0,
            transport=transport,
            follow_redirects=True,
        ) as client:
            for kw in keywords:
                max_pages = min(5, (max_results // self.PAGE_SIZE) + 1)

                for page_idx in range(max_pages):
                    if len(results) >= max_results:
                        break

                    start = page_idx * self.PAGE_SIZE
                    params = {
                        "kw": kw,
                        "cityId": city,
                        "start": start,
                        "pageSize": self.PAGE_SIZE,
                        "kt": 3,
                    }

                    try:
                        resp = await client.get(
                            self.SEARCH_URL,
                            params=params,
                            headers=headers,
                        )
                        logger.info(
                            "[zhilian] keyword_len=%d page=%d status=%d",
                            len(kw), page_idx + 1, resp.status_code,
                        )

                        if resp.status_code == 403:
                            logger.warning("[zhilian] 403 Forbidden — 可能需要配置 Cookie")
                            break
                        if resp.status_code != 200:
                            logger.warning("[zhilian] HTTP %d", resp.status_code)
                            break

                        data = resp.json()
                        code = data.get("code")

                        if code != 200:
                            logger.warning(
                                "[zhilian] API returned non-success code=%s",
                                code,
                            )
                            break

                        job_list = data.get("data", {}).get("results", [])
                        if not job_list:
                            break

                        for raw in job_list:
                            item = self._normalize(raw)
                            if item.hash_key not in seen_hashes:
                                seen_hashes.add(item.hash_key)
                                results.append(item)
                            if len(results) >= max_results:
                                break

                        logger.info(
                            "[zhilian] keyword_len=%d page=%d got %d items (total %d)",
                            len(kw), page_idx + 1, len(job_list), len(results),
                        )

                        # 翻页延迟
                        if page_idx < max_pages - 1 and len(results) < max_results:
                            await self._delay()

                    except httpx.TimeoutException:
                        logger.warning("[zhilian] 请求超时 keyword_len=%d page=%d", len(kw), page_idx + 1)
                        break
                    except Exception as e:
                        logger.warning(
                            "[zhilian] 请求异常: %s",
                            safe_error_message(e),
                        )
                        break

                if len(results) >= max_results:
                    break

                # 不同关键词间加延迟
                if keywords.index(kw) < len(keywords) - 1:
                    await self._delay()

            # ---- 并发请求详情页补全 JD ----
            sem = asyncio.Semaphore(5)

            async def _enrich(item: JobItem) -> None:
                if not item.url:
                    return
                async with sem:
                    try:
                        resp = await client.get(
                            item.url,
                            headers={
                                "User-Agent": headers["User-Agent"],
                                "Referer": "https://sou.zhaopin.com/",
                            },
                        )
                        if resp.status_code != 200:
                            return
                        soup = BeautifulSoup(resp.text, "html.parser")

                        # 完整 JD（职位描述）
                        jd_el = soup.select_one(
                            ".describtion__detail-content, "
                            ".describtion, "
                            ".job-description, "
                            ".pos-ul"
                        )
                        if jd_el:
                            item.raw_description = jd_el.get_text(
                                separator="\n", strip=True
                            )
                    except Exception:
                        pass

            await asyncio.gather(*[_enrich(item) for item in results])

        return results[:max_results]

    def _normalize(self, raw: dict) -> JobItem:
        """将智联招聘 API 原始 JSON 转为统一 JobItem"""
        number = raw.get("number", "")
        url = f"https://jobs.zhaopin.com/{number}.htm" if number else ""

        title = raw.get("jobName", "")
        company = raw.get("company", {}).get("name", "")
        city = raw.get("city", {}).get("display", "")
        salary = raw.get("salary", "")

        return JobItem(
            title=title,
            company=company,
            location=city,
            url=url,
            source="zhilian",
            salary=salary,
            seniority_level=raw.get("workingExp", {}).get("name", ""),
            employment_type=raw.get("eduLevel", {}).get("name", ""),
            raw_description="",  # 详情由 _enrich 补全
            posted_at=raw.get("updateDate", ""),
            hash_key=self._make_hash(title, company, url),
            industries=raw.get("company", {}).get("type", {}).get("name", ""),
            company_info={
                "size": raw.get("company", {}).get("size", {}).get("name", ""),
                "type": raw.get("company", {}).get("type", {}).get("name", ""),
            },
        )

    async def get_detail(self, job_id: str) -> Optional[JobItem]:
        """获取单个岗位详情页"""
        url = f"https://jobs.zhaopin.com/{job_id}.htm"
        transport = httpx.AsyncHTTPTransport(proxy=None)
        try:
            async with httpx.AsyncClient(
                timeout=15.0, transport=transport
            ) as client:
                resp = await client.get(url, headers=self._build_headers())
                if resp.status_code != 200:
                    return None
                soup = BeautifulSoup(resp.text, "html.parser")

                title_el = soup.select_one(".inner-left h1, .l-jobid-content h1")
                title = title_el.get_text(strip=True) if title_el else ""

                jd_el = soup.select_one(
                    ".describtion__detail-content, .describtion, .pos-ul"
                )
                jd = jd_el.get_text(separator="\n", strip=True) if jd_el else ""

                return JobItem(
                    title=title,
                    company="",
                    url=url,
                    source="zhilian",
                    raw_description=jd,
                    hash_key=self._make_hash(title, "", url),
                )
        except Exception as e:
            logger.warning(
                "[zhilian] get_detail 异常: %s",
                safe_error_message(e),
            )
            return None


# 注册到全局适配器注册表
register_scraper(ZhilianScraper())
