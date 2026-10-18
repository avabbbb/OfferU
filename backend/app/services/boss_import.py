"""导入 boss-cli 导出的投递 / 面试 / 沟通记录。

OfferU 不调用 boss-cli、不碰 BOSS 的登录态：用户自己在终端运行
`boss applied --json > boss.json`（或 `boss interviews` / `boss chat`），再把文件交给 OfferU。
这里只读这份文件，按岗位合并进投递表，状态只往前推，不往回改。
沟通列表没有岗位名，只用来把已有投递推到「已回复」。
"""

from __future__ import annotations

import hashlib
from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, update

from app.database import async_session
from app.models.models import ApplicationRecord, ApplicationTableRecord, Job

KINDS = {"cardList": "applied", "interviewList": "interviews", "friendList": "chat", "result": "chat"}
KIND_LABELS = {"applied": "投递记录", "interviews": "面试邀请", "chat": "沟通列表"}
# 状态只往前推；已拒绝 / 已录用 是终点，导入不会改动。
RANK = {"pending": 0, "submitted": 1, "responded": 2, "interview": 3}
MAX_ITEMS = 1000


class ImportBossExportInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    table_id: int = Field(gt=0)
    payload: dict[str, Any]


def _pick(item: dict[str, Any], *keys: str) -> str:
    for scope in (item, item.get("jobInfo") or {}, item.get("brandInfo") or {}):
        for key in keys:
            value = scope.get(key) if isinstance(scope, dict) else None
            if isinstance(value, (str, int)) and str(value).strip():
                return str(value).strip()
    return ""


def _status(kind: str, item: dict[str, Any]) -> str:
    if kind == "interviews":
        return "interview"
    if kind == "chat":
        # 沟通列表里 uid 是对方。最后一条是对方发的，或者已经是双向聊天（relationType=3），就算 HR 回了。
        last = item.get("lastMessageInfo") or {}
        replied = item.get("relationType") == 3 or (last.get("fromId") and last.get("fromId") == item.get("uid"))
        return "responded" if replied else "submitted"
    text = _pick(item, "deliverStatusDesc", "statusDesc")
    if "不合适" in text:
        return "rejected"
    if "面试" in text:
        return "interview"
    return "submitted"


