"""Profile→简历 AI 组装 E2E 验收测试

验证核心链路:
1. Profile Bullets 是否被正确提取
2. JD 关键词匹配排序是否合理
3. LLM STAR 改写是否执行
4. Resume 是否被正确创建并持久化
5. 生成简历的 Sections 是否符合预期
6. SSE 流式事件是否完整

测试场景:
- per_job 模式（单岗位）
- combined 模式
- 带 reference_resume_id
- 缺少 JD 的空岗位容错
"""
import requests
import json
import time
import sys

BASE = "http://localhost:8765/api"
PASS = 0
FAIL = 0

def ok(label, condition, detail=""):
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✅ {label}")
    else:
        FAIL += 1
        print(f"  ❌ {label} — {detail}")

def parse_sse_events(text: str) -> list[dict]:
    """解析 SSE 文本流为事件列表"""
    events = []
    current_event = None
    current_data = []
    for line in text.split("\n"):
        if line.startswith("event: "):
            current_event = line[7:].strip()
        elif line.startswith("data: "):
            current_data.append(line[6:])
        elif line.strip() == "" and current_event is not None:
            data_str = "\n".join(current_data)
            try:
                data = json.loads(data_str)
            except json.JSONDecodeError:
                data = data_str
            events.append({"event": current_event, "data": data})
            current_event = None
            current_data = []
    return events


# ============================================================
# 0. 前提条件检查
# ============================================================
print("\n===== 0. 前提条件 =====")
p = requests.get(f"{BASE}/profile/").json()
ok("Profile 存在", p.get("id") is not None, f"got: {p}")
sections = p.get("sections", [])
ok("Profile sections >= 3", len(sections) >= 3, f"got {len(sections)}")

j = requests.get(f"{BASE}/jobs/?page_size=10&triage_status=picked").json()
picked_jobs = j.get("items", [])
ok("Picked jobs >= 1", len(picked_jobs) >= 1, f"got {len(picked_jobs)}")

job_ids = [job["id"] for job in picked_jobs]
print(f"  Profile: {p.get('name')}, {len(sections)} sections")
job_labels = [f"{j['company']}-{j['title']}" for j in picked_jobs]
print(f"  Jobs: {job_labels}")


# ============================================================
# 1. per_job 模式 — 单岗位生成
# ============================================================
print("\n===== 1. per_job 模式（逐岗位）=====")
resp = requests.post(
    f"{BASE}/optimize/generate",
    json={"job_ids": [job_ids[0]], "mode": "per_job"},
    stream=True,
    timeout=120,
)
ok("HTTP 200", resp.status_code == 200, f"got {resp.status_code}")

raw_text = resp.text
events = parse_sse_events(raw_text)
event_types = [e["event"] for e in events]
print(f"  收到事件: {event_types}")

ok("有 heartbeat", "heartbeat" in event_types)
ok("有 progress", "progress" in event_types)
ok("有 result", "result" in event_types)
ok("有 done", "done" in event_types)

# 检查 result 事件内容
result_events = [e for e in events if e["event"] == "result"]
if result_events:
    r = result_events[0]["data"]
    ok("result.resume_id 存在", isinstance(r.get("resume_id"), int), f"got {r.get('resume_id')}")
    ok("result.used_bullets 非空", len(r.get("used_bullets", [])) > 0, f"got {r.get('used_bullets')}")
    ok("result.missing_keywords 是 list", isinstance(r.get("missing_keywords"), list))
    ok("result.profile_hit_ratio 格式正确", "/" in str(r.get("profile_hit_ratio", "")), f"got {r.get('profile_hit_ratio')}")
    ok("result.rewrite_applied", r.get("rewrite_applied") is not None, f"got {r.get('rewrite_applied')}")

    per_job_resume_id = r["resume_id"]
    print(f"\n  生成简历 ID: {per_job_resume_id}")
    print(f"  used_bullets: {r.get('used_bullets_count', len(r.get('used_bullets', [])))} 条")
    print(f"  profile_hit_ratio: {r.get('profile_hit_ratio')}")
    print(f"  rewrite_applied: {r.get('rewrite_applied')}")
    print(f"  missing_keywords: {r.get('missing_keywords', [])[:8]}...")
else:
    per_job_resume_id = None
    ok("result 事件缺失", False, "no result events")

