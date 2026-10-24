import json, os, sys
os.environ['OFFERU_DATA_DIR'] = 'H:/tmp/offeru/demo-data'
sys.path.insert(0, 'H:/tmp/offeru/wt-test/backend')
from app.core import tools

def save(t, d):
    r = tools.call('save', {'type': t, 'data': d}, actor='demo')
    print(t, json.dumps(r, ensure_ascii=False)[:120])
    return r

save('profile', {'name': '林示例', 'phone': '138-0000-0000', 'email': 'demo@example.com', 'school': '示例大学', 'major': '计算机科学与技术', 'degree': '本科', 'grad_year': 2027, 'about': '想做 AI Agent 应用工程，偏后端与工具链。'})
mems = [
    ('experience', '某互联网公司 · 后端实习', '2026.03-2026.08；负责内部 LLM 网关的限流与重试，接口 P99 从 1.8s 降到 0.6s。'),
    ('project', '开源 API 代理工具', '支持 5 家模型厂商的统一代理，GitHub 1.2k star，写了多账号轮询与熔断。'),
    ('project', '求职 Agent 工作台', '共享工具层 + MCP，网页、内置 Agent、Codex 读写同一份数据，写入可撤销。'),
    ('education', '示例大学 · 计算机科学与技术 · 本科', '2023-2027，GPA 3.7/4.0，主修操作系统、分布式系统。'),
    ('skill', 'Python / FastAPI', '3 年，写过异步服务、SQLite/Postgres。'),
    ('skill', 'TypeScript / React', '做过 Vite + React 的工作台前端。'),
    ('award', '某省大学生程序设计竞赛 二等奖', '2025 年，队伍 3 人。'),
]
for k, t, b in mems:
    save('memory', {'kind': k, 'title': t, 'body': b})
jobs = [('星河科技', 'AI Agent 应用工程师（校招）', 'interview'), ('山海智能', '后端开发实习生', 'applied'), ('云雀数据', 'LLM 应用开发', 'saved')]
for c, t, st in jobs:
    save('job', {'company': c, 'title': t, 'status': st})
save('event', {'kind': 'interview', 'title': '星河科技 二面', 'at': '2026-10-27T14:00:00'})
save('event', {'kind': 'deadline', 'title': '云雀数据 网申截止', 'at': '2026-10-31T23:59:00'})
resume_md = '''# 林示例
138-0000-0000 · demo@example.com

## 教育
示例大学 · 计算机科学与技术 · 本科 · 2023-2027 · GPA 3.7/4.0

## 经历
某互联网公司 · 后端实习 · 2026.03-2026.08
- 负责内部 LLM 网关限流与重试，接口 P99 从 1.8s 降到 0.6s

## 项目
开源 API 代理工具 · GitHub 1.2k star
- 统一代理 5 家模型厂商，多账号轮询与熔断

求职 Agent 工作台
- 共享工具层 + MCP，网页 / 内置 Agent / Codex 读写同一份数据，写入可撤销

## 技能
Python、FastAPI、TypeScript、React、SQLite、MCP
'''
r = save('doc', {'kind': 'resume', 'template': 'single', 'title': '林示例｜单栏简历', 'body': resume_md})
rid = r.get('id') or (r.get('record') or {}).get('id')
print('resume id', rid)
if rid:
    print(tools.call('export_resume_pdf', {'id': rid}, actor='demo'))
