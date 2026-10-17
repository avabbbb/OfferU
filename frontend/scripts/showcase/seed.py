"""给展示站造一份演示数据：真实后端 + 真实接口写入，之后 record.py 把页面用到的接口响应录成快照。

只用公开接口写数据，不碰数据库，接口改了这里会直接报错，不会悄悄录出过时的数据。
用法：先起一个空数据目录的后端（8766），再 python seed.py。
"""
import json
import sys
import urllib.request
from datetime import datetime, timedelta

API = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8766"


def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"content-type": "application/json"})
    return json.loads(urllib.request.urlopen(req).read() or "{}")


B = API + "/api/resume"
call("PUT", "/api/profile/", {"name": "林知远", "headline": "北邮计算机 2026 届 · 后端开发方向"})

JOBS = [
    ("后端开发实习生", "字节跳动", "北京", "负责抖音电商交易链路后端开发。\n要求：熟悉 Go 或 Java；了解 Kafka、Redis、MySQL；有高并发服务经验优先；每周实习 4 天以上，可实习 6 个月。"),
    ("基础架构实习生", "美团", "北京", "参与日志采集与可观测性平台研发。\n要求：熟悉 Linux 与网络编程；Go/C++ 至少一门；对性能优化有兴趣。"),
    ("服务端研发工程师（2026 校招）", "拼多多", "上海", "负责交易、营销等核心系统研发。\n要求：计算机相关专业本科及以上；扎实的数据结构与算法基础；熟悉分布式系统者优先。"),
    ("后端工程师（实习）", "小红书", "上海", "参与社区内容分发服务开发。\n要求：熟悉 Java/Go；了解缓存、消息队列；有开源项目经验加分。"),
    ("研发工程师", "阿里云", "杭州", "参与云原生存储产品研发。\n要求：熟悉操作系统、分布式一致性协议（Raft/Paxos）者优先。"),
]
job_ids = []
for title, company, location, jd in JOBS:
    job_ids.append(call("POST", "/api/jobs/capture", {"title": title, "company": company, "location": location, "jd_text": jd,
                                                       "url": "https://example.com/jobs/" + str(len(job_ids) + 1)})["job_id"])

r = call("POST", "/api/resume/", {"title": "校招通用版", "user_name": "林知远", "summary": "计算机科学与技术专业本科在读，两段后端实习，熟悉 Go 与分布式存储；在校主导的二手交易平台上线后服务 1200 名同学。希望在高并发业务里继续深挖稳定性与性能。",
  "contact_json": {"nameEn": "Zhiyuan Lin", "role": "后端开发实习生", "phone": "138-0000-0000", "email": "zhiyuan.lin@example.com", "github": "github.com/zhiyuan", "location": "北京 · 可实习 6 个月"},
  "style_config": {"template": "paper"}})
rid = r["id"]
for section in call("GET", f"/api/resume/{rid}").get("sections", []):  # 新建简历自带的空段落，展示时只会多出空标题
    call("DELETE", f"/api/resume/{rid}/sections/{section['id']}")
sections = [
  ("education", "教育背景", [{"school": "北京邮电大学", "degree": "本科", "major": "计算机科学与技术", "gpa": "3.8/4.0（前 10%）", "startDate": "2022.09", "endDate": "2026.06", "description": "<ul><li><p>主修课程：操作系统、计算机网络、数据库系统、分布式系统（均 90+）</p></li></ul>"}]),
  ("internshipExperiences", "实习经历", [
    {"company": "字节跳动", "position": "后端开发实习生 · 抖音电商", "location": "北京", "startDate": "2025.06", "endDate": "2025.09", "description": "<ul><li><p>负责订单履约链路的超时补偿任务，改为分片 + 幂等重试后，补偿延迟从 15 分钟降到 40 秒</p></li><li><p>给商品详情接口加二级缓存与热点探测，大促峰值 P99 从 180ms 降到 65ms</p></li></ul>"},
    {"company": "美团", "position": "基础架构实习生", "location": "北京", "startDate": "2024.12", "endDate": "2025.03", "description": "<ul><li><p>参与日志采集 Agent 的内存优化，单机常驻内存下降 32%，在 2 万台机器上灰度上线</p></li></ul>"}]),
  ("projects", "项目经历", [{"name": "校园二手交易平台", "role": "后端负责人", "startDate": "2024.03", "endDate": "2024.07", "description": "<ul><li><p>用 Go + Gin 开发商品、订单与即时消息模块，MySQL 存储，Redis 做会话和热点缓存</p></li><li><p>平台在校内上线，注册用户约 1200 人，累计成交 3000+ 单</p></li></ul>"},
    {"name": "Raft 分布式 KV", "role": "独立完成", "startDate": "2023.10", "endDate": "2024.01", "description": "<ul><li><p>实现选主、日志复制与快照，通过 MIT 6.824 全部测试；线性一致读压测 QPS 2.1 万</p></li></ul>"}]),
  ("skills", "专业技能", [{"category": "语言", "items": "Go、Java、Python、SQL"}, {"category": "后端", "items": "Gin、Spring Boot、gRPC、Kafka、Redis、MySQL"}, {"category": "工程", "items": "Docker、Kubernetes、Prometheus、Linux"}]),
  ("awards", "荣誉奖项", [{"awardName": "ICPC 亚洲区域赛铜奖", "issuer": "ICPC", "awardedAt": "2024.11"}, {"awardName": "校一等奖学金", "issuer": "北京邮电大学", "awardedAt": "2023.10"}]),
]
for order, (kind, title, content) in enumerate(sections):
    call("POST", f"/api/resume/{rid}/sections", {"section_type": kind, "title": title, "sort_order": order, "visible": True, "content_json": content})

tomorrow = (datetime.now() + timedelta(days=1)).replace(hour=14, minute=0, second=0, microsecond=0)
call("POST", "/api/calendar/events", {"title": "美团 · 基础架构实习生 一面", "event_type": "interview", "location": "线上",
                                     "start_time": tomorrow.isoformat(), "end_time": (tomorrow + timedelta(hours=1)).isoformat(),
                                     "related_job_id": job_ids[1]})
exam = (datetime.now() + timedelta(days=4)).replace(hour=19, minute=0, second=0, microsecond=0)
call("POST", "/api/calendar/events", {"title": "阿里云 · 研发工程师 在线笔试", "event_type": "exam", "location": "牛客网",
                                     "start_time": exam.isoformat(), "end_time": (exam + timedelta(hours=2)).isoformat(),
                                     "related_job_id": job_ids[4]})
table_id = call("GET", "/api/applications/workspace")["current_table_id"]  # 投递页默认打开的那张表
call("POST", f"/api/applications/tables/{table_id}/import-jobs", {"job_ids": job_ids[:4]})
print(json.dumps({"jobs": job_ids, "resume": rid}))
