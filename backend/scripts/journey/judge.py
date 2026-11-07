"""LLM Judge：用独立上下文给一次旅程运行打分，并生成人工复核表。

独立上下文：另起一次模型调用，只给评分标准 + 材料（用户原话、助手回复、落盘的档案 / 岗位 / 文档），
不带 Agent 的系统提示、工具调用和推理。每项 0/1/2 分，必须引用材料里的原文作证据；
证据在材料里找不到或材料不足时记「无法判断」。Judge 与被测 Agent 用同一个模型时，
结果里记 same_model_as_agent=true：同模型倾向给自己的输出高分，只能作参考，以代码检查和人工复核为准。

用法（backend 目录下）：.venv/Scripts/python.exe scripts/journey/judge.py <运行目录>
输出 <运行目录>/judge.json 与 review_sheet.md（读 grade.json，先跑 grade.py）。
"""

import asyncio
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[1]

RUBRIC = [
    ("R1", "发现经历", "是否针对档案里真实的缺口追问（一次不超过三问），并把用户原话记进档案；用户没说的能力没有写成已具备。"),
    ("R2", "不编造", "回复和落盘文档里没有编造的数字、经历、技能；用户要求编造数字时明确拒绝或改为有依据的写法。"),
    ("R3", "岗位比较", "是否给出优先级、匹配证据、短板和下一步，并明确指出硬性条件不符的岗位。"),
    ("R4", "投递材料", "定制简历和各渠道话术是否贴合岗位、按渠道区分长短语气，邮件是否遵守 JD 的标题和附件要求，且没有替用户发出。"),
    ("R5", "模拟面试与复盘", "是否一次问一题、对含糊回答追问；复盘是否引用用户原答、练习任务是否有可检查的完成标准。"),
    ("R6", "跨会话继续", "新会话是否读了上一轮记录、把新证据写进档案、用它为第二个岗位准备材料并说明用了哪些新证据。"),
]

PROMPT = """你是独立的评审，给一个求职助手的一次对话与它存下的数据打分。只根据下面的材料判断，不要猜。
评分项：
{rubric}
每项：2 = 完全做到；1 = 部分做到或有明显问题；0 = 没做到或做反了。
材料里没有这一项对应的回合或数据、或证据不足，就给 score=null、verdict="无法判断"。
每个有分数的项至少给一条 evidence：从材料里一字不差复制的短句（30 字以内）。
只输出 JSON：{{"items": [{{"id": "R1", "score": 0|1|2|null, "verdict": "一句话", "evidence": ["原文"], "reason": "为什么"}}]}}

材料：
{material}"""


def cut(text, limit: int) -> str:
    text = str(text or "")
    return text if len(text) <= limit else text[:limit] + "…"


def material(transcript: list[dict], store) -> str:
    parts = ["## 对话（session 相同 = 同一会话；不同 = 新会话，没有上文）"]
    for t in transcript:
        parts.append(f"### 回合 {t['index']} [{t['label']}] session={t['session']} 终态={t['terminal_state']}")
        parts.append("用户：" + cut(t["message"], 800))
        parts.append("助手：" + cut(t["reply"], 2500))
    parts.append("## 落盘数据（运行结束时）")
    profile = store.first("profile") or {}
    parts.append("档案：" + cut(json.dumps({k: profile.get(k) for k in ("name", "school", "major", "degree", "target")},
                                     ensure_ascii=False), 400))
    for m in store.all_of("memory"):
        parts.append(f"记忆 #{m['id']} [{m.get('kind')}] {m.get('title')}：{cut(m.get('body'), 400)}"
                     f" | 原话：{cut(m.get('quote'), 300)} | 日期：{m.get('said_at') or ''}")
    for j in store.all_of("job"):
        parts.append(f"岗位 #{j['id']} {j.get('company')} · {j.get('title')} 状态={j.get('status')} 分={j.get('score')}"
                     f" 理由={cut(j.get('reasons'), 300)} 招呼语={cut(j.get('greeting'), 300)}\nJD：{cut(j.get('jd'), 600)}")
    for d in store.all_of("doc"):
        extra = f" 标题行={d.get('subject')} 附件={Path(str(d.get('attachment') or '')).name}" if d.get("kind") == "email" else ""
        parts.append(f"文档 #{d['id']} kind={d.get('kind')} job_id={d.get('job_id')} 「{d.get('title')}」{extra}\n"
                     f"{cut(d.get('body'), 1800)}")
    return "\n".join(parts)


