"""按岗位改简历：起草 → 审稿 → 修订，整个流程跑完才写一次库。

起草是一次流式调用，边写边推给前端。审稿是另一次独立的模型调用：只读 JD、档案、原简历、初稿和按导出版式量出的页数，
输出 {old, new, reason, category} 修改清单和四类意见，不重写全文。修订按 old 精确替换：找不到或不唯一就跳过，
替换完不像简历就整轮作废。最多审 ROUNDS 轮，某一轮没有可用的修改就停。
判断都交给模型；代码只量页数、做精确替换。
只有跑完才写库，记成「Agent」的一条改动，可以撤销；超时、取消、起草出错、格式不对都不动简历。
主简历（没关联岗位）不被覆盖：结果写进这个岗位的定制简历，没有就新建一份。同一份简历同时只跑一个改写。
"""

import asyncio
import time
import logging
import json
import re
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable, Optional

from app.core import store, verify
from app.core.tools import FIELDS, MEMORY_KIND, label, save

Stream = Callable[[list[dict[str, str]]], AsyncIterator[str]]
Complete = Callable[[list[dict[str, str]]], Awaitable[Optional[str]]]

_log = logging.getLogger(__name__)

ROUNDS = 2
CATEGORIES = ("grounding", "keyword", "depth", "length", "tone")
NOTE_KEYS = ("关键词", "岗位角度", "动作和结果", "语气")
# 追问成果：第 1 轮审稿挑出只有动作、没有结果的句子问用户，一次最多 3 句。
MAX_ASKS = 3
ASK_KEYS = ("old", "why", "question")

PROMPT = (
    "你是简历编辑。按岗位 JD 改写用户的简历。只用「档案和经历」里有的事实，不编造经历、数字、公司、技能。\n"
    "JD 原文里可能夹着公司介绍、福利、投递方式，这些不是岗位要求，忽略。\n"
    "和 JD 相关的经历放前面、写具体，无关的压缩或删掉；要点动词开头，写清做了什么、结果和数字；控制在一页 A4。\n"
    "简历要经得起面试追问：技术类经历每段写出关键做法（方案选型和原因、难点怎么解决、性能或质量的量化结果），用档案里出现过的技术名词，不写空泛的「负责」「参与」；"
    "档案里没有的做法和数字不要补，JD 要求但档案里没有的技能不要硬塞。\n"
    "如果给了「岗位评估」，按里面的逐条匹配和简历怎么改来取舍；评估里写成差距或「待补充」的内容不要写进简历。\n"
    "只输出完整的 Markdown 简历本身，不要解释，不要代码块。写法："
    + FIELDS["doc"].split("也可以只传 body，写法：", 1)[1].split("，保存时转成", 1)[0]
)

REVIEW_PROMPT = (
    "你是简历审稿人，和写这份简历的人不是同一个人。你只审稿、给修改，不重写全文。\n"
    "事实来源只有两份：「档案和经历」和「原简历」。对照它们和 JD 审「待审简历」，只输出严格 JSON：\n"
    '{"edits": [{"old": "待审简历里一字不差、只出现一次的原文", "new": "替换成的文字，删除写空串", '
    '"reason": "一句话说明", "category": "grounding / keyword / depth / length / tone 之一"}], '
    '"notes": {"关键词": "…", "岗位角度": "…", "动作和结果": "…", "语气": "…"}, '
    '"asks": [{"old": "待审简历里只写了动作、没写结果的那一句，一字不差", "why": "和 JD 哪条要求有关，一句话", "question": "问用户的一个具体问题"}]}\n'
    "怎么审：\n"
    "1. grounding：每个公司、职位、日期、数字、技术名词都要在事实来源里找得到（换了写法但意思相同算有出处）。找不到的必须给 edit：改回有出处的写法，或者删掉。\n"
    "2. keyword：JD 的要求在事实来源里有依据、简历却没写的，给 edit 补上；没有依据的不要补，在 notes 的「关键词」里写明缺口。JD 里的公司介绍、福利、投递方式不是要求。\n"
    "3. depth：技术类经历看不出方案、难点、取舍、量化结果的，用事实来源里有的内容改写；事实来源里也没有，就在 notes 的「动作和结果」里提，不要编。\n"
    "4. length：给了页数时，超过 1 页就按和 JD 的相关度从低到高删整条要点，删到预计一页（删整条时 old 写整行，含开头的「- 」，new 写空串）；不到 1 页不要为了凑篇幅加内容。\n"
    "5. 不改第一行「# 名字」和联系方式那一行，不改 ## / ### 的格式结构。\n"
    "6. old 从待审简历原样复制，带够上下文保证只出现一次；一条 edit 只改一处。没有问题就返回空的 edits，notes 里没意见的项写「无」。\n"
    "7. asks：挑出和 JD 最相关、只写了动作没写结果、事实来源里也找不到结果的句子，最多 3 句；没有就返回空数组。question 要具体好答，比如「你接手前后，粉丝或阅读量大概变了多少？」「这件事帮团队省了时间或钱吗？」「有没有被表扬、被推广到别的组、拿奖？」，不要问「请量化你的成果」。不要替用户编结果。"
)

