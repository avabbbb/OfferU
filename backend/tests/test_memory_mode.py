"""经历性质 mode：拆简历只收和 kind 对得上的值，存的时候校验。"""
import pytest

from app.core import resume_split, tools


def test_split_keeps_mode_only_when_it_fits_kind():
    assert resume_split.normalize({"kind": "experience", "title": "中国电信 · 产品推广经理", "mode": "全职"})["mode"] == "全职"
    assert resume_split.normalize({"kind": "education", "title": "华南师范大学", "mode": "全日制"})["mode"] == "全日制"
    assert "mode" not in resume_split.normalize({"kind": "experience", "title": "中国电信", "mode": "全日制"})
    assert "mode" not in resume_split.normalize({"kind": "project", "title": "OfferU", "mode": "全职"})
    assert "mode" not in resume_split.normalize({"kind": "experience", "title": "中国电信", "mode": ""})


def test_save_checks_mode_against_kind():
    tools._check("memory", {"kind": "experience", "title": "中国电信", "mode": "全职"}, creating=True)
    tools._check("memory", {"kind": "education", "title": "华南师范大学", "mode": "非全日制"}, creating=True)
    with pytest.raises(ValueError, match="memory.mode"):
        tools._check("memory", {"kind": "education", "title": "华南师范大学", "mode": "全职"}, creating=True)
    with pytest.raises(ValueError, match="memory.mode"):
        tools._check("memory", {"kind": "experience", "title": "中国电信", "mode": "正式"}, creating=True)


def test_memory_fields_mention_mode():
    assert "mode" in tools.FIELDS["memory"]
