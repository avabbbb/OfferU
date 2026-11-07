"""回放模式：不调用任何模型，把一次真实运行的录制（transcript、trace、数据库副本）复制成新目录，
标记 mode=replay，再跑一遍代码检查。用途：改了 grade.py 后确认判分结果是否稳定。
LLM Judge 需要模型，回放不跑它。

用法：python scripts/journey/replay.py <运行目录> [<运行目录> ...]
"""
import json
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(sys.argv[0]).resolve().parent


def replay(src: Path) -> int:
    meta = json.loads((src / "meta.json").read_text(encoding="utf-8"))
    if meta.get("mode", "real") != "real":
        print(f"跳过 {src.name}：只回放真实运行")
        return 0
    dst = src.parent / f"{src.name}-replay-{datetime.now():%H%M%S}"
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns("grade.json", "judge.json", "review_sheet.md"))
    meta["mode"] = "replay"
    meta["replay_of"] = src.name
    (dst / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    rc = subprocess.call([sys.executable, str(HERE / "grade.py"), str(dst)])
    old = src / "grade.json"
    new = dst / "grade.json"
    if old.exists() and new.exists():
        a = {c["id"]: c["result"] for c in json.loads(old.read_text(encoding="utf-8"))["checks"]}
        b = {c["id"]: c["result"] for c in json.loads(new.read_text(encoding="utf-8"))["checks"]}
        diff = {k: (a.get(k), b.get(k)) for k in sorted(set(a) | set(b)) if a.get(k) != b.get(k)}
        print(f"{src.name} 回放与原判分差异：{diff or '无'}")
    return rc


sys.exit(max([replay(Path(p)) for p in sys.argv[1:]] or [2]))
