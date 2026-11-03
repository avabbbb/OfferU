"""按岗位改写前后的确定性处理：JD 清洗（进 prompt 前）、关键词覆盖、预计页数、审稿。

都不调模型。覆盖、页数、审稿只作提醒返回，不挡写库：改写本身是一条可撤销的改动。
缺失的关键词只列出来，不往简历里塞：档案里没有的事实不写。
"""

import re
import unicodedata
from typing import Any, Optional

from app.core import fact_check

# JD 段落标题：职责 / 要求 / 加分保留，公司介绍、福利、投递方式等整段丢掉。
_KEEP = ("职责", "要求", "任职", "资格", "加分", "优先", "技能", "工作内容", "岗位描述", "职位描述",
         "responsibilit", "requirement", "qualification")
_DROP = ("公司介绍", "公司简介", "关于我们", "关于公司", "福利", "待遇", "薪资", "投递", "联系方式", "联系我们",
         "工作地点", "办公地点", "工作时间", "招聘流程", "面试流程", "about us", "benefit", "how to apply")
# 正文里零散的噪声行：福利词、投递说明、邮箱、链接。
_NOISE = re.compile(r"五险一金|带薪|年假|下午茶|团建|餐补|房补|简历(?:请)?(?:投递|发送)|投递(?:邮箱|方式|简历)|邮件标题|扫码|内推码"
                    r"|[\w.+-]+@[\w-]+\.[\w.]+|https?://")

# 「熟悉 / 掌握 / 精通 …」后面到标点为止是要求词；按顿号、和、及、与、或拆开，去掉「经验」「优先」这类尾巴。
_LEAD = re.compile(r"(?:熟悉|掌握|精通|了解|熟练(?:使用|掌握)?|具备|擅长|使用过|懂)([^，。；;,.！!？?\n]{2,40})")
_SPLIT = re.compile(r"[、/／和及与或等]+|\s+")
_TAIL = re.compile(r"(?:相关)?(?:工作)?(?:经验|经历|能力|基础|原理|知识|者优先|优先|的)+$")
MAX_KEYWORDS = 40

# 审稿：空泛开头、没结果、看不出技术做法（面试会被追问技术深度）、过长。
_VAGUE = re.compile(r"^(?:负责|参与|协助|帮助|熟悉|了解|学习|配合)")
_DEPTH = re.compile(r"架构|设计|选型|方案|并发|缓存|索引|一致性|延迟|吞吐|内存|性能|优化|算法|模型|分布式|异步|队列|协议"
                    r"|重构|压测|召回|准确率|评测|指标|抽象|解耦|容错|扩展|流式|调度|检索")
_TECH_SECTION = re.compile(r"实习|工作|项目|科研|研究")
_BOLD = chr(42) + chr(42)
LONG_BULLET = 90
PAGE_SLACK = 1.02  # 量高度有舍入，超过这个才算超一页


def _heading(line: str) -> Optional[str]:
    """像段落标题（# 开头、【】括住、冒号结尾或 8 字以内）且含已知关键字时返回标题文字。"""
    s = unicodedata.normalize("NFKC", line).strip().lower()
    bare = s.lstrip("#").strip().strip("[]【】").rstrip(":").strip()
    if not bare or len(bare) > 16:
        return None
    marked = s.startswith(("#", "[", "【")) or s.endswith(":") or len(bare) <= 8
    return bare if marked and any(k in bare for k in _KEEP + _DROP) else None


def clean_jd(jd: str) -> str:
    """去掉公司介绍、福利、投递方式等段落和零散噪声行；清完是空的就原样返回，别把 JD 清没了。"""
    raw = str(jd or "")
    out: list[str] = []
    keep = True
    for line in raw.splitlines():
        head = _heading(line)
        if head is not None:
            keep = not any(k in head for k in _DROP)
            if keep:
                out.append(line)
            continue
        if keep and not _NOISE.search(line):
            out.append(line)
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()
    return text or raw.strip()


def keywords(jd: str) -> list[str]:
    """JD 里的要求词：英文技术词 + 「熟悉 / 掌握 …」后的中文短语，按出现顺序去重。"""
    text = unicodedata.normalize("NFKC", clean_jd(jd))
    found: list[str] = []
    seen: set[str] = set()

    def add(word: str) -> None:
        word = word.strip(" -·•")
        if word and word.lower() not in seen and len(found) < MAX_KEYWORDS:
            seen.add(word.lower())
            found.append(word)

    for word in fact_check._WORD.findall(text):
        if len(word) > 1 and word.lower() not in fact_check._STOP:
            add(word)
    for match in _LEAD.finditer(text):
        for part in _SPLIT.split(match.group(1)):
            part = _TAIL.sub("", part.strip())
            if 2 <= len(part) <= 12 and not fact_check._WORD.fullmatch(part):
                add(part)
    return found


def coverage(jd: str, body: str) -> dict[str, list[str]]:
    """{hit, missing}：要求词在新简历里出现没有（全半角、大小写、空白不计）。"""
    flat = fact_check._norm(body)
    hit: list[str] = []
    missing: list[str] = []
    for word in keywords(jd):
        (hit if fact_check._norm(word) in flat else missing).append(word)
    return {"hit": hit, "missing": missing}


def review(body: str) -> list[dict[str, Any]]:
    """[{kind, text, line}]：动词 / 结果 / 篇幅按要点查；技术深度按条目查（实习、项目类模块里，一条要点都看不出技术做法）。"""
    issues: list[dict[str, Any]] = []
    section, item = "", ""
    bullets: list[str] = []

    def add(kind: str, text: str, line: str) -> None:
        if len(issues) < fact_check.LIMIT:
            issues.append({"kind": kind, "text": text, "line": line.strip()[:120]})

    def flush() -> None:
        if item and bullets and _TECH_SECTION.search(section) \
                and not any(_DEPTH.search(b) or fact_check._WORD.search(b) for b in bullets):
            add("深度", "看不出技术做法（方案、难点、取舍），面试容易被追问", item)

    for line in body.splitlines():
        if line.startswith("## "):
            flush()
            section, item, bullets = line[3:].strip(), "", []
            continue
        if line.startswith("### "):
            flush()
            item, bullets = line[4:].strip(), []
            continue
        stripped = line.lstrip()
        if not section or not stripped.startswith(("- ", chr(42) + " ")):
            continue
        plain = stripped[2:].replace(_BOLD, "").strip()
        bullets.append(plain)
        vague = _VAGUE.match(plain)
        if vague:
            add("动词", "以「" + vague.group(0) + "」开头，改成具体做了什么", plain)
        if _TECH_SECTION.search(section) and not re.search(r"\d", plain):
            add("结果", "没有数字或可核实的结果", plain)
        if len(plain) > LONG_BULLET:
            add("篇幅", f"{len(plain)} 字，超过一行半", plain)
    flush()
    return issues


def page_count(record: dict[str, Any]) -> Optional[float]:
    """按导出 PDF 的同一份 HTML 量页数；机器上没有 Chromium 或渲染出错就返回 None，不影响改写。"""
    try:
        from app.core import resume

        return resume.page_count(resume.doc_html(record))
    except Exception:  # noqa: BLE001 - 只是提醒
        return None


def build(body: str, jd: str, record: dict[str, Any]) -> dict[str, Any]:
    """改写完成后一并返回的提醒：coverage / pages / over_page / review。会开浏览器量页数，在线程里调。"""
    pages = page_count(record)
    return {"coverage": coverage(jd, body), "pages": pages, "over_page": bool(pages and pages > PAGE_SLACK),
            "review": review(body)}
