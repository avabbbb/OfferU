"""按岗位改简历：档案 + 记忆 + JD + 现在的简历 → 一份新的 Markdown 简历，边写边推给前端。

一次改写就是一次流式调用，有硬性时限。只有完整跑完、而且返回的还是简历格式时才写库，
记成「Agent」的一条改动，可以撤销；超时、取消、模型出错、格式不对都不动简历。
同一份简历同时只跑一个改写。
"""

import asyncio
import re
from typing import Any, AsyncIterator, Callable, Optional

from app.core import store
from app.core.tools import FIELDS, MEMORY_KIND, label, save

Stream = Callable[[list[dict[str, str]]], AsyncIterator[str]]

PROMPT = (
    "你是简历编辑。按岗位 JD 改写用户的简历。只用「档案和经历」里有的事实，不编造经历、数字、公司、技能。\n"
    "和 JD 相关的经历放前面、写具体，无关的压缩或删掉；要点动词开头，写清做了什么、结果和数字；控制在一页 A4。\n"
    "只输出完整的 Markdown 简历本身，不要解释，不要代码块。写法：" + FIELDS["doc"].split("简历 body 的写法：", 1)[1]
)

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


def messages(doc: dict[str, Any], job: dict[str, Any]) -> list[dict[str, str]]:
    user = (f"## 岗位：{label(job)}\n{str(job.get('jd'))[:8000]}\n\n"
            f"## 档案和经历（唯一的事实来源）\n{_facts()}\n\n"
            f"## 现在的简历\n{doc.get('body') or '（空）'}")
    return [{"role": "system", "content": PROMPT}, {"role": "user", "content": user}]


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


def _default_stream() -> Stream:
    from app.agents.llm import chat_completion_stream, resolve_llm_client_config

    resolve_llm_client_config()  # 没配模型时直接报 ValueError，别等到流里静默返回空
    return lambda msgs: chat_completion_stream(msgs, temperature=0.3, max_tokens=4096)


async def run(doc_id: int, job_id: Optional[int] = None, *, stream: Optional[Stream] = None,
              deadline: Optional[float] = None) -> AsyncIterator[dict[str, Any]]:
    """事件：start → delta… → done（已保存）；任何一步失败是 error，之后不再有事件。"""
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
        data: dict[str, Any] = {"body": body} if doc.get("job_id") else {"body": body, "job_id": job["id"]}
        result = await asyncio.to_thread(save, "doc", data, doc["id"], actor="Agent")
        yield {"type": "done", "body": body, "change_id": result["change_id"]}
    finally:
        _running.discard(doc["id"])
