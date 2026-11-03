"""只给「公司 岗位」时从公司自己的招聘系统拿 JD：大厂走招聘官网公开接口，其余只认官方域名。

镜像站、聚合站即使正文里有公司名也不采用。接口查不到时只报「官网没有」并列出名字相近的岗位，
不拿相近岗位顶替用户要的那一个。
"""

import re
import time
from typing import Any, Optional
from urllib.parse import urlparse

import httpx

_S = "https:" + "//"

# 公司 → 自有招聘域名（含子域名）。
OFFICIAL_DOMAINS: dict[str, tuple[str, ...]] = {
    "腾讯": ("careers.tencent.com", "join.qq.com"),
    "百度": ("talent.baidu.com",),
    "字节跳动": ("jobs.bytedance.com", "job.toutiao.com"),
    "阿里巴巴": ("talent.alibaba.com", "careers.alibaba.com", "talent-holding.alibaba.com"),
    "蚂蚁": ("talent.antgroup.com",),
    "美团": ("zhaopin.meituan.com",),
    "京东": ("zhaopin.jd.com", "campus.jd.com"),
    "快手": ("zhaopin.kuaishou.cn", "campus.kuaishou.cn"),
    "网易": ("hr.163.com",),
    "小米": ("hr.xiaomi.com",),
    "华为": ("career.huawei.com",),
    "拼多多": ("careers.pddglobalhr.com",),
    "哔哩哔哩": ("jobs.bilibili.com",),
}
ALIASES = {"字节": "字节跳动", "bytedance": "字节跳动", "tencent": "腾讯", "baidu": "百度", "阿里": "阿里巴巴",
           "蚂蚁集团": "蚂蚁", "b站": "哔哩哔哩", "bilibili": "哔哩哔哩", "meituan": "美团", "kuaishou": "快手"}
# 公司自己开通的托管招聘系统：域名不属于公司，页面里必须对得上公司名。
HOSTED_ATS = ("mokahr.com", "jobs.feishu.cn", "zhiye.com", "hotjob.cn", "greenhouse.io", "lever.co",
              "myworkdayjobs.com", "ashbyhq.com", "smartrecruiters.com")
# 有公开岗位接口、已接入的公司。
API_COMPANIES = ("腾讯", "百度", "字节跳动")

_JCODE = re.compile(r"[（(]?\s?(J\d{4,})\s?[)）]?", re.I)
_PAREN = re.compile(r"[（(][^)）]+[)）]")
_CITIES = ("北京", "上海", "深圳", "广州", "杭州", "成都", "武汉", "南京", "西安", "苏州", "天津", "重庆",
           "长沙", "合肥", "厦门", "珠海", "大连", "新加坡")
_SEP = " ·-|/，,：:"


def split_name(name: str) -> tuple[str, str]:
    """「腾讯 大模型数据运营」→ (腾讯, 大模型数据运营)；认不出公司时公司为空。"""
    text = name.strip()
    low = text.lower()
    for key in sorted(list(OFFICIAL_DOMAINS) + list(ALIASES), key=len, reverse=True):
        if low.startswith(key.lower()):
            return ALIASES.get(key, key), text[len(key):].strip(_SEP)
    return "", text


def _host_in(host: str, domains: tuple[str, ...]) -> bool:
    return any(host == d or host.endswith("." + d) for d in domains)


def official_kind(url: str, company: str) -> str:
    """own：公司自有招聘域名；ats：托管招聘系统（还要核对页面里的公司名）；空：不采用。"""
    host = (urlparse(url).hostname or "").lower()
    if not host:
        return ""
    if company and _host_in(host, OFFICIAL_DOMAINS.get(company, ())):
        return "own"
    if _host_in(host, HOSTED_ATS):
        return "ats"
    return ""


def parse_want(rest: str) -> tuple[str, str, str]:
    """岗位名、城市、J 编号：「AI产品营销经理（J102408）北京」→ (AI产品营销经理, 北京, J102408)。"""
    found = _JCODE.search(rest)
    jcode = found.group(1).upper() if found else ""
    title = _JCODE.sub("", rest)
    city = next((c for c in _CITIES if c in title), "")
    if city:
        title = title.replace(city, "")
    return title.strip(_SEP), city, jcode


def _norm(value: Any) -> str:
    return re.sub(r"[\s（）()·\-—_/|，,、]+", "", str(value or "")).lower()


