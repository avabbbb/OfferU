"""登录态平台采集的风险告知与同意。没同意（或条款改版后没重新同意）就不开启：
授权浏览会话和插件列表页多选都先查这里。同意记录存在本机数据目录，写明版本和时间。"""

import json
from datetime import datetime, timezone
from typing import Any

from app.core.store import data_dir

VERSION = "2026-11-03"

TITLE = "登录态平台采集（BOSS 直聘、小红书）"

RISKS = [
    "要用你自己的账号登录后读取页面。平台用户协议一般不允许自动化采集；被平台判定为异常时，账号可能被限流、要求验证甚至封禁。",
    "OfferU 不绕过验证码、不改浏览器指纹、不破解接口签名、不换 IP，也不在后台批量翻页；遇到验证要你自己处理，处理不了就停。",
    "页面里可能有别人的信息（HR 姓名、帖子作者、评论）。存下来只用于你自己求职，不要转发或公开。",
    "授权浏览用一个独立的 Chrome 资料目录，放在 OfferU 数据目录下，会在本机保留这些平台的登录状态；撤回同意或删除该目录即可清掉。",
]

DUTIES = {
    "你负责": [
        "决定是否使用、用哪个账号，遵守平台规则和法律法规，承担由此产生的账号后果。",
        "只采集你本来就能看到、且确实用于自己求职的内容。",
    ],
    "OfferU 负责": [
        "只读取你打开的页面、你勾选的条目，不替你点投递、发消息或改资料；授权浏览进入只读后拦截一切非 GET 请求。",
        "存下的岗位只在本机；你让它评估时，JD 会发给你在设置里配置的模型服务。",
        "条款有实质变化时改版本号，旧的同意失效，要你重新确认。",
    ],
}

NOT_AGREED = "登录态采集还没开启：先到 设置 → 登录态采集 读完风险说明并点「同意并开启」"


def _path():
    return data_dir() / "platform-consent.json"


def _record() -> dict[str, Any]:
    """文件不存在或损坏都算没同意，让 require() 报 NOT_AGREED 而不是 JSON 错误。"""
    p = _path()
    try:
        rec = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
    except (OSError, ValueError):
        return {}
    return rec if isinstance(rec, dict) else {}


def status() -> dict[str, Any]:
    rec = _record()
    return {
        "version": VERSION,
        "title": TITLE,
        "risks": RISKS,
        "duties": DUTIES,
        "agreed": rec.get("version") == VERSION,
        "agreed_version": rec.get("version"),
        "agreed_at": rec.get("agreed_at"),
    }


def agree(version: str) -> dict[str, Any]:
    if version != VERSION:
        raise ValueError(f"条款已更新到 {VERSION}，请刷新后重新阅读再同意")
    p = _path()
    p.parent.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    p.write_text(json.dumps({"version": VERSION, "agreed_at": stamp}, ensure_ascii=False), encoding="utf-8")
    return status()


def revoke() -> dict[str, Any]:
    """撤回同意：删同意记录，并清掉授权浏览用的 Chrome 资料目录（里面有平台的登录态）。"""
    import shutil

    _path().unlink(missing_ok=True)
    shutil.rmtree(data_dir() / "chrome-profile", ignore_errors=True)
    return status()


def require() -> None:
    if not status()["agreed"]:
        raise ValueError(NOT_AGREED)