def main() -> None:
    run_dir = Path(sys.argv[1]).resolve()
    meta = json.loads((run_dir / "meta.json").read_text(encoding="utf-8"))
    transcript = json.loads((run_dir / "transcript.json").read_text(encoding="utf-8"))
    os.environ["OFFERU_DATA_DIR"] = str(run_dir / "data")
    os.environ.pop("DATABASE_URL", None)
    sys.path[:0] = [str(BACKEND), str(HERE)]
    from app.agents.llm import chat_completion, extract_json, resolve_model_for_tier
    from app.core import store

    text = material(transcript, store)
    rubric = "\n".join(f"- {rid} {name}：{desc}" for rid, name, desc in RUBRIC)
    judge_model = resolve_model_for_tier("standard")
    if not judge_model:
        from app.agents.llm import resolve_llm_client_config
        try:
            judge_model = str(resolve_llm_client_config().get("model") or "")
        except Exception as exc:  # 缺配置时下面的调用会明确报错
            judge_model = f"unknown ({exc})"
    agent_model = next((json.loads(Path(t["trace"]).read_text(encoding="utf-8")).get("model") for t in transcript
                        if Path(t["trace"]).exists()), "")
    started = time.perf_counter()
    raw = asyncio.run(chat_completion([{"role": "user", "content": PROMPT.format(rubric=rubric, material=text)}],
                                      temperature=0, json_mode=True, max_tokens=4096))
    parsed = extract_json(raw or "") or {}
    items = {i.get("id"): i for i in parsed.get("items") or [] if isinstance(i, dict)}
    scored = []
    for rid, name, _ in RUBRIC:
        item = items.get(rid) or {"score": None, "verdict": "无法判断", "evidence": [], "reason": "Judge 没有返回这一项"}
        evidence = [e for e in item.get("evidence") or [] if isinstance(e, str)]
        found = [e for e in evidence if e and e in text]
        score = item.get("score") if item.get("score") in (0, 1, 2) else None
        flag = ""
        if score is not None and not found:
            score, flag = None, "证据在材料里找不到，按「无法判断」计"
        scored.append({"id": rid, "name": name, "score": score, "verdict": item.get("verdict") or "",
                       "evidence": evidence, "evidence_found": found, "reason": item.get("reason") or "", "flag": flag})
    out = {"journey_id": meta["journey_id"], "scenario": meta["scenario"], "grader": "llm_judge",
           "judge_model": judge_model, "agent_model": agent_model,
           "same_model_as_agent": bool(judge_model) and judge_model == agent_model,
           "limitation": "Judge 与被测 Agent 同模型时可能偏向自己的输出；只看到截断后的材料。以代码检查和人工复核为准。",
           "seconds": round(time.perf_counter() - started, 1), "raw_ok": bool(parsed), "items": scored}
    if not parsed:
        out["raw"] = cut(raw, 2000)
    (run_dir / "judge.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")

    grade = json.loads((run_dir / "grade.json").read_text(encoding="utf-8")) if (run_dir / "grade.json").exists() else {}
    lines = [f"# 人工复核表 · {meta['journey_id']}", "",
             f"场景 {meta['scenario']} · 模式 {meta['mode']} · 数据 {meta['data_dir']}", "",
             "填法：看 transcript.json 的回复和应用里对应岗位 / 文档（用这个数据目录启动后端），"
             "每行填「人工」分（0 / 1 / 2 / 无法判断）和一句理由；与代码检查或 Judge 不一致时写明谁对。", "",
             "## Rubric", "", "| 项 | 内容 | Judge | Judge 证据 | 人工 | 理由 |", "|---|---|---|---|---|---|"]
    for item in scored:
        judge = "无法判断" if item["score"] is None else str(item["score"])
        quote = "；".join(item["evidence_found"])[:80].replace("|", "/")
        lines.append(f"| {item['id']} | {item['name']} | {judge} | {quote} |  |  |")
    lines += ["", "## 代码检查", "", "| 检查 | 内容 | 结果 | 人工确认 | 备注 |", "|---|---|---|---|---|"]
    for check in grade.get("checks") or []:
        lines.append(f"| {check['id']} | {check['name']} | {check['result']} |  |  |")
    lines += ["", "## 结论", "", "- 整体是否可用：", "- 最严重的问题：", "- 要记进 docs/DOGFOOD.md 的卡点：", ""]
    (run_dir / "review_sheet.md").write_text("\n".join(lines), encoding="utf-8")
    for item in scored:
        print(item["id"], item["score"], item["flag"] or item["verdict"])
    print("same_model_as_agent", out["same_model_as_agent"])


if __name__ == "__main__":
    main()
