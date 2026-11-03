"""授权浏览用的真 Chrome：独立资料目录（OfferU 数据目录下 chrome-profile），
调试端口只开在 127.0.0.1，后端用 CDP 连上去。不改指纹、不加反检测参数。
OFFERU_CHROME 可指定 chrome 可执行文件。"""

import asyncio
import os
import shutil
import socket
import subprocess
from pathlib import Path

import httpx

NAMES = ("chrome", "google-chrome", "google-chrome-stable", "chromium")


def _candidates() -> list[str]:
    out = []
    for var in ("ProgramFiles", "ProgramFiles(x86)", "LocalAppData"):
        base = os.environ.get(var)
        if base:
            out.append(os.path.join(base, "Google", "Chrome", "Application", "chrome.exe"))
    out.append("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    return out


def find_chrome() -> str:
    env = os.environ.get("OFFERU_CHROME")
    if env:
        if Path(env).is_file():
            return env
        raise ValueError(f"OFFERU_CHROME 指向的文件不存在: {env}")
    for path in _candidates():
        if Path(path).is_file():
            return path
    for name in NAMES:
        hit = shutil.which(name)
        if hit:
            return hit
    raise ValueError("没找到 Chrome：请安装 Google Chrome，或用环境变量 OFFERU_CHROME 指定 chrome 可执行文件")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def build_args(chrome: str, profile: Path, port: int, url: str) -> list[str]:
    return [
        chrome,
        f"--user-data-dir={profile}",
        "--remote-debugging-address=127.0.0.1",
        f"--remote-debugging-port={port}",
        "--no-first-run",
        "--no-default-browser-check",
        url,
    ]


def stop(proc) -> None:
    if proc is None or proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


async def launch(profile: Path, url: str, timeout: float = 20.0) -> tuple[subprocess.Popen, str]:
    """起 Chrome 并等调试端口就绪，返回 (启动进程, 调试端点)。

    Windows 上 chrome.exe 常把真正的浏览器交给子进程后自己以 0 退出，所以只看端口是否就绪；
    非 0 退出才算启动失败。资料目录已被另一个 Chrome 占用时，新进程会把网址交给那个窗口然后退出，
    端口永远起不来，按超时报。关浏览器用 close_browser（CDP Browser.close），不靠这个进程句柄。"""
    profile.mkdir(parents=True, exist_ok=True)
    port = free_port()
    proc = subprocess.Popen(
        build_args(find_chrome(), profile, port, url),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    endpoint = "http:" + "/" + "/127.0.0.1:" + str(port)
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    async with httpx.AsyncClient(trust_env=False, timeout=2) as client:
        while loop.time() < deadline:
            code = proc.poll()
            if code not in (None, 0):
                raise RuntimeError(f"Chrome 启动失败，退出码 {code}")
            try:
                r = await client.get(endpoint + "/json/version")
                if r.status_code == 200:
                    return proc, endpoint
            except httpx.HTTPError:
                pass
            await asyncio.sleep(0.3)
    stop(proc)
    raise RuntimeError(
        f"Chrome 调试端口 {timeout:.0f}s 内没有就绪：OfferU 的授权浏览 Chrome 窗口可能还开着，关掉它再试"
    )


async def close_browser(browser) -> None:
    """通过 CDP 让整个 Chrome 退出（connect_over_cdp 的 browser.close() 只断开连接）。"""
    try:
        cdp = await browser.new_browser_cdp_session()
        await cdp.send("Browser.close")
    except Exception:
        pass