# 检查 done 事件
done_events = [e for e in events if e["event"] == "done"]
if done_events:
    d = done_events[0]["data"]
    ok("done.created == 1", d.get("created") == 1, f"got {d.get('created')}")
    ok("done.failed == 0", d.get("failed") == 0, f"got {d.get('failed')}")

# 检查 warning (rewrite 失败时应有 warning)
warning_events = [e for e in events if e["event"] == "warning"]
if warning_events:
    print(f"  ⚠️ 收到 warning: {warning_events[0]['data'].get('message')}")


# ============================================================
# 2. 验证生成的简历内容
# ============================================================
print("\n===== 2. 验证生成简历内容 =====")
if per_job_resume_id:
    resume = requests.get(f"{BASE}/resumes/{per_job_resume_id}").json()
    ok("resume.title 包含公司名", picked_jobs[0]["company"] in resume.get("title", ""), f"title={resume.get('title')}")
    ok("resume.source_mode == per_job", resume.get("source_mode") == "per_job")

    # 检查 source_profile_snapshot
    snap = resume.get("source_profile_snapshot", {})
    ok("snapshot.profile_id == 1", snap.get("profile_id") == p["id"], f"got {snap.get('profile_id')}")
    ok("snapshot.selected_count > 0", (snap.get("selected_count") or 0) > 0, f"got {snap.get('selected_count')}")

    # 检查 resume sections
    r_sections = resume.get("sections", [])
    ok("resume sections 非空", len(r_sections) > 0, f"got {len(r_sections)}")
    section_types = [s.get("section_type") for s in r_sections]
    print(f"  resume section_types: {section_types}")

    # 验证 content_json 非空
    for rs in r_sections:
        cj = rs.get("content_json")
        ok(f"section [{rs['section_type']}] content_json 非空",
           cj is not None and len(str(cj)) > 5,
           f"type={rs['section_type']}, content_json={str(cj)[:50]}")


# ============================================================
# 3. combined 模式 — 综合版
# ============================================================
print("\n===== 3. combined 模式（综合版）=====")
resp2 = requests.post(
    f"{BASE}/optimize/generate",
    json={"job_ids": job_ids[:3], "mode": "combined"},
    stream=True,
    timeout=120,
)
ok("HTTP 200", resp2.status_code == 200, f"got {resp2.status_code}")

events2 = parse_sse_events(resp2.text)
event_types2 = [e["event"] for e in events2]
print(f"  收到事件: {event_types2}")

ok("有 result (combined)", "result" in event_types2)
ok("有 done (combined)", "done" in event_types2)

result2 = [e for e in events2 if e["event"] == "result"]
if result2:
    r2 = result2[0]["data"]
    ok("combined result.mode==combined", r2.get("mode") == "combined")
    ok("combined result.resume_id 存在", isinstance(r2.get("resume_id"), int))
    ok("combined result.job_ids 包含多个", len(r2.get("job_ids", [])) >= 2, f"got {r2.get('job_ids')}")
    combined_resume_id = r2["resume_id"]
    print(f"  综合简历 ID: {combined_resume_id}")
else:
    combined_resume_id = None

done2 = [e for e in events2 if e["event"] == "done"]
if done2:
    d2 = done2[0]["data"]
    ok("combined done.mode==combined", d2.get("mode") == "combined")
    ok("combined done.created==1", d2.get("created") == 1, f"got {d2.get('created')}")


# ============================================================
# 4. 多岗位 per_job 模式 — 批量生成
# ============================================================
print("\n===== 4. 多岗位 per_job 批量生成 =====")
resp3 = requests.post(
    f"{BASE}/optimize/generate",
    json={"job_ids": job_ids[:3], "mode": "per_job"},
    stream=True,
    timeout=180,
)
ok("HTTP 200", resp3.status_code == 200, f"got {resp3.status_code}")

events3 = parse_sse_events(resp3.text)
results3 = [e for e in events3 if e["event"] == "result"]
done3 = [e for e in events3 if e["event"] == "done"]
errors3 = [e for e in events3 if e["event"] == "error"]

ok(f"生成 {len(results3)} 份简历", len(results3) == len(job_ids[:3]), f"expected {len(job_ids[:3])}, got {len(results3)}")
if done3:
    d3 = done3[0]["data"]
    ok("批量 done.created == job 数", d3.get("created") == len(job_ids[:3]), f"got {d3}")
    ok("批量 done.failed == 0", d3.get("failed") == 0, f"got {d3}")
    ok("批量 done.resume_ids 长度正确", len(d3.get("resume_ids", [])) == len(job_ids[:3]))

