"""Row-level change capture: every Agent write can be undone.

While an Agent operation runs inside ``capture()``, every INSERT / UPDATE /
DELETE the backend sends to the database is recorded together with the row's
state before the write (``None`` for rows the operation created). Rows removed
by ``ON DELETE CASCADE`` / ``SET NULL`` are captured too. Undo puts every
touched row back to that state, newest first, in one transaction.

What this cannot see makes the action "not undoable" instead of silently
half-undone: raw SQL writes, inserts whose keys are unknown, and tables
without a primary key. Side effects outside the database (files, the vector
index) are never undone.
"""

from __future__ import annotations

import base64
import contextvars
import re
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import date, datetime, time
from decimal import Decimal
from typing import Any, Iterator

from sqlalchemy import Table, and_, delete, event, insert, select, update
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.pool import Pool
from sqlalchemy.sql.dml import Delete, Insert, Update

from app.database import Base, async_session

# Bookkeeping, not user data: undo never touches these.
BOOKKEEPING_TABLES = frozenset({
    "operation_audit_logs",
    "agent_runs",
    "agent_run_events",
    "agent_actions",
    "agent_input_requests",
    "agent_provider_health",
    "agent_workspace_states",
    "hosted_executor_events",
    "bridge_pairings",
})
# Columns that change on every save; "was it edited later" compares the rest.
_NOT_CONTENT = frozenset({"updated_at", "workspace_revision"})
_WRITE_SQL = re.compile(r"^\s*(insert|update|delete|replace)\b", re.IGNORECASE)

Key = tuple[str, tuple]


@dataclass
class Capture:
    before: dict[Key, dict | None] = field(default_factory=dict)  # first state seen, in touch order
    lossy: str = ""
    open: bool = True


_CURRENT: contextvars.ContextVar[Capture | None] = contextvars.ContextVar("offeru_change_capture", default=None)


@contextmanager
def capture() -> Iterator[Capture]:
    cap = Capture()
    token = _CURRENT.set(cap)
    try:
        yield cap
    finally:
        cap.open = False
        _CURRENT.reset(token)


# ---- encoding rows into JSON -------------------------------------------------

def _encode(value: Any) -> Any:
    if isinstance(value, datetime):
        return {"$dt": value.isoformat()}
    if isinstance(value, date):
        return {"$d": value.isoformat()}
    if isinstance(value, time):
        return {"$t": value.isoformat()}
    if isinstance(value, bytes):
        return {"$b": base64.b64encode(value).decode()}
    if isinstance(value, Decimal):
        return float(value)
    return value


def _decode(value: Any) -> Any:
    if isinstance(value, dict) and len(value) == 1:
        (tag, raw), = value.items()
        if tag == "$dt":
            return datetime.fromisoformat(raw)
        if tag == "$d":
            return date.fromisoformat(raw)
        if tag == "$t":
            return time.fromisoformat(raw)
        if tag == "$b":
            return base64.b64decode(raw)
    return value


def _row(table: Table, mapping: Any) -> dict:
    return {column.name: _encode(mapping[column.name]) for column in table.columns}


def _key(table: Table, mapping: Any) -> Key:
    return table.name, tuple(_encode(mapping[column.name]) for column in table.primary_key.columns)


# ---- recording ------------------------------------------------------------------

def _table(statement: Any) -> Table | None:
    name = getattr(getattr(statement, "table", None), "name", None)
    return Base.metadata.tables.get(name) if name else None


def _pending(conn: Connection) -> list:
    return conn.info.setdefault("offeru_capture_pending", [])


def _note(conn: Connection, cap: Capture, table: Table, rows: list[Any], *, created: bool = False) -> None:
    pending = _pending(conn)
    for mapping in rows:
        pending.append((cap, _key(table, mapping), None if created else _row(table, mapping)))


def _param_sets(multiparams: Any, params: Any) -> list[dict]:
    if multiparams:
        return [dict(item) for item in multiparams if isinstance(item, dict)] or [{}]
    return [dict(params or {})]


def _cascaded(conn: Connection, cap: Capture, table: Table, rows: list[Any], depth: int = 0) -> None:
    """Rows the database itself will delete or null out when ``rows`` go away."""
    if not rows or depth > 8:
        return
    for child in Base.metadata.sorted_tables:
        for fk in child.foreign_keys:
            if fk.column.table is not table or (fk.ondelete or "").upper() not in {"CASCADE", "SET NULL"}:
                continue
            if child.name in BOOKKEEPING_TABLES:
                continue
            values = list({mapping[fk.column.name] for mapping in rows} - {None})
            if not values:
                continue
            found = list(conn.execute(select(child).where(fk.parent.in_(values))).mappings())
            if not found:
                continue
            if not child.primary_key.columns:
                cap.lossy = f"{child.name} 没有主键"
                continue
            if fk.ondelete.upper() == "CASCADE":
                _cascaded(conn, cap, child, found, depth + 1)
            _note(conn, cap, child, found)


