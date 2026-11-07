"""汇总 evals/runs 下的全部运行（包括脚本失败和未打分的）。

用法：python scripts/journey/aggregate.py [runs_dir]
输出：<runs_dir>/../results.md 与 results.json。真实模型 / Mock / 回放按 meta.mode 分开统计，不混在一起。
"""

import json
import sys
from collections import defaultdict
from pathlib import Path


def load(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def run_row(run_dir: Path) -> dict:
    meta = load(run_dir / "meta.json") or {}
    turns = load(run_dir / "transcript.json") or []
    grade = load(run_dir / "grade.json")
    judge = load(run_dir / "judge.json")
    http_bad = [t.get("http_status") for t in turns if t.get("http_status") not in (200, 201, 202, None)]
    errors = [e for t in turns for e in (t.get("errors") or [])]
    states = [t.get("terminal_state") or "none" for t in turns]
    if meta and not meta.get("ended_at"):
        outcome = "未结束（进行中或被中断）"
    elif not turns:
        outcome = "脚本失败（无 transcript）"
    elif http_bad:
        outcome = f"脚本失败（HTTP {sorted(set(map(str, http_bad)))}）"
    elif grade and grade["summary"].get("fail"):
        outcome = "代码检查有失败"
    elif grade:
        outcome = "代码检查通过"
    else:
        outcome = "未打分"
    return {
        "run": run_dir.name,
        "scenario": meta.get("scenario") or run_dir.name.split("-a")[0],
        "attempt": meta.get("attempt"),
        "mode": meta.get("mode") or "real",
        "turns": len(turns),
        "seconds": round(sum(float(t.get("seconds") or 0) for t in turns), 1),
        "terminal_states": states,
        "stop_reasons": [t.get("stop_reason") for t in turns],
        "errors": errors[:5],
        "outcome": outcome,
        "code": grade["summary"] if grade else None,
        "failed_checks": [c["id"] for c in (grade or {}).get("checks", []) if c.get("result") == "fail"],
        "judge": {i["id"]: i.get("score") for i in (judge or {}).get("items", [])} if judge else None,
        "same_model": (judge or {}).get("same_model_as_agent"),
    }


def fmt_judge(j):
    if not j:
        return "—"
    return " ".join(f"{k}={'?' if v is None else v}" for k, v in sorted(j.items()))


def main(argv: list[str]) -> int:
    runs_dir = Path(argv[1]) if len(argv) > 1 else Path("H:/OfferU/evals/runs")
    rows = [run_row(p) for p in sorted(runs_dir.iterdir()) if p.is_dir()]
    by_mode = defaultdict(list)
    for r in rows:
        by_mode[r["mode"]].append(r)
    lines = ["# 旅程评测结果汇总", "", f"运行目录：{runs_dir}，共 {len(rows)} 次运行（失败一并保留）。", "",
             "Judge 分数：0/1/2，? = 无法判断（含本场景不涉及）。Judge 与 Agent 同模型时存在自评偏差，仅供参考，以人工复核为准。", ""]
    for mode in ("real", "mock", "replay"):
        group = by_mode.get(mode, [])
        lines.append(f"## 模式：{mode}（{len(group)} 次）")
        lines.append("")
        if not group:
            lines += ["未运行 / 未实现。", ""]
            continue
        lines.append("| 运行 | 场景 | 尝试 | 回合 | 耗时s | 终态 | 结果 | 代码检查 pass/fail/na | 失败项 | Judge |")
        lines.append("|---|---|---|---|---|---|---|---|---|---|")
        for r in group:
            c = r["code"] or {}
            code = f"{c.get('pass', '—')}/{c.get('fail', '—')}/{c.get('na', '—')}" if c else "—"
            lines.append("| " + " | ".join([
                r["run"], r["scenario"], str(r["attempt"]), str(r["turns"]), str(r["seconds"]),
                ",".join(r["terminal_states"]), r["outcome"], code,
                ",".join(r["failed_checks"]) or "—", fmt_judge(r["judge"]),
            ]) + " |")
        lines.append("")
    out_md = runs_dir.parent / "results.md"
    out_md.write_text("\n".join(lines), encoding="utf-8")
    (runs_dir.parent / "results.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n".join(lines))
    return 0


sys.exit(main(sys.argv))
