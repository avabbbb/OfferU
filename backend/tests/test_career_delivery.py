from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest

from app.services import career_delivery
from app.services.career_artifacts import ARTIFACT_TYPES, CareerArtifactStore


def _reengagement_metadata(idempotency_key: str) -> dict:
    return {
        "idempotency_key": idempotency_key,
        "director": {
            "task_id": "career_task_synthetic",
            "artifact_type": "reengagement_candidate",
            "idempotency_key": idempotency_key,
        },
        "scope": {"resume_id": 7, "job_id": 11},
    }


def _save_reengagement(store: CareerArtifactStore, *, idempotency_key: str, content: str = "Synthetic candidate") -> dict:
    return store.save(
        artifact_type="reengagement_candidate",
        title="Synthetic re-engagement candidate",
        content_markdown=content,
        related_job_id=11,
        metadata=_reengagement_metadata(idempotency_key),
    )


def test_reengagement_is_a_persisted_delivery_type() -> None:
    assert career_delivery.DELIVERY_ARTIFACT_TYPES["reengagement_candidate"] == "reengagement_candidate"
    assert "reengagement_candidate" in ARTIFACT_TYPES


def test_reengagement_artifact_is_idempotent_under_concurrent_retry(tmp_path) -> None:
    store = CareerArtifactStore(tmp_path)
    key = "career-director:synthetic-task:reengagement_candidate:11:7:"

    with ThreadPoolExecutor(max_workers=8) as workers:
        artifacts = list(
            workers.map(
                lambda _: _save_reengagement(
                    CareerArtifactStore(tmp_path), idempotency_key=key
                ),
                range(8),
            )
        )

    assert len({artifact["id"] for artifact in artifacts}) == 1
    assert len(list(tmp_path.glob("artifact_*.json"))) == 1
    assert store.find_by_idempotency_key("reengagement_candidate", key)["id"] == artifacts[0]["id"]


def test_conflicting_concurrent_retry_cannot_replace_winning_content(tmp_path) -> None:
    key = "career-director:synthetic-task:concurrent-conflict"
    barrier = Barrier(8)

    def save(index: int):
        barrier.wait()
        try:
            return _save_reengagement(
                CareerArtifactStore(tmp_path),
                idempotency_key=key,
                content=f"Synthetic payload {index}",
            )
        except ValueError as exc:
            return exc

    with ThreadPoolExecutor(max_workers=8) as workers:
        results = list(workers.map(save, range(8)))

    saved = [result for result in results if isinstance(result, dict)]
    rejected = [result for result in results if isinstance(result, ValueError)]
    assert len(saved) == 1
    assert len(rejected) == 7
    persisted = CareerArtifactStore(tmp_path).find_by_idempotency_key(
        "reengagement_candidate", key
    )
    assert persisted["content_markdown"] == saved[0]["content_markdown"]


def test_artifact_idempotency_is_scoped_by_type_and_store_directory(tmp_path) -> None:
    key = "career-director:synthetic-task:shared-key"
    first_store = CareerArtifactStore(tmp_path / "owner-a")
    other_store = CareerArtifactStore(tmp_path / "owner-b")
    first = _save_reengagement(first_store, idempotency_key=key)
    interview_metadata = _reengagement_metadata(key)
    interview_metadata["director"]["artifact_type"] = "interview_prep"
    different_type = first_store.save(
        artifact_type="interview_prep",
        title="Synthetic practice",
        content_markdown="Synthetic practice content",
        related_job_id=11,
        metadata=interview_metadata,
    )
    different_store = _save_reengagement(
        other_store, idempotency_key=key, content="Other owner synthetic content"
    )

    assert first["id"] != different_type["id"]
    assert first_store.find_by_idempotency_key("reengagement_candidate", key)["id"] == first["id"]
    assert first_store.find_by_idempotency_key("interview_prep", key)["id"] == different_type["id"]
    assert other_store.find_by_idempotency_key("reengagement_candidate", key) == different_store
    assert first_store.find_by_idempotency_key("reengagement_candidate", key)["content_markdown"] == "Synthetic candidate"


def test_idempotency_key_cannot_silently_replace_saved_content(tmp_path) -> None:
    store = CareerArtifactStore(tmp_path)
    key = "career-director:synthetic-task:immutable"
    original = _save_reengagement(store, idempotency_key=key, content="Original synthetic content")

    with pytest.raises(ValueError, match="idempotency key"):
        _save_reengagement(store, idempotency_key=key, content="Conflicting synthetic content")

    assert store.find_by_idempotency_key("reengagement_candidate", key)["id"] == original["id"]
    assert len(list(tmp_path.glob("artifact_*.json"))) == 1


def test_artifact_saves_without_idempotency_key_keep_random_id_behavior(tmp_path) -> None:
    store = CareerArtifactStore(tmp_path)
    first = store.save(artifact_type="job_evaluation", title="Synthetic", content_markdown="One")
    second = store.save(artifact_type="job_evaluation", title="Synthetic", content_markdown="One")

    assert first["id"] != second["id"]
    assert len(list(tmp_path.glob("artifact_*.json"))) == 2


@pytest.mark.parametrize("key", ["x" * 201, 123])
def test_invalid_idempotency_keys_fail_closed(tmp_path, key) -> None:
    store = CareerArtifactStore(tmp_path)

    with pytest.raises(ValueError, match="idempotency key"):
        store.save(
            artifact_type="job_evaluation",
            title="Synthetic",
            content_markdown="Synthetic content",
            metadata={"idempotency_key": key},
        )

    assert list(tmp_path.glob("artifact_*.json")) == []
