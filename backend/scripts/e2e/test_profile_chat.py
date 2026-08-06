"""
测试 /api/profile/chat — SSE 对话模式
模拟用户告诉 LLM 自己的经历，LLM 返回结构化 bullet candidates
然后通过 /api/profile/chat/confirm 确认入库
"""
import json
import urllib.request

BASE = "http://localhost:8765"

def api(method, path, data=None):
    body = json.dumps(data, ensure_ascii=False).encode() if data else None
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=body,
        headers={"Content-Type": "application/json"} if body else {},
        method=method,
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())

def sse_request(path, data):
    body = json.dumps(data, ensure_ascii=False).encode()
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        },
        method="POST",
    )
    events = []
    with urllib.request.urlopen(req) as resp:
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


# ==== 测试 1: 对话模式 — 新对话 ====
print("=" * 60)
print("测试 1: 对话模式 /api/profile/chat")
print("=" * 60)

user_msg = """我大学期间在学校的创新创业中心做过一个项目，是一个基于微信小程序的校园二手交易平台。
我是项目负责人，带了3个人的团队，用了Taro + 云开发，上线2个月有500+用户注册，
日均交易额超过200元。这个项目拿了学校创新创业大赛二等奖。"""

print(f"\n用户输入: {user_msg[:80]}...")
events = sse_request("/api/profile/chat", {
    "topic": "project",
    "message": user_msg,
})

session_id = None
candidates = []
for event_type, data in events:
    if event_type == "ai_message":
        print(f"\n[AI回复] {data['content'][:200]}...")
        session_id = data.get("session_id")
    elif event_type == "bullet_candidate":
        candidates.append(data)
        print(f"\n[候选条目 #{data['index']}]")
        print(f"  类型: {data.get('section_type')}")
        print(f"  标题: {data.get('title')}")
        cj = data.get("content_json", {})
        print(f"  bullet: {cj.get('bullet', '')[:100]}")
        print(f"  confidence: {data.get('confidence')}")
    elif event_type == "done":
        print(f"\n[完成] session_id={data.get('session_id')}")
    elif event_type == "error":
        print(f"\n[错误] {data.get('message')}")

# ==== 测试 2: 确认候选入库 ====
if session_id and candidates:
    print("\n" + "=" * 60)
    print("测试 2: 确认候选条目入库 /api/profile/chat/confirm")
    print("=" * 60)

    confirmed = api("POST", "/api/profile/chat/confirm", {
        "session_id": session_id,
        "bullet_index": 0,  # 确认第一个候选
    })
    print(f"\n确认入库成功!")
    print(f"  ID: {confirmed.get('id')}")
    print(f"  类型: {confirmed.get('section_type')}")
    print(f"  标题: {confirmed.get('title')}")
    print(f"  source: {confirmed.get('source')}")
    cj = confirmed.get("content_json", {})
    print(f"  bullet: {cj.get('bullet', '')[:100]}")
    normalized = cj.get("normalized", {})
    has_content = any(v for v in normalized.values() if v)
    print(f"  normalized has content: {has_content}")
    print(f"  normalized: {json.dumps(normalized, ensure_ascii=False)[:200]}")

# ==== 测试 3: 验证 profile 多了新条目 ====
print("\n" + "=" * 60)
print("测试 3: 验证 profile sections")
print("=" * 60)
profile = api("GET", "/api/profile/")
for s in profile.get("sections", []):
    cj = s.get("content_json", {})
    bullet = cj.get("bullet", "")
    source = s.get("source", "")
    marker = "🤖 AI" if source == "ai_chat" else "📝 手动"
    print(f"  [{s['section_type']}] {s['title']} ({marker})")
    if bullet:
        print(f"    bullet: {bullet[:80]}{'...' if len(bullet)>80 else ''}")

print(f"\n总计 {len(profile.get('sections', []))} 个条目")
