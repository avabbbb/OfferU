"""Where the user is in the job search, the one next step, and today's questions.

One rule-based judgment shared by the workbench, external Agents and the daily
brief. No LLM: the user's own answers plus OfferU records decide. When the two
disagree the user is told and decides; nothing is silently overwritten.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any, Optional

from sqlalchemy import func, select

from app.database import async_session
from app.models.models import (
    ApplicationRecord,
    CalendarEvent,
    CareerCheckInAnswer,
    CareerCheckInState,
    Job,
    ProfileSection,
)

STAGES = ("not_started", "preparing", "applying", "testing", "interviewing", "offer", "done")
STAGE_LABELS = {
    "not_started": "还没开始",
    "preparing": "准备材料",
    "applying": "投递中",
    "testing": "笔试 / 测评",
    "interviewing": "面试中",
    "offer": "谈 offer",
    "done": "已上岸或暂停",
}
_RANK = {stage: index for index, stage in enumerate(STAGES)}
_INTERVIEW = {"interview_1", "interview_2", "interview_hr"}
_TEST = {"written_test", "assessment"}
_MAX_DAILY_QUESTIONS = 2
_WEEKLY_AFTER_IGNORED_DAYS = 3

_STAGE_OPTIONS = [{"id": stage, "label": STAGE_LABELS[stage]} for stage in STAGES[:-1]]
ONBOARDING = (
    {
        "key": "onboarding.stage",
        "question": "你现在到哪一步了？",
        "options": _STAGE_OPTIONS,
        "text": "",
    },
    {
        "key": "onboarding.about",
        "question": "哪一届？想找什么方向、在哪些城市？",
        "options": [],
        "text": "例如：27 届，产品经理，上海 / 杭州",
    },
    {
        "key": "onboarding.deadline",
        "question": "最近的截止日期或面试是什么时候？",
        "options": [{"id": "none", "label": "暂时没有"}],
        "text": "例如：腾讯网申 9 月 30 日截止",
    },
)


# ---------------------------------------------------------------------------
# Facts
# ---------------------------------------------------------------------------


async def _state(db: Any) -> CareerCheckInState:
    state = await db.get(CareerCheckInState, 1)
    if state is None:
        state = CareerCheckInState(id=1)
        db.add(state)
        await db.flush()
    return state


async def _facts(db: Any, now: datetime) -> dict[str, Any]:
    from app.services.application_progress import get_application_progress_board

    board = await get_application_progress_board(status="all")
    records = [record for company in board["companies"] for record in company["records"]]
    # Same bar as the old quick-start checklist: at least one confirmed fact.
    facts_count = int((await db.execute(
        select(func.count(ProfileSection.id)).where(ProfileSection.tier == "verified_fact")
    )).scalar() or 0)
    jobs = (await db.execute(select(Job.id, Job.company, Job.title).order_by(Job.id.desc()).limit(200))).all()
    events = (
        await db.execute(
            select(CalendarEvent)
            .where(CalendarEvent.start_time >= now - timedelta(days=3))
            .where(CalendarEvent.start_time <= now + timedelta(days=7))
            .order_by(CalendarEvent.start_time.asc())
        )
    ).scalars().all()
    answered = dict((await db.execute(select(CareerCheckInAnswer.key, CareerCheckInAnswer.choice))).all())
    return {
        "records": records,
        "pending_review": int(board["summary"]["pending_review"]),
        "profile_facts": facts_count,
        "jobs": [{"id": row.id, "company": row.company or "", "title": row.title or ""} for row in jobs],
        "events": events,
        "answered": answered,
    }


def _inferred_stage(facts: dict[str, Any]) -> str:
    stages = {record["current_stage"] for record in facts["records"]}
    if "offer" in stages:
        return "offer"
    if stages & _INTERVIEW or any(record.get("upcoming_interview") for record in facts["records"]):
        return "interviewing"
    if stages & _TEST:
        return "testing"
    if stages & {"applied", "rejected"}:
        return "applying"
    if facts["profile_facts"] or facts["jobs"] or facts["records"]:
        return "preparing"
    return "not_started"


def _stale(record: dict[str, Any], now: datetime) -> bool:
    raw = record.get("last_event_at") or record.get("attempt_created_at")
    if record["current_stage"] != "applied" or not raw:
        return False
    try:
        when = datetime.fromisoformat(str(raw)).replace(tzinfo=None)
    except ValueError:
        return False
    return when <= now - timedelta(days=7)


def _label(record: dict[str, Any]) -> str:
    return f"{record['company']} · {record['job_title']}".strip(" ·")


def _job_label(facts: dict[str, Any], job_id: Optional[int], fallback: str) -> str:
    for job in facts["jobs"]:
        if job["id"] == job_id:
            return f"{job['company']} · {job['title']}".strip(" ·")
    return fallback


def _applied_job_ids(facts: dict[str, Any]) -> set[int]:
    return {
        record["job_id"]
        for record in facts["records"]
        if record["current_stage"] not in {"prepared", "saved", "preparing", "ready", "unknown"}
    }


# ---------------------------------------------------------------------------
# Judgment
# ---------------------------------------------------------------------------


def _conflict(state: CareerCheckInState, inferred: str, facts: dict[str, Any]) -> Optional[dict[str, Any]]:
    said = state.self_stage
    if not said or said == "done" or said == inferred:
        return None
    key = f"conflict:{said}:{inferred}"
    if key in facts["answered"]:
        return None
    records_missing = _RANK[said] >= _RANK["applying"] and _RANK[inferred] < _RANK["applying"]
    records_ahead = _RANK[said] < _RANK["applying"] <= _RANK[inferred]
    if not (records_missing or records_ahead):
        return None
    if records_missing:
        message = f"你说自己在「{STAGE_LABELS[said]}」，但 OfferU 里还没有投递记录。"
    else:
        message = f"你说自己在「{STAGE_LABELS[said]}」，但 OfferU 里已经有投递进展，看起来是「{STAGE_LABELS[inferred]}」。"
    return {
        "key": key,
        "question": message + "以哪个为准？",
        "options": [
            {"id": "self", "label": f"以我说的为准（{STAGE_LABELS[said]}）"},
            {"id": "records", "label": f"按记录改成「{STAGE_LABELS[inferred]}」"},
        ],
        "text": "",
        "link": {"label": "去补录投递", "href": "/applications"} if records_missing else None,
    }


def _steps(stage: str, state: CareerCheckInState, onboarded: bool, conflict: Optional[dict],
           facts: dict[str, Any], now: datetime) -> list[dict[str, Any]]:
    steps: list[dict[str, Any]] = []

    def add(key: str, title: str, reason: str, href: str, cta: str) -> None:
        steps.append({"key": key, "title": title, "reason": reason, "href": href, "cta": cta})

    if not onboarded:
        add("onboarding", "先告诉 OfferU 你现在的情况", "回答三个问题，OfferU 才知道你在哪一步、该先做什么。", "/", "回答")
    if conflict:
        add("conflict", "核对你现在的阶段", conflict["question"], "/", "核对")
    if facts["pending_review"]:
        add("review-progress", f"先确认 {facts['pending_review']} 条求职进展",
            "邮箱等来源发现了新进展，确认后阶段判断才准。", "/applications?view=board", "去确认")
    for event in facts["events"]:
        hours = (event.start_time - now).total_seconds() / 3600
        if event.event_type == "interview" and 0 <= hours <= 72:
            add(f"interview-{event.id}", f"准备面试：{_job_label(facts, event.related_job_id, event.title)}",
                f"面试在 {event.start_time:%m月%d日 %H:%M}，先把岗位重点和高频追问准备好。",
                f"/jobs/{event.related_job_id}" if event.related_job_id else "/interview", "开始准备")
            break
    applied = _applied_job_ids(facts)
    for event in facts["events"]:
        days = (event.start_time.date() - now.date()).days
        skipped = facts["answered"].get(f"applied:{event.related_job_id}:{event.id}") == "skip"
        if event.event_type == "deadline" and 0 <= days <= 3 and event.related_job_id not in applied and not skipped:
            add(f"deadline-{event.id}", f"完成网申：{_job_label(facts, event.related_job_id, event.title)}",
                {0: "今天截止。", 1: "明天截止。"}.get(days, f"还有 {days} 天截止。"),
                f"/jobs/{event.related_job_id}?focus=apply-form" if event.related_job_id else "/calendar", "去投递")
            break

    records = facts["records"]
    if stage in {"not_started", "preparing"}:
        if not facts["profile_facts"]:
            add("profile", "建立职业档案", "导入旧简历并确认经历，OfferU 才能按岗位帮你改。没有简历也可以从经历开始写。", "/profile", "去建立")
        elif not facts["jobs"]:
            add("first-job", "存下第一个想投的岗位", "贴一段 JD 或链接，OfferU 会拆出岗位要求。", "/jobs", "添加岗位")
        else:
            job = facts["jobs"][0]
            add(f"prepare-{job['id']}", f"为 {job['company']} · {job['title']} 准备材料并投递",
                "已经有简历和岗位了，下一步是真正投出去。", f"/jobs/{job['id']}", "去准备")
    elif stage == "applying":
        stale = sorted((r for r in records if _stale(r, now)),
                       key=lambda r: str(r.get("last_event_at") or r.get("attempt_created_at")))
        if stale:
            add(f"follow-{stale[0]['application_attempt_id']}", f"跟进 {_label(stale[0])}",
                "投出去一周还没消息，可以发一封简短的跟进。", f"/jobs/{stale[0]['job_id']}", "写跟进")
        add("more-jobs", "继续投递", "投递中阶段，保持每周有新投递。", "/jobs", "找岗位")
    elif stage == "testing":
        record = next((r for r in records if r["current_stage"] in _TEST), None)
        if record:
            add(f"test-{record['application_attempt_id']}", f"完成 {_label(record)} 的笔试 / 测评",
            "记下截止时间，考前复习对应题型。", f"/jobs/{record['job_id']}", "去准备")
    elif stage == "interviewing":
        record = next((r for r in records if r["current_stage"] in _INTERVIEW), None)
        if record:
            add(f"interview-prep-{record['application_attempt_id']}", f"准备 {_label(record)} 的下一轮",
                "复盘上一轮被问到的问题，补上答得不好的部分。", f"/jobs/{record['job_id']}", "开始准备")
    elif stage == "offer":
        record = next((r for r in records if r["current_stage"] == "offer"), None)
        if record:
            add(f"offer-{record['application_attempt_id']}", f"核对 {_label(record)} 的 offer",
            "看清薪资、地点和回复期限；决定前可以继续推进其他机会。", f"/jobs/{record['job_id']}", "查看")
    if not state.agent_seen_on:
        add("connect-agent", "连接你的 Agent", "让你正在用的 Codex、Claude Code 等读到同一份进度；不连也能先用。", "#agent", "去连接")
    return steps


def _daily_questions(stage: str, state: CareerCheckInState, conflict: Optional[dict],
                     facts: dict[str, Any], now: datetime) -> tuple[list[dict[str, Any]], bool]:
    """Return questions and whether any is urgent (new movement resumes daily asking)."""
    urgent: list[dict[str, Any]] = []
    routine: list[dict[str, Any]] = []
    answered = facts["answered"]
    by_job = {r["job_id"]: r for r in facts["records"]}

    def ask(bucket: list, key: str, question: str, options: list[tuple[str, str]]) -> None:
        if key not in answered:
            bucket.append({"key": key, "question": question,
                           "options": [{"id": i, "label": label} for i, label in options], "text": ""})

    if conflict:
        urgent.append(conflict)
    for event in facts["events"]:
        if not event.related_job_id:
            continue
        label = _job_label(facts, event.related_job_id, event.title)
        if event.event_type == "interview" and now - timedelta(days=3) <= event.start_time < now:
            record = by_job.get(event.related_job_id)
            if record and record["current_stage"] in {"offer", "rejected"}:
                continue
            ask(urgent, f"interview_result:{event.related_job_id}:{event.id}",
                f"{label} 的面试（{event.start_time:%m月%d日}）结束了吗？结果怎样？",
                [("next", "进入下一轮"), ("offer", "拿到 offer"), ("rejected", "没通过"), ("waiting", "还没消息")])
        days = (event.start_time.date() - now.date()).days
        if event.event_type == "deadline" and 0 <= days <= 1 and event.related_job_id not in _applied_job_ids(facts):
            ask(urgent, f"applied:{event.related_job_id}:{event.id}",
                f"{label} {'今天' if days == 0 else '明天'}截止，投了吗？",
                [("yes", "已经投了"), ("no", "还没投"), ("skip", "不投了")])
    week = now.strftime("%G-W%V")
    for record in facts["records"]:
        if _stale(record, now):
            ask(routine, f"heard_back:{record['job_id']}:{week}", f"{_label(record)} 有回音吗？",
                [("test", "收到笔试 / 测评"), ("interview", "约了面试"), ("rejected", "没通过"), ("none", "还没消息")])
    if stage in {"offer", "done"} and state.still_searching is None:
        ask(routine, "still_searching", "恭喜！还继续找吗？",
            [("yes", "继续找，想冲更好的"), ("no", "不找了，先停下")])
    return (urgent + routine)[:_MAX_DAILY_QUESTIONS], bool(urgent)


def _should_ask_today(state: CareerCheckInState, today: str, urgent: bool) -> bool:
    if urgent or state.ignored_days < _WEEKLY_AFTER_IGNORED_DAYS:
        return True
    if state.last_asked_on == today:
        return True
    return not state.last_asked_on or (date.fromisoformat(today) - date.fromisoformat(state.last_asked_on)).days >= 7


async def get_career_next_step(now: Optional[datetime] = None, *, record_ask: bool = True,
                               from_agent: bool = False) -> dict[str, Any]:
    """阶段、唯一的下一步（最多一个备选）和今天要问的问题。"""
    now = now or datetime.now()
    today = now.date().isoformat()
    async with async_session() as db:
        state = await _state(db)
        if from_agent and not state.agent_seen_on:
            state.agent_seen_on = today
        facts = await _facts(db, now)
        inferred = _inferred_stage(facts)
        if state.self_stage == inferred:
            state.self_stage = ""  # records caught up; from here on they lead
        onboarded = {"onboarding.stage", "onboarding.about"} <= facts["answered"].keys()
        if state.still_searching is False:
            stage = "done"
        elif state.self_stage and state.self_stage != inferred:
            # Disagreement: show the user's own stage until they decide.
            stage = state.self_stage
        else:
            stage = inferred
        conflict = _conflict(state, inferred, facts)
        steps = _steps(stage, state, onboarded, conflict, facts, now)
        if not onboarded:
            questions = [q for q in ONBOARDING if q["key"] not in facts["answered"]]
            urgent = True
        else:
            questions, urgent = _daily_questions(stage, state, conflict, facts, now)
            if questions and not _should_ask_today(state, today, urgent):
                questions = []
        if record_ask and questions and state.last_asked_on != today:
            if state.last_asked_on and state.last_answered_on < state.last_asked_on:
                state.ignored_days += 1
            state.last_asked_on = today
        await db.commit()
        return {
            "stage": stage,
            "stage_label": STAGE_LABELS[stage],
            "inferred_stage": inferred,
            "self_stage": state.self_stage,
            "about": state.about,
            "nearest_deadline": state.nearest_deadline,
            "onboarded": onboarded,
            "next_step": steps[0] if steps else None,
            "alternate": steps[1] if len(steps) > 1 else None,
            "questions": questions,
            "cadence": "weekly" if state.ignored_days >= _WEEKLY_AFTER_IGNORED_DAYS and not urgent else "daily",
        }


# ---------------------------------------------------------------------------
# Answers
# ---------------------------------------------------------------------------


async def _set_job_status(job_id: int, status: str) -> None:
    from app.services.agent_operations import create_application, update_application_status

    async with async_session() as db:
        record_id = (
            await db.execute(
                select(ApplicationRecord.id)
                .where(ApplicationRecord.job_ref_id == job_id)
                .order_by(ApplicationRecord.updated_at.desc())
                .limit(1)
            )
        ).scalar()
    if not record_id:
        created = await create_application(job_id)
        record_id = created.get("id")
        if not record_id:
            raise ValueError(created.get("error") or "无法创建投递记录")
    result = await update_application_status(int(record_id), status)
    if result.get("error"):
        raise ValueError(result["error"])


_STATUS_BY_ANSWER = {
    "interview_result": {"next": "interview", "offer": "offer", "rejected": "rejected"},
    "applied": {"yes": "submitted"},
    "heard_back": {"test": "assessment", "interview": "interview", "rejected": "rejected"},
}


async def answer_check_in(key: str, choice: str = "", text: str = "", user_quote: str = "",
                          question: str = "") -> dict[str, Any]:
    """记录一条回答并立刻生效（改阶段、改投递状态）；可在时间线撤销。"""
    key = str(key or "").strip()
    choice = str(choice or "").strip()
    text = str(text or "").strip()
    if not key or not (choice or text):
        raise ValueError("回答需要 key，以及 choice 或 text")
    kind, _, rest = key.partition(":")
    status = None
    async with async_session() as db:
        state = await _state(db)
        if key == "onboarding.stage":
            if choice not in STAGES:
                raise ValueError("onboarding.stage 的 choice 必须是阶段 id")
            state.self_stage = choice
        elif key == "onboarding.about":
            state.about = text or choice
        elif key == "onboarding.deadline":
            state.nearest_deadline = "" if choice == "none" else text
        elif kind == "conflict":
            said, _, inferred = rest.partition(":")
            if choice == "records" and inferred in STAGES:
                state.self_stage = inferred
            elif choice != "self":
                raise ValueError("conflict 的 choice 只能是 self 或 records")
        elif key == "still_searching":
            state.still_searching = choice != "no"
        elif kind in _STATUS_BY_ANSWER:
            status = _STATUS_BY_ANSWER[kind].get(choice)
            job_id = int(rest.split(":")[0])
        else:
            raise ValueError(f"未知的问题 key：{key}")
        state.last_answered_on = datetime.now().date().isoformat()
        state.ignored_days = 0
        db.add(CareerCheckInAnswer(key=key, question=question[:500], choice=choice, text=text,
                                   user_quote=str(user_quote or "")[:2000]))
        await db.commit()
    if status:
        await _set_job_status(job_id, status)
        async with async_session() as db:
            # The user just reported a real result: records lead from now on.
            (await _state(db)).self_stage = ""
            await db.commit()
    return {"ok": True, "key": key, "applied_status": status, "next": await get_career_next_step()}


async def get_career_next_step_for_agent() -> dict[str, Any]:
    """Operation entry point: the caller is an Agent, so it is connected."""
    return await get_career_next_step(from_agent=True)


__all__ = ["STAGES", "STAGE_LABELS", "answer_check_in", "get_career_next_step"]
