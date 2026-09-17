"""BOSS 平台投递/面试进展的手动同步入口（Sync now）。

严格只读：仅调用 boss CLI 的只读命令（`me --section deliver`、`interviews`），
把平台记录逐条送入 `ingest_boss_application_record` → `ingest_application_signal`
(channel="boss") 的候选管线。绝不自动改写 ApplicationAttempt 阶段——
所有记录只生成待用户确认的 candidate（unmatched → review queue）。

CLI 契约：`boss --json <cmd>` stdout 信封 `{ok, data, pagination, error, hints}`；
`ok=false` 时 `error.code` 带 AUTH_REQUIRED / NOT_SUPPORTED / 平台风控码。
未登录不是崩溃：返回 auth_required=True 的计数结果，提示 `boss login`。
"""

from __future__ import annotations
from typing import Any

from app.services.job_sources.adapters.boss import BossCliError, _run_boss
from app.services.job_sources.boss_signals import ingest_boss_application_record

# data.deliver 下可能出现的投递列表键名（防御性枚举，按序取第一个 list）。
_DELIVER_LIST_KEYS = (
    "deliverList",
    "deliver_list",
    "list",
    "items",
    "records",
    "jobList",
)

# data / data.deliver 下可能出现的分页字段。
_PAGINATION_KEYS = ("hasMore", "has_more", "more", "nextPage", "next_page")

# interviews 命令 data 是 list 还是带 interviewList 的 dict 都做防御。
_INTERVIEW_LIST_KEYS = ("interviewList", "interview_list", "list", "items")


def _as_list(value: Any) -> list[dict[str, Any]]:
    """把任意值归一化为 dict 记录列表；非标量/非 dict 项直接丢弃。"""
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _first_list(mapping: Any, keys: tuple[str, ...]) -> list[dict[str, Any]]:
    if not isinstance(mapping, dict):
        return []
    for key in keys:
        records = _as_list(mapping.get(key))
        if records:
            return records
    return []


def _extract_deliver_records(data: Any) -> list[dict[str, Any]]:
    """`me --section deliver` 的 data 形状：{"deliver": {...投递分页对象...}}。"""
    if not isinstance(data, dict):
        return []
    deliver = data.get("deliver")
    if isinstance(deliver, list):
        return _as_list(deliver)
    if isinstance(deliver, dict):
        records = _first_list(deliver, _DELIVER_LIST_KEYS)
        if records:
            return records
        # 有些平台直接把分页对象铺在 deliver 层之外
    # 兜底：data 本身就是投递列表容器
    return _first_list(data, _DELIVER_LIST_KEYS)


def _has_next_page(data: Any) -> bool:
    """从 data.deliver / data 里嗅探是否还有下一页；缺字段一律 False（保守）。"""
    containers = []
    if isinstance(data, dict):
        containers.append(data)
        if isinstance(data.get("deliver"), dict):
            containers.append(data["deliver"])
    for container in containers:
        for key in _PAGINATION_KEYS:
            value = container.get(key)
            if isinstance(value, bool):
                return value
            if isinstance(value, (int, float)) and key.lower().startswith("next"):
                return bool(value)
    return False


def _extract_interview_records(data: Any) -> list[dict[str, Any]]:
    """`interviews` 的 data 是条目 list（items）或带 interviewList 的 dict。"""
    if isinstance(data, list):
        return _as_list(data)
    return _first_list(data, _INTERVIEW_LIST_KEYS)


def _normalize_deliver_record(record: dict[str, Any]) -> dict[str, Any]:
    """投递记录 → ingest_boss_application_record 期望的字段名（防御性抽取）。

    boss-agent-cli 的 geekDeliverList 项字段名未固定文档化，这里做
    camelCase/snake_case/中文状态的多键探测；全部缺失也返回合法 dict。
    """
    def pick(*keys: str) -> str:
        for key in keys:
            value = record.get(key)
            if value not in (None, ""):
                return str(value)
        return ""

    status = pick("status", "statusDesc", "state", "deliverStatus", "deliver_status")
    return {
        "application_id": pick(
            "application_id", "geekApplyId", "geek_apply_id", "deliverId", "deliver_id",
        ),
        "job_id": pick("jobId", "job_id", "encryptJobId", "encrypt_job_id"),
        "security_id": pick("securityId", "security_id", "bossSecurityId"),
        "status": status,
        "job_title": pick("jobName", "job_name", "jobTitle", "job_title", "title", "positionName"),
        "company": pick("brandName", "brand_name", "company", "companyName", "company_name"),
        "thread_id": pick("friendId", "friend_id", "threadId", "thread_id", "chatId", "chat_id"),
        "updated_at": pick("updateTime", "update_time", "updatedAt", "updated_at", "time"),
        "applied_at": pick("createTime", "create_time", "appliedAt", "applied_at", "deliverTime"),
    }