# 内置 tw93/Kami 的简历写作规范（app/assets/kami，MIT）。只取内容策略，版式由 doc.style 管。
_KAMI = Path(__file__).resolve().parents[1] / "assets" / "kami" / "references"
_KAMI_NOTE = ("\n\n## 写作规范（Kami）\n下面是 Kami 的简历写作规范。只用它的内容策略：角色/动作/结果、动词开头、结果和可核实的数字、"
              "头衔用词校准、反模式。里面关于两页、HTML/CSS、脚本、字体的规定不适用；输出格式、篇幅和不编造事实以上面为准。\n\n")

# 岗位评估报告（job_eval.SECTIONS）里和改简历有关的板块。
EVAL_SECTIONS = ("逐条匹配", "简历怎么改")


def kami_rules() -> str:
    """resume-writing + anti-patterns；文件缺了就不加，改写照常跑。"""
    parts = [(_KAMI / name).read_text(encoding="utf-8") for name in ("resume-writing.md", "anti-patterns.md") if (_KAMI / name).is_file()]
    return _KAMI_NOTE + "\n\n".join(parts) if parts else ""


_running: set[int] = set()
FENCE = chr(96) * 3  # 三个反引号


def _facts() -> str:
    profile = store.first("profile") or {}
    keys = ("name", "school", "major", "degree", "grad_year", "phone", "email", "city", "target", "about")
    lines = [f"{key}: {profile[key]}" for key in keys if profile.get(key)]
    for memory in sorted(store.all_of("memory"), key=lambda record: record["id"]):
        span = " – ".join(filter(None, [memory.get("start"), memory.get("end")]))
        head = " ".join(filter(None, [f"[{MEMORY_KIND.get(memory.get('kind') or '', '其他')}]", memory.get("title"), memory.get("mode"), span]))
        body = str(memory.get("body") or "")
        if memory.get("quote"):  # 追问成果时用户亲口说的，审稿把它当有出处
            said = f"用户 {memory['said_at']} 亲口说" if memory.get("said_at") else "用户亲口说"
            body += f"\n（{said}：{memory['quote']}）"
        lines.append(f"{head}\n{body}".strip())
    return "\n\n".join(lines) or "（空）"


def evaluation_notes(job_id: int) -> str:
    """岗位下 evaluation 文档里的「逐条匹配」「简历怎么改」两段；没评估过或两段都没有就返回空串。"""
    report = next((d for d in store.all_of("doc", job_id=job_id) if d.get("kind") == "evaluation"), None)
    if not report:
        return ""
    found: list[str] = []
    for block in re.split(r"(?m)^(?=## )", str(report.get("body") or "")):
        head = block.split("\n", 1)[0][3:].strip()
        if block.startswith("## ") and head in EVAL_SECTIONS:
            found.append("### " + block[3:].strip())
    return "\n\n".join(found)


def _jd(job: dict[str, Any]) -> str:
    return f"## 岗位：{label(job)}\n{str(job.get('jd') or '')[:8000]}"


def messages(doc: dict[str, Any], job: dict[str, Any]) -> list[dict[str, str]]:
    notes = evaluation_notes(job["id"])
    user = (_jd(job) + "\n\n"
            + (f"## 岗位评估（参考，事实仍以档案为准）\n{notes}\n\n" if notes else "")
            + f"## 档案和经历（唯一的事实来源）\n{_facts()}\n\n"
            f"## 现在的简历\n{doc.get('body') or '（空）'}")
    return [{"role": "system", "content": PROMPT + kami_rules()}, {"role": "user", "content": user}]


