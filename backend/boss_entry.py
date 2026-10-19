"""OfferU 自带的 boss 命令：就是 jackwener/boss-cli，另加两处改动。

- 只用扫码登录：不读浏览器 Cookie；接口报错时也不删凭证（扫码拿不到 __zp_stoken__，
  搜索会失败，原版会因此删掉凭证，连同步都用不了）。
- 多一个子命令 `login-qr <png>`：把二维码写成图片给 OfferU 显示，过期自动换新码，最多 5 张。
  每一步往 stdout 打一行 JSON：{"event": "qr" | "scanned" | "ok" | "expired" | "error"}。
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time

from boss_cli import auth
from boss_cli.client import BossClient
from boss_cli.constants import BASE_URL, FRIEND_LIST_URL, HEADERS, QR_CODE_URL

auth.extract_browser_credential = lambda *args, **kwargs: (None, [])
auth.clear_credential = lambda: None
# 上游不传 page 时沟通列表是空的，合并 jackwener/boss-cli#37 后删掉这行。
BossClient.get_friend_list = lambda self, page=1: self._get(FRIEND_LIST_URL, params={"page": page}, action="好友列表")

ROUNDS = 5
QR_SECONDS = 110  # BOSS 的码大约 2 分钟失效


def _say(event: str, **extra) -> None:
    print(json.dumps({"event": event, **extra}, ensure_ascii=False), flush=True)


async def _login_qr(png: str) -> None:
    import httpx

    async with httpx.AsyncClient(base_url=BASE_URL, headers=HEADERS, follow_redirects=True, timeout=httpx.Timeout(30, read=40)) as client:
        for round_no in range(1, ROUNDS + 1):
            qr_id = (await auth._get_qr_session(client))["qrId"]
            image = await client.get(QR_CODE_URL, params={"content": qr_id})
            image.raise_for_status()
            with open(png + ".part", "wb") as fh:
                fh.write(image.content)
            os.replace(png + ".part", png)
            _say("qr", round=round_no)
            deadline = time.monotonic() + QR_SECONDS
            while time.monotonic() < deadline:
                if await auth._wait_for_scan(client, qr_id):
                    break
            else:
                continue
            _say("scanned")
            deadline = time.monotonic() + QR_SECONDS
            while time.monotonic() < deadline:
                if await auth._wait_for_confirm(client, qr_id):
                    auth.save_credential(await auth._dispatch_login(client, qr_id))
                    _say("ok")
                    return
            _say("expired")
            return
        _say("expired")


def main() -> None:
    if sys.argv[1:2] == ["login-qr"]:
        try:
            asyncio.run(_login_qr(sys.argv[2]))
        except Exception as exc:  # 子进程里把原因交给 OfferU 显示
            _say("error", message=str(exc)[:300])
        return
    if sys.argv[1:2] == ["logout"]:
        auth.CREDENTIAL_FILE.unlink(missing_ok=True)
        print(json.dumps({"ok": True, "schema_version": "1", "data": {}}))
        return
    from boss_cli.cli import cli

    cli()


if __name__ == "__main__":
    main()
