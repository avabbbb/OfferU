"""Agent-friendly public job-search capability for OfferU.

The source is the public Arbeitnow Job Board API.  This process has no OfferU
database access: it only returns source candidates to the Capability Gateway.
"""

from __future__ import annotations

import hashlib
import html
import json
import re
import sys
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


VERSION = "0.1.0"
SOURCE = "arbeitnow"
API_URL = "https://www.arbeitnow.com/api/job-board-api"
SOURCE_HOST = "www.arbeitnow.com"
EXIT_USAGE = 2
EXIT_INPUT = 3
EXIT_SOURCE = 4
EXIT_OUTPUT = 5

_KNOWN_CAPABILITIES = {
    "agent_runtime": (
        "agent runtime",
        "agentic",
        "agent framework",
        "agent infrastructure",
        "agent orchestration",
        "agent workflow",
        "ai agent",
        "智能体",
    ),
    "model_evaluation": (
        "model evaluation",
        "model eval",
        "evaluation framework",
        "evaluation metrics",
        "eval design",
        "benchmarking",
        "model quality",
        "模型评测",
        "评测体系",
    ),
    "developer_workflow": (
        "developer experience",
        "developer productivity",
        "developer workflow",
        "developer tools",
        "developer platform",
        "开发者体验",
        "开发者工作流",
    ),
    "product_strategy": (
        "product strategy",
        "product vision",
        "product roadmap",
        "product planning",
        "产品策略",
        "产品规划",
    ),
    "growth_experiment": (
        "growth experiment",
        "growth experiments",
        "experimentation",
        "growth strategy",
        "增长实验",
    ),
    "commercialization": (
        "commercialization",
        "monetization",
        "go-to-market",
        "commercial strategy",
        "商业化",
    ),
}


class _TextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.casefold() in {"script", "style", "noscript"}:
            self._skip += 1
        elif not self._skip and tag.casefold() in {"br", "li", "p", "div", "h1", "h2", "h3"}:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag.casefold() in {"script", "style", "noscript"} and self._skip:
            self._skip -= 1
        elif not self._skip and tag.casefold() in {"li", "p", "div", "h1", "h2", "h3"}:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self._skip:
            self.parts.append(data)


def _plain_text(value: Any, limit: int = 50_000) -> str:
    parser = _TextParser()
    parser.feed(html.unescape(str(value or "")))
    text = re.sub(r"[ \t\r\f\v]+", " ", "".join(parser.parts))
    text = re.sub(r"\n\s*\n+", "\n", text)
    return text.strip()[:limit]


def _key(value: Any) -> str:
    return re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "_", str(value or "").casefold()).strip("_")


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _request_page(page: int) -> list[dict[str, Any]]:
    query = urlencode({"page": page})
    request = Request(
        f"{API_URL}?{query}",
        headers={
            "Accept": "application/json",
            "User-Agent": "OfferU-job-search/0.1 (+public-research)",
        },
    )
    try:
        with urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"public source unavailable: {SOURCE_HOST}: {exc}") from exc
    rows = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise RuntimeError("public source returned an invalid jobs array")
    return [row for row in rows if isinstance(row, dict)]


def _fetch_pages(page_limit: int) -> tuple[list[dict[str, Any]], int]:
    rows: list[dict[str, Any]] = []
    pages = max(1, min(int(page_limit), 8))
    for page in range(1, pages + 1):
        current = _request_page(page)
        rows.extend(current)
        if len(current) < 100:
            break
    return rows, pages


def _target_text(target: dict[str, Any], payload: dict[str, Any]) -> str:
    pieces = [
        payload.get("query"),
        target.get("title"),
        target.get("raw_description"),
        payload.get("role_family"),
        payload.get("specialization"),
        payload.get("industry"),
    ]
    return " ".join(str(item or "") for item in pieces).strip()


def _role_family(text: str) -> str:
    value = text.casefold()
    if re.search(r"\b(product|technical|growth|platform)\s+manager\b|product management", value):
        return "product_manager"
    if re.search(r"\b(data|business)\s+(analyst|analytics)|data scientist", value):
        return "data_analytics"
    if re.search(r"\b(software|backend|frontend|full[- ]stack) engineer\b", value):
        return "software_engineer"
    if re.search(r"\b(design|ux|ui)\s+(manager|designer)\b", value):
        return "designer"
    if re.search(r"\b(sales|account|business development)\b", value):
        return "commercial"
    return "other"


