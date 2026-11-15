"""Python side of the data backup / restore contract → python-store.json.

Run from repo root while the Python backend still exists (needs pydantic):
    OFFERU_DATA_DIR=$(mktemp -d) python3 backend-ts/test/fixtures/data/gen_data_roundtrip.py

Python writes a store through tools.call (create, update, delete, undo, a resume doc), then:
- `snapshot`: both SQLite tables row for row in the offeru-data v1 shape (what TS export_data writes);
- `views`: what Python's own tools return over that store (list full per type, get, changes).
The TS test imports `snapshot`, checks its export is the same rows, runs the same tool calls and
compares to `views`; a second test restores a TS export into a file Python then reads.
"""
import asyncio
import json
import sqlite3
import sys
from pathlib import Path

here = Path(__file__).resolve().parent
root = here.parents[3]
sys.path.insert(0, str(root / "backend"))
from app.core import store, tools  # noqa: E402


def call(name, args, actor="你"):
    result = tools.call(name, args, actor=actor)
    return asyncio.run(result) if asyncio.iscoroutine(result) else result


call("save", {"type": "profile", "data": {"name": "张三", "school": "某大学"}})
job = call("save", {"type": "job", "data": {"company": "甲公司", "title": "后端实习", "url": "https://jobs.example.com/1"}})["record"]
call("save", {"type": "job", "id": job["id"], "data": {"status": "applied", "applied_at": "2026-11-01"}})
call("save", {"type": "event", "data": {"title": "笔试", "kind": "test", "at": "2026-11-20T19:00", "job_id": job["id"]}})
mem = call("save", {"type": "memory", "data": {"kind": "skill", "title": "SQL", "body": "熟悉窗口函数"}}, actor="agent")["record"]
gone = call("save", {"type": "memory", "data": {"kind": "note", "title": "临时"}})["record"]
call("delete", {"type": "memory", "id": gone["id"]})
undone = call("save", {"type": "event", "data": {"title": "撤销掉的", "kind": "todo"}})
call("undo", {"change_id": undone["change_id"]})
call("save", {"type": "doc", "data": {"kind": "resume", "title": "主简历", "body": "# 张三\n\n## 教育经历\n\n**某大学** 计算机 本科 2023-2027\n"}})

c = sqlite3.connect(store.db_path())
c.row_factory = sqlite3.Row
records = [
    {"id": r["id"], "type": r["type"], "job_id": r["job_id"], "data": json.loads(r["data"]),
     "created_at": r["created_at"], "updated_at": r["updated_at"]}
    for r in c.execute("SELECT * FROM records ORDER BY id")
]
changes = [
    {"id": r["id"], "at": r["at"], "actor": r["actor"], "summary": r["summary"], "type": r["type"],
     "record_id": r["record_id"], "before": json.loads(r["before"]) if r["before"] else None,
     "after": json.loads(r["after"]) if r["after"] else None, "undone_at": r["undone_at"]}
    for r in c.execute("SELECT * FROM changes ORDER BY id")
]
counts = {t: sum(1 for r in records if r["type"] == t) for t in store.TYPES}
counts["changes"] = len(changes)
snapshot = {"format": "offeru-data", "version": 1, "exported_at": "2026-11-15T12:00:00", "counts": counts,
            "records": records, "changes": changes}

views = {
    "list": {t: call("list", {"type": t, "full": True}) for t in store.TYPES},
    "get_job": call("get", {"type": "job", "id": job["id"]}),
    "get_memory": call("get", {"type": "memory", "id": mem["id"]}),
    "changes": call("changes", {"limit": 50}),
}
(here / "python-store.json").write_text(json.dumps({"snapshot": snapshot, "views": views}, ensure_ascii=False, indent=1), encoding="utf-8")
print("ok", counts)
