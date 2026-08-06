"""E2E test: optimize generate with jieba + SSE warning + tier system."""
import httpx, json, sys

BASE = "http://127.0.0.1:8765"

print("=== E2E Optimize Test ===")

# 1) Trigger per_job optimize for job 1
with httpx.Client(timeout=120) as c:
    resp = c.post(
        f"{BASE}/api/optimize/generate",
        json={"job_ids": [1], "mode": "per_job"},
        headers={"Accept": "text/event-stream"},
    )
    print(f"Status: {resp.status_code}")
    events = []
    for line in resp.text.strip().split("\n"):
        if line.startswith("data: "):
            try:
                ev = json.loads(line[6:])
                events.append(ev)
            except:
                pass

    for ev in events:
        t = ev.get("type")
        d = ev.get("data", {})
        if t == "resume_ready":
            print(f"  [resume_ready] id={d.get('resume_id')}, rewrite_applied={d.get('rewrite_applied')}")
        elif t == "missing_keywords":
            kw = d.get("keywords", [])
            print(f"  [missing_keywords] ({len(kw)}): {kw[:15]}")
        elif t == "warning":
            print(f"  [WARNING] {d.get('message')}")
        elif t == "error":
            print(f"  [ERROR] {d}")
        elif t == "done":
            print(f"  [DONE] total={d.get('total')}")
        else:
            print(f"  [{t}] {d}")

    # 2) Check the latest resume for content quality
    resume_events = [e for e in events if e.get("type") == "resume_ready"]
    if resume_events:
        rid = resume_events[-1]["data"]["resume_id"]
        r2 = c.get(f"{BASE}/api/resumes/{rid}")
        resume = r2.json()
        sections = resume.get("sections", [])
        print(f"\n=== Resume #{rid} Sections ({len(sections)}) ===")
        for s in sections:
            title = s.get("title", "?")
            items = s.get("items", [])
            print(f"  [{title}] {len(items)} items")
            for item in items[:2]:
                bullets = item.get("bullets", [])
                print(f"    - {item.get('primary_text','')[:60]}... ({len(bullets)} bullets)")

print("\nDone.")