def _specialization(text: str, requested: str = "") -> str:
    value = text.casefold()
    requested_key = _key(requested)
    if requested_key and any(
        term in value
        for term in (" ai ", "ai/", "agent", "aigc", "generative", "llm", "machine learning", "人工智能")
    ):
        return requested_key
    if any(term in value for term in ("agent", "aigc", "generative ai", "large language model", "llm", "人工智能")):
        return "ai_agent"
    if any(term in value for term in ("data platform", "data product", "analytics")):
        return "data"
    return "general"


def _seniority(text: str, requested: str = "") -> str:
    value = text.casefold()
    requested_key = _key(requested)
    if requested_key:
        return requested_key
    if re.search(r"\b(principal|staff)\b", value):
        return "principal"
    if re.search(r"\b(lead|head)\b", value):
        return "lead"
    if re.search(r"\b(senior|sr\.?|manager)\b", value):
        return "senior"
    if re.search(r"\b(junior|jr\.?|entry[- ]level|graduate)\b", value):
        return "entry"
    return "unknown"


def _domain(text: str, requested: str = "") -> str:
    requested_key = _key(requested)
    if requested_key:
        return requested_key
    value = text.casefold()
    if any(term in value for term in ("ai", "agent", "llm", "machine learning", "software", "saas")):
        return "technology"
    if any(term in value for term in ("fintech", "payments", "banking")):
        return "fintech"
    return "general"


def _sentences(text: str) -> list[str]:
    items = re.split(r"(?<=[.!?。！？])\s+|\n+", text)
    return [item.strip() for item in items if item.strip()]


def _importance(text: str) -> str:
    value = text.casefold()
    if re.search(r"\b(required|must|essential|min(?:imum)? requirements?)\b|必须|必备", value):
        return "must_have"
    return "strong"


def _observations(text: str) -> list[dict[str, Any]]:
    sentences = _sentences(text)
    observations: list[dict[str, Any]] = []
    seen: set[str] = set()
    for capability, terms in _KNOWN_CAPABILITIES.items():
        evidence = next(
            (sentence for sentence in sentences if any(term in sentence.casefold() for term in terms)),
            None,
        )
        if not evidence:
            continue
        label = {
            "agent_runtime": "Agent Runtime",
            "model_evaluation": "Model Evaluation",
            "developer_workflow": "Developer Workflow",
            "product_strategy": "Product Strategy",
            "growth_experiment": "Growth Experiment",
            "commercialization": "Commercialization",
        }[capability]
        if capability in seen:
            continue
        seen.add(capability)
        observations.append(
            {
                "capability": label,
                "category": "technical_product" if capability in {"agent_runtime", "model_evaluation", "developer_workflow"} else "business_capability",
                "importance": _importance(evidence),
                "evidence_text": evidence[:1500],
                "source_section": "description",
                "confidence": 0.72,
            }
        )
    return observations


def _profile(text: str, payload: dict[str, Any], *, target: bool = False) -> dict[str, Any]:
    role_family = _key(payload.get("role_family")) if target else ""
    specialization = _key(payload.get("specialization")) if target else ""
    seniority = _key(payload.get("seniority")) if target else ""
    domain = _key(payload.get("industry")) if target else ""
    family = role_family or _role_family(text)
    spec = _specialization(text, specialization)
    level = _seniority(text, seniority)
    area = _domain(text, domain)
    sentences = _sentences(text)
    return {
        "schema": "offeru.role_jd.v1",
        "role_family": family,
        "specialization": spec,
        "seniority": level,
        "domain": area,
        "responsibilities": sentences[:8],
        "hard_skills": [item["capability"] for item in _observations(text) if item["category"] == "technical_product"],
        "business_capabilities": [item["capability"] for item in _observations(text) if item["category"] == "business_capability"],
        "behavioral_requirements": [],
        "domain_knowledge": [],
        "outcome_expectations": [],
        "constraints": [],
    }