def _grams(text: str) -> set[str]:
    return {text[i:i + 2] for i in range(len(text) - 1)} or {text}


def _score(title: str, city: str, name: Any, location: Any) -> float:
    want, got = _norm(title), _norm(_JCODE.sub("", str(name or "")))
    if not want or not got:
        return 0.0
    score = 1.0 if want == got else len(_grams(want) & _grams(got)) / len(_grams(want))
    if city and city in str(location or ""):
        score += 0.1
    return score


def _keywords(title: str, jcode: str = "") -> list[str]:
    core = _PAREN.sub("", title).strip()
    words = [jcode, title, core, core[-4:] if len(core) > 6 else ""]
    return list(dict.fromkeys(w for w in words if w))


def _client() -> httpx.Client:
    return httpx.Client(timeout=15, trust_env=False, headers={"User-Agent": "Mozilla/5.0 OfferU"})


def _label(name: Any, location: Any) -> str:
    return f"{name}（{location}）" if location else str(name)


def _now_ms() -> int:
    return time.time_ns() // 1_000_000


def _tencent(title: str, city: str, jcode: str) -> tuple[Optional[dict[str, Any]], list[str]]:
    base = _S + "careers.tencent.com"
    posts: dict[str, dict[str, Any]] = {}
    with _client() as client:
        for keyword in _keywords(title):
            resp = client.get(base + "/tencentcareer/api/post/Query", params={
                "timestamp": _now_ms(), "keyword": keyword, "pageIndex": 1, "pageSize": 20,
                "language": "zh-cn", "area": "cn"})
            resp.raise_for_status()
            for post in (resp.json().get("Data") or {}).get("Posts") or []:
                posts.setdefault(str(post.get("PostId")), post)
        ranked = sorted(((_score(title, city, p.get("RecruitPostName"), p.get("LocationName")), p) for p in posts.values()),
                        key=lambda x: -x[0])
        similar = [_label(p.get("RecruitPostName"), p.get("LocationName")) for s, p in ranked[:5] if s > 0.3]
        if not ranked or ranked[0][0] < 0.8:
            return None, similar
        post = ranked[0][1]
        post_id = str(post.get("PostId"))
        resp = client.get(base + "/tencentcareer/api/post/ByPostId", params={
            "timestamp": _now_ms(), "postId": post_id, "language": "zh-cn"})
        resp.raise_for_status()
        detail = resp.json().get("Data") or {}
    name = detail.get("RecruitPostName") or post.get("RecruitPostName")
    parts = [
        ("", f"腾讯 {name}"),
        ("地点", detail.get("LocationName") or post.get("LocationName")),
        ("事业群", detail.get("BGName") or post.get("BGName")),
        ("产品", detail.get("ProductName")),
        ("岗位职责", detail.get("Responsibility") or post.get("Responsibility")),
        ("岗位要求", detail.get("Requirement")),
    ]
    text = "\n".join(f"{k}：\n{v}" if k in ("岗位职责", "岗位要求") else (f"{k}：{v}" if k else str(v))
                     for k, v in parts if v)
    return {"url": base + "/jobdesc.html?postId=" + post_id, "title": f"腾讯 {name}", "text": text,
            "truncated": False, "source": "careers.tencent.com 公开接口"}, similar


def _baidu(title: str, city: str, jcode: str) -> tuple[Optional[dict[str, Any]], list[str]]:
    base = _S + "talent.baidu.com"
    posts: dict[str, tuple[str, dict[str, Any]]] = {}
    with _client() as client:
        for keyword in _keywords(title, jcode):
            for recruit in ("SOCIAL", "GRADUATE", "INTERN"):
                resp = client.post(base + "/httservice/getPostListNew", data={
                    "recruitType": recruit, "pageSize": 20, "keyWord": keyword, "curPage": 1, "projectType": ""},
                    headers={"Referer": base + "/jobs/social-list"})
                resp.raise_for_status()
                for post in (resp.json().get("data") or {}).get("list") or []:
                    posts.setdefault(str(post.get("postId")), (recruit, post))
    by_name = sorted(((_score(title, city, p.get("name"), p.get("workPlace")), r, p) for r, p in posts.values()),
                     key=lambda x: -x[0])
    similar = [_label(p.get("name"), p.get("workPlace")) for s, _, p in by_name[:5] if s > 0.3]
    if jcode:  # 给了编号就只认编号：同名不同编号的是另一个岗位
        ranked = [(2.0, r, p) for r, p in posts.values() if jcode in str(p.get("name") or "").upper()]
    else:
        ranked = by_name
    if not ranked or ranked[0][0] < 0.8:
        return None, similar
    _, recruit, post = ranked[0]
    parts = [
        ("", f"百度 {post.get('name')}"),
        ("地点", post.get("workPlace")),
        ("工作年限", post.get("workYears")),
        ("学历", post.get("education")),
        ("发布", post.get("publishDate")),
        ("更新", post.get("updateDate")),
        ("工作职责", post.get("workContent")),
        ("职责要求", post.get("serviceCondition")),
    ]
    text = "\n".join(f"{k}：\n{v}" if k in ("工作职责", "职责要求") else (f"{k}：{v}" if k else str(v))
                     for k, v in parts if v)
    return {"url": base + "/jobs/detail/" + recruit + "/" + str(post.get("postId")), "title": f"百度 {post.get('name')}",
            "text": text, "truncated": False, "source": "talent.baidu.com 公开接口"}, similar


