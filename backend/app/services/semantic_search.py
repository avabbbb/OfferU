# =============================================
# Semantic Search Service — Vector-based Matching
# =============================================
# 使用 Qdrant Vector DB 替代 jieba 分词的关键词匹配
# 实现真正的语义理解：
#   - JD 说"数据驱动决策" 能匹配到 "通过 A/B 测试优化转化率"
#   - JD 说"用户增长" 能匹配到 "电商平台拉新活动策划"
# =============================================

from __future__ import annotations

import hashlib
import logging
from typing import Optional

from qdrant_client import AsyncQdrantClient
from qdrant_client.models import Distance, PointStruct, VectorParams, FieldCondition, Filter, MatchValue

from app.agents.llm import chat_completion
from app.config import get_settings
from app.services.security_redaction import redact_sensitive_text

_logger = logging.getLogger(__name__)

# ---- Embedding 模型配置 ----
# 优先使用 Qwen 的 embedding 模型（便宜）
# 备选：OpenAI text-embedding-3-small
EMBEDDING_MODEL = "text-embedding-v3"  # Qwen embedding
EMBEDDING_DIMENSION = 1024  # Qwen v3 输出维度

# ---- Collection 名称 ----
COLLECTION_PROFILE_BULLETS = "profile_bullets"
COLLECTION_JOB_DESCRIPTIONS = "job_descriptions"
COLLECTION_MEMORY_OBSERVATIONS = "memory_observations"


