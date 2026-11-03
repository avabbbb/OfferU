"""按岗位改简历：档案 + 记忆 + 岗位评估 + JD + 现在的简历 → 一份新的 Markdown 简历，边写边推给前端。

一次改写就是一次流式调用，有硬性时限。只有完整跑完、而且返回的还是简历格式时才写库，
记成「Agent」的一条改动，可以撤销；超时、取消、模型出错、格式不对都不动简历。
主简历（没关联岗位）不被覆盖：结果写进这个岗位的定制简历，没有就新建一份。
同一份简历同时只跑一个改写。
"""

import asyncio
import re
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Optional

from app.core import fact_check, store, tailor_report
from app.core.tools import FIELDS, MEMORY_KIND, label, save

Stream = Callable[[list[dict[str, str]]], AsyncIterator[str]]

PROMPT = (
    "你是简历编辑。按岗位 JD 改写用户的简历。只用「档案和经历」里有的事实，不编造经历、数字、公司、技能。\n"
    "和 JD 相关的经历放前面、写具体，无关的压缩或删掉；要点动词开头，写清做了什么、结果和数字；控制在一页 A4。\n"
    "简历要经得起面试追问：技术类经历每段写出关键做法（方案选型和原因、难点怎么解决、性能或质量的量化结果），用档案里出现过的技术名词，不写空泛的「负责」「参与」；"
    "档案里没有的做法和数字不要补，JD 要求但档案里没有的技能不要硬塞。\n"
    "如果给了「岗位评估」，按里面的逐条匹配和简历怎么改来取舍；评估里写成差距或「待补充」的内容不要写进简历。\n"
    "只输出完整的 Markdown 简历本身，不要解释，不要代码块。写法："
    + FIELDS["doc"].split("也可以只传 body，写法：", 1)[1].split("，保存时转成", 1)[0]
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
        head = " ".join(filter(None, [f"[{MEMORY_KIND.get(memory.get('kind') or '', '其他')}]", memory.get("title"), span]))
        lines.append(f"{head}\n{memory.get('body') or ''}".strip())
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


def messages(doc: dict[str, Any], job: dict[str, Any]) -> list[dict[str, str]]:
    notes = evaluation_notes(job["id"])
    user = (f"## 岗位：{label(job)}\n{tailor_report.clean_jd(str(job.get('jd') or ''))[:8000]}\n\n"
            + (f"## 岗位评估（参考，事实仍以档案为准）\n{notes}\n\n" if notes else "")
            + f"## 档案和经历（唯一的事实来源）\n{_facts()}\n\n"
            f"## 现在的简历\n{doc.get('body') or '（空）'}")
    return [{"role": "system", "content": PROMPT + kami_rules()}, {"role": "user", "content": user}]


def clean(text: str) -> str:
    """去掉模型偶尔包的代码块围栏；不像简历就报错，不写库。"""
    body = text.strip()
    if fence := re.fullmatch(FENCE + r"[\w-]*\n(.*?)\n?" + FENCE, body, re.S):
        body = fence.group(1).strip()
    if not body:
        raise ValueError("模型没有返回内容，检查设置里的模型配置后再试。简历没动")
    if not body.startswith("# ") or "\n## " not in body:
        raise ValueError("模型返回的不是简历格式（要以 # 名字 开头、有 ## 分节）。简历没动")
    return body + "\n"


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


def _default_stream() -> Stream:
    from app.agents import agent_fallback
    from app.agents.llm import chat_completion_stream, resolve_llm_client_config

    try:
        resolve_llm_client_config()  # 没配模型、又不许交给外置 Agent 时直接报 ValueError，别等到流里静默返回空
    except ValueError:
        if not agent_fallback.enabled():
            raise
    return lambda msgs: chat_completion_stream(msgs, temperature=0.3, max_tokens=4096)


async def run(doc_id: int, job_id: Optional[int] = None, *, stream: Optional[Stream] = None,
              deadline: Optional[float] = None, actor: str = "Agent") -> AsyncIterator[dict[str, Any]]:
    """事件：start → delta… → done（已保存，doc_id 是写入的那份简历）；任何一步失败是 error，之后不再有事件。"""
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
    try:
        stream = stream or _default_stream()
    except ValueError as exc:
        yield {"type": "error", "message": str(exc)}
        return
    if deadline is None:
        from app.config import get_settings

        deadline = float(get_settings().llm_timeout) * 3
        from app.agents import agent_fallback

        if agent_fallback.needed():  # 外置 Agent 冷启动慢，给足时间
            deadline = max(deadline, agent_fallback.TIMEOUT_SECONDS + 30.0)

    _running.add(doc["id"])
    try:
        yield {"type": "start", "job": label(job)}
        parts: list[str] = []
        try:
            async with asyncio.timeout(deadline):
                async for piece in stream(messages(doc, job)):
                    parts.append(piece)
                    yield {"type": "delta", "text": piece}
        except TimeoutError:
            yield {"type": "error", "message": f"超过 {deadline:g} 秒没写完，已停下。简历没动"}
            return
        try:
            body = clean("".join(parts))
        except ValueError as exc:
            yield {"type": "error", "message": str(exc)}
            return
        target_id, extra = _target(doc, job)
        result = await asyncio.to_thread(save, "doc", {**extra, "body": body}, target_id, actor=actor)
        record = result["record"]
        # 确定性核对：新简历里的数字、日期、机构、英文词在档案/记忆/原简历里找不到出处的，只提醒不挡写库
        unsupported = fact_check.check(body, [_facts(), str(doc.get("body") or "")])
        # 关键词覆盖、页数、审稿：同样只提醒；量页数要开浏览器，放线程里
        report = await asyncio.to_thread(tailor_report.build, body, str(job.get("jd") or ""), record)
        event = {"type": "done", "doc_id": record["id"], "body": record["body"], "resume": record["resume"],
                 "change_id": result["change_id"], "unsupported": unsupported}
        event.update(report)
        yield event
    finally:
        _running.discard(doc["id"])
