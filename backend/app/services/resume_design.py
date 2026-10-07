"""Versioned presentation edits, shared by the Registry's Agent and HTTP surfaces."""
from __future__ import annotations

from io import BytesIO
from typing import Literal
from uuid import uuid4

from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select, update
from sqlalchemy.orm import selectinload

from app.database import async_session
from app.models.models import Resume
from app.runtime_paths import runtime_uploads_dir
from app.services.agent_files import atomic_write_bytes
from app.services.resume_route_operations import _decode_upload, _resume_dict
from app.services.resume_versions import create_version_snapshot


class DesignPatch(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    template: Literal["editorial", "reference", "reference-compact", "modern", "modern-two-column", "swiss-single", "swiss-two-column"] | None = None
    pageSize: Literal["A4", "LETTER"] | None = None
    bodySize: float | None = Field(default=None, ge=8, le=20)
    headingSize: float | None = Field(default=None, ge=8, le=28)
    nameSize: float | None = Field(default=None, ge=10, le=40)
    lineHeight: float | None = Field(default=None, ge=1, le=2)
    sectionGap: float | None = Field(default=None, ge=0, le=30)
    itemGap: float | None = Field(default=None, ge=0, le=20)
    paragraphGap: float | None = Field(default=None, ge=0, le=16)
    headerGap: float | None = Field(default=None, ge=0, le=30)
    marginTop: float | None = Field(default=None, ge=3, le=30)
    marginRight: float | None = Field(default=None, ge=3, le=30)
    marginBottom: float | None = Field(default=None, ge=3, le=30)
    marginLeft: float | None = Field(default=None, ge=3, le=30)
    accentColorHex: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    ruleColor: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    photoWidth: float | None = Field(default=None, ge=10, le=50)
    photoHeight: float | None = Field(default=None, ge=10, le=60)
    logoWidth: float | None = Field(default=None, ge=10, le=65)
    logoHeight: float | None = Field(default=None, ge=5, le=40)


class DesignImage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    content_b64: str = Field(min_length=1, max_length=7_000_000)
    content_type: Literal["image/jpeg", "image/png", "image/webp"]


class ResumeDesignInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    resume_id: int = Field(gt=0)
    expected_revision: int = Field(ge=0, description="get_resume 返回的 workspace_revision；过期时重新读取并审阅修改。")
    style_config: DesignPatch = Field(default_factory=DesignPatch)
    photo: DesignImage | None = None
    logo: DesignImage | None = None
    remove_photo: bool = False
    remove_logo: bool = False

    @model_validator(mode="after")
    def valid_changes(self):
        if (self.photo and self.remove_photo) or (self.logo and self.remove_logo):
            raise ValueError("同一图片不能同时上传和移除")
        if not (self.style_config.model_dump(exclude_none=True) or self.photo or self.logo or self.remove_photo or self.remove_logo):
            raise ValueError("请提供至少一项版式或图片修改")
        return self


def validate_design_image(image: DesignImage) -> tuple[bytes, str]:
    content = _decode_upload(image.content_b64)
    expected, extension = {"image/jpeg": ("JPEG", "jpg"), "image/png": ("PNG", "png"), "image/webp": ("WEBP", "webp")}[image.content_type]
    try:
        with Image.open(BytesIO(content)) as decoded:
            if decoded.format != expected or decoded.width * decoded.height > 25_000_000:
                raise ValueError("图片格式与声明不符，或超过 2500 万像素")
            decoded.verify()
    except (OSError, SyntaxError, Image.DecompressionBombError) as exc:
        raise ValueError("无法读取上传图片") from exc
    return content, extension


async def update_resume_design(resume_id: int, expected_revision: int, style_config: dict | None = None,
                               photo: dict | None = None, logo: dict | None = None,
                               remove_photo: bool = False, remove_logo: bool = False) -> dict:
    request = ResumeDesignInput(resume_id=resume_id, expected_revision=expected_revision, style_config=style_config or {},
                                photo=photo, logo=logo, remove_photo=remove_photo, remove_logo=remove_logo)
    # Validate both images before creating files or changing the record.
    images = {kind: validate_design_image(image) for kind, image in (("photo", request.photo), ("logo", request.logo)) if image}
    created = []
    committed = False
    try:
        async with async_session() as db:
            resume = (await db.execute(select(Resume).where(Resume.id == resume_id).options(selectinload(Resume.sections)))).scalar_one_or_none()
            if resume is None:
                raise ValueError("Resume not found")
            if int(resume.workspace_revision or 0) != expected_revision:
                raise ValueError("简历已被修改，请重新读取后再提交版式提案")
            style = {**(resume.style_config or {}), **{key: str(value) for key, value in request.style_config.model_dump(exclude_none=True).items()}}
            contact = dict(resume.contact_json or {})
            photo_url = "" if remove_photo else resume.photo_url
            if remove_logo:
                for key in ("schoolLogoUrl", "universityLogoUrl", "logoUrl", "school_logo_url"):
                    contact.pop(key, None)
            if not images and style == (resume.style_config or {}) and contact == (resume.contact_json or {}) and photo_url == resume.photo_url:
                return {**_resume_dict(resume), "duplicate": True}
            # Acquire the row with a compare-and-swap in the same transaction as snapshots.
            result = await db.execute(update(Resume).where(Resume.id == resume_id, Resume.workspace_revision == expected_revision)
                                      .values(workspace_revision=expected_revision + 1).execution_options(synchronize_session=False))
            if result.rowcount != 1:
                raise ValueError("简历已被修改，请重新读取后再提交版式提案")
            await create_version_snapshot(db, resume, change_summary="版式修改前", created_by="resume_design")
            for kind, (content, extension) in images.items():
                folder = "photos" if kind == "photo" else "logos"
                path = runtime_uploads_dir(folder) / f"{uuid4().hex}.{extension}"
                created.append(path)
                atomic_write_bytes(path, content)
                url = f"/uploads/{folder}/{path.name}"
                if kind == "photo":
                    photo_url = url
                else:
                    contact["schoolLogoUrl"] = url
            resume.style_config, resume.contact_json, resume.photo_url = style, contact, photo_url
            resume.workspace_revision = expected_revision + 1
            version = await create_version_snapshot(db, resume, change_summary="版式与图片修改", created_by="resume_design")
            resume.current_version_id = version.id
            await db.flush()
            await db.refresh(resume, attribute_names=["updated_at"])
            output = {**_resume_dict(resume), "duplicate": False}
            await db.commit()
            committed = True
            return output
    finally:
        if not committed:
            for path in created:
                path.unlink(missing_ok=True)
