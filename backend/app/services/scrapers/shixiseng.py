# =============================================
# 实习僧 数据源适配器 — 面向实习/校招
# =============================================
# 爬取策略：
#   1. 请求实习僧搜索页面 HTML（SSR 渲染）
#   2. 使用 BeautifulSoup 解析岗位列表卡片
#   3. 提取标题、公司、城市、薪资、链接等字段
#   4. 可选：二次请求详情页获取完整 JD
# 特点：
#   - 专注于实习/校招岗位（适合在校生/应届生）
#   - 反爬力度相对较低，无需登录/Cookie
#   - 支持分页抓取（每页约 20 条）
# =============================================

import asyncio
import hashlib
import logging
import re
from typing import Optional
from urllib.parse import quote

import httpx
from bs4 import BeautifulSoup

from app.services.scrapers.base import (
    JobScraperBase,
    JobItem,
    register_scraper,
)
from app.services.security_redaction import safe_error_message

logger = logging.getLogger(__name__)


class ShixisengScraper(JobScraperBase):
    """
    实习僧适配器
    source_name: "shixiseng"

    流程：
      1. GET /interns?k={keyword}&city={city}&page={p} 拿到搜索列表 HTML
      2. BeautifulSoup 解析列表卡片 → JobItem
      3. （可选）请求 /intern/{id} 获取完整 JD
    """

    source_name = "shixiseng"

    BASE_URL = "https://www.shixiseng.com"
    SEARCH_URL = "https://www.shixiseng.com/interns"

    HEADERS = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/125.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": "https://www.shixiseng.com/",
    }

    def _make_hash(self, title: str, company: str, url: str) -> str:
        raw = f"{title}|{company}|{url}"
        return hashlib.md5(raw.encode()).hexdigest()

    async def search(
        self,
        keywords: list[str],
        location: str = "全国",
        max_results: int = 50,
    ) -> list[JobItem]:
        """
        搜索实习僧岗位（HTML 解析模式）
        1. 列表页获取基础信息（公司、城市、行业、链接）
        2. 并发请求详情页补全标题 + JD（列表页标题被字体加密截断）
        """
        results: list[JobItem] = []
        seen_hashes: set[str] = set()

        try:
            # 使用自定义 transport 绕过系统代理（国内网站直连）
            transport = httpx.AsyncHTTPTransport(retries=1)
            async with httpx.AsyncClient(
                timeout=15.0,
                follow_redirects=True,
                transport=transport,
            ) as client:
                for kw in keywords:
                    page = 1
                    max_pages = 3

                    while page <= max_pages and len(results) < max_results:
                        params = {
                            "k": kw,
                            "city": location,
                            "page": str(page),
                        }
                        try:
                            resp = await client.get(
                                self.SEARCH_URL,
                                params=params,
                                headers=self.HEADERS,
                            )
                            logger.warning(
                                "[shixiseng] kw=%s page=%s status=%s len=%s",
                                kw, page, resp.status_code, len(resp.text),
                            )
                            if resp.status_code != 200:
                                break

                            items = self._parse_search_page(resp.text)
                            logger.warning(
                                "[shixiseng] parsed %s items from page %s",
                                len(items), page,
                            )
                            if not items:
                                break

                            for item in items:
                                if item.hash_key not in seen_hashes:
                                    seen_hashes.add(item.hash_key)
                                    results.append(item)
                                if len(results) >= max_results:
                                    break

                            page += 1
                        except Exception as exc:
                            logger.warning(
                                "[shixiseng] search error: %s",
                                safe_error_message(exc),
                            )
                            break

                    if len(results) >= max_results:
                        break

                # ---- 并发请求详情页补全标题 + JD ----
                sem = asyncio.Semaphore(5)

                async def _enrich(item: JobItem) -> None:
                    async with sem:
                        try:
                            resp = await client.get(
                                item.url,
                                headers=self.HEADERS,
                            )
                            if resp.status_code != 200:
                                return
                            soup = BeautifulSoup(resp.text, "html.parser")

                            # 完整标题（详情页无字体加密）
                            name_el = soup.select_one(".new_job_name")
                            if name_el:
                                full_title = name_el.get_text(strip=True)
                                if full_title:
                                    item.title = full_title

                            # 完整 JD
                            jd_el = soup.select_one(".job_detail")
                            if jd_el:
                                item.raw_description = jd_el.get_text(
                                    separator="\n", strip=True
                                )

                            # 薪资（详情页可能有明文）
                            salary_el = soup.select_one(".job_money")
                            if salary_el:
                                s = salary_el.get_text(strip=True)
                                if s:
                                    item.salary = s
                        except Exception:
                            pass

                await asyncio.gather(*[_enrich(item) for item in results])
        except Exception as exc:
            logger.warning(
                "[shixiseng] unexpected error: %s",
                safe_error_message(exc),
            )

        return results[:max_results]

    @staticmethod
    def _strip_font_encrypt(text: str) -> str:
        """
        去除实习僧字体加密产生的 PUA 乱码字符
        
        实习僧使用两层反爬：
        1. HTML 属性中的双重转义实体: &amp;#xe5d8; → BeautifulSoup 解析后变为 &#xe5d8;
        2. 页面文本中的 Unicode PUA 字符: U+E000 – U+F8FF
        
        处理步骤：
        1. 将 &#xNNNN; 格式的文本实体解码为 Unicode 字符
        2. 过滤 Unicode PUA 私有区字符
        """
        # Step 1: 将 &#xHHHH; 或 &#xHHH; 文本还原为 Unicode 字符
        def _decode_entity(m):
            try:
                return chr(int(m.group(1), 16))
            except (ValueError, OverflowError):
                return ""
        text = re.sub(r'&#x([0-9a-fA-F]{3,5});?', _decode_entity, text)

        # Step 2: 过滤 PUA 字符区 (E000-F8FF)
        text = re.sub(r'[\ue000-\uf8ff]', '', text)

        return text.strip()

    def _parse_search_page(self, html: str) -> list[JobItem]:
        """
        解析实习僧搜索结果页 HTML
        
        实际 DOM 结构（2025-07）：
        div.intern-wrap.intern-item[data-intern-id="inn_xxx"]
          └─ div.intern-detail
              ├─ div.intern-detail__job
              │    ├─ p > a.title[href, title]   ← 岗位标题+链接
              │    │       span.day              ← 薪资 (/天)
              │    └─ p.tip > span.city          ← 城市
              └─ div.intern-detail__company
                   └─ p > a.title[title]         ← 公司名
        
        注意: 网站使用自定义字体加密，文本中夹杂 PUA 字符（U+E000-U+F8FF），
        需要过滤后保留可见中文。
        """
        soup = BeautifulSoup(html, "html.parser")
        items: list[JobItem] = []

        cards = soup.select(".intern-wrap")
        for card in cards:
            # ---- intern-id / URL ----
            intern_id = card.get("data-intern-id", "")
            job_link = card.select_one(".intern-detail__job a.title")
            if not job_link:
                continue

            href = job_link.get("href", "")
            if not href or "/intern/inn_" not in href:
                continue
            url = href if href.startswith("http") else f"{self.BASE_URL}{href}"
            url = url.split("?")[0]  # 去掉 pcm 参数

            # ---- 标题 ----
            # title 属性包含完整标题（含加密字符），过滤后得到真实中文
            raw_title = job_link.get("title", "") or job_link.get_text(strip=True)
            title = self._strip_font_encrypt(raw_title)
            if not title:
                title = self._strip_font_encrypt(job_link.get_text(strip=True))
            if not title:
                continue

            # ---- 公司 ----
            company = ""
            company_el = card.select_one(".intern-detail__company a.title")
            if company_el:
                company = company_el.get("title", "") or company_el.get_text(strip=True)

            # ---- 城市 ----
            city = ""
            city_el = card.select_one(".intern-detail__job .city")
            if city_el:
                city = city_el.get_text(strip=True)

            # ---- 薪资 ----
            salary = ""
            salary_el = card.select_one(".intern-detail__job .day")
            if salary_el:
                raw_salary = self._strip_font_encrypt(salary_el.get_text(strip=True))
                # 加密后可能只剩 "/天" — 检查是否有有效数字
                if re.search(r'\d', raw_salary):
                    salary = raw_salary
                else:
                    salary = raw_salary  # 仍然保留原文如 "/天"

            # ---- 行业（从公司区域提取） ----
            industry = ""
            company_div = card.select_one(".intern-detail__company")
            if company_div:
                comp_text = company_div.get_text(separator="|", strip=True)
                industry_match = re.search(
                    r'(互联网|游戏|软件|金融|医疗|教育|汽车|制造|'
                    r'电子|通信|传媒|设计|咨询|贸易|物流|'
                    r'人工智能|生物|健康|制药|新能源|房产|'
                    r'电商|外贸|物联网|区块链)',
                    comp_text,
                )
                if industry_match:
                    industry = industry_match.group(1)

            # ---- 标签（周末双休/可转正等） ----
            labels = [
                span.get_text(strip=True)
                for span in card.select(".intern-label span")
                if span.get_text(strip=True)
            ]

            item = JobItem(
                title=title,
                company=company,
                location=city,
                url=url,
                source="shixiseng",
                salary=salary,
                seniority_level="实习",
                employment_type="实习",
                raw_description="",  # 需要二次请求详情页
                hash_key=self._make_hash(title, company, url),
                company_info={
                    "industry": industry,
                    "tags": labels,
                    "intern_id": intern_id,
                },
            )
            items.append(item)

        return items

    async def get_detail(self, job_id: str) -> Optional[JobItem]:
        """
        获取单个实习岗详情（完整 JD）
        job_id: 实习僧岗位 ID，如 inn_flxo0zj9ho57
        """
        url = f"{self.BASE_URL}/intern/{job_id}"
        try:
            async with httpx.AsyncClient(
                timeout=15.0, follow_redirects=True,
            ) as client:
                resp = await client.get(url, headers=self.HEADERS)
                if resp.status_code != 200:
                    return None

                soup = BeautifulSoup(resp.text, "html.parser")

                # 岗位详情区域 — 多种备选选择器
                desc_el = soup.select_one(
                    '.intern_position_detail, .job_detail, '
                    '.intern-detail-desc, [class*="job_detail"], '
                    '[class*="position_detail"]'
                )
                description = ""
                if desc_el:
                    description = desc_el.get_text(separator="\n", strip=True)

                # 标题
                title_el = soup.select_one(
                    '.intern_position_name, .new_job_name, '
                    'h1, .intern-name'
                )
                title = ""
                if title_el:
                    title = self._strip_font_encrypt(
                        title_el.get("title", "") or title_el.get_text(strip=True)
                    )

                # 公司
                company_el = soup.select_one(
                    '.com_name, .company-name, [class*="company"] a'
                )
                company = ""
                if company_el:
                    company = company_el.get("title", "") or company_el.get_text(strip=True)

                return JobItem(
                    title=title,
                    company=company,
                    url=url,
                    source="shixiseng",
                    raw_description=description,
                    hash_key=self._make_hash(title, company, url),
                )
        except Exception:
            return None


# 注册到全局适配器注册表
register_scraper(ShixisengScraper())
