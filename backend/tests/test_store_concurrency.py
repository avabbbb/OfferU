import threading

from app.core import store


def test_concurrent_save_and_read_share_one_connection_safely():
    # store keeps one sqlite3 connection for all threads; reads used to run outside _lock
    # and came back as None / undecodable data while a save was in flight.
    errors: list[BaseException] = []
    stop = threading.Event()

    def writer(n: int) -> None:
        try:
            for i in range(60):
                store.save("event", {"title": f"w{n}-{i}", "at": "2026-12-01T10:00:00"},
                           id_=None, actor="test", summary="concurrency")
        except BaseException as exc:
            errors.append(exc)

    def reader() -> None:
        try:
            while not stop.is_set():
                for row in store.all_of("event"):
                    assert isinstance(row["title"], str)
                store.changes(5)
        except BaseException as exc:
            errors.append(exc)

    readers = [threading.Thread(target=reader) for _ in range(3)]
    writers = [threading.Thread(target=writer, args=(n,)) for n in range(3)]
    for t in readers + writers:
        t.start()
    for t in writers:
        t.join(timeout=60)
    stop.set()
    for t in readers:
        t.join(timeout=60)

    assert not errors, errors[:3]
    assert len(store.all_of("event")) == 180
