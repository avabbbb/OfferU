"""主线冒烟：粘贴 JD → 定制 → 采用 → 导出 PDF，用你本地配置的真模型跑一遍。

用法（先在应用「设置」里配好模型，或用环境变量启动后端）：
    cd backend && uvicorn app.main:app --host 127.0.0.1 --port 8766
    python scripts/smoke/tailor_mainline.py --resume-file 我的简历.pdf   # 上传简历 → 定制 → 导出
    python scripts/smoke/tailor_mainline.py --seed-profile     # 空库：内置样例 JD + 样例经历
    python scripts/smoke/tailor_mainline.py --jd jd.txt --resume-id 3

定制用档案里的经历；空库请加 --resume-file 或 --seed-profile。
会在本地库里新建 1 个岗位和 1 份定制简历。
任何一步失败立刻退出并打印后端返回原文，不做重试、不兜底。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import httpx

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

_SAMPLE_DESC = "用 Python Flask 写了商品、订单接口，数据库用 MySQL，给常用查询加了 Redis 缓存。平台在校内上线，注册用户约 1200 人。"
SAMPLE_PROFILE_FACT = {
    "section_type": "project",
    "category_label": "项目经历",
    "title": "校园二手交易平台",
    "content_json": {
        "name": "校园二手交易平台", "role": "后端负责人",
        "start_date": "2024-03", "end_date": "2024-07",
        "description": _SAMPLE_DESC, "bullet": _SAMPLE_DESC,
    },
    "source": "manual",
    "confidence": 1,
    "tier": "verified_fact",
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


def call(client: httpx.Client, method: str, path: str, **kw) -> dict:
    resp = client.request(method, path, **kw)
    if resp.status_code >= 400:
        die(resp, f"{method} {path}")
    return resp.json()


def read_sse(client: httpx.Client, path: str, body: dict) -> list[tuple[str, dict]]:
    events: list[tuple[str, dict]] = []
    with client.stream("POST", path, json=body, timeout=None) as resp:
        if resp.status_code >= 400:
            resp.read()
            die(resp, f"POST {path}")
        name = ""
        for line in resp.iter_lines():
            if line.startswith("event:"):
                name = line[6:].strip()
            elif line.startswith("data:"):
                data = json.loads(line[5:].strip() or "{}")
                events.append((name, data))
                if name in {"progress", "error", "done"}:
                    print(f"    · {name}: {json.dumps(data, ensure_ascii=False)[:300]}", flush=True)
    return events


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base", default="http://127.0.0.1:8766")
    parser.add_argument("--jd", type=Path, help="JD 文本文件；默认用内置样例")
    parser.add_argument("--resume-id", type=int, help="可选：参考简历 id（沿用它的模板和结构）")
    parser.add_argument("--seed-profile", action="store_true", help="空库时先往档案里录 1 条样例经历")
    parser.add_argument("--resume-file", type=Path, help="先上传这份 PDF/DOCX 简历（直接入档，和界面「导入旧简历」同一接口）")
    parser.add_argument("--parse-mode", default="ai", choices=["ai", "mechanical"], help="上传简历的解析方式")
    parser.add_argument("--out", type=Path, default=Path("smoke-tailored.pdf"))
    args = parser.parse_args()
    jd_text = args.jd.read_text(encoding="utf-8") if args.jd else SAMPLE_JD
    started = time.monotonic()

    with httpx.Client(base_url=args.base.rstrip("/") + "/api", timeout=180) as client:
        t = step(1, "粘贴 JD → 识别草稿")
        draft = call(client, "POST", "/jobs/capture/draft", json={"text": jd_text})
        fields = draft.get("draft") or {}
        if draft.get("status") != "ready":
            die(None, f"草稿不完整，缺 {draft.get('missing')}：{json.dumps(fields, ensure_ascii=False)[:300]}")
        done(t, f"{fields.get('company')} / {fields.get('title')} / {fields.get('location')}")

        t = step(2, "确认草稿 → 建岗位")
        job = call(client, "POST", "/jobs/capture", json={
            "title": fields["title"], "company": fields["company"],
            "jd_text": fields.get("jd_text") or jd_text,
            "location": fields.get("location", ""), "url": fields.get("url", ""),
        })
        job_id = job["job_id"]
        done(t, f"job_id={job_id} duplicate={job.get('duplicate')}")

        resume_id = args.resume_id
        if args.resume_file:
            t = step(3, f"上传简历 {args.resume_file.name} → 直接入档")
            with args.resume_file.open("rb") as handle:
                imported = call(client, "POST", f"/profile/import-resume?parse_mode={args.parse_mode}",
                                files={"file": (args.resume_file.name, handle)}, timeout=300)
            for bullet in imported.get("bullets") or []:
                flag = "  ← 没解析清楚" if bullet.get("needs_look") else ""
                print(f"    - {bullet.get('section_type')}: {bullet.get('title')}{flag}")
            done(t, f"入档 {imported.get('imported_count')} 条，撤销：POST /api/profile/import-resume/{imported.get('session_id')}/undo")
        if args.seed_profile:
            t = step(3, "冷启动：手动录入 1 条经历到档案（与「岗位定制」页手动录入同一接口）")
            call(client, "POST", "/profile/sections", json=SAMPLE_PROFILE_FACT)
            done(t)
        elif not args.resume_file:
            print("\n[3] 用你档案里已有的经历" + (f"，参考简历 #{resume_id}" if resume_id else ""))

        t = step(4, "定制（调用真模型）")
        events = read_sse(client, "/optimize/generate", {"job_ids": [job_id], "reference_resume_id": resume_id})
        results = [data for name, data in events if name == "result"]
        if not results:
            die(None, "没有生成提案，见上面的 error 事件")
        proposal_id = results[0]["proposal_id"]
        done(t, f"proposal={proposal_id} 改动={results[0].get('change_count')} 事实闸门={results[0].get('fact_gate_status')}")

        t = step(5, "看改动")
        proposal = call(client, "GET", f"/optimize/proposals/{proposal_id}")
        detail = proposal.get("proposal") or proposal
        import re

        def plain(row: dict) -> str:
            items = row.get("content_json") or []
            return " / ".join(re.sub(r"<[^>]+>", "", str(i.get("description") or i.get("items") or "")) for i in items if isinstance(i, dict))

        for change in (detail.get("diff") or [])[:8]:
            gate = (change.get("fact_gate") or {}).get("status", "-")
            print(f"    - {change.get('title')} [{change.get('change_type')}, 事实闸门 {gate}]")
            print(f"      前：{plain(change.get('before') or {})[:120]}")
            print(f"      后：{plain(change.get('after') or {})[:160]}")
            for item in change.get("inferred_skills") or []:
                print(f"      ? 推断技能 {item.get('skill')}（依据：{item.get('basis')}）")
        for name, message in ((detail.get("trace") or {}).get("pipeline_errors") or {}).items():
            print(f"    ! {name} 没跑成（不影响改写）：{message}")
        for notice in detail.get("notices") or proposal.get("notices") or []:
            print(f"    ! {notice}")
        done(t)

        t = step(6, "在简历画布上逐条采用（等于你逐条点「采用」/「属实，采用」）")
        workspace = call(client, "POST", "/resume/workspace/ensure", json={
            "job_id": job_id, "proposal_id": proposal_id, "reference_resume_id": resume_id,
        })
        tailored_id = workspace.get("resume_id") or (workspace.get("resume") or {}).get("id")
        if not tailored_id:
            die(None, f"没拿到岗位简历 id：{json.dumps(workspace, ensure_ascii=False)[:600]}")
        for change in detail.get("diff") or []:
            reviewed = call(client, "POST", f"/resume/workspace/proposals/{proposal_id}/review-item", json={
                "resume_id": tailored_id, "change_id": change["change_id"], "action": "accept",
            })
            state = reviewed.get("status") or reviewed.get("item_status") or "ok"
            print(f"    · {change.get('title')}：{state}")
        done(t, f"tailored_resume_id={tailored_id}")

        t = step(7, "导出 PDF")
        resp = client.get(f"/resume/{tailored_id}/export/pdf")
        if resp.status_code >= 400 or not resp.content.startswith(b"%PDF"):
            die(resp, "导出不是 PDF")
        args.out.write_bytes(resp.content)
        done(t, f"{args.out.resolve()} ({len(resp.content) // 1024} KB)")

    print(f"\n主线跑通，总耗时 {time.monotonic() - started:.0f}s。打开 PDF 看一眼排版和改写是否站得住。")


if __name__ == "__main__":
    main()
