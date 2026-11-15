"""Golden outputs of the Python resume domain, for the TS contract tests (backend-ts/test/resume.contract.test.ts).

Run from backend/:  python ../backend-ts/test/fixtures/resume/gen_golden.py
Needs only pydantic, pydantic-settings, numpy, Pillow (no FastAPI / SQLAlchemy). Rewrites golden.json next to this file.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = tempfile.mkdtemp(prefix="offeru-golden-")
os.environ["OFFERU_DATA_DIR"] = DATA
sys.path.insert(0, str(Path.cwd()))

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

from app.core import impact, resume, resume_model, store, tailor, verify  # noqa: E402
from app.core.tools import check_style, save  # noqa: E402
from app.services import web_assets  # noqa: E402

out: dict = {}


def strip_ids(r):
    r = json.loads(json.dumps(r))
    for sec in r["sections"]:
        sec.pop("id", None)
        for it in sec["items"]:
            it.pop("id", None)
    return r


def err(fn, *args):
    try:
        fn(*args)
    except ValueError as exc:
        return str(exc)
    return None


# ---- templates css ----
out["css"] = {t: resume.css(t) for t in ("classic", "clear", "kami", "compact", "single", "photo", "nope")}

# ---- markdown <-> structure ----
MDS = [
    "# 张三\n电话：138 0000 0000 · 邮箱：a@b.com | https://x.dev\n\n求职意向：产品经理\n\n## 教育经历\n### 某大学 | 计算机 | 2022.09 – 2026.06\n- GPA 3.8/4.0\n- 主修课程：**数据结构**、操作系统\n\n## 实习工作经历\n### 字节跳动 | 后端 | 北京 | 2025.06 – 2025.09\n- 接口 QPS 提升 30%\n  续行写在这里\n1. 有序要点\n\n## 自我评价\n热爱技术\n第二行\n",
    "#\n138 · a@b.com\n\n## 技能\n### 语言\nPython、Go\n",
    "无名字的一段\n\n第二段\n\n### 孤立条目 | 2024\n- 要点\n&nbsp;\n## 获奖\n### 国奖 | 学院 | 城市 | 某组织 | 2023\n",
    "",
    "# 李四\n\n## 项目经历\n### 一个项目\n\n### A | B\n  缩进的正文\n",
]
out["markdown"] = []
for md in MDS:
    parsed = resume_model.from_markdown(md)
    out["markdown"].append({"in": md, "resume": strip_ids(parsed), "md": resume_model.to_markdown(parsed)})

STRUCT = {
    "basics": {"name": " 王五 ", "target": "数据分析", "contacts": ["电话：139", {"label": "", "value": "w@x.cn"}, "https://a.b", {"label": "微信", "value": "  "}]},
    "sections": [
        {"id": "s1", "title": "教育背景", "items": [{"id": "i1", "title": "北大", "subtitle": "统计", "date": "2020 – 2024", "location": "北京",
                                                    "bullets": ["**GPA** 3.9", "", "*斜体* 与 [链](https://x.dev/?a=1&b=2)"], "text": "{center} 居中\n  - 列表\n1. 一\n普通 <b>"}]},
        {"id": "s2", "type": "custom", "title": "隐藏", "hidden": True, "items": [{"title": "x"}]},
        {"id": "s3", "title": "  ", "items": [{"id": "i3", "title": "", "date": "2024"}, {"id": "i4", "text": "只有正文"}]},
        {"id": "s4", "type": "bogus", "title": "项目", "items": []},
    ],
}
out["normalize"] = {"in": STRUCT, "resume": strip_ids(resume_model.normalize(STRUCT)), "md": resume_model.to_markdown(STRUCT)}
BAD = [None, [], {"basics": "x"}, {"sections": {}}, {"sections": ["x"]}, {"sections": [{"items": [1]}]},
       {"sections": [{"items": [{"title": {"a": 1}}]}]}, {"basics": {"contacts": "a"}}, {"sections": [{"items": [{"bullets": [True]}]}]}]
out["normalize_errors"] = [{"in": b, "error": err(resume_model.normalize, b)} for b in BAD]

# ---- style ----
STYLES_BAD = [[], {"x": 1, "a": 2}, {"template": "nope"}, {"font": "mono"}, {"bodySize": 20}, {"bodySize": True}, {"lineHeight": 0.5},
              {"margin": {"top": 1}}, {"margin": {"middle": 5}}, {"margin": 5}, {"accent": "red"}, {"photo": "yes"},
              {"logo": "a/b.png"}, {"logo": ""}, {"sectionGap": 31}, {"itemGap": -1}]
out["style_errors"] = [{"in": s, "error": err(check_style, s)} for s in STYLES_BAD]
out["style_ok"] = [{"in": s, "error": err(check_style, s)} for s in ({}, {"template": "kami", "bodySize": 9, "margin": {"top": 3}, "accent": "#AbCdEf", "photo": True, "logo": "logo-x.png", "font": None})]
out["resolve_style"] = [{"style": s, "legacy": l, "out": resume.resolve_style(s, l)} for s, l in (
    (None, None), ({"template": "kami"}, None), (None, "photo"), ({"template": "compact", "bodySize": 11, "margin": {"left": 20}}, "single"),
    ({"template": "nope", "accent": "#123456"}, None), ({"photo": None, "logo": "x.png"}, "compact"))]

# ---- inline markup (bold / italic / ++underline++ / links) ----
INLINES = ["熟悉 ++Python++ 和 C++、C++11", "++a++b ++c++", "x++y++", "++ 空 ++", "**粗** *斜* ++下++ [链](https://a.b/?q=\"1\")",
           "a <b> & ++<i>++", "++中文++。", "C++ ++Go++", "+++三+++", "++a++++b++"]
out["inline"] = {t: resume._inline(t) for t in INLINES}

# ---- render ----
photo = Image.new("RGB", (4, 4), (200, 10, 10))
buf = io.BytesIO(); photo.save(buf, format="JPEG"); photo_bytes = buf.getvalue()
logo = Image.new("RGBA", (3, 3), (0, 0, 255, 255))
buf = io.BytesIO(); logo.save(buf, format="PNG"); logo_bytes = buf.getvalue()
(store.data_dir("files") / "photo.jpg").write_bytes(photo_bytes)
(store.data_dir("files") / "logo-a.png").write_bytes(logo_bytes)
out["files"] = {"photo.jpg": base64.b64encode(photo_bytes).decode(), "logo-a.png": base64.b64encode(logo_bytes).decode()}
fixed = resume_model.normalize(STRUCT)
RENDERS = [
    ({}, None, "简历"),
    ({"template": "kami", "photo": True}, "photo.jpg", "张三-简历"),
    ({"template": "compact", "photo": False, "logo": "logo-a.png"}, "photo.jpg", "a<b>'\""),
    ({"template": "clear", "photo": True, "logo": "missing.png", "bodySize": 11, "margin": {"top": 20}}, "nope.jpg", "t"),
]
out["render"] = [{"resume": fixed, "style": s, "photo": p, "title": t, "html": resume.render_html(fixed, s, p, t)} for s, p, t in RENDERS]

# ---- doc html / file name (store-backed) ----
save("profile", {"name": "张三/ 李", "photo": "photo.jpg"}, actor="你")
DOCS = [
    {"kind": "resume", "title": "主简历", "body": MDS[0], "style": {"template": "clear", "photo": True}},
    {"kind": "resume", "title": "  后端:实习?  ", "template": "photo", "body": MDS[1]},
    {"kind": "resume", "body": "", "resume": STRUCT, "style": {"logo": "logo-a.png"}},
]
out["doc_html"] = [{"doc": d, "html": resume.doc_html(d), "file_name": resume.file_name(d)} for d in DOCS]
out["safe_stem"] = {s: resume.safe_stem(s) for s in ("a/b:c*d?e\"f<g>h|i", "  x   y  ", "._a_.", "", "简历 2026")}

# ---- verify ----
SOURCES = """[实习 / 工作] 某公司 · 运营实习 2023.06 – 2023.09
参与公众号运营，粉丝从 2,000 涨到 8000
（用户 2026-11-04 亲口说：大概让处理时间缩短了三成左右）
- 协助策划校园活动，来了 300 人"""
BODIES = [
    "# 张三\n1. 运营实习 2023.06 – 2023.09\n- 参与公众号运营，粉丝从 2000 涨到 8,000\n- 协助策划校园活动，来了 300 人",
    "- 参与公众号运营，粉丝从 2000 涨到 2 万",
    "- 主导公众号运营，处理时间缩短三成\n- 策划全网爆款校园活动，来了 300 人",
    "- 参与公众号运营，处理时间缩短约三成",
    "### 某公司 | 运营 | 2023.6 – 2023.9\n- 增长 1.50 倍，营收 2.5万，用户 25000，留存 百分之三十\n- ２０２３ 年 全国首个",
    "- 成本降低 12.345%\r\n- 2025.06 上线",
]
out["verify"] = [{"body": b, "sources": SOURCES, "out": verify.check(b, SOURCES)} for b in BODIES]
out["verify"].append({"body": "- 粉丝涨到 8000", "sources": "  ", "out": verify.check("- 粉丝涨到 8000", "  ")})
MEMS = [
    {"id": 1, "kind": "experience", "title": "某公司 · 运营实习", "body": "主导公众号运营\n粉丝 2万 → 8万", "quote": "大概 3 个月"},
    {"id": 2, "kind": "project", "title": "推荐系统", "body": "召回率 +12%", "confirmed": False},
    {"id": 3, "kind": "preference", "title": "别写负责", "body": "x"},
    {"id": 4, "kind": "award", "title": "国家奖学金", "body": "2023"},
    {"id": 5, "kind": "experience", "title": "", "body": "无标题"},
    {"id": 6, "kind": "project", "title": "OfferU（开源）", "body": "Stars 1,200"},
]
RBODY = "## 实习\n### 某公司 | 运营 | 2023\n- 负责公众号运营，粉丝 20000 → 8 万\n### OfferU\n- Stars 1200"
out["retained"] = {"body": RBODY, "memories": MEMS, "retained": verify.retained(RBODY, MEMS), "omitted": verify.omitted(RBODY, MEMS)}

# ---- impact ----
out["impact_flags"] = [{"add": a, "said": s, "flags": impact.flags(a, s), "numbers": impact.numbers(a)} for a, s in (
    ("粉丝约从 2000 增至 8000", "大概从2000涨到8000吧"),
    ("粉丝从 2,000 显著增至 9000", "从2000涨到8000"),
    ("效率提升约三成左右", "大概快了三成"),
    ("被推广到别的组", "没有数据，但后来被推广到别的组了"),
    ("提升百分之三十，两倍", "提升了30%"),
)]
store.data_dir()  # fresh records for the capture case below
m1 = save("memory", {"kind": "experience", "title": "某公司 · 运营实习", "body": "- 负责公众号运营", "quote": "旧原话"}, actor="你")["record"]
m2 = save("memory", {"kind": "project", "title": "活动", "body": ""}, actor="你")["record"]
ANSWERS = [
    {"old": "- 负责公众号运营", "question": "粉丝变了多少？", "answer": "大概从2000涨到8000吧"},
    {"old": "- 负责活动策划", "question": "推广了吗？", "answer": "  "},
    {"old": "- 负责数据周报", "question": "表扬？", "answer": "被部门表扬过"},
    {"old": "- 负责活动策划", "question": "效果？", "answer": "来了 300 人"},
    {"old": "x", "question": "y", "answer": "第五条不看"},
]
REPLY = json.dumps({"drafts": [
    {"index": 0, "memory_id": m1["id"], "add": "- 粉丝约从 2000 增至 8000"},
    {"index": "2", "memory_id": None, "title": "", "add": "被部门表扬"},
    {"index": 0, "memory_id": m1["id"], "add": "重复的 index 被忽略"},
    {"index": 9, "add": "不存在的回答"},
    {"index": 1, "add": "空回答不在列表里"},
    "not an object",
]}, ensure_ascii=False)
seen_msgs = []


async def fake_complete(msgs):
    seen_msgs.append(msgs)
    return "好的：" + REPLY + " 完"

captured = asyncio.run(impact.capture(ANSWERS, "百度 · 产品", complete=fake_complete, today="2026-11-04"))
out["impact_capture"] = {"memories": [m1, m2], "answers": ANSWERS, "reply": "好的：" + REPLY + " 完", "messages": seen_msgs[0], "out": captured}
out["impact_errors"] = {
    "empty": err(lambda: asyncio.run(impact.capture([{"old": "a", "answer": " "}], "", complete=fake_complete, today="x"))),
    "bad_reply": err(lambda: asyncio.run(impact.capture(ANSWERS, "", complete=lambda m: asyncio.sleep(0, "no json"), today="x"))),
}

# ---- tailor pure parts ----
REVIEWS = [
    '前言 {"edits": [{"old": "a", "new": null, "reason": 1, "category": "keyword"}, {"old": " "}, {"old": 3}, "x", {"old": "b", "category": "?"}], '
    '"notes": {"关键词": "缺 Go", "语气": ""}, "asks": [{"old": "o", "question": "q", "why": 2}, {"old": "", "question": "q"}, {"old": "o2"}]} 后记',
    '{"edits": []}',
    "[1, 2]",
    "no json at all",
    '{"edits": [}',
]
out["parse_review"] = [{"raw": r, "out": None, "error": None} for r in REVIEWS]
for case in out["parse_review"]:
    try:
        case["out"] = tailor.parse_review(case["raw"])
    except ValueError as exc:
        case["error"] = "json" if "Expecting" in str(exc) or "JSON" in str(exc) and "审稿" not in str(exc) else str(exc)
APPLY_BODY = "# 张三\n\n## 实习\n- 甲\n- 乙\n- 乙\n\n\n\n- 丙\n"
EDITS = [{"old": "- 甲", "new": "- 甲甲", "reason": "", "category": "tone"}, {"old": "- 乙", "new": "", "reason": "", "category": "length"},
         {"old": "不存在", "new": "x", "reason": "", "category": "grounding"}, {"old": "- 丙\n", "new": "", "reason": "", "category": "length"}]
body, applied, skipped = tailor.apply_edits(APPLY_BODY, EDITS)
out["apply_edits"] = {"body": APPLY_BODY, "edits": EDITS, "out": {"body": body, "applied": applied, "skipped": skipped}}
ASKS = [{"old": "- 甲甲", "why": "", "question": "1"}, {"old": "- 甲甲", "why": "", "question": "dup"}, {"old": "不存在", "why": "", "question": "2"},
        {"old": "张三", "why": "", "question": "3"}, {"old": "实习", "why": "", "question": "4"}, {"old": "#", "why": "", "question": "5"}]
out["pick_asks"] = {"asks": ASKS, "body": body, "out": tailor.pick_asks(ASKS, body)}
CLEANS = ["```markdown\n# 张三\n\n## 教育\n```", "  # 张三\n## 教育  ", "#\n\n## 技能", "", "```\n\n```", "好的，以下是", "# 张三\n没有分节"]
out["clean"] = [{"in": c, "out": None, "error": None} for c in CLEANS]
for case in out["clean"]:
    try:
        case["out"] = tailor.clean(case["in"])
    except ValueError as exc:
        case["error"] = str(exc)

# ---- tailor run (store-backed, fake model) ----
DATA2 = tempfile.mkdtemp(prefix="offeru-golden-tailor-")
os.environ["OFFERU_DATA_DIR"] = DATA2
tailor.measure = lambda body, doc: 1.0
OLD = "# 张三\n138 · a@b.com\n\n## 教育经历\n### 某大学 | 计算机 | 2022.09 – 2026.06\n"
NEW = "# 张三\n138 · a@b.com\n\n## 实习经历\n### 字节 | 后端 | 2025.06 – 2025.09\n- 接口 QPS 提升 30%\n- 负责缓存改造，延迟降低 50%\n- 参与 全网 首个 项目\n"
SETUP = [
    ("profile", {"name": "张三", "school": "某大学", "major": "计算机", "phone": "138", "about": "爱折腾"}),
    ("memory", {"kind": "experience", "title": "字节后端实习", "body": "接口 QPS 提升 30%\n参与缓存改造", "start": "2025.06", "end": "2025.09", "mode": "实习", "quote": "大概快了一半", "said_at": "2026-11-01"}),
    ("memory", {"kind": "preference", "title": "别写精通", "body": "技能只写熟悉"}),
    ("memory", {"kind": "skill", "title": "Go", "body": "熟悉", "confirmed": False}),
    ("memory", {"kind": "award", "title": "国家奖学金", "body": "2024"}),
    ("job", {"company": "美团", "title": "后端", "jd": "负责 Go 后端开发" * 3, "posting": {
        "hire_type": "校招", "team": "基础架构", "responsibilities": ["写 Go", " "], "hard_reqs": ["本科"], "keywords": ["Go", "Redis"],
        "collaborators": ["SRE"], "evidence": [{"req": "Go", "need": "项目"}, {"req": "x"}], "essence": "后端"}}),
    ("doc", {"kind": "resume", "title": "主简历", "body": OLD, "style": {"template": "kami"}}),
]
ids = {}
for type_, data in SETUP:
    if type_ == "doc":
        data = dict(data)
    rec = save(type_, data, actor="你")["record"]
    ids.setdefault(type_, rec["id"])
job_id = ids["job"]
save("doc", {"kind": "evaluation", "job_id": job_id, "title": "评估", "body": "# 结论\n可以\n\n## 逐条匹配\n- Go → 有\n\n## 简历怎么改\n- 实习放前\n\n## 面试\n- x\n"}, actor="你")
doc_id = ids["doc"]
REVIEW_REPLY = json.dumps({
    "edits": [
        {"old": "- 参与 全网 首个 项目\n", "new": "", "reason": "没出处", "category": "grounding"},
        {"old": "延迟降低 50%", "new": "延迟降低", "reason": "数字没出处", "category": "grounding"},
        {"old": "不在稿里", "new": "x", "reason": "", "category": "keyword"},
    ],
    "notes": {"关键词": "缺 Redis", "岗位角度": "无"},
    "asks": [{"old": "- 负责缓存改造，延迟降低", "why": "JD 要性能", "question": "延迟降了多少？"}, {"old": "- 接口 QPS 提升 30%", "why": "", "question": "QPS 多少？"}],
}, ensure_ascii=False)
drafts, reviews = [], []


async def stream(msgs):
    drafts.append(msgs)
    for part in ("```markdown\n", NEW[:15], NEW[15:], "```"):
        yield part


async def complete(msgs):
    reviews.append(msgs)
    return "not json" if len(reviews) == 1 else REVIEW_REPLY


async def run(**kw):
    return [e async for e in tailor.run(doc_id, job_id, stream=stream, complete=complete, deadline=5.0, **kw)]

events = asyncio.run(run())
target = store.get("doc", events[-1]["doc_id"])
for e in events:
    e.pop("timings", None)
    for r in e.get("rounds") or []:
        r.pop("seconds", None)
out["tailor_run"] = {
    "setup": SETUP, "evaluation_job": True, "old": OLD, "new_chunks": ["```markdown\n", NEW[:15], NEW[15:], "```"],
    "review_replies": ["not json", REVIEW_REPLY],
    "draft_messages": drafts[0], "review_messages": list(reviews),
    "events": events, "target": {k: target.get(k) for k in ("kind", "title", "job_id", "body", "style", "pending_asks")},
    "change_actor": store.changes(1)[0]["actor"],
}
# review_only on the job copy: no deltas; pending_asks cleared
reviews.clear()
events2 = asyncio.run(run(review_only=True))
for e in events2:
    e.pop("timings", None)
    for r in e.get("rounds") or []:
        r.pop("seconds", None)
out["tailor_run"]["review_only_events"] = events2
out["tailor_run"]["review_only_messages"] = reviews
out["tailor_errors"] = {
    "no_jd_message": "「美团 · 后端」还没有 JD，先在岗位页贴上",
}

# ---- school logos ----
out["school_logos"] = {q: web_assets.search_school_logos(q) for q in ("北大", "华师", "华南", "师范", "北京大学软件与微电子学院", "  ", "中国石油大学（北京）", "zzz", "大学")}

# ---- transparent logo ----


def png_bytes(img):
    b = io.BytesIO(); img.save(b, format="PNG"); return b.getvalue()


def emblem(bg, size=(40, 30), mode="RGB"):
    img = Image.new(mode, size, bg)
    px = img.load()
    for y in range(size[1]):
        for x in range(size[0]):
            d = (x - 20) ** 2 + (y - 15) ** 2
            if 64 <= d <= 120:
                px[x, y] = (180, 20, 20) if mode == "RGB" else (180, 20, 20, 255)
            elif 120 < d <= 150:
                px[x, y] = (230, 200, 200) if mode == "RGB" else (230, 200, 200, 255)
    return img

images = {
    "white": emblem((255, 255, 255)),
    "near_white": emblem((250, 252, 247)),
    "black": emblem((0, 0, 0)),
    "colored": emblem((30, 90, 200)),
    "transparent": emblem((255, 255, 255, 0), mode="RGBA"),
    "palette": emblem((255, 255, 255)).convert("P", palette=Image.ADAPTIVE, colors=8),
}
out["logos"] = {}
for name, img in images.items():
    data = png_bytes(img)
    res = Image.open(io.BytesIO(web_assets.transparent_logo(data))).convert("RGBA")
    out["logos"][name] = {"png": base64.b64encode(data).decode(), "width": res.width, "height": res.height,
                          "rgba": base64.b64encode(np.array(res, dtype=np.uint8).tobytes()).decode()}
big = Image.new("RGB", (1000, 300), (255, 255, 255))
res = Image.open(io.BytesIO(web_assets.transparent_logo(png_bytes(big)))).convert("RGBA")
out["logo_big_size"] = [res.width, res.height]
out["logo_bad"] = err(web_assets.transparent_logo, b"not an image")

(HERE / "golden.json").write_text(json.dumps(out, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
print("wrote", HERE / "golden.json", (HERE / "golden.json").stat().st_size, "bytes")