@event.listens_for(Engine, "before_execute")
def _before_execute(conn, clauseelement, multiparams, params, execution_options):  # noqa: ANN001
    cap = _CURRENT.get()
    if cap is None or not cap.open or not isinstance(clauseelement, (Update, Delete)):
        return
    table = _table(clauseelement)
    if table is None or table.name in BOOKKEEPING_TABLES:
        return
    if not table.primary_key.columns:
        cap.lossy = f"{table.name} 没有主键"
        return
    query = select(table)
    if clauseelement.whereclause is not None:
        query = query.where(clauseelement.whereclause)
    for values in _param_sets(multiparams, params):
        rows = list(conn.execute(query, values).mappings())
        if isinstance(clauseelement, Delete):
            _cascaded(conn, cap, table, rows)
        _note(conn, cap, table, rows)


@event.listens_for(Engine, "after_execute")
def _after_execute(conn, clauseelement, multiparams, params, execution_options, result):  # noqa: ANN001
    cap = _CURRENT.get()
    if cap is None or not cap.open or not isinstance(clauseelement, Insert):
        return
    table = _table(clauseelement)
    if table is None or table.name in BOOKKEEPING_TABLES:
        return
    try:
        keys = list(result.inserted_primary_key_rows)
    except Exception:  # noqa: BLE001 - executemany without RETURNING, INSERT..SELECT
        keys = []
    names = [column.name for column in table.primary_key.columns]
    if not names or not keys or any(value is None for row in keys for value in row):
        cap.lossy = f"没能记下 {table.name} 新增行的主键"
        return
    _note(conn, cap, table, [dict(zip(names, row)) for row in keys], created=True)


@event.listens_for(Engine, "before_cursor_execute")
def _before_cursor_execute(conn, cursor, statement, parameters, context, executemany):  # noqa: ANN001
    cap = _CURRENT.get()
    if cap is None or not cap.open or not _WRITE_SQL.match(statement or ""):
        return
    compiled = getattr(getattr(context, "compiled", None), "statement", None)
    if isinstance(compiled, (Insert, Update, Delete)):
        return
    if any(re.search(rf"\b{name}\b", statement, re.IGNORECASE) for name in BOOKKEEPING_TABLES):
        return
    cap.lossy = "有一条原生 SQL 写入没法记录"


@event.listens_for(Engine, "commit")
def _commit(conn):  # noqa: ANN001
    for cap, key, before in conn.info.pop("offeru_capture_pending", []):
        cap.before.setdefault(key, before)


@event.listens_for(Engine, "rollback")
def _rollback(conn):  # noqa: ANN001
    conn.info.pop("offeru_capture_pending", None)


@event.listens_for(Pool, "reset")
def _reset(dbapi_connection, connection_record, reset_state=None):  # noqa: ANN001
    connection_record.info.pop("offeru_capture_pending", None)


# ---- reading back and undoing --------------------------------------------------

def _where(table: Table, pk: list) -> Any:
    return and_(*(column == _decode(value) for column, value in zip(table.primary_key.columns, pk)))


def _content(row: dict | None) -> dict | None:
    return None if row is None else {key: value for key, value in row.items() if key not in _NOT_CONTENT}


async def current_rows(changes: list[dict]) -> list[dict | None]:
    """The present content of every touched row (``None`` = row is gone)."""
    out: list[dict | None] = []
    async with async_session() as db:
        for change in changes:
            table = Base.metadata.tables[change["table"]]
            found = (await db.execute(select(table).where(_where(table, change["pk"])))).mappings().first()
            out.append(_content(_row(table, found)) if found else None)
    return out


def to_undo(cap: Capture) -> list[dict]:
    return [{"table": table, "pk": list(pk), "before": before} for (table, pk), before in cap.before.items()]


async def changed_since(changes: list[dict], after: list[dict | None]) -> bool:
    return await current_rows(changes) != after


async def restore(changes: list[dict]) -> int:
    """Put every touched row back to its state before the Agent's write."""

    def _apply(conn: Connection) -> int:
        if conn.dialect.name == "sqlite":
            # Replay order can restore a child before its deleted parent is re-inserted;
            # check foreign keys once at commit, when every row is back.
            conn.exec_driver_sql("PRAGMA defer_foreign_keys=ON")
        for change in reversed(changes):
            table = Base.metadata.tables[change["table"]]
            where = _where(table, change["pk"])
            before = change["before"]
            if before is None:
                conn.execute(delete(table).where(where))
                continue
            values = {key: _decode(value) for key, value in before.items()}
            if conn.execute(update(table).where(where).values(values)).rowcount == 0:
                conn.execute(insert(table).values(values))
        return len(changes)

    async with async_session() as db:
        count = await db.run_sync(lambda session: _apply(session.connection()))
        await db.commit()
        return count
