# =============================================
# BOSS直聘 数据源适配器 — 国内主流招聘平台
# =============================================
# 爬取策略：通过 BOSS直聘 wapi 端点 + 用户 Cookie 获取搜索结果
# 技术参考：boss-agent-cli (github.com/can4hou6joeng4/boss-agent-cli)
#
# 反爬现状 (2025-2026)：
#   - 2025.12 起禁用访客 Cookie，必须用户登录后提供 Cookie
#   - 关键 Cookie 字段：wt2 / zp_token（有效期约 7-14 天）
#   - 每页限制 15 条，浏览器 DevTools 反调试（Chrome/Edge 闪退）
#   - 高频请求触发 IP 风控和极验滑块
#
# 用户操作流程：
#   1. 在浏览器登录 zhipin.com
#   2. 复制 Cookie 粘贴到「设置 → BOSS直聘」
#   3. 后端自动携带 Cookie 调用 wapi
# =============================================

import asyncio
import hashlib
import logging
import random
from pathlib import Path
from typing import Optional

import httpx

from app.services.scrapers.base import (
    JobScraperBase,
    JobItem,
    register_scraper,
)
from app.services.security_redaction import safe_error_message
from app.services.runtime_credentials import load_scraper_cookie

logger = logging.getLogger(__name__)

def _load_boss_cookie() -> str:
    return load_scraper_cookie("boss_cookie")