def review_messages(doc: dict[str, Any], job: dict[str, Any], body: str, pages: Optional[float]) -> list[dict[str, str]]:
    measured = f"按导出 PDF 的版式量，预计 {pages:.2f} 页" if pages else "量不了（本机没有可用的 Chromium），篇幅只按内容判断"
    user = (_jd(job) + "\n\n"
            f"## 档案和经历（事实来源）\n{_facts()}\n\n"
            f"## 原简历（事实来源）\n{doc.get('body') or '（空）'}\n\n"
            f"## 页数\n{measured}\n\n"
            f"## 待审简历\n{body}")
    return [{"role": "system", "content": REVIEW_PROMPT}, {"role": "user", "content": user}]


def _is_resume(body: str) -> bool:
    return (body.startswith("# ") or body.startswith("#\n")) and "\n## " in body  # 没名字的简历第一行是 #


def clean(text: str) -> str:
    """去掉模型偶尔包的代码块围栏；不像简历就报错，不写库。"""
    body = text.strip()
    if fence := re.fullmatch(FENCE + r"[\w-]*\n(.*?)\n?" + FENCE, body, re.S):
        body = fence.group(1).strip()
    if not body:
        raise ValueError("模型没有返回内容，检查设置里的模型配置后再试。简历没动")
    if not _is_resume(body):
        raise ValueError("模型返回的不是简历格式（要以 # 名字 开头、有 ## 分节）。简历没动")
    return body + "\n"


def parse_review(raw: Optional[str]) -> dict[str, Any]:
    """审稿输出 → {edits, notes}；不是 JSON 对象就报 ValueError。category 不认识的归到 tone。"""
    text = (raw or "").strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise ValueError("审稿没有返回 JSON")
    data = json.loads(text[start:end + 1])
    if not isinstance(data, dict):
        raise ValueError("审稿返回的不是 JSON 对象")
    edits = [{"old": item["old"], "new": str(item.get("new") or ""), "reason": str(item.get("reason") or ""),
              "category": item.get("category") if item.get("category") in CATEGORIES else "tone"}
             for item in data.get("edits") or []
             if isinstance(item, dict) and isinstance(item.get("old"), str) and item["old"].strip()]
    raw_notes = data.get("notes") if isinstance(data.get("notes"), dict) else {}
    asks = [{key: str(item.get(key) or "").strip() for key in ASK_KEYS}
            for item in data.get("asks") or [] if isinstance(item, dict)]
    return {"edits": edits, "notes": {key: str(raw_notes.get(key) or "无") for key in NOTE_KEYS},
            "asks": [ask for ask in asks if ask["old"] and ask["question"]]}


def pick_asks(asks: list[dict[str, str]], body: str) -> list[dict[str, str]]:
    """只留终稿里一字不差、只出现一次的句子（修订可能已经改掉它），去重，最多 MAX_ASKS 条。"""
    seen: set[str] = set()
    out: list[dict[str, str]] = []
    for ask in asks:
        if ask["old"] in seen or body.count(ask["old"]) != 1:
            continue
        seen.add(ask["old"])
        out.append(ask)
    return out[:MAX_ASKS]


REVIEW_RETRY = ("上一条回复不是一个完整的 JSON 对象。按要求只返回一个 JSON 对象"
                "（{\"edits\": [...], \"notes\": {...}}），不要别的文字。")


async def review(complete: Complete, msgs: list[dict[str, str]]) -> dict[str, Any]:
    """审稿一次：模型没返回、或回的不是 JSON，就带上它的原回复再要一次；第二次还不行才报 ValueError。
    chat_completion 出错（网关报错、超时）时返回 None，这里和「回了但不是 JSON」分开写原因。"""
    def parse(raw: Optional[str]) -> dict[str, Any]:
        if raw is None or not raw.strip():
            raise ValueError("审稿调用没有返回内容（网关报错或超时，详见后端日志）")
        return parse_review(raw)

    raw = await complete(msgs)
    try:
        return parse(raw)
    except ValueError:
        retry = [*msgs, *([{"role": "assistant", "content": raw}] if raw and raw.strip() else []),
                 {"role": "user", "content": REVIEW_RETRY}]
        try:
            return parse(await complete(retry))
        except ValueError as exc:
            raise ValueError(f"{exc}（已重试一次）") from None


