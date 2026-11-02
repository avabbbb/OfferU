"""Assets OfferU fetches on first use and then keeps locally.

* School emblems ship with the app (``app/assets/school_logos``, ~800 schools,
  160px palette PNGs, ~6 MB) so matching never needs the network. They come from
  the MIT-licensed dataset github.com/xioajiumi/Chinese_Universities; the emblems
  themselves belong to the schools.
* Kami's typeface (TsangerJinKai02, free for personal non-commercial use) is
  downloaded once into ``uploads/fonts`` and served from there, so the canvas
  and the PDF export use the same font and keep working offline afterwards.
"""

from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

import httpx

from app.runtime_paths import runtime_uploads_dir

LOGO_DIR = Path(__file__).resolve().parents[1] / "assets" / "school_logos"
LOGO_URL_PREFIX = "/api/resume/assets/school-logos/"
FONT_URLS = {
    name: (
        f"https://cdn.jsdelivr.net/gh/tw93/Kami@main/assets/fonts/{name}",
        f"https://raw.githubusercontent.com/tw93/Kami/main/assets/fonts/{name}",
    )
    for name in ("TsangerJinKai02-W04.ttf", "TsangerJinKai02-W05.ttf")
}
# Common short names students type.
ALIASES = {
    "北大": "北京大学", "清华": "清华大学", "复旦": "复旦大学", "上交": "上海交通大学", "交大": "上海交通大学",
    "浙大": "浙江大学", "南大": "南京大学", "中科大": "中国科学技术大学", "人大": "中国人民大学",
    "北航": "北京航空航天大学", "北理": "北京理工大学", "北理工": "北京理工大学", "哈工大": "哈尔滨工业大学",
    "西交": "西安交通大学", "华科": "华中科技大学", "武大": "武汉大学", "中大": "中山大学", "川大": "四川大学",
    "电子科大": "电子科技大学", "成电": "电子科技大学", "北邮": "北京邮电大学", "西电": "西安电子科技大学",
    "华南理工": "华南理工大学", "华工": "华南理工大学", "同济": "同济大学", "南开": "南开大学", "天大": "天津大学",
    "厦大": "厦门大学", "山大": "山东大学", "东南": "东南大学", "北师大": "北京师范大学", "华东师大": "华东师范大学",
    "上海交大": "上海交通大学", "西安交大": "西安交通大学", "北京交大": "北京交通大学", "北交": "北京交通大学",
    "西南交大": "西南交通大学", "国科大": "中国科学院大学", "央财": "中央财经大学", "贸大": "对外经济贸易大学",
    "上财": "上海财经大学", "深大": "深圳大学", "南科大": "南方科技大学", "西工大": "西北工业大学", "中南": "中南大学",
}

_lock = asyncio.Lock()


def _font_dir() -> Path:
    return runtime_uploads_dir("fonts")


def _normalize(name: str) -> str:
    name = re.sub(r"[（(][^）)]*[）)]", "", name or "")  # 中国石油大学（北京） -> campus dropped for fuzzy match
    return re.sub(r"\s+", "", name).strip()


async def _download(urls: tuple[str, ...], *, timeout: float) -> bytes:
    errors = []
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True,
                                 headers={"User-Agent": "OfferU/0.4 asset-fetch"}) as client:
        for url in urls:
            try:
                response = await client.get(url)
                response.raise_for_status()
                return response.content
            except httpx.HTTPError as exc:
                errors.append(f"{url}: {exc}")
    raise ValueError("下载失败：" + "；".join(errors))


_logo_index_cache: dict[str, str] | None = None


def _logo_index() -> dict[str, str]:
    global _logo_index_cache
    if _logo_index_cache is None:
        _logo_index_cache = json.loads((LOGO_DIR / "index.json").read_text("utf-8"))
    return _logo_index_cache


def school_logo_path(file_name: str) -> Path:
    if not re.fullmatch(r"\d{4}\.png", file_name or ""):
        raise ValueError("未知的校徽文件")
    return LOGO_DIR / file_name


