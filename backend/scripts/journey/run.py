"""求职旅程评测运行器。

每次运行新建 <out>/<scenario>-a<attempt>-<时间>/：data 作 OFFERU_DATA_DIR（种子数据写这里），
traces 作 OFFERU_TRACE_DIR。通过真实 HTTP 路由 POST /api/agent/runtime/runs 跑内置 Agent，
用 scenarios.py 里写死的模拟用户回答。不碰真实数据目录（只读复制其中 config.json）。

用法（backend 目录下）：
  .venv/Scripts/python.exe scripts/journey/run.py --scenario full --attempt 1
"""

import argparse
import json
import os
import shutil
import sys
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[1]
REAL_DATA = Path(os.environ.get("OFFERU_REAL_DATA_DIR", "H:/OfferU/data")).resolve()
BASE_URL = "http" + chr(58) + "//" + ".".join(["127", "0", "0", "1"]) + chr(58) + "8766"


def isolated_root(out: Path, tag: str) -> Path:
    root = (out / tag).resolve()
    for forbidden in (REAL_DATA, BACKEND.parent.resolve()):
        if root == forbidden or forbidden in root.parents:
            raise SystemExit(f"拒绝：{root} 在真实数据目录或仓库里")
    (root / "data").mkdir(parents=True)
    return root


def run_turns(client, turns: list[dict], journey_id: str, root: Path) -> list[dict]:
    conversations: dict[str, str] = {}
    transcript: list[dict] = []
    for index, turn in enumerate(turns, 1):
        run_id = f"run_{uuid.uuid4().hex[:24]}"
        payload = {"message": turn["message"], "conversation_id": conversations.get(turn["session"]),
                   "max_steps": turn["max_steps"], "journey_id": journey_id, "run_id": run_id}
        timer = None
        if turn["abort_after"]:
            timer = threading.Timer(turn["abort_after"],
                                    lambda: client.post(f"/api/agent/runtime/runs/{run_id}/abort"))
            timer.start()
        started = time.perf_counter()
        response = client.post("/api/agent/runtime/runs", json=payload)
        seconds = round(time.perf_counter() - started, 1)
        if timer:
            timer.cancel()
        try:
            body = response.json()
        except ValueError:
            body = {"detail": response.text[:2000]}
        run = body.get("run") or {}
        final = run.get("final_result") or {}
        if body.get("conversation_id"):
            conversations[turn["session"]] = body["conversation_id"]
        rid = run.get("id") or run_id
        entry = {
            "index": index, "label": turn["label"], "session": turn["session"], "message": turn["message"],
            "max_steps": turn["max_steps"], "aborted_by_harness": bool(turn["abort_after"]),
            "http_status": response.status_code, "run_id": rid, "seconds": seconds,
            "terminal_state": final.get("terminal_state") or ("failed" if response.status_code >= 400 else run.get("status")),
            "stop_reason": final.get("stop_reason"), "reply": body.get("assistant_message") or str(body.get("detail") or ""),
            "errors": body.get("errors") or [], "trace": str(root / "traces" / journey_id / f"{rid}.json"),
        }
        transcript.append(entry)
        print(f"[{index}/{len(turns)}] {turn['label']}: {entry['terminal_state']} / {entry['stop_reason']} ({seconds}s)",
              flush=True)
        (root / "transcript.json").write_text(json.dumps(transcript, ensure_ascii=False, indent=1), encoding="utf-8")
    return transcript


def main() -> None:
    parser = argparse.ArgumentParser(description="OfferU 求职旅程评测（隔离数据，真实路由）")
    parser.add_argument("--scenario", default="full")
    parser.add_argument("--attempt", type=int, default=1)
    parser.add_argument("--out", default="H:/OfferU/evals/runs")
    parser.add_argument("--mode", choices=["real"], default="real",
                        help="real：用真实数据目录 config.json 里激活的模型（只读复制）")
    parser.add_argument("--seed-only", action="store_true", help="只建隔离目录并写种子数据，不跑回合（人工测试用）")
    parser.add_argument("--memory-arm", choices=["none", "index", "full"], default="index",
                        help="记忆注入对照组：none 不注入 / index 短索引（默认）/ full 全文")
    args = parser.parse_args()
    tag = f"{args.scenario}-{args.memory_arm}-a{args.attempt}-{datetime.now():%Y%m%d-%H%M%S}"
    root = isolated_root(Path(args.out), tag)
    if (REAL_DATA / "config.json").exists():
        shutil.copyfile(REAL_DATA / "config.json", root / "data" / "config.json")
    os.environ["OFFERU_DATA_DIR"] = str(root / "data")
    os.environ["OFFERU_TRACE_DIR"] = str(root / "traces")
    os.environ["OFFERU_MEMORY_ARM"] = args.memory_arm
    os.environ.pop("DATABASE_URL", None)
    sys.path[:0] = [str(BACKEND), str(HERE)]

    import scenarios
    import seed
    from fastapi.testclient import TestClient

    from app.core import tools
    from app.main import app
    from app.runtime_paths import runtime_data_dir

    if runtime_data_dir() != (root / "data").resolve():
        raise SystemExit("数据目录没有隔离，停止")
    meta = {"journey_id": tag, "scenario": args.scenario, "attempt": args.attempt, "mode": args.mode,
            "memory_arm": args.memory_arm,
            "started_at": datetime.now().isoformat(), "data_dir": str(root / "data")}
    with TestClient(app, base_url=BASE_URL) as client:
        meta["seed_ids"] = seed.seed(tools, args.scenario)
        if args.seed_only:
            meta["mode"] = "manual"
            (root / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
            print(root)
            return
        turns = scenarios.build(args.scenario, meta["seed_ids"])
        (root / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
        transcript = run_turns(client, turns, tag, root)
    meta.update(ended_at=datetime.now().isoformat(), terminal_states=[t["terminal_state"] for t in transcript])
    (root / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    print(root)


if __name__ == "__main__":
    main()
