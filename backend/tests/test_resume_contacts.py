"""联系方式是 {label, value}，旧的一行文字照样读；校徽库搜索给多个候选。"""

from app.core import resume, resume_model
from app.services.web_assets import search_school_logos


def test_contacts_are_labeled_and_old_strings_still_read():
    r = resume_model.normalize({"basics": {"name": "张三", "contacts": [
        "电话：138", "a@b.c", "https://x.dev", {"label": "微信", "value": "zs"}]}, "sections": []})
    assert r["basics"]["contacts"] == [
        {"label": "电话", "value": "138"}, {"label": "", "value": "a@b.c"},
        {"label": "", "value": "https://x.dev"}, {"label": "微信", "value": "zs"}]
    md = resume_model.to_markdown(r)
    assert "电话：138 · a@b.c · https://x.dev · 微信：zs" in md
    assert resume_model.from_markdown(md)["basics"]["contacts"] == r["basics"]["contacts"]
    assert "电话：138 | a@b.c" in resume.resume_html(r)


def test_school_logo_search_returns_candidates():
    hits = search_school_logos("浙大")
    assert hits and hits[0]["school_name"] == "浙江大学"
    assert hits[0]["url"].endswith(hits[0]["file"])
    assert len(search_school_logos("北京")) > 1
    assert search_school_logos("   ") == []


def test_school_logo_search_fuzzy():
    names = lambda q: [hit["school_name"] for hit in search_school_logos(q)]  # noqa: E731
    assert "华南师范大学" in names("华南")
    assert "华南师范大学" in names("华师")
    assert names("华南师范")[0] == "华南师范大学"


def test_figures_float_so_sections_clear_them():
    css = resume.css("kami")
    assert "float: left" in css and "float: right" in css and ".resume section { clear: both; }" in css
    assert "position: absolute; top: var(--margin-top)" not in css


def test_logo_background_becomes_transparent():
    from io import BytesIO

    from PIL import Image, ImageDraw

    from app.services.web_assets import transparent_logo

    img = Image.new("RGB", (100, 100), "white")
    ImageDraw.Draw(img).ellipse((10, 10, 90, 90), outline="navy", width=8)
    buf = BytesIO()
    img.save(buf, format="JPEG")
    out = Image.open(BytesIO(transparent_logo(buf.getvalue()))).convert("RGBA")
    assert out.getpixel((0, 0))[3] == 0 and out.getpixel((99, 99))[3] == 0
    assert out.getpixel((50, 50))[3] == 255  # 圆圈里面的白色不抠
    assert out.getpixel((50, 12))[3] == 255  # 圆圈本身不动


def test_logo_rejects_non_image():
    import pytest

    from app.services.web_assets import transparent_logo

    with pytest.raises(ValueError):
        transparent_logo(b"not an image")