def parse_boss_export(payload: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    """返回 (类型, 岗位列表)。认 boss-cli 的 {ok, data} 外壳，也认直接的 data。"""

    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    key = next((k for k in KINDS if isinstance(data.get(k), list)), None)
    if key is None:
        raise ValueError("认不出这份文件。请用 boss applied / boss interviews / boss chat 加 --json 导出")
    kind = KINDS[key]
    rows = []
    for item in data[key][:MAX_ITEMS]:
        if not isinstance(item, dict):
            continue
        title, company = _pick(item, "jobName"), _pick(item, "brandName")
        job_id = _pick(item, "encryptJobId")
        # 沟通列表没有岗位名，只能靠岗位编号去对已有的投递。
        if not (job_id if kind == "chat" else title and company):
            continue
        url = f"https://www.zhipin.com/job_detail/{job_id}.html" if job_id else ""
        identity = job_id or f"{company}|{title}"
        rows.append(
            {
                "job": {
                    "title": title[:500],
                    "company": company[:300],
                    "location": _pick(item, "cityName", "locationName")[:200],
                    "url": url,
                    "apply_url": url,
                    "source": "boss",
                    "salary_text": _pick(item, "salaryDesc")[:200],
                    "hash_key": "boss:" + hashlib.sha256(identity.encode()).hexdigest()[:40],
                },
                "status": _status(kind, item),
                "security_id": _pick(item, "securityId")[:300],
            }
        )
    return kind, rows


async def import_boss_export(table_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    """把 boss-cli 导出的记录合并进投递表：新岗位建记录，已有的只把状态往前推。"""

    from app.services.agent_operations import _application_record_status, update_application_status
    from app.services.job_ingest import import_job_batch
    from app.services.legacy_operations import import_jobs_to_application_table

    kind, rows = parse_boss_export(payload)
    if not rows:
        raise ValueError("文件里没有可导入的岗位")
    if kind == "chat":
        return await _advance_from_chat(table_id, rows)
    # 同一个岗位在文件里出现多次时，取最靠后的状态。
    wanted_by_hash: dict[str, str] = {}
    jobs: dict[str, dict[str, Any]] = {}
    for row in rows:
        key = row["job"]["hash_key"]
        jobs.setdefault(key, row["job"])
        prev = wanted_by_hash.get(key)
        if prev is None or row["status"] == "rejected" or RANK.get(row["status"], 0) > RANK.get(prev, 0):
            wanted_by_hash[key] = row["status"]
    await import_job_batch(list(jobs.values()), source="boss")
    security_by_hash = {row["job"]["hash_key"]: row["security_id"] for row in rows if row["security_id"]}
    async with async_session() as db:
        id_by_hash = dict((await db.execute(select(Job.hash_key, Job.id).where(Job.hash_key.in_(list(jobs))))).all())
        # 已经投过的岗位不该再出现在「岗位」收件箱里。
        await db.execute(update(Job).where(Job.hash_key.in_(list(jobs)), Job.triage_status == "inbox").values(triage_status="applied"))
        for key, security_id in security_by_hash.items():
            await db.execute(update(Job).where(Job.hash_key == key).values(boss_security_id=security_id))
        await db.commit()
    wanted = {int(id_by_hash[key]): status for key, status in wanted_by_hash.items() if key in id_by_hash}
    created = (await import_jobs_to_application_table(table_id=table_id, job_ids=list(wanted), skip_existing_in_table=True)).get("created", 0)

    async with async_session() as db:
        records = (
            await db.execute(
                select(ApplicationRecord)
                .join(ApplicationTableRecord, ApplicationTableRecord.record_id == ApplicationRecord.id)
                .where(ApplicationTableRecord.table_id == table_id, ApplicationRecord.job_ref_id.in_(list(wanted)))
            )
        ).scalars().all()
    advanced = 0
    for record in records:
        current = _application_record_status((record.custom_values or {}).get("apply_status"))
        target = wanted[record.job_ref_id]
        if current not in RANK:
            continue
        if target == "rejected" or RANK[target] > RANK[current]:
            await update_application_status(application_id=record.id, status=target)
            advanced += 1
    return {"kind": kind, "kind_label": KIND_LABELS[kind], "total": len(wanted), "created": created, "advanced": advanced, "job_ids": list(wanted)}


async def _advance_from_chat(table_id: int, rows: list[dict[str, Any]]) -> dict[str, Any]:
    """沟通列表只把已有投递推到「已回复」，不新建岗位。"""

    from app.services.agent_operations import _application_record_status, update_application_status

    replied = [row["job"]["hash_key"] for row in rows if row["status"] == "responded"]
    async with async_session() as db:
        records = (
            await db.execute(
                select(ApplicationRecord)
                .join(ApplicationTableRecord, ApplicationTableRecord.record_id == ApplicationRecord.id)
                .join(Job, Job.id == ApplicationRecord.job_ref_id)
                .where(ApplicationTableRecord.table_id == table_id, Job.hash_key.in_(replied))
            )
        ).scalars().all()
    advanced = 0
    for record in records:
        current = _application_record_status((record.custom_values or {}).get("apply_status"))
        if current in RANK and RANK[current] < RANK["responded"]:
            await update_application_status(application_id=record.id, status="responded")
            advanced += 1
    return {"kind": "chat", "kind_label": KIND_LABELS["chat"], "total": len(rows), "created": 0, "advanced": advanced, "job_ids": [r.job_ref_id for r in records]}


class FillBossJobDetailInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    job_id: int = Field(gt=0)


async def fill_boss_job_detail(job_id: int) -> dict[str, Any]:
    """用本机 boss-cli 跑一次 boss detail，把职位描述补进岗位。已有描述的不覆盖。"""

    from app.services.boss_sync import _run_boss

    async with async_session() as db:
        job = await db.get(Job, job_id)
        if job is None:
            raise ValueError("岗位不存在")
        if job.raw_description.strip():
            return {"job_id": job_id, "filled": False}
        security_id = job.boss_security_id
    if not security_id:
        raise ValueError("这个岗位没有 BOSS 的岗位编号，打开原文把职位描述复制过来")
    data = (await _run_boss(("detail", security_id))).get("data") or {}
    info = data.get("jobInfo") or {}
    description = str(info.get("postDescription") or data.get("jobDesc") or "").strip()
    if not description:
        raise ValueError("BOSS 没返回职位描述，可能岗位已关闭。打开原文看看")
    async with async_session() as db:
        job = await db.get(Job, job_id)
        job.raw_description = description[:50_000]
        if not job.education:
            job.education = str(info.get("degreeName") or "")[:50]
        if not job.experience:
            job.experience = str(info.get("experienceName") or "")[:100]
        await db.commit()
    return {"job_id": job_id, "filled": True}
