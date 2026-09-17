"""BOSS Zhipin experimental adapter — subprocess 薄封装 `boss` CLI。

契约：`uvx --from boss-agent-cli boss <cmd>` stdout 输出 JSON 信封
`{ok, data, pagination, error, hints}`；`ok=False` 时 `error.code`
带 `AUTH_REQUIRED`/`NOT_SUPPORTED`/平台风控码 + `recoverable` + `recovery_action`。

V1 边界：只暴露 status/search/detail，全部 READ_ONLY。
apply/greet/submit/contact 命令绝不映射进来。
"""

from __future__ import annotations

import asyncio
import json
import shutil
from datetime import datetime, timezone
from typing import Any, Optional

from ..protocol import (
    JobObservation,
    JobSearchQuery,
    JobSource,
    JobSourceCapabilities,
    JobSourceStatus,
    compute_raw_hash,
)

# CLI 可执行路径：优先已安装 boss，退化为 uvx 拉起。
_BOSS_BIN: list[str] = (
    ["boss"]
    if shutil.which("boss")
    else ["uvx", "--from", "boss-agent-cli", "boss"]
)

_STATUS_MAP: dict[str, JobSourceStatus] = {
    "AUTH_REQUIRED": "AUTH_REQUIRED",
    "NOT_SUPPORTED": "UNAVAILABLE",
    "COMPLIANCE_BLOCKED": "UNAVAILABLE",
    "BROWSER_SESSION_NOT_FOUND": "AUTH_REQUIRED",
    "PLATFORM_RISK": "DEGRADED",
    "RATE_LIMITED": "DEGRADED",
}


class BossCliError(RuntimeError):
    """BOSS CLI 返回 ok=False 或进程失败；code 透传结构化错误码。"""

    def __init__(self, code: str, message: str, recovery_action: str = "") -> None:
        super().__init__(f"[{code}] {message}")
        self.code = code
        self.recovery_action = recovery_action


async def _run_boss(*args: str, timeout: float = 30.0) -> dict[str, Any]:
    """执行 boss CLI，返回解析后的 JSON 信封；只认 stdout，stderr 仅为日志。

    `--json` 是全局 flag（强制 JSON 信封输出），必须放在子命令之前。
    """
    cmd = [*_BOSS_BIN, "--json", *args]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, _stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError as exc:
        proc.kill()
        await proc.wait()
        raise BossCliError("TIMEOUT", f"boss {' '.join(args)} timed out after {timeout}s") from exc
    text = stdout.decode("utf-8", errors="replace").strip()
    if not text:
        raise BossCliError("EMPTY_OUTPUT", f"boss {' '.join(args)} produced no output")
    try:
        envelope = json.loads(text)
    except json.JSONDecodeError as exc:
        raise BossCliError("BAD_JSON", f"unparseable CLI output: {text[:200]}") from exc
    if not isinstance(envelope, dict) or "ok" not in envelope:
        raise BossCliError("BAD_ENVELOPE", f"missing 'ok' key: {text[:200]}")
    return envelope


def _unwrap(envelope: dict[str, Any]) -> dict[str, Any]:
    """校验信封 ok；失败抛 BossCliError 携带结构化 code/recovery。"""
    if envelope.get("ok") is True:
        data = envelope.get("data")
        return data if isinstance(data, dict) else {}
    err = envelope.get("error") or {}
    raise BossCliError(
        str(err.get("code") or "UNKNOWN"),
        str(err.get("message") or "boss CLI error"),
        str(err.get("recovery_action") or ""),
    )


def _to_observation(raw: dict[str, Any]) -> JobObservation:
    """BOSS 搜索结果条目 → JobObservation。字段名按 boss-agent-cli schema。"""
    jid = str(raw.get("job_id") or raw.get("security_id") or raw.get("encrypt_id") or "")
    title = str(raw.get("title") or raw.get("job_name") or "").strip()
    company = str(raw.get("company") or raw.get("brand_name") or "").strip()
    return JobObservation(
        source="boss",
        external_job_id=jid,
        source_url=str(raw.get("url") or raw.get("job_url") or ""),
        title=title,
        company=company,
        description=str(raw.get("description") or raw.get("job_desc") or raw.get("desc") or ""),
        location=str(raw.get("city") or raw.get("location") or raw.get("area") or ""),
        salary=str(raw.get("salary") or raw.get("salary_desc") or ""),
        experience=str(raw.get("experience") or raw.get("work_year") or ""),
        education=str(raw.get("education") or raw.get("degree") or ""),
        captured_at=datetime.now(timezone.utc),
        raw_hash=compute_raw_hash(raw),
        metadata={
            "security_id": raw.get("security_id"),
            "boss_status": raw.get("status"),
            "welfare": raw.get("welfare") or raw.get("welfare_tags"),
        },
    )


class BossJobSource:
    """BOSS adapter：只读 search/detail；永远报 EXPERIMENTAL。"""

    source_id = "boss"

    async def status(self) -> JobSourceStatus:
        """`boss status` 探测登录态；任何失败映射为 AUTH_REQUIRED/UNAVAILABLE。"""
        try:
            env = await _run_boss("status", timeout=20.0)
        except BossCliError as exc:
            return _STATUS_MAP.get(exc.code, "UNAVAILABLE")
        except (OSError, FileNotFoundError):
            return "UNAVAILABLE"
        if env.get("ok") is True:
            # EXPERIMENTAL 永远压住 READY —— 产品语义上这是实验连接器。
            return "EXPERIMENTAL"
        code = str((env.get("error") or {}).get("code") or "")
        return _STATUS_MAP.get(code, "UNAVAILABLE")

    async def capabilities(self) -> JobSourceCapabilities:
        return JobSourceCapabilities(search=True, detail=True)

    async def search(self, query: JobSearchQuery) -> list[JobObservation]:
        """`boss --json search <kw> [--city X] [--page N]`；失败抛 BossCliError。

        CLI 没有 --limit/--format：limit 由 adapter 端截断，页码走 filters["page"]。
        """
        args = ["search", query.keywords]
        city = query.location or str(query.filters.get("city") or "")
        if city:
            args += ["--city", city]
        page = int(query.filters.get("page") or 1)
        if page > 1:
            args += ["--page", str(page)]
        env = await _run_boss(*args, timeout=45.0)
        data = _unwrap(env)
        items = data.get("items") or data.get("jobs") or data.get("list") or []
        if not isinstance(items, list):
            return []
        return [_to_observation(i) for i in items if isinstance(i, dict)][: max(1, query.limit)]

    async def get(self, external_job_id: str) -> Optional[JobObservation]:
        """`boss --json detail <security_id>`；security_id/job_id 都可作键。"""
        if not external_job_id:
            return None
        env = await _run_boss("detail", external_job_id, timeout=30.0)
        data = _unwrap(env)
        detail = data.get("job") or data.get("detail") or data
        if not isinstance(detail, dict) or not detail:
            return None
        return _to_observation(detail)