class BossScraper(JobScraperBase):
    """
    BOSS直聘适配器 — 基于 wapi + 用户 Cookie
    source_name: "boss"

    核心端点（逆向自 boss-agent-cli）：
      搜索列表：/wapi/zpgeek/search/joblist.json
      职位卡片：/wapi/zpgeek/job/card.json（含福利/完整描述）

    认证方式：用户在浏览器登录 zhipin.com 后手动粘贴 Cookie
    关键 Cookie：wt2（核心认证）、zp_token
    """

    source_name = "boss"

    SEARCH_URL = "https://www.zhipin.com/wapi/zpgeek/search/joblist.json"
    CARD_URL = "https://www.zhipin.com/wapi/zpgeek/job/card.json"

    # 城市码映射（boss-agent-cli 支持 40 个城市，这里覆盖最常用的）
    CITY_CODES = {
        "全国": "100010000",
        "北京": "101010100",
        "上海": "101020100",
        "深圳": "101280600",
        "广州": "101280100",
        "杭州": "101210100",
        "成都": "101270100",
        "南京": "101190100",
        "武汉": "101200100",
        "西安": "101110100",
        "长沙": "101250100",
        "重庆": "101040100",
        "天津": "101030100",
        "苏州": "101190400",
        "郑州": "101180100",
        "合肥": "101220100",
        "厦门": "101230200",
        "大连": "101070200",
        "青岛": "101120200",
        "济南": "101120100",
        "珠海": "101280700",
        "东莞": "101281600",
        "佛山": "101280800",
        "无锡": "101190200",
        "宁波": "101210400",
        "福州": "101230100",
        "哈尔滨": "101050100",
        "沈阳": "101070100",
        "昆明": "101290100",
        "贵阳": "101260100",
    }

    # 每页最大 15 条（2025.12 后的限制）
    PAGE_SIZE = 15

    def _city_code(self, location: str) -> str:
        """城市名 → 城市码，未知城市默认全国"""
        return self.CITY_CODES.get(location, "100010000")

    def _make_hash(self, title: str, company: str, url: str) -> str:
        raw = f"{title}|{company}|{url}"
        return hashlib.md5(raw.encode()).hexdigest()

    def _build_headers(self, cookie: str) -> dict:
        """
        构造请求头 — 模拟真实浏览器访问
        关键是 Cookie、Referer、User-Agent 三件套
        """
        return {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/131.0.0.0 Safari/537.36"
            ),
            "Referer": "https://www.zhipin.com/web/geek/job",
            "Cookie": cookie,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "sec-ch-ua": '"Chromium";v="131", "Not_A Brand";v="24"',
            "sec-ch-ua-platform": '"Windows"',
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
        }

    async def _delay(self):
        """高斯分布随机延迟（模拟人类操作节奏，参考 boss-agent-cli）"""
        delay = max(1.0, random.gauss(2.0, 0.5))
        await asyncio.sleep(delay)

    async def search(
        self,
        keywords: list[str],
        location: str = "全国",
        max_results: int = 50,
    ) -> list[JobItem]:
        """
        搜索 BOSS直聘岗位
        需要用户在设置页配置有效的 Cookie（含 wt2 / zp_token）
        自动翻页，每页 15 条，最多翻 10 页（共 150 条）
        """
        cookie = _load_boss_cookie()
        if not cookie:
            logger.warning("[boss] 未配置 Cookie，跳过 BOSS直聘爬取。请在设置页粘贴 Cookie。")
            return []

        # 校验 Cookie 中是否包含关键字段
        if "wt2" not in cookie:
            logger.warning("[boss] Cookie 中缺少 wt2 字段，可能已过期或不完整。")
            return []

        results: list[JobItem] = []
        city = self._city_code(location)
        headers = self._build_headers(cookie)

        # httpx 绕过系统代理（Windows Clash 等）
        transport = httpx.AsyncHTTPTransport(proxy=None)
        async with httpx.AsyncClient(
            timeout=20.0,
            transport=transport,
            follow_redirects=True,
        ) as client:
            for kw in keywords:
                max_pages = min(10, (max_results // self.PAGE_SIZE) + 1)
                for page in range(1, max_pages + 1):
                    if len(results) >= max_results:
                        break

                    params = {
                        "query": kw,
                        "city": city,
                        "page": page,
                        "pageSize": self.PAGE_SIZE,
                    }

                    try:
                        resp = await client.get(
                            self.SEARCH_URL,
                            params=params,
                            headers=headers,
                        )

                        # 检查 HTTP 状态
                        if resp.status_code == 403:
                            logger.error("[boss] 403 Forbidden — Cookie 失效或被风控")
                            return results
                        if resp.status_code == 302:
                            logger.error("[boss] 302 重定向 — Cookie 已过期，需重新登录")
                            return results

                        data = resp.json()
                        code = data.get("code", -1)

                        # code=37 表示需要登录，code=0 表示成功
                        if code == 37:
                            logger.error("[boss] code=37 AUTH_REQUIRED — Cookie 已过期")
                            return results
                        if code != 0:
                            logger.warning(
                                "[boss] API 返回异常 code=%s",
                                code,
                            )
                            break

                        # BOSS直聘返回结构：{ zpData: { jobList: [...] } }
                        job_list = data.get("zpData", {}).get("jobList", [])
                        if not job_list:
                            break  # 无更多数据

                        for raw in job_list:
                            item = self._normalize(raw)
                            results.append(item)
                            if len(results) >= max_results:
                                break

                        logger.info("[boss] keyword_len=%d page=%d got %d items (total %d)",
                                    len(kw), page, len(job_list), len(results))

                        # 翻页延迟 — 避免触发频率限制
                        if page < max_pages and len(results) < max_results:
                            await self._delay()

                    except httpx.TimeoutException:
                        logger.warning("[boss] 请求超时 keyword_len=%d page=%d", len(kw), page)
                        break
                    except Exception as e:
                        logger.error("[boss] 请求异常: %s", safe_error_message(e))
                        break

                if len(results) >= max_results:
                    break

                # 不同关键词间也加延迟
                if keywords.index(kw) < len(keywords) - 1:
                    await self._delay()

        return results[:max_results]

    def _normalize(self, raw: dict) -> JobItem:
        """
        将 BOSS直聘原始 JSON 转为统一 JobItem
        字段映射参考 boss-agent-cli 输出格式
        """
        enc_id = raw.get("encryptJobId", "")
        lid = raw.get("lid", "")
        url = f"https://www.zhipin.com/job_detail/{enc_id}.html?lid={lid}"

        # 提取福利标签列表
        welfare = raw.get("welfareList", [])
        skills = raw.get("skills", [])

        # 拼接描述：技能标签 + 福利标签（详情需二次请求 card.json）
        desc_parts = []
        if skills:
            desc_parts.append(f"技能要求：{', '.join(skills)}")
        if welfare:
            desc_parts.append(f"福利：{', '.join(welfare)}")

        return JobItem(
            title=raw.get("jobName", ""),
            company=raw.get("brandName", ""),
            location=raw.get("cityName", ""),
            url=url,
            source="boss",
            salary=raw.get("salaryDesc", ""),
            seniority_level=raw.get("jobExperience", ""),
            employment_type=raw.get("jobDegree", ""),
            raw_description="\n".join(desc_parts),
            posted_at="",
            hash_key=self._make_hash(
                raw.get("jobName", ""),
                raw.get("brandName", ""),
                url,
            ),
            industries=raw.get("brandIndustry", ""),
            company_info={
                "size": raw.get("brandScaleName", ""),
                "industry": raw.get("brandIndustry", ""),
                "stage": raw.get("brandStageName", ""),
                "welfare": welfare,
                "skills": skills,
                "area": raw.get("areaDistrict", ""),
                "business_district": raw.get("businessDistrict", ""),
            },
        )

    async def get_detail(self, job_id: str) -> Optional[JobItem]:
        """
        获取单个岗位详情（card.json 端点）
        job_id 为 encryptJobId
        需要 Cookie 认证，高频调用易触发风控
        """
        cookie = _load_boss_cookie()
        if not cookie or "wt2" not in cookie:
            return None

        headers = self._build_headers(cookie)
        transport = httpx.AsyncHTTPTransport(proxy=None)

        try:
            async with httpx.AsyncClient(
                timeout=15.0,
                transport=transport,
            ) as client:
                resp = await client.get(
                    self.CARD_URL,
                    params={"securityId": job_id},
                    headers=headers,
                )
                data = resp.json()
                if data.get("code") != 0:
                    return None

                card = data.get("zpData", {}).get("jobCard", {})
                if not card:
                    return None

                return JobItem(
                    title=card.get("jobName", ""),
                    company=card.get("brandName", ""),
                    location=card.get("cityName", ""),
                    url=f"https://www.zhipin.com/job_detail/{job_id}.html",
                    source="boss",
                    salary=card.get("salaryDesc", ""),
                    raw_description=card.get("postDescription", ""),
                    hash_key=self._make_hash(
                        card.get("jobName", ""),
                        card.get("brandName", ""),
                        f"https://www.zhipin.com/job_detail/{job_id}.html",
                    ),
                )
        except Exception as e:
            logger.error("[boss] get_detail 异常: %s", safe_error_message(e))
            return None


# 注册到全局适配器注册表
register_scraper(BossScraper())
