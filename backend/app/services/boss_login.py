"""在 OfferU 里扫码登录 BOSS 直聘。

跑自带 boss 命令的 `login-qr`，它把二维码写成图片、过期自动换新码（最多 5 张），
登录成功后凭证存在 boss-cli 自己的目录里。OfferU 只转交二维码图片和进度，不碰 Cookie。
"""

from __future__ import annotations

import asyncio
import base64
import json
import tempfile
from pathlib import Path
from typing import Any, Optional

from app.services.boss_sync import boss_command, run_boss_json

QR_PNG = Path(tempfile.gettempdir()) / "offeru-boss-qr.img"
_STATE: dict[str, Any] = {"status": "idle", "message": ""}
_PROC: Optional[asyncio.subprocess.Process] = None


def _running() -> bool:
    return _PROC is not None and _PROC.returncode is None


async def _follow(proc: asyncio.subprocess.Process) -> None:
    assert proc.stdout is not None
    async for raw in proc.stdout:
        try:
            event = json.loads(raw.decode("utf-8", "replace"))
        except ValueError:
            continue
        kind = event.get("event")
        if kind == "qr":
            _STATE.update(status="waiting", message="")
        elif kind == "scanned":
            _STATE.update(status="scanned", message="")
        elif kind == "ok":
            _STATE.update(status="ok", message="")
        elif kind == "expired":
            _STATE.update(status="expired", message="二维码过期了")
        elif kind == "error":
            _STATE.update(status="error", message=str(event.get("message") or "登录失败"))
    await proc.wait()
    if _STATE["status"] in {"starting", "waiting", "scanned"}:
        _STATE.update(status="error", message="登录进程意外退出")
    QR_PNG.unlink(missing_ok=True)


async def start_boss_login() -> dict[str, Any]:
    global _PROC
    if _running():
        return await get_boss_login()
    cmd = boss_command()
    if not cmd:
        raise ValueError("这个版本没有带 boss 命令，请重新安装 OfferU")
    QR_PNG.unlink(missing_ok=True)
    _STATE.update(status="starting", message="")
    _PROC = await asyncio.create_subprocess_exec(*cmd, "login-qr", str(QR_PNG), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    asyncio.create_task(_follow(_PROC))
    return await get_boss_login()


async def cancel_boss_login() -> dict[str, Any]:
    if _running():
        _PROC.kill()
        await _PROC.wait()
    _STATE.update(status="idle", message="")
    return await get_boss_login()


async def logout_boss() -> dict[str, Any]:
    await cancel_boss_login()
    await run_boss_json(("logout",), timeout=20)
    return await get_boss_login()


async def get_boss_login() -> dict[str, Any]:
    """登录进度；没在登录时顺便问一次 boss 命令有没有保存的凭证，以及凭证能做什么。

    capabilities.search 只有 boss 校验搜索通过（凭证里有 __zp_stoken__）时才为 true；
    扫码登录拿不到 __zp_stoken__，所以只能同步，不能搜索、打招呼、补职位描述。
    """

    view: dict[str, Any] = {"installed": boss_command() is not None, **_STATE, "qr": None, "logged_in": None, "capabilities": {"sync": False, "search": False}}
    if _STATE["status"] in {"waiting", "scanned"} and QR_PNG.exists():
        image = QR_PNG.read_bytes()
        kind = "jpeg" if image[:2] == b"\xff\xd8" else "png"
        view["qr"] = f"data:image/{kind};base64," + base64.b64encode(image).decode()
    if not _running() and view["installed"]:
        try:
            status = await run_boss_json(("status", "--json"), timeout=20)
        except ValueError:
            status = {}
        view["logged_in"] = bool(status.get("credential_present"))
        view["capabilities"] = {"sync": view["logged_in"], "search": view["logged_in"] and bool(status.get("search_authenticated"))}
    return view
