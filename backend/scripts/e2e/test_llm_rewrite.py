"""
测试 LLM 改写后的简历质量
只生成 1 个岗位（字节跳动 AIGC产品经理）看改写效果
"""
import json
import urllib.request
import time

BASE = "http://localhost:8765"

def sse_request(path, data, timeout=120):
    body = json.dumps(data, ensure_ascii=False).encode()
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=body,
        headers={"Content-Type": "application/json", "Accept": "text/event-stream"},
        method="POST",
    )
    events = []
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        buffer = ""
        for line in resp:
            decoded = line.decode("utf-8")
            buffer += decoded
            while "\n\n" in buffer:
                block, buffer = buffer.split("\n\n", 1)
                event_type = None
                data_str = None
                for l in block.strip().split("\n"):
                    if l.startswith("event: "):
                        event_type = l[7:]
                    elif l.startswith("data: "):
                        data_str = l[6:]
                if event_type and data_str:
                    events.append((event_type, json.loads(data_str)))
    return events

def api_get(path):
    return json.loads(urllib.request.urlopen(f"{BASE}{path}").read())

print("=== 测试 LLM 改写版简历生成 ===")
print("目标岗位: 字节跳动 AIGC产品经理 (job_id=1)")
print()

start = time.time()
events = sse_request("/api/optimize/generate", {
    "job_ids": [1],
    "mode": "per_job",
})
elapsed = time.time() - start
print(f"耗时: {elapsed:.1f}秒")

for event_type, data in events:
    if event_type == "result":
        print(f"\n[生成结果]")
        print(f"  resume_id: {data.get('resume_id')}")
        print(f"  resume_title: {data.get('resume_title')}")
        print(f"  hit_ratio: {data.get('profile_hit_ratio')}")
        resume_id = data.get("resume_id")
    elif event_type == "error":
        print(f"[错误] {data.get('message')}")
    elif event_type == "done":
        print(f"\n[完成] created={data.get('created')}, failed={data.get('failed')}")

# 下载详细简历看改写效果
if resume_id:
    print(f"\n{'='*60}")
    print(f"=== 简历 #{resume_id} 详细内容（LLM 改写后）===")
    print(f"{'='*60}")
    detail = api_get(f"/api/resume/{resume_id}")
    for s in detail.get("sections", []):
        cj_list = s.get("content_json", [])
        print(f"\n## [{s['section_type']}] {s['title']}")
        if isinstance(cj_list, list):
            for item in cj_list:
                if not isinstance(item, dict):
                    continue
                name = (item.get("school") or item.get("company") or
                        item.get("name") or item.get("category") or "")
                if name:
                    print(f"  ### {name}")
                desc = item.get("description", "")
                if desc:
                    for line in desc.split("\n"):
                        line = line.strip()
                        if line:
                            print(f"    {line}")
                items = item.get("items")
                if items and isinstance(items, list):
                    print(f"    技能: {', '.join(str(i) for i in items[:10])}")
