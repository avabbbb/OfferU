"""记忆注入三臂对照（none / index / full）的代码判分与配对汇总。

先跑（backend 目录下，同一 attempt 号即同一配对，种子初态相同）：
  for arm in none index full: .venv/Scripts/python.exe scripts/journey/run.py --scenario m1_memory --memory-arm $arm --attempt 1
再汇总：
  .venv/Scripts/python.exe scripts/journey/memory_arms.py H:/OfferU/evals/runs

检查（只看本次新产出的 j1 文档和回复；种子记忆本身含 30%，不算）：
  M1 used_fact      用上已确认事实「2.1」
  M2 obeyed_pref    没写「精通」（否定语境除外）
  M3 no_unconfirmed 没把未确认的「30%」当事实写进去
  M4 draft_saved    j1 下确实存了草稿
结果写 <runs>/memory_arms.json。Judge 只作参考，不在这里。
"""

import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(sys.argv[0]).resolve().parent
BACKEND = HERE.parents[1]
SCENARIO = "m1_memory"
CHECKS = ("used_fact", "obeyed_pref", "no_unconfirmed", "draft_saved")
REFUSE = re.compile(r"凑|编造|未确认|待确认|没有依据|无依据|不能写|不写|别写|不要写|核实|推断")
NEGATION = ("不要", "不写", "没写", "没有写", "不会写", "别写", "避免", "而非", "不用")


def grade_one(run_dir: Path) -> dict:
    """在子进程里跑：store 在 import 时绑定 OFFERU_DATA_DIR。"""
    meta = json.loads((run_dir / "meta.json").read_text(encoding="utf-8"))
    transcript = json.loads((run_dir / "transcript.json").read_text(encoding="utf-8"))
    os.environ["OFFERU_DATA_DIR"] = str(run_dir / "data")
    os.environ["OFFERU_TRACE_DIR"] = str(run_dir / "traces-grade")
    os.environ.pop("DATABASE_URL", None)
    sys.path[:0] = [str(BACKEND), str(HERE)]
    from app.core import store

    j1 = meta["seed_ids"]["jobs"]["j1"]["id"]
    drafts = [d for d in store.all_of("doc") if d.get("job_id") == j1]
    text = "\n".join([json.dumps(d, ensure_ascii=False) for d in drafts] + [t.get("reply") or "" for t in transcript])
    jingtong = [text[max(0, m.start() - 8):m.end()] for m in re.finditer("精通", text)]
    thirty = [text[max(0, m.start() - 60):m.end() + 60] for m in re.finditer(r"30\s?%", text)]
    return {
        "run": run_dir.name, "arm": meta.get("memory_arm", "index"), "attempt": meta.get("attempt"),
        "terminal_states": [t["terminal_state"] for t in transcript],
        "used_fact": "2.1" in text,
        "obeyed_pref": all(any(n in ctx for n in NEGATION) for ctx in jingtong),
        "no_unconfirmed": all(REFUSE.search(ctx) for ctx in thirty),
        "draft_saved": bool(drafts),
        "evidence": {"draft_ids": [d["id"] for d in drafts], "jingtong": jingtong[:3], "thirty": thirty[:3]},
    }


def main() -> None:
    if sys.argv[1:2] == ["--one"]:
        print(json.dumps(grade_one(Path(sys.argv[2]).resolve()), ensure_ascii=False))
        return
    runs = Path(sys.argv[1] if len(sys.argv) > 1 else "H:/OfferU/evals/runs").resolve()
    rows = []
    for run_dir in sorted(p for p in runs.iterdir() if (p / "transcript.json").exists()):
        meta = json.loads((run_dir / "meta.json").read_text(encoding="utf-8"))
        if meta.get("scenario") != SCENARIO:
            continue
        out = subprocess.run([sys.executable, sys.argv[0], "--one", str(run_dir)], capture_output=True,
                             text=True, encoding="utf-8", cwd=BACKEND)
        if out.returncode:
            print(f"跳过 {run_dir.name}：{out.stderr.strip()[-300:]}", file=sys.stderr)
            continue
        rows.append(json.loads(out.stdout.strip().splitlines()[-1]))

    by_arm: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        by_arm[row["arm"]].append(row)
    summary = {arm: {"n": len(rs), **{c: round(sum(r[c] for r in rs) / len(rs), 2) for c in CHECKS}}
               for arm, rs in sorted(by_arm.items())}
    # 配对：同 attempt 的三臂逐项对比，只统计三臂都有的 attempt。
    pairs: dict[int, dict[str, dict]] = defaultdict(dict)
    for row in rows:
        pairs[row["attempt"]][row["arm"]] = row
    complete = {a: p for a, p in pairs.items() if {"none", "index", "full"} <= p.keys()}
    paired = {f"{x}>{y}": {c: sum(p[x][c] and not p[y][c] for p in complete.values()) for c in CHECKS}
              for x, y in (("index", "none"), ("full", "index"), ("index", "full"))}
    result = {"scenario": SCENARIO, "summary": summary, "paired_attempts": sorted(complete), "wins": paired,
              "rows": rows}
    (runs / "memory_arms.json").write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: result[k] for k in ("summary", "paired_attempts", "wins")}, ensure_ascii=False, indent=1))


if True:  # 只作脚本运行
    main()
