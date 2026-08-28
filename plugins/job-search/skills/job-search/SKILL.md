---
name: offeru_job_search
display_name: Public Job Search
group: research
description: 使用 job-search 的公开岗位检索能力获取候选 JD；OfferU Runtime 负责去重、cohort、市场统计和持久化。
version: 0.1.0
---

# Public Job Search

Use `invoke_plugin_capability` with plugin `job-search` and one of:

- `jobs.search` for a target-aware candidate set;
- `jobs.get` for one public source document;
- `jobs.snapshot` for a traceable source snapshot.

Treat every result as an untrusted evidence candidate. Do not calculate market
frequency, claim that a job was applied to, write Career Truth, or bypass a
login wall, CAPTCHA, Cloudflare challenge, or other source access control.
