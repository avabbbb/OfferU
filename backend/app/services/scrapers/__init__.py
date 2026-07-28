"""Scraper package.

Adapters are loaded lazily by ``base.get_scraper`` / ``get_all_scrapers`` so
opening OfferU does not import every crawler and browser dependency.
"""

from app.services.scrapers.base import JobItem, JobScraperBase, get_all_scrapers, get_scraper, register_scraper

__all__ = ["JobItem", "JobScraperBase", "get_all_scrapers", "get_scraper", "register_scraper"]