def _job_document(row: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    slug = str(row.get("slug") or "").strip()
    url = str(row.get("url") or "").strip()
    description = _plain_text(row.get("description"), 50_000)
    title = str(row.get("title") or "").strip()
    company = str(row.get("company_name") or "").strip()
    identity = slug or url or f"{company}:{title}:{description}"
    source_ref = f"{SOURCE}:{identity}"
    return {
        "source_ref": source_ref[:120],
        "source": SOURCE,
        "title": title[:500],
        "company": company[:300],
        "location": str(row.get("location") or "")[:300],
        "industry": ", ".join(str(item) for item in row.get("tags") or [] if str(item).strip())[:200],
        "url": url[:4000],
        "raw_description": description,
        "role_profile": _profile(description + " " + title, payload),
        "capability_observations": _observations(description),
        "published_at": row.get("created_at"),
        "remote": bool(row.get("remote")),
        "job_types": [str(item) for item in row.get("job_types") or []],
    }


def _score(document: dict[str, Any], target_text: str, payload: dict[str, Any]) -> int:
    title = str(document.get("title") or "").casefold()
    body = f"{title} {document.get('raw_description') or ''}".casefold()
    score = 0
    family = _key(payload.get("role_family"))
    if family == "product_manager" and "product manager" in title:
        score += 8
    if family and family == str(document.get("role_profile", {}).get("role_family") or ""):
        score += 3
    words = [item for item in re.findall(r"[a-z][a-z0-9+.#-]{2,}", target_text.casefold()) if item not in {"the", "and", "for", "with", "this", "that"}]
    for word in sorted(set(words)):
        if word in title:
            score += 3
        elif word in body:
            score += 1
    specialization = _key(payload.get("specialization"))
    if specialization == "ai_agent" and any(term in body for term in ("agent", "aigc", "generative ai", "llm")):
        score += 6
    region = str(payload.get("region") or "").strip().casefold()
    if region and region in str(document.get("location") or "").casefold():
        score += 2
    return score


def _dedupe(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    result: list[dict[str, Any]] = []
    for row in sorted(rows, key=lambda item: (str(item.get("url") or ""), str(item.get("source_ref") or ""))):
        key = str(row.get("url") or "") or hashlib.sha256(
            f"{row.get('company')}:{row.get('title')}:{row.get('raw_description')}".casefold().encode("utf-8")
        ).hexdigest()
        if key in seen:
            continue
        seen.add(key)
        result.append(row)
    return result


def _search(payload: dict[str, Any]) -> dict[str, Any]:
    target = payload.get("target") if isinstance(payload.get("target"), dict) else {}
    target_text = _target_text(target, payload)
    rows, pages = _fetch_pages(int(payload.get("page_limit") or 3))
    target_url = str(target.get("url") or "").rstrip("/").casefold()
    target_company = str(target.get("company") or "").strip().casefold()
    candidates: list[tuple[int, dict[str, Any]]] = []
    for row in rows:
        document = _job_document(row, payload)
        if not document["title"] or not document["company"] or len(document["raw_description"]) < 20:
            continue
        if target_url and str(document.get("url") or "").rstrip("/").casefold() == target_url:
            continue
        if target_company and str(document.get("company") or "").strip().casefold() == target_company:
            continue
        score = _score(document, target_text, payload)
        if score >= 4:
            candidates.append((score, document))
    candidates.sort(key=lambda item: (-item[0], str(item[1].get("url") or ""), str(item[1].get("source_ref") or "")))
    comparators = _dedupe([item[1] for item in candidates])[: max(1, min(int(payload.get("limit") or 30), 50))]
    target_text_value = str(target.get("raw_description") or "").strip() or str(target.get("title") or "").strip()
    target_profile = _profile(target_text_value, payload, target=True)
    return {
        "schema": "offeru.role_benchmark_candidate.v1",
        "source": SOURCE,
        "source_host": SOURCE_HOST,
        "fetched_at": _iso_now(),
        "pages_fetched": pages,
        "target": {
            "raw_description": target_text_value,
            "role_profile": target_profile,
            "capability_observations": _observations(target_text_value),
        },
        "comparators": comparators,
        "gaps": [] if comparators else ["公开岗位源没有返回满足当前检索条件的候选 JD"],
        "sample": {
            "requested": max(1, min(int(payload.get("limit") or 30), 50)),
            "returned": len(comparators),
            "sufficient_for_role_benchmark": len(comparators) >= 15,
        },
    }


def _get_job(payload: dict[str, Any]) -> dict[str, Any]:
    requested = str(payload.get("source_ref") or payload.get("job_id") or payload.get("slug") or "").strip()
    if not requested:
        raise ValueError("jobs.get requires source_ref, job_id, or slug")
    rows, _ = _fetch_pages(int(payload.get("page_limit") or 3))
    for row in rows:
        identity = str(row.get("slug") or row.get("url") or "").strip()
        if requested in {identity, f"{SOURCE}:{identity}"}:
            return {
                "schema": "offeru.job_candidate.v1",
                "source": SOURCE,
                "fetched_at": _iso_now(),
                "job": _job_document(row, payload),
            }
    raise ValueError("public job not found in fetched pages")


def _snapshot(payload: dict[str, Any]) -> dict[str, Any]:
    rows, pages = _fetch_pages(int(payload.get("page_limit") or 1))
    jobs = [
        {
            "slug": row.get("slug"),
            "company_name": row.get("company_name"),
            "title": row.get("title"),
            "description": _plain_text(row.get("description"), 50_000),
            "url": row.get("url"),
            "location": row.get("location"),
            "tags": row.get("tags") or [],
            "job_types": row.get("job_types") or [],
            "remote": bool(row.get("remote")),
            "created_at": row.get("created_at"),
        }
        for row in rows
        if isinstance(row, dict)
    ]
    return {
        "schema": "offeru.job_search_snapshot.v1",
        "source": SOURCE,
        "source_host": SOURCE_HOST,
        "fetched_at": _iso_now(),
        "pages_fetched": pages,
        "jobs": _dedupe(jobs),
    }


def _emit(value: dict[str, Any]) -> int:
    try:
        print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
        return 0
    except (TypeError, ValueError) as exc:
        print(f"output serialization failed: {exc}", file=sys.stderr)
        return EXIT_OUTPUT


def _read_payload() -> dict[str, Any]:
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("stdin must be a JSON object")
    return value


def _configure_stdio() -> None:
    """Keep machine-readable JSON UTF-8 on Windows' default text streams."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8")


def main(argv: list[str]) -> int:
    _configure_stdio()
    if "--version" in argv:
        return _emit({"name": "job-search", "version": VERSION, "source": SOURCE})
    if "--help" in argv or not argv:
        return _emit({"name": "job-search", "version": VERSION, "commands": ["jobs.search", "jobs.get", "jobs.snapshot", "doctor"]})
    if "--json" not in argv:
        print("job-search requires --json", file=sys.stderr)
        return EXIT_USAGE
    command = next((item for item in argv if item in {"jobs.search", "search", "jobs.get", "get", "jobs.snapshot", "snapshot", "doctor", "health"}), "")
    if not command:
        print("supported commands: jobs.search, jobs.get, jobs.snapshot, doctor", file=sys.stderr)
        return EXIT_USAGE
    if "--dry-run" in argv:
        return _emit({
            "schema": "offeru.capability_plan.v1",
            "plugin": "job-search",
            "capability": command,
            "side_effects": ["external_read", "local_compute"],
            "executed": False,
        })
    try:
        payload = _read_payload()
        if command in {"doctor", "health"}:
            return _emit({"schema": "offeru.plugin_health.v1", "plugin": "job-search", "source": SOURCE, "available": True, "network": SOURCE_HOST})
        if command in {"jobs.search", "search"}:
            return _emit(_search(payload))
        if command in {"jobs.get", "get"}:
            return _emit(_get_job(payload))
        return _emit(_snapshot(payload))
    except json.JSONDecodeError as exc:
        print(f"invalid JSON input: {exc}", file=sys.stderr)
        return EXIT_INPUT
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return EXIT_INPUT
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return EXIT_SOURCE


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