def apply_edits(body: str, edits: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]], list[dict[str, Any]]]:
    """按 old 精确替换，按顺序一条条来；old 找不到或出现不止一次就跳过并写明原因。"""
    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for edit in edits:
        count = body.count(edit["old"])
        if count != 1:
            skipped.append({**edit, "why": "原文里找不到" if count == 0 else f"原文出现 {count} 次，不唯一"})
            continue
        body = body.replace(edit["old"], edit["new"], 1)
        applied.append(edit)
    return re.sub(r"\n{3,}", "\n\n", body).strip() + "\n", applied, skipped


def measure(body: str, doc: dict[str, Any]) -> Optional[float]:
    """按导出 PDF 的同一份 HTML 量页数（会开 Chromium，在线程里调）；量不了返回 None，审稿时如实告诉模型。"""
    try:
        from app.core import resume, resume_model

        record = {"body": body, "resume": resume_model.from_markdown(body), "style": doc.get("style"),
                  "template": doc.get("template"), "title": doc.get("title")}
        return resume.page_count(resume.doc_html(record))
    except Exception:  # noqa: BLE001 - 量不了不影响改写，审稿 prompt 里会写明
        return None


def _default_stream() -> Stream:
    from app.agents import agent_fallback
    from app.agents.llm import chat_completion_stream, resolve_llm_client_config

    try:
        resolve_llm_client_config()  # 没配模型、又不许交给外置 Agent 时直接报 ValueError，别等到流里静默返回空
    except ValueError:
        if not agent_fallback.enabled():
            raise
    return lambda msgs: chat_completion_stream(msgs, temperature=0.3, max_tokens=4096)


def _default_complete() -> Complete:
    from app.agents.llm import chat_completion

    return lambda msgs: chat_completion(msgs, temperature=0.2, json_mode=True, max_tokens=4096)


def _since(mark: float) -> float:
    return round(time.perf_counter() - mark, 2)


def _replay(body: str) -> Stream:
    """review_only 用：把已有正文当作「起草结果」原样交出去。"""
    async def stream(messages):
        yield body
    return stream


