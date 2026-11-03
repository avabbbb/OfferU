"""主线冒烟：导入旧简历（或录一条样例经历）→ 存岗位 → 按 JD 改写简历 → 导出 PDF，用你本地配置的模型跑一遍。

用法（先在应用「设置」里配好模型，或打开「没配模型时交给本机 Agent」）：
    cd backend && uvicorn app.main:app --host 127.0.0.1 --port 8766
    python scripts/smoke/tailor_mainline.py --resume-file 我的简历.pdf   # 拆成经历入档 → 改写 → 导出
    python scripts/smoke/tailor_mainline.py --seed-profile               # 空库：内置样例 JD + 样例经历
    python scripts/smoke/tailor_mainline.py --jd jd.txt --company 百度 --title 产品实习生 --resume-id 3

全部走工作台同一套工具（POST /api/tools/{name}）。会在本地库里新建 1 个岗位和 1 份简历（给了 --resume-id 就改写那份）。
任何一步失败立刻退出并打印后端返回原文，不做重试、不兜底。
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import httpx

SAMPLE_COMPANY = "字节跳动"
SAMPLE_TITLE = "后端开发实习生（抖音电商）"
SAMPLE_JD = """字节跳动 后端开发实习生（抖音电商）
工作地点：北京
岗位职责：
1. 参与抖音电商交易链路后端服务的设计与开发；
2. 负责高并发接口的性能优化与稳定性保障；
3. 参与数据埋点与指标看板建设。
任职要求：
1. 2026 届本科及以上，计算机相关专业；
2. 熟悉 Python 或 Go，了解 MySQL、Redis；
3. 有 Web 后端项目经验，了解 RESTful API 设计；
4. 每周实习 4 天以上，持续 3 个月以上。
"""
SAMPLE_MEMORY = {
    "kind": "project",
    "title": "校园二手交易平台 · 后端负责人",
    "body": "用 Python Flask 写了商品、订单接口，数据库用 MySQL，给常用查询加了 Redis 缓存。平台在校内上线，注册用户约 1200 人。",
    "start": "2024-03",
    "end": "2024-07",
}


def step(n: int, label: str) -> float:
    print(f"\n[{n}] {label}", flush=True)
    return time.monotonic()


def done(t0: float, detail: str = "") -> None:
    print(f"    ok ({time.monotonic() - t0:.1f}s) {detail}", flush=True)


def die(resp: httpx.Response | None, message: str) -> None:
    print(f"    FAIL: {message}", flush=True)
    if resp is not None:
        print(f"    HTTP {resp.status_code}: {resp.text[:2000]}", flush=True)
    sys.exit(1)


def tool(client: httpx.Client, name: str, args: dict, timeout: float = 180) -> dict:
    resp = client.post(f"/tools/{name}", json=args, timeout=timeout)
    if resp.status_code >= 400:
        die(resp, f"工具 {name}")
    return resp.json()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base", default="http://127.0.0.1:8766")
    parser.add_argument("--jd", type=Path, help="JD 文本文件；默认用内置样例")
    parser.add_argument("--company", default=SAMPLE_COMPANY)
    parser.add_argument("--title", default=SAMPLE_TITLE)
    parser.add_argument("--resume-id", type=int, help="可选：改写这份已有简历（会覆盖它，可在「最近改动」撤销）")
    parser.add_argument("--seed-profile", action="store_true", help="空库时先录 1 条样例经历")
    parser.add_argument("--resume-file", type=Path, help="先上传这份 PDF/DOCX 简历并拆成经历入档（和档案页「导入旧简历」同一工具）")
    parser.add_argument("--out", type=Path, default=Path("smoke-tailored.pdf"))
    args = parser.parse_args()
    jd_text = args.jd.read_text(encoding="utf-8") if args.jd else SAMPLE_JD
    started = time.monotonic()

    with httpx.Client(base_url=args.base.rstrip("/") + "/api", timeout=180) as client:
        if args.resume_file:
            t = step(1, f"上传简历 {args.resume_file.name} → 拆成经历入档")
            with args.resume_file.open("rb") as handle:
                resp = client.post("/files", files={"file": (args.resume_file.name, handle)})
            if resp.status_code >= 400:
                die(resp, "上传简历")
            split = tool(client, "split_resume", {"path": resp.json()["name"]}, timeout=600)
            for item in split.get("items") or []:
                print(f"    - {item.get('kind')}: {item.get('title')}")
            done(t, f"入档 {split.get('count')} 条，撤销：逐条 undo {split.get('change_ids')}")
        elif args.seed_profile:
            t = step(1, "冷启动：录 1 条样例经历到档案")
            tool(client, "save", {"type": "memory", "data": SAMPLE_MEMORY})
            done(t)
        else:
            print("\n[1] 用你档案里已有的经历")

        t = step(2, "存岗位")
        job = tool(client, "save", {"type": "job", "data": {"company": args.company, "title": args.title, "jd": jd_text}})["record"]
        done(t, f"job_id={job['id']}")

        resume_id = args.resume_id
        if resume_id is None:
            t = step(3, "新建一份简历")
            doc = tool(client, "save", {"type": "doc", "data": {
                "kind": "resume", "title": f"{args.company} · {args.title}", "body": "# 我的简历", "job_id": job["id"],
            }})["record"]
            resume_id = doc["id"]
            done(t, f"resume_id={resume_id}")

        t = step(4, "按 JD 改写（调用真模型）")
        tailored = tool(client, "tailor_resume", {"id": resume_id, "job_id": job["id"]}, timeout=900)
        print("    " + (tailored.get("body") or "")[:400].replace("\n", "\n    "))
        done(t, f"doc_id={tailored['doc_id']} change_id={tailored.get('change_id')}（可撤销）")

        t = step(5, "导出 PDF")
        resp = client.get(f"/resume/{tailored['doc_id']}/pdf", timeout=300)
        if resp.status_code >= 400 or not resp.content.startswith(b"%PDF"):
            die(resp, "导出不是 PDF")
        args.out.write_bytes(resp.content)
        done(t, f"{args.out.resolve()} ({len(resp.content) // 1024} KB)")

    print(f"\n主线跑通，总耗时 {time.monotonic() - started:.0f}s。打开 PDF 看一眼排版和改写是否站得住。")


if __name__ == "__main__":
    main()