def _normalize_interview_record(record: dict[str, Any]) -> dict[str, Any]:
    """interviews 条目 → ingest_boss_application_record 字段。

    CLI 输出键：jobName / brandName / interviewTime / address / statusDesc。
    """
    def pick(*keys: str) -> str:
        for key in keys:
            value = record.get(key)
            if value not in (None, ""):
                return str(value)
        return ""

    status = pick("statusDesc", "status", "state") or "面试"
    return {
        "application_id": pick(
            "interviewId", "interview_id", "application_id", "geekApplyId",
        ),
        "job_id": pick("jobId", "job_id", "encryptJobId"),
        "security_id": pick("securityId", "security_id"),
        "status": status,
        "job_title": pick("jobName", "job_name", "jobTitle", "job_title", "title"),
        "company": pick("brandName", "brand_name", "company", "companyName"),
        "thread_id": pick("friendId", "threadId", "chatId"),
        "updated_at": pick("interviewTime", "interview_time", "updatedAt", "time"),
        "applied_at": "",
    }


async def _fetch_deliver_records(
    *,
    max_pages: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """拉取投递记录页；返回 (records, fetch_errors)。不抛异常。"""
    records: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for page in range(1, max(1, max_pages) + 1):
        try:
            envelope = await _run_boss(
                "--json", "me", "--section", "deliver",
                "--deliver-page", str(page),
            )
        except BossCliError as exc:
            errors.append({
                "source": "me --section deliver",
                "page": page,
                "code": exc.code,
                "message": str(exc),
                "recovery_action": exc.recovery_action,
            })
            break
        if envelope.get("ok") is not True:
            err = envelope.get("error") or {}
            errors.append({
                "source": "me --section deliver",
                "page": page,
                "code": str(err.get("code") or "UNKNOWN"),
                "message": str(err.get("message") or "boss CLI error"),
                "recovery_action": str(err.get("recovery_action") or ""),
            })
            break
        page_records = _extract_deliver_records(envelope.get("data"))
        records.extend(page_records)
        if not page_records or not _has_next_page(envelope.get("data")):
            break
    return records, errors


async def _fetch_interview_records() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """拉取面试邀请列表；失败返回错误而非抛异常。"""
    try:
        envelope = await _run_boss("--json", "interviews")
    except BossCliError as exc:
        return [], [{
            "source": "interviews",
            "code": exc.code,
            "message": str(exc),
            "recovery_action": exc.recovery_action,
        }]
    if envelope.get("ok") is not True:
        err = envelope.get("error") or {}
        return [], [{
            "source": "interviews",
            "code": str(err.get("code") or "UNKNOWN"),
            "message": str(err.get("message") or "boss CLI error"),
            "recovery_action": str(err.get("recovery_action") or ""),
        }]
    return _extract_interview_records(envelope.get("data")), []


async def sync_boss_application_progress(
    account_ref: str = "boss",
    max_pages: int = 1,
) -> dict[str, Any]:
    """手动触发一次 BOSS 投递/面试进展读取同步。

    每条平台记录 → `ingest_boss_application_record` → `ingest_application_signal`
    (channel="boss") → candidate（status=pending，等待用户确认）。
    不写任何 ApplicationStageEvent；未匹配记录进 review queue。

    返回计数：{fetched, ingested, duplicates, errors, auth_required, ...}。
    未登录（AUTH_REQUIRED）不抛错——返回 auth_required=True 与恢复提示。
    """
    clean_account_ref = str(account_ref or "boss").strip() or "boss"
    safe_max_pages = max(1, min(int(max_pages or 1), 10))

    deliver_records, fetch_errors = await _fetch_deliver_records(max_pages=safe_max_pages)
    interview_records, interview_errors = await _fetch_interview_records()
    fetch_errors.extend(interview_errors)

    auth_required = any(e.get("code") in {"AUTH_REQUIRED", "AUTH_EXPIRED", "BROWSER_SESSION_NOT_FOUND"} for e in fetch_errors)
    auth_hint = next(
        (e.get("recovery_action") for e in fetch_errors if e.get("recovery_action")),
        "boss login",
    )

    result: dict[str, Any] = {
        "account_ref": clean_account_ref,
        "fetched": len(deliver_records) + len(interview_records),
        "ingested": 0,
        "duplicates": 0,
        "errors": len(fetch_errors),
        "error_details": fetch_errors,
        "auth_required": auth_required,
        "commands": ["boss --json me --section deliver", "boss --json interviews"],
        "note": "只读同步：所有记录生成待确认候选进展，不自动改写投递阶段。",
    }
    if auth_required:
        result["auth_hint"] = auth_hint

    # AUTH_REQUIRED 时不会再有记录；仍跑 ingest 循环（空）保持形状一致。
    normalized: list[tuple[str, dict[str, Any]]] = [
        ("deliver", _normalize_deliver_record(r)) for r in deliver_records
    ] + [
        ("interview", _normalize_interview_record(r)) for r in interview_records
    ]

    for _source, record in normalized:
        try:
            payload = await ingest_boss_application_record(
                account_ref=clean_account_ref,
                record=record,
            )
            if payload.get("duplicate"):
                result["duplicates"] += 1
            else:
                result["ingested"] += 1
        except Exception as exc:  # noqa: BLE001 — 单条失败不阻塞整批
            result["errors"] += 1
            result["error_details"].append({
                "source": "ingest",
                "code": "INGEST_ERROR",
                "message": f"{type(exc).__name__}: {exc}",
            })

    return result
