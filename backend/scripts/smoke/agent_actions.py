"""Smoke: embedded Agent writes go through ActionGate (real backend, scripted model).
Run 1 (resume_export): Agent changes the resume accent colour -> applied at once, on the timeline.
Run 2 (tracker, same conversation): Agent marks application applied -> queued, Run still completes.
User: undo the colour, confirm the status (desktop token). Run 3: prompt must carry both decisions.

Needs: backend on :8766 started with OFFERU_APPROVAL_TOKEN=<token> and its model
pointed at scripts/smoke/stub_agent_llm.py (:9914), one resume (#1) and one
application (#1) — e.g. run tailor_mainline.py first and POST /api/applications/.
Usage: python agent_actions.py <token> [<data_dir>]"""
import json, os, sys, urllib.request
B = "http://127.0.0.1:8766"
TOKEN = sys.argv[1]
DB = os.path.join(sys.argv[2] if len(sys.argv) > 2 else os.environ.get("OFFERU_DATA_DIR", "/tmp/smoke-data"), "djm.db")

def call(method, path, body=None, auth=False):
    headers = {"content-type": "application/json"}
    if auth:
        headers["Authorization"] = f"Bearer {TOKEN}"
    req = urllib.request.Request(B + path, method=method, headers=headers,
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")

def check(label, ok, detail=""):
    print(("  ok   " if ok else "  FAIL ") + label + (f"  {detail}" if detail else ""))
    if not ok:
        sys.exit(1)

def script(steps):
    json.dump(steps, open("/tmp/agent_script.json", "w"))

def accent():
    return (call("GET", "/api/resume/1")[1].get("style_config") or {}).get("accentColorHex")

def app_status():
    import sqlite3
    row = sqlite3.connect(DB).execute("select * from application_records where id = 1").fetchone()
    for cell in row or ():
        if isinstance(cell, str) and cell.startswith("{") and json.loads(cell).get("apply_status") == "已投递":
            return "已投递"
    return "未投递"

open("/tmp/agent_stub.log", "w").close()
resume = call("GET", "/api/resume/1")[1]
color0, status0 = accent(), app_status()
new_color = "#0ea5e9" if color0 == "#7c3aed" else "#7c3aed"
print(f"起点：主题色={color0} 投递状态={status0}")

print("[1] Agent 改简历主题色（可撤销，应直接生效）")
script([{"tool": "update_resume_design", "args": {"resume_id": 1, "expected_revision": int(resume.get("workspace_revision") or 0),
                                                  "style_config": {"accentColorHex": new_color}}},
        {"text": "主题色改成紫色了。"}])
code, r1 = call("POST", "/api/agent/runtime/runs", {"message": "把简历主题色改成紫色", "skill_id": "resume_export"})
run1 = r1.get("run") or {}
check("Run 1 结束", code == 200 and run1.get("status") == "completed", f"status={run1.get('status')} {r1.get('errors') or ''}")
check("颜色已改", accent() == new_color, str(accent()))
done = [a for a in call("GET", f"/api/agent/runtime/actions?run_id={run1['id']}")[1]["items"] if a["status"] == "done"]
check("时间线有一条可撤销记录", len(done) == 1 and done[0]["undoable"], json.dumps(done, ensure_ascii=False)[:200])

conv = r1.get("conversation_id") or run1.get("conversation_id")
print("[2] 同一对话里 Agent 标记已投递（不可逆，应进待确认，Run 不停）")
script([{"tool": "update_application_status", "args": {"application_id": 1, "status": "submitted"}},
        {"text": "标记已投递在等你确认，我先继续。"}])
code, r2 = call("POST", "/api/agent/runtime/runs", {"message": "把这个岗位标记为已投递", "skill_id": "tracker", "conversation_id": conv})
run2 = r2.get("run") or {}
check("Run 2 是 completed 而不是卡住", code == 200 and run2.get("status") == "completed", f"status={run2.get('status')} {r2.get('errors') or ''}")
check("返回里带待确认数", r2.get("pending_action_count") == 1 or (run2.get("final_result") or {}).get("pending_action_count") == 1)
check("投递状态没变", app_status() == status0, str(app_status()))
pending = call("GET", "/api/agent/runtime/actions?status=pending")[1]["items"]
check("待确认列表有 1 条", len(pending) == 1 and pending[0]["operation"] == "update_application_status")

print("[3] 用户操作：没 token 确认应被拒；撤销颜色；带 token 确认投递")
code, _ = call("POST", f"/api/agent/runtime/actions/{pending[0]['id']}/confirm")
check("没 token 确认被拒", code in (403, 422), str(code))
code, u = call("POST", f"/api/agent/runtime/actions/{done[0]['id']}/undo", auth=True)
check("撤销成功", code == 200 and u.get("ok"), json.dumps(u, ensure_ascii=False)[:200])
check("颜色回到原样", accent() == color0, str(accent()))
code, c = call("POST", f"/api/agent/runtime/actions/{pending[0]['id']}/confirm", auth=True)
check("确认成功", code == 200 and c.get("ok"), json.dumps(c, ensure_ascii=False)[:300])
check("投递状态已改", app_status() == "已投递", str(app_status()))

print("[4] 下一轮 prompt 里应带上这两个决定")
script([{"text": "收到。"}])
code, r3 = call("POST", "/api/agent/runtime/runs", {"message": "接下来呢", "skill_id": "tracker", "conversation_id": conv})
prompts = [json.loads(l) for l in open("/tmp/agent_stub.log") if l.strip()]
last_user = next(m for m in reversed(prompts[-1]["messages"]) if m.get("role") == "user")
text = last_user["content"] if isinstance(last_user["content"], str) else json.dumps(last_user["content"], ensure_ascii=False)
check("提到确认并执行", "已确认并执行" in text)
check("提到撤销", "用户撤销了" in text)
print("\n内置 Agent 写操作主线跑通。")
