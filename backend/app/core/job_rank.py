"""岗位评估：读档案、职业记忆（含偏好）和 JD，给每个岗位打 0–100 分并写三句理由。

只用已有事实，不编造。写库由调用方走 tools.save，每个岗位一条改动、可撤销。
"""

from __future__ import annotations

from typing import Any, Iterable

from app.core.resume_split import available  # noqa: F401  同一套「配了模型或允许交给本机 Agent」判断

PROMPT = """你是求职顾问。根据候选人的档案和职业记忆（含偏好），评估每个岗位对他的匹配度，只输出严格 JSON：
{"items": [{"id": 0, "score": 0, "reasons": ["", "", ""]}]}
规则：
1. score 是 0–100 的整数：80 以上值得优先投，60–79 可以投，60 以下不建议。
2. reasons 恰好三句，每句不超过 40 字：第一句说最匹配的点，第二句说最大的差距或风险，第三句说和偏好（城市、方向、公司类型）是否相符。
3. 只用档案、记忆和 JD 里写了的事实，不猜；JD 信息太少就在理由里说明并给保守分。
4. 每个输入岗位都要有一项，id 原样返回。
"""

BATCH = 6
PROFILE_KEYS = ("school", "major", "degree", "grad_year", "city", "target", "stage", "about")


def candidate(profile: dict[str, Any] | None, memories: Iterable[dict[str, Any]]) -> str:
    lines = []
    if profile:
        lines.append("档案：" + "；".join(f"{k}={profile[k]}" for k in PROFILE_KEYS if profile.get(k)))
    for m in memories:
        lines.append(f"[{m.get('kind') or 'note'}] {m.get('title') or ''} {str(m.get('body') or '')[:300]}".strip())
    return "\n".join(lines)[:12_000]


def job_text(job: dict[str, Any]) -> str:
    head = f"id={job['id']} 公司：{job.get('company') or ''} 岗位：{job.get('title') or ''} 城市：{job.get('city') or ''}"
    return f"{head}\n{str(job.get('jd') or '')[:3000]}"


def normalize(parsed: Any, ids: set[int]) -> dict[int, dict[str, Any]]:
    out: dict[int, dict[str, Any]] = {}
    items = parsed.get("items") if isinstance(parsed, dict) else None
    for item in items or []:
        if not isinstance(item, dict):
            continue
        try:
            id_ = int(item.get("id"))
            score = int(round(float(item.get("score"))))
        except (TypeError, ValueError):
            continue
        if id_ not in ids:
            continue
        reasons = [str(r).strip()[:80] for r in item.get("reasons") or [] if str(r).strip()][:3]
        out[id_] = {"score": max(0, min(100, score)), "reasons": reasons}
    return out


async def evaluate(profile_text: str, jobs: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    from app.agents.llm import chat_completion, extract_json

    results: dict[int, dict[str, Any]] = {}
    for start in range(0, len(jobs), BATCH):
        batch = jobs[start:start + BATCH]
        user = "候选人：\n" + (profile_text or "（档案是空的）") + "\n\n岗位：\n" + "\n\n".join(job_text(j) for j in batch)
        raw = await chat_completion(
            [{"role": "system", "content": PROMPT}, {"role": "user", "content": user}],
            temperature=0.2,
            json_mode=True,
            max_tokens=4000,
        )
        results.update(normalize(extract_json(raw or ""), {int(j["id"]) for j in batch}))
    return results
