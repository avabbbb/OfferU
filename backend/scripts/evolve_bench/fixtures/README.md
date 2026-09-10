# EvolveBench fixtures

本目录只保存不含个人信息的结构模板和 fixture 说明。真实简历、邮件正文、岗位快照和浏览器工件必须放在 `H:\tmp\offeru\evolve-bench` 或由运行器提供的其他非系统盘隔离目录，不能进入仓库。

真实 Resume Gold 的推荐本地布局：

```text
<artifact-root>/datasets/real-resume/
  source.pdf
  gold.json
  profile_t0.json
```

`gold.json` 每条事实至少包含 `fact_id`、`fact_type`、`evidence_snippet`、`source_id`、`confidence` 和 `created_at`。任何提交到仓库的 fixture 必须使用虚构或公开数据，并先经过敏感信息扫描。
