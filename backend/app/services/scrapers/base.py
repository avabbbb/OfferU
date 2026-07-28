# =============================================
# 数据源适配器基类 — 可插拔多平台爬取架构
# =============================================
# 所有平台爬虫继承此基类，实现统一接口
# 新增平台只需要：
#   1. 新建 xxxScraper(JobScraperBase) 类
#   2. 实现 search() 和 get_detail() 方法
#   3. 在 registry 中注册
# =============================================

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class JobItem:
    """统一的岗位数据结构，所有平台爬取结果都转换为此格式"""
    title: str
    company: str
    location: str = ""
    url: str = ""
    apply_url: str = ""
    source: str = ""
    raw_description: str = ""
    posted_at: str = ""
    seniority_level: str = ""
    employment_type: str = ""
    industries: str = ""
    salary: str = ""
    hash_key: str = ""
    company_info: dict = field(default_factory=dict)


class JobScraperBase(ABC):
    """
    数据源适配器基类
    每个平台实现一个子类，提供统一的 search / get_detail 接口
    """
    source_name: str = "unknown"

    @abstractmethod
    async def search(
        self,
        keywords: list[str],
        location: str = "",
        max_results: int = 50,
    ) -> list[JobItem]:
        """
        执行搜索，返回统一格式的岗位列表
        - keywords: 搜索关键词列表（如 ["Data Scientist", "Python"]）
        - location: 地区筛选
        - max_results: 最大返回数量
        """
        raise NotImplementedError

    @abstractmethod
    async def get_detail(self, job_id: str) -> Optional[JobItem]:
        """获取单个岗位详情"""
        raise NotImplementedError


# ---- 适配器注册表 ----
# 通过 source_name 查找对应的适配器实例
_registry: dict[str, JobScraperBase] = {}
_loaded = False


def _load_builtin_scrapers() -> None:
    global _loaded
    if _loaded:
        return
    _loaded = True
    from app.services.scrapers import boss, corporate, linkedin, shixiseng, zhilian  # noqa: F401
    try:
        from app.services.scrapers import jobspy  # noqa: F401
    except ImportError:
        pass


def register_scraper(scraper: JobScraperBase):
    """注册一个数据源适配器"""
    _registry[scraper.source_name] = scraper


def get_scraper(source_name: str) -> Optional[JobScraperBase]:
    """根据名称获取适配器"""
    _load_builtin_scrapers()
    return _registry.get(source_name)


def get_all_scrapers() -> dict[str, JobScraperBase]:
    """获取所有已注册的适配器"""
    _load_builtin_scrapers()
    return dict(_registry)