async def run(doc_id: int, job_id: Optional[int] = None, *, stream: Optional[Stream] = None,
              complete: Optional[Complete] = None, deadline: Optional[float] = None,
              actor: str = "Agent", review_only: bool = False) -> AsyncIterator[dict[str, Any]]:
    """事件：start → delta…（起草）→ review…（每轮审稿开始）→ done（已保存，doc_id 是写入的那份简历）；
    任何一步失败是 error，之后不再有事件。审稿某一轮出错或超时只停在那一轮，写进 done 的 rounds，初稿和已修订的部分照常保存。
    review_only：不重新起草，拿这个岗位已有的定制简历直接审稿（档案补了新成果后「用新信息再改一下」），没有 delta 事件。"""
    doc = store.get("doc", int(doc_id))
    if doc is None or doc.get("kind") != "resume":
        yield {"type": "error", "message": f"简历 #{doc_id} 不存在"}
        return
    job_id = int(job_id or doc.get("job_id") or 0)
    job = store.get("job", job_id) if job_id else None
    if job is None:
        yield {"type": "error", "message": "先给这份简历选一个岗位"}
        return
    if not str(job.get("jd") or "").strip():
        yield {"type": "error", "message": f"「{label(job)}」还没有 JD，先在岗位页贴上"}
        return
    if doc["id"] in _running:
        yield {"type": "error", "message": "这份简历正在改写，等它写完或取消"}
        return
    if review_only:
        base_id, _ = _target(doc, job)
        base = store.get("doc", base_id) if base_id else None
        if base is None or not str(base.get("body") or "").strip():
            yield {"type": "error", "message": "这个岗位还没有定制简历，先完整改写一次"}
            return
        stream = _replay(base["body"])
    try:
        stream = stream or _default_stream()
    except ValueError as exc:
        yield {"type": "error", "message": str(exc)}
        return
    complete = complete or _default_complete()
    if deadline is None:
        from app.config import get_settings

        deadline = float(get_settings().llm_timeout) * 3
        from app.agents import agent_fallback

        if agent_fallback.needed():  # 外置 Agent 冷启动慢，给足时间
            deadline = max(deadline, agent_fallback.TIMEOUT_SECONDS + 30.0)

    _running.add(doc["id"])
    try:
        yield {"type": "start", "job": label(job)}
        # 分段计时（秒）：定位改写变慢用，放进 done 事件并写日志
        started = time.perf_counter()
        timings: dict[str, Any] = {}
        # 核对来源里的原简历；只审稿且审的就是这份时不算，免得拿自己对自己
        origin = "" if review_only and base["id"] == doc["id"] else str(doc.get("body") or "")
        parts: list[str] = []
        try:
            async with asyncio.timeout(deadline):
                async for piece in stream(messages(doc, job)):
                    parts.append(piece)
                    if not review_only:
                        yield {"type": "delta", "text": piece}
        except TimeoutError:
            yield {"type": "error", "message": f"超过 {deadline:g} 秒没写完，已停下。简历没动"}
            return
        timings["draft"] = _since(started)
        try:
            body = clean("".join(parts))
        except ValueError as exc:
            yield {"type": "error", "message": str(exc)}
            return

        rounds: list[dict[str, Any]] = []
        notes = {key: "无" for key in NOTE_KEYS}
        asks: list[dict[str, str]] = []
        calls = [0]  # 每轮模型调用次数：2 说明审稿重试了

        async def counted(msgs: list[dict[str, str]]) -> Optional[str]:
            calls[0] += 1
            return await complete(msgs)

        for number in range(1, ROUNDS + 1):
            mark = time.perf_counter()
            pages = await asyncio.to_thread(measure, body, doc)
            seconds: dict[str, Any] = {"measure": _since(mark)}
            yield {"type": "review", "round": number, "pages": pages}
            entry: dict[str, Any] = {"round": number, "pages": pages, "applied": [], "skipped": [], "seconds": seconds}
            rounds.append(entry)
            mark, calls[0] = time.perf_counter(), 0
            try:
                async with asyncio.timeout(deadline):
                    verdict = await review(counted, review_messages(doc, job, body, pages))
            except TimeoutError:
                entry["error"] = f"超过 {deadline:g} 秒没审完"
                break
            except ValueError as exc:  # json.JSONDecodeError 也是 ValueError
                entry["error"] = str(exc)
                break
            finally:
                seconds.update(review=_since(mark), calls=calls[0])
            notes = verdict["notes"]
            if number == 1:
                asks = verdict["asks"]
            revised, applied, skipped = apply_edits(body, verdict["edits"])
            if applied and not _is_resume(revised):
                skipped = [{**edit, "why": "改完不像简历了，这一轮整轮作废"} for edit in applied] + skipped
                applied = []
            entry.update(applied=applied, skipped=skipped)
            if not applied:
                break
            body = revised

        asks = pick_asks(asks, body)
        mark = time.perf_counter()
        checks = verify.check(body, (_facts() + "\n\n" + origin).strip())
        timings["verify"], mark = _since(mark), time.perf_counter()
        target_id, extra = _target(doc, job)
        result = await asyncio.to_thread(save, "doc", {**extra, "body": body, "pending_asks": asks}, target_id, actor=actor)
        record = result["record"]
        timings["save"], mark = _since(mark), time.perf_counter()
        pages = await asyncio.to_thread(measure, record["body"], record)
        timings.update(final_measure=_since(mark), total=_since(started))
        _log.info("tailor doc=%s review_only=%s timings=%s rounds=%s", record["id"], review_only, timings,
                  [entry["seconds"] for entry in rounds])
        yield {"type": "done", "doc_id": record["id"], "body": record["body"], "resume": record["resume"],
               "change_id": result["change_id"], "pages": pages, "rounds": rounds, "notes": notes, "asks": asks, "checks": checks, "timings": timings,
               "grounding": [edit for entry in rounds for edit in entry["applied"] if edit["category"] == "grounding"]}
    finally:
        _running.discard(doc["id"])


def _target(doc: dict[str, Any], job: dict[str, Any]) -> tuple[Optional[int], dict[str, Any]]:
    """写到哪份简历：本身就是岗位简历就原地改；主简历就写进这个岗位已有的定制简历，没有就新建，主简历不动。"""
    if doc.get("job_id"):
        return doc["id"], {}
    existing = next((d for d in sorted(store.all_of("doc", job_id=job["id"]), key=lambda d: -d["id"])
                     if d.get("kind") == "resume"), None)
    if existing:
        return existing["id"], {}
    fresh: dict[str, Any] = {"kind": "resume", "job_id": job["id"], "title": f"{doc.get('title') or '简历'} · {label(job)}"}
    if doc.get("style"):
        fresh["style"] = doc["style"]
    return None, fresh