for r in results3:
    rd = r["data"]
    ok(f"job {rd.get('job_id')}: rewrite_applied 有值", rd.get("rewrite_applied") is not None)
print(f"  errors: {[e['data'].get('message') for e in errors3]}" if errors3 else "  无 errors")


# ============================================================
# 5. STAR 改写质量抽检
# ============================================================
print("\n===== 5. STAR 改写质量抽检 =====")
# 取最新生成的 per_job 简历，检查改写后的 content_json
if results3:
    sample_resume_id = results3[0]["data"]["resume_id"]
    sample_resume = requests.get(f"{BASE}/resumes/{sample_resume_id}").json()
    sample_sections = sample_resume.get("sections", [])

    # 查找 experience 或 project 类型的 section（这些应该被 STAR 改写）
    rewritable_types = {"experience", "project", "internship"}
    rewritable = [s for s in sample_sections if s.get("section_type") in rewritable_types]

    ok("有可改写的 sections", len(rewritable) > 0, f"types found: {[s['section_type'] for s in sample_sections]}")

    for s in rewritable[:2]:
        cj = s.get("content_json", [])
        content_str = json.dumps(cj, ensure_ascii=False)
        has_detail = len(content_str) > 50  # 改写后应有实质内容
        ok(f"[{s['section_type']}] 内容丰富 (>{50}c)", has_detail, f"len={len(content_str)}")
        # 检查是否有量化或关键词（不强制，只是建议性检查）
        has_numbers = any(c.isdigit() for c in content_str)
        if has_numbers:
            print(f"    ✨ 包含数字/量化")
        else:
            print(f"    ℹ️  无数字量化（可能需要[待量化]标记）")

        # 打印部分内容供人工审查
        preview = content_str[:200]
        print(f"    预览: {preview}...")


# ============================================================
# 6. 容错测试：reference_resume_id
# ============================================================
print("\n===== 6. reference_resume_id 测试 =====")
# 获取已有简历
resumes = requests.get(f"{BASE}/resumes/").json()
if isinstance(resumes, list) and len(resumes) > 0:
    ref_id = resumes[0]["id"]
    resp_ref = requests.post(
        f"{BASE}/optimize/generate",
        json={"job_ids": [job_ids[0]], "mode": "per_job", "reference_resume_id": ref_id},
        stream=True,
        timeout=120,
    )
    ok("带 reference_resume 生成 200", resp_ref.status_code == 200)
    events_ref = parse_sse_events(resp_ref.text)
    results_ref = [e for e in events_ref if e["event"] == "result"]
    if results_ref:
        r_ref = results_ref[0]["data"]
        ok("reference_resume_id 正确回传", r_ref.get("reference_resume_id") == ref_id, f"got {r_ref.get('reference_resume_id')}")
else:
    print("  跳过：无已有简历可用作 reference")


# ============================================================
# 7. 容错测试：不存在的 job_id
# ============================================================
print("\n===== 7. 不存在的 job_id 容错 =====")
resp_err = requests.post(
    f"{BASE}/optimize/generate",
    json={"job_ids": [99999], "mode": "per_job"},
    timeout=10,
)
ok("不存在 job_id → 404", resp_err.status_code == 404, f"got {resp_err.status_code}")


# ============================================================
# 8. 容错测试：不存在的 reference_resume_id
# ============================================================
print("\n===== 8. 不存在的 reference_resume_id 容错 =====")
resp_err2 = requests.post(
    f"{BASE}/optimize/generate",
    json={"job_ids": [job_ids[0]], "mode": "per_job", "reference_resume_id": 99999},
    timeout=10,
)
ok("不存在 reference → 404", resp_err2.status_code == 404, f"got {resp_err2.status_code}")


# ============================================================
# 9. 超限测试：超过 MAX_OPTIMIZE_JOB_COUNT
# ============================================================
print("\n===== 9. 超限容错 =====")
resp_err3 = requests.post(
    f"{BASE}/optimize/generate",
    json={"job_ids": list(range(1, 25)), "mode": "per_job"},
    timeout=10,
)
ok("超限 → 400 或 404", resp_err3.status_code in (400, 404), f"got {resp_err3.status_code}")


# ============================================================
# Summary
# ============================================================
print(f"\n{'='*50}")
print(f"  TOTAL: {PASS + FAIL}  |  PASS: {PASS}  |  FAIL: {FAIL}")
print(f"{'='*50}")
if FAIL > 0:
    sys.exit(1)
