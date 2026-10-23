"""All OfferU data in one SQLite file: records (profile / memory / job / event / doc) + a change log for undo.

Records are JSON with a few known fields per type (see tools.py); anything else an agent wants to keep is kept too.
Every write goes through here and leaves a change that can be undone.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

TYPES = ("profile", "memory", "job", "event", "doc")
_lock = threading.RLock()
_conn: Optional[sqlite3.Connection] = None
_path: Optional[str] = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY, type TEXT NOT NULL, job_id INTEGER, data TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS records_type ON records(type, updated_at);
CREATE INDEX IF NOT EXISTS records_job ON records(job_id);
CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, summary TEXT NOT NULL,
  type TEXT NOT NULL, record_id INTEGER NOT NULL, before TEXT, after TEXT, undone_at TEXT);
"""


def db_path() -> str:
    base = os.environ.get("OFFERU_DATA_DIR") or str(Path.home() / ".offeru")
    Path(base).mkdir(parents=True, exist_ok=True)
    return str(Path(base) / "offeru.db")


def conn() -> sqlite3.Connection:
    global _conn, _path
    path = db_path()
    if _conn is None or _path != path:
        _conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.executescript(SCHEMA)
        _path = path
    return _conn


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _row(row: sqlite3.Row | None) -> Optional[dict[str, Any]]:
    if row is None:
        return None
    return {**json.loads(row["data"]), "id": row["id"], "type": row["type"], "job_id": row["job_id"],
            "created_at": row["created_at"], "updated_at": row["updated_at"]}


def _plain(record: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in record.items() if k not in ("id", "type", "created_at", "updated_at")}


def get(type_: str, id_: int) -> Optional[dict[str, Any]]:
    return _row(conn().execute("SELECT * FROM records WHERE id=? AND type=?", (id_, type_)).fetchone())


def first(type_: str) -> Optional[dict[str, Any]]:
    return _row(conn().execute("SELECT * FROM records WHERE type=? ORDER BY id LIMIT 1", (type_,)).fetchone())


def all_of(type_: str, job_id: Optional[int] = None) -> list[dict[str, Any]]:
    sql, args = "SELECT * FROM records WHERE type=?", [type_]
    if job_id is not None:
        sql, args = sql + " AND job_id=?", [*args, job_id]
    return [_row(r) for r in conn().execute(sql + " ORDER BY updated_at DESC, id DESC", args)]


def _log(c: sqlite3.Connection, actor: str, summary: str, type_: str, record_id: int,
         before: Optional[dict], after: Optional[dict]) -> int:
    cur = c.execute("INSERT INTO changes(at, actor, summary, type, record_id, before, after) VALUES (?,?,?,?,?,?,?)",
                    (now(), actor, summary, type_, record_id,
                     json.dumps(before, ensure_ascii=False) if before is not None else None,
                     json.dumps(after, ensure_ascii=False) if after is not None else None))
    return int(cur.lastrowid)


def save(type_: str, data: dict[str, Any], *, id_: Optional[int], actor: str, summary: str) -> tuple[dict, int]:
    """Create (id_ None) or merge-update. Fields set to None are removed."""
    with _lock:
        c = conn()
        c.execute("BEGIN")
        try:
            before = get(type_, id_) if id_ is not None else None
            if id_ is not None and before is None:
                raise ValueError(f"{type_} #{id_} 不存在")
            merged = {**(_plain(before) if before else {}), **data}
            merged = {k: v for k, v in merged.items() if v is not None}
            job_id = merged.pop("job_id", None)
            stamp = now()
            if before is None:
                cur = c.execute("INSERT INTO records(type, job_id, data, created_at, updated_at) VALUES (?,?,?,?,?)",
                                (type_, job_id, json.dumps(merged, ensure_ascii=False), stamp, stamp))
                id_ = int(cur.lastrowid)
            else:
                c.execute("UPDATE records SET job_id=?, data=?, updated_at=? WHERE id=?",
                          (job_id, json.dumps(merged, ensure_ascii=False), stamp, id_))
            after = get(type_, id_)
            change = _log(c, actor, summary, type_, id_, _plain(before) if before else None, _plain(after))
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise
    return after, change


def delete(type_: str, id_: int, *, actor: str, summary: str) -> int:
    with _lock:
        c = conn()
        before = get(type_, id_)
        if before is None:
            raise ValueError(f"{type_} #{id_} 不存在")
        c.execute("BEGIN")
        c.execute("DELETE FROM records WHERE id=?", (id_,))
        change = _log(c, actor, summary, type_, id_, _plain(before), None)
        c.execute("COMMIT")
    return change


def changes(limit: int = 20) -> list[dict[str, Any]]:
    rows = conn().execute("SELECT id, at, actor, summary, type, record_id, before IS NULL AS created, "
                          "after IS NULL AS deleted, undone_at FROM changes ORDER BY id DESC LIMIT ?", (limit,))
    return [dict(r) for r in rows]


def undo(change_id: int, *, actor: str) -> dict[str, Any]:
    """Put the record back the way it was before this change."""
    with _lock:
        c = conn()
        row = c.execute("SELECT * FROM changes WHERE id=?", (change_id,)).fetchone()
        if row is None:
            raise ValueError(f"改动 #{change_id} 不存在")
        if row["undone_at"]:
            raise ValueError("这条改动已经撤销过了")
        before = json.loads(row["before"]) if row["before"] else None
        c.execute("BEGIN")
        if before is None:
            c.execute("DELETE FROM records WHERE id=?", (row["record_id"],))
        else:
            job_id = before.pop("job_id", None)
            data = json.dumps(before, ensure_ascii=False)
            exists = c.execute("SELECT 1 FROM records WHERE id=?", (row["record_id"],)).fetchone()
            if exists:
                c.execute("UPDATE records SET job_id=?, data=?, updated_at=? WHERE id=?", (job_id, data, now(), row["record_id"]))
            else:
                c.execute("INSERT INTO records(id, type, job_id, data, created_at, updated_at) VALUES (?,?,?,?,?,?)",
                          (row["record_id"], row["type"], job_id, data, now(), now()))
        c.execute("UPDATE changes SET undone_at=? WHERE id=?", (now(), change_id))
        c.execute("COMMIT")
    return {"undone": change_id, "summary": row["summary"], "actor": actor}
