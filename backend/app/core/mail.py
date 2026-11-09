"""邮件回写：把一封已识别的求职邮件写成岗位状态和事项。

全部走 tools.save（actor=邮箱），直接生效、可以在「最近改动」里撤销。
同一封信（mail_id）只处理一次：记录或改动记录里出现过就跳过，所以撤销后不会被下次同步写回来。
"""


import re
from datetime import datetime
from typing import Any, Optional

from app.core import store, tools

ACTOR = tools.MAIL_ACTOR
# 分类阶段 -> (岗位 status, 事项 kind)
STAGE: dict[str, tuple[str, Optional[str]]] = {
    "applied": ("applied", None),
    "written_test": ("test", "test"),
    "assessment": ("test", "test"),
    "interview_1": ("interview", "interview"),
    "interview_2": ("interview", "interview"),
    "interview_hr": ("interview", "interview"),
    "offer": ("offer", None),
    "rejected": ("rejected", None),
}
ORDER = tools.JOB_ORDER


def seen(mail_id: str) -> bool:
    if store.fetch_one("SELECT 1 FROM records WHERE json_extract(data, '$.mail_id') = ? LIMIT 1", (mail_id,)):
        return True
    return store.fetch_one("SELECT 1 FROM changes WHERE json_extract(before, '$.mail_id') = ? "
                           "OR json_extract(after, '$.mail_id') = ? LIMIT 1", (mail_id, mail_id)) is not None


def _norm(value: Any) -> str:
    return re.sub(r"\s+", "", str(value or "")).lower()


def _find_job(company: str, title: str) -> Optional[dict[str, Any]]:
    same = [j for j in store.all_of("job") if company and _norm(j.get("company")) == _norm(company)]
    if title:
        return next((j for j in same if _norm(j.get("title")) == _norm(title)), None)
    return same[0] if len(same) == 1 else None


def _forward(current: Optional[str], new: str) -> bool:
    """邮件只在状态真的前进时写：规则归 tools.status_move_error，这里只去掉原地不动。"""
    return new != current and tools.status_move_error(current, new) is None


def _local(at: Any) -> Optional[str]:
    if not at:
        return None
    try:
        moment = datetime.fromisoformat(str(at).strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is not None:
        moment = moment.astimezone().replace(tzinfo=None)
    return moment.strftime("%Y-%m-%dT%H:%M")


def apply(signal: dict[str, Any], *, actor: str = ACTOR) -> dict[str, Any]:
    """signal: mail_id, stage, company, title, at, sender, subject, link。返回 {job_id, changes, skipped}。"""
    mail_id = str(signal.get("mail_id") or "").strip()
    status, event_kind = STAGE.get(str(signal.get("stage") or ""), (None, None))
    company = str(signal.get("company") or "").strip()
    title = str(signal.get("title") or "").strip()
    if not mail_id or status is None or not company or seen(mail_id):
        return {"job_id": None, "changes": [], "skipped": True}
    notes = " · ".join(filter(None, [signal.get("sender"), signal.get("subject"), signal.get("link")]))
    at = _local(signal.get("at"))
    changes: list[int] = []
    job = _find_job(company, title)
    if job is None:
        data = {"company": company, "title": title, "status": status, "notes": notes, "mail_id": mail_id}
        saved = tools.save("job", {k: v for k, v in data.items() if v}, actor=actor)
        job = saved["record"]
        changes.append(saved["change_id"])
    elif _forward(job.get("status"), status):
        saved = tools.save("job", {"status": status, "mail_id": mail_id}, job["id"], actor=actor)
        changes.append(saved["change_id"])
    if event_kind and at:
        stage = str(signal.get("stage"))
        now = datetime.now().strftime("%Y-%m-%dT%H:%M")
        # 同一岗位同一阶段还没到的事项又来一封信：当改期，改时间；已过去的轮次不算，照常新建。
        upcoming = next((e for e in store.all_of("event", job_id=job["id"])
                         if e.get("mail_stage") == stage and not e.get("done") and str(e.get("at") or "") >= now), None)
        if upcoming is None:
            event = {"title": f"{tools.EVENT_KIND[event_kind]} · {tools.label(dict(job, type='job'))}", "kind": event_kind,
                     "at": at, "job_id": job["id"], "notes": notes, "mail_id": mail_id, "mail_stage": stage}
            changes.append(tools.save("event", event, actor=actor)["change_id"])
        elif upcoming.get("at") != at:
            moved = {"at": at, "notes": notes, "mail_id": mail_id}
            changes.append(tools.save("event", moved, upcoming["id"], actor=actor)["change_id"])
    return {"job_id": job["id"], "changes": changes, "skipped": not changes}