async def find_school_logo(school_name: str) -> dict[str, str] | None:
    """``{"school_name", "logo_url"}`` for the best match, or None."""
    wanted = ALIASES.get(school_name.strip(), school_name.strip())
    index = _logo_index()
    candidates = [wanted, _normalize(wanted)]
    for name in candidates:
        if name in index:
            return {"school_name": name, "logo_url": f"{LOGO_URL_PREFIX}{index[name]}"}
    normalized = {(_normalize(key)): key for key in index}
    if _normalize(wanted) in normalized:
        key = normalized[_normalize(wanted)]
        return {"school_name": key, "logo_url": f"{LOGO_URL_PREFIX}{index[key]}"}
    # "北京大学软件与微电子学院" -> 北京大学 : longest school name contained in the input
    contained = sorted((key for key in index if len(key) >= 4 and key in wanted), key=len, reverse=True)
    if contained:
        return {"school_name": contained[0], "logo_url": f"{LOGO_URL_PREFIX}{index[contained[0]]}"}
    return None


def _in_order(key: str, name: str) -> bool:
    """key 的每个字按顺序出现在 name 里：华师 -> 华南师范大学。"""
    chars = iter(name)
    return all(ch in chars for ch in key)


def search_school_logos(query: str, limit: int = 20) -> list[dict[str, str]]:
    """边打边联想：全名 / 简称、前缀、片段（华南、师范）、跳字（华师）都算，最像的排前面，给用户挑。"""
    q = (query or "").strip()
    if not q:
        return []
    key = _normalize(ALIASES.get(q, q))
    scored = []
    for name, file in _logo_index().items():
        n = _normalize(name)
        if n == key:
            rank = 0
        elif n.startswith(key):
            rank = 1
        elif key in n:
            rank = 2
        elif len(n) >= 4 and n in key:
            rank = 3
        elif len(key) >= 2 and _in_order(key, n):
            rank = 4
        else:
            continue
        scored.append((rank, len(n), name, file))
    scored.sort()
    return [{"school_name": name, "file": file, "url": LOGO_URL_PREFIX + file} for _, _, name, file in scored[:limit]]


def transparent_logo(data: bytes, max_side: int = 800) -> bytes:
    """校徽抠成透明底，返回 PNG。从四条边连通、颜色接近边框主色的像素变透明；
    校徽内部和背景同色的区域（被图形围住的白色）不动；轮廓外一圈按色差给半透明，边缘不发毛。
    边框本来大多透明的原样转 PNG。打不开的图片抛 ValueError。"""
    from io import BytesIO

    import numpy as np
    from PIL import Image, UnidentifiedImageError

    try:
        img = Image.open(BytesIO(data))
        img.load()
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("不是能识别的图片") from exc
    img = img.convert("RGBA")
    img.thumbnail((max_side, max_side))
    px = np.array(img, dtype=np.int16)
    rgb, alpha = px[..., :3], px[..., 3]
    border = np.concatenate([px[0], px[-1], px[:, 0], px[:, -1]])
    opaque = border[border[:, 3] > 8]
    bg = np.median(opaque[:, :3], axis=0) if len(opaque) > len(border) // 2 else None
    # 只抠白底/黑底：彩色方块底（如宁波诺丁汉、青海师大）本身就是校徽的一部分，原样保留。
    if bg is not None and bg.max() - bg.min() <= 24 and (bg.min() >= 200 or bg.max() <= 50):
        dist = np.abs(rgb - bg).max(axis=2)
        cand = (alpha <= 8) | (dist <= 40)
        reached = np.zeros_like(cand)
        for edge in (np.s_[0, :], np.s_[-1, :], np.s_[:, 0], np.s_[:, -1]):
            reached[edge] = cand[edge]

        def grow(mask):
            out = mask.copy()
            out[1:] |= mask[:-1]
            out[:-1] |= mask[1:]
            out[:, 1:] |= mask[:, :-1]
            out[:, :-1] |= mask[:, 1:]
            return out

        while True:
            nxt = grow(reached) & cand
            if np.array_equal(nxt, reached):
                break
            reached = nxt
        ring = grow(reached) & ~reached & (dist < 100)
        soft = np.clip(np.divide(dist - 40, 60), 0, 1)
        new_alpha = alpha.astype(np.float32)
        new_alpha[ring] = np.multiply(new_alpha[ring], soft[ring])
        new_alpha[reached] = 0
        px[..., 3] = new_alpha.round().astype(np.int16)
        img = Image.fromarray(px.astype(np.uint8), "RGBA")
    buf = BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


async def kami_font(name: str) -> Path:
    if name not in FONT_URLS:
        raise ValueError("未知字体")
    target = _font_dir() / name
    if target.exists():
        return target
    async with _lock:
        if not target.exists():
            payload = await _download(FONT_URLS[name], timeout=300)
            target.parent.mkdir(parents=True, exist_ok=True)
            partial = target.with_suffix(".part")
            partial.write_bytes(payload)
            partial.replace(target)
    return target