class SemanticSearchService:
    """语义搜索服务 — 基于 Qdrant Vector DB"""

    def __init__(self):
        self.client: Optional[AsyncQdrantClient] = None
        self.settings = get_settings()
        self._embedding_cache: dict[str, list[float]] = {}  # 简单内存缓存

    async def _get_client(self) -> AsyncQdrantClient:
        """懒加载 Qdrant 客户端"""
        if self.client is None:
            # 本地开发：使用内存模式
            # 生产环境：连接 Docker 容器 (qdrant_host in settings)
            qdrant_host = getattr(self.settings, "qdrant_host", None)
            if qdrant_host:
                self.client = AsyncQdrantClient(host=qdrant_host, port=6333)
                _logger.info("Connected to configured remote Qdrant")
            else:
                self.client = AsyncQdrantClient(":memory:")
                _logger.warning("Using in-memory Qdrant (data will be lost on restart)")

            # 初始化 Collections
            await self._ensure_collections()

        return self.client

    async def _ensure_collections(self):
        """确保必要的 Collections 存在"""
        client = await self._get_client()
        collections = await client.get_collections()
        existing = {c.name for c in collections.collections}

        if COLLECTION_PROFILE_BULLETS not in existing:
            await client.create_collection(
                collection_name=COLLECTION_PROFILE_BULLETS,
                vectors_config=VectorParams(size=EMBEDDING_DIMENSION, distance=Distance.COSINE),
            )
            _logger.info(f"Created collection: {COLLECTION_PROFILE_BULLETS}")

        if COLLECTION_JOB_DESCRIPTIONS not in existing:
            await client.create_collection(
                collection_name=COLLECTION_JOB_DESCRIPTIONS,
                vectors_config=VectorParams(size=EMBEDDING_DIMENSION, distance=Distance.COSINE),
            )
            _logger.info(f"Created collection: {COLLECTION_JOB_DESCRIPTIONS}")

        if COLLECTION_MEMORY_OBSERVATIONS not in existing:
            await client.create_collection(
                collection_name=COLLECTION_MEMORY_OBSERVATIONS,
                vectors_config=VectorParams(size=EMBEDDING_DIMENSION, distance=Distance.COSINE),
            )
            _logger.info(f"Created collection: {COLLECTION_MEMORY_OBSERVATIONS}")

    async def embed_text(self, text: str) -> list[float]:
        """
        将文本转换为 embedding 向量
        优先使用 Qwen embedding API（便宜且效果好）
        """
        if not text or not text.strip():
            return [0.0] * EMBEDDING_DIMENSION

        # 缓存命中
        cache_key = hashlib.md5(text.encode()).hexdigest()
        if cache_key in self._embedding_cache:
            return self._embedding_cache[cache_key]

        try:
            # 调用 Qwen embedding API
            # 注意：需要在 llm.py 中添加 embedding 支持
            from app.agents.llm import get_embedding

            vector = await get_embedding(text, model=EMBEDDING_MODEL)

            # 缓存结果
            self._embedding_cache[cache_key] = vector
            return vector

        except Exception as e:
            _logger.error(
                "Embedding failed: %s",
                redact_sensitive_text(e, max_length=500),
            )
            # Fallback: 返回零向量（不影响系统运行）
            return [0.0] * EMBEDDING_DIMENSION

    # =============================================
    # Profile Bullets 索引与搜索
    # =============================================

    async def index_profile_section(self, section_id: int, title: str, bullet_text: str, profile_id: int):
        """
        索引单个 Profile Section（bullet point）
        """
        client = await self._get_client()
        combined_text = f"{title} {bullet_text}".strip()

        if not combined_text:
            _logger.warning(f"Empty text for section {section_id}, skipping indexing")
            return

        vector = await self.embed_text(combined_text)

        await client.upsert(
            collection_name=COLLECTION_PROFILE_BULLETS,
            points=[
                PointStruct(
                    id=section_id,
                    vector=vector,
                    payload={
                        "section_id": section_id,
                        "profile_id": profile_id,
                        "title": title,
                        "text": combined_text,
                    },
                )
            ],
        )
        _logger.debug(
            "Indexed section %s (content_len=%d)",
            section_id,
            len(combined_text),
        )

    async def batch_index_profile_sections(self, sections: list[dict]):
        """
        批量索引 Profile Sections
        sections: [{"id": int, "title": str, "bullet": str, "profile_id": int}, ...]
        """
        client = await self._get_client()
        points = []

        for section in sections:
            combined_text = f"{section['title']} {section['bullet']}".strip()
            if not combined_text:
                continue

            vector = await self.embed_text(combined_text)
            points.append(
                PointStruct(
                    id=section["id"],
                    vector=vector,
                    payload={
                        "section_id": section["id"],
                        "profile_id": section["profile_id"],
                        "title": section["title"],
                        "text": combined_text,
                    },
                )
            )

        if points:
            await client.upsert(collection_name=COLLECTION_PROFILE_BULLETS, points=points)
            _logger.info(f"Batch indexed {len(points)} profile sections")

    async def search_relevant_sections(
        self,
        jd_text: str,
        profile_id: int,
        limit: int = 12,
        score_threshold: float = 0.5,
    ) -> list[dict]:
        """
        语义搜索：根据 JD 文本找到最相关的 Profile Bullets

        返回: [{"section_id": int, "score": float, "title": str, "text": str}, ...]
        """
        client = await self._get_client()
        jd_vector = await self.embed_text(jd_text)

        results = await client.search(
            collection_name=COLLECTION_PROFILE_BULLETS,
            query_vector=jd_vector,
            query_filter=Filter(must=[FieldCondition(key="profile_id", match=MatchValue(value=profile_id))]),
            limit=limit,
            score_threshold=score_threshold,
        )

        return [
            {
                "section_id": r.id,
                "score": r.score,
                "title": r.payload.get("title", ""),
                "text": r.payload.get("text", ""),
            }
            for r in results
        ]

    async def delete_profile_section(self, section_id: int):
        """删除 Profile Section 的向量索引"""
        client = await self._get_client()
        await client.delete(collection_name=COLLECTION_PROFILE_BULLETS, points_selector=[section_id])
        _logger.debug(f"Deleted vector index for section {section_id}")

    # =============================================
    # Job Description 索引与搜索（可选）
    # =============================================

    async def index_job_description(self, job_id: int, jd_text: str):
        """索引 Job Description（用于反向搜索：给定 Profile 找匹配岗位）"""
        client = await self._get_client()
        vector = await self.embed_text(jd_text)

        await client.upsert(
            collection_name=COLLECTION_JOB_DESCRIPTIONS,
            points=[
                PointStruct(
                    id=job_id,
                    vector=vector,
                    payload={"job_id": job_id, "text": jd_text[:500]},
                )
            ],
        )

    async def search_matching_jobs(self, profile_text: str, limit: int = 20) -> list[dict]:
        """反向搜索：给定用户 Profile 找匹配的岗位"""
        client = await self._get_client()
        profile_vector = await self.embed_text(profile_text)

        results = await client.search(
            collection_name=COLLECTION_JOB_DESCRIPTIONS,
            query_vector=profile_vector,
            limit=limit,
        )

        return [{"job_id": r.id, "score": r.score, "text": r.payload.get("text", "")} for r in results]

    # =============================================
    # Memory Observations 索引与检索（长时记忆语义召回）
    # =============================================

    async def index_observation(
        self,
        observation_id: int,
        text: str,
        payload: Optional[dict] = None,
    ):
        """索引一条 LearningObservation 的文本摘要，供 memory distiller 召回相关历史。"""
        clean_text = str(text or "").strip()
        if not clean_text:
            return
        client = await self._get_client()
        vector = await self.embed_text(clean_text[:2000])
        await client.upsert(
            collection_name=COLLECTION_MEMORY_OBSERVATIONS,
            points=[
                PointStruct(
                    id=observation_id,
                    vector=vector,
                    payload={
                        "observation_id": observation_id,
                        "text": clean_text[:500],
                        **(payload or {}),
                    },
                )
            ],
        )
        _logger.debug(f"Indexed observation {observation_id}")

    async def search_observations(
        self,
        query: str,
        limit: int = 8,
        score_threshold: float = 0.4,
    ) -> list[dict]:
        """语义检索历史 observation；失败返回空列表（调用方降级 SQL）。"""
        clean_query = str(query or "").strip()
        if not clean_query:
            return []
        client = await self._get_client()
        vector = await self.embed_text(clean_query[:2000])
        results = await client.search(
            collection_name=COLLECTION_MEMORY_OBSERVATIONS,
            query_vector=vector,
            limit=limit,
            score_threshold=score_threshold,
        )
        return [
            {
                "observation_id": r.payload.get("observation_id", r.id),
                "score": r.score,
                "text": r.payload.get("text", ""),
                "observation_type": r.payload.get("observation_type", ""),
                "source_type": r.payload.get("source_type", ""),
            }
            for r in results
        ]

    async def delete_observation(self, observation_id: int):
        """删除 observation 的向量索引（来源失效时级联调用）。"""
        client = await self._get_client()
        await client.delete(
            collection_name=COLLECTION_MEMORY_OBSERVATIONS,
            points_selector=[observation_id],
        )


# =============================================
# 全局单例
# =============================================
_semantic_search_service: Optional[SemanticSearchService] = None


def get_semantic_search() -> SemanticSearchService:
    """获取全局语义搜索服务实例"""
    global _semantic_search_service
    if _semantic_search_service is None:
        _semantic_search_service = SemanticSearchService()
    return _semantic_search_service