def _bytedance(title: str, city: str, jcode: str) -> tuple[Optional[dict[str, Any]], list[str]]:
    base = _S + "jobs.bytedance.com"
    posts: dict[str, tuple[str, dict[str, Any]]] = {}
    # 字节招聘（atsx）按门户区分站点：社招 society、校招和实习 campus。website-path 填别的值会回 site not exist。
    for site, page, portal in (("society", "/experienced/position", 2), ("campus", "/campus/position", 3)):
        with _client() as client:
            client.follow_redirects = True
            client.get(base + page)
            headers = {"Referer": base + page, "Portal-Channel": "office", "Portal-Platform": "pc", "website-path": site}
            token = (client.post(base + "/api/v1/csrf/token", json={"portal_entrance": 1}, headers=headers).json().get("data") or {}).get("token")
            if token:
                headers["x-csrf-token"] = token
            for keyword in _keywords(title, jcode):
                resp = client.post(base + "/api/v1/search/job/posts", headers=headers, json={
                    "keyword": keyword, "limit": 20, "offset": 0, "job_category_id_list": [], "location_code_list": [],
                    "subject_id_list": [], "recruitment_id_list": [], "portal_type": portal, "job_function_id_list": [],
                    "portal_entrance": 1})
                resp.raise_for_status()
                body = resp.json()
                if body.get("code") != 0:
                    raise ValueError(f"字节招聘接口返回：{body.get('message')}")
                for post in (body.get("data") or {}).get("job_post_list") or []:
                    posts.setdefault(str(post.get("id")), (page, post))

    def where(post: dict[str, Any]) -> str:
        return str((post.get("city_info") or {}).get("name") or "")

    ranked = sorted(((_score(title, city, p.get("title"), where(p)), page, p) for page, p in posts.values()), key=lambda x: -x[0])
    similar = [_label(p.get("title"), where(p)) for s, _, p in ranked[:5] if s > 0.3]
    if not ranked or ranked[0][0] < 0.8:
        return None, similar
    _, page, post = ranked[0]
    recruit = post.get("recruit_type") or {}
    parts = [
        ("", f"字节跳动 {post.get('title')}"),
        ("地点", where(post)),
        ("类别", (post.get("job_category") or {}).get("name")),
        ("招聘类型", "·".join(x for x in ((recruit.get("parent") or {}).get("name"), recruit.get("name")) if x)),
        ("职位编号", post.get("code")),
        ("职位描述", post.get("description")),
        ("职位要求", post.get("requirement")),
    ]
    text = "\n".join(f"{k}：\n{v}" if k in ("职位描述", "职位要求") else (f"{k}：{v}" if k else str(v))
                     for k, v in parts if v)
    return {"url": base + page + "/" + str(post.get("id")) + "/detail", "title": f"字节跳动 {post.get('title')}",
            "text": text, "truncated": False, "source": "jobs.bytedance.com 公开接口"}, similar


def find_via_api(company: str, rest: str) -> tuple[Optional[dict[str, Any]], list[str]]:
    """查招聘官网接口：返回 (岗位页, 名字相近的官网岗位)。岗位页为 None 表示官网确实没有这一个；网络错误照样抛出。"""
    lookup = {"腾讯": _tencent, "百度": _baidu, "字节跳动": _bytedance}.get(company)
    if lookup is None:
        raise ValueError(f"{company} 还没接招聘官网接口")
    title, city, jcode = parse_want(rest)
    return lookup(title, city, jcode)
