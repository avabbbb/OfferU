# OfferU-EvolveBench runner

这是一个离线的 Benchmark 契约层，不是第二套 Agent Runtime。它只负责：

- 校验公开 Dev task catalog 与 Dev/Feedback/Hidden 分界；
- 计算可由确定性证据支持的稳定性、纵向学习、校准和泛化指标；
- 在非系统盘生成诚实的 `NOT_RUN` 报告骨架。

它不会启动 Codex、浏览器、后端或邮箱，也不会写 OfferU 数据库。真实执行器以后必须把 Operation Registry 轨迹和最终 outcome 写入报告，才能把 case 从 `NOT_RUN` 改为其他状态。

从仓库根目录运行：

```powershell
python -m backend.scripts.evolve_bench.runner validate
python -m backend.scripts.evolve_bench.runner manifest
python -m backend.scripts.evolve_bench.runner scaffold --split dev
# 对已生成的报告执行确定性证据守卫
python -m backend.scripts.evolve_bench.runner validate-report H:\tmp\offeru\evolve-bench\<run-id>.json
```

默认 artifact 根目录是 `H:\tmp\offeru\evolve-bench`。也可以通过 `OFFERU_EVOLVEBENCH_ROOT` 或 `--output-root` 指定非系统盘目录；运行器拒绝静默落到 `C:`。

Hidden/Feedback 只在仓外由 Benchmark Runner 注入，仓库中只保留数量、哈希和 `runner_only` 标记。真实简历、邮件、岗位快照和截图必须沿用 fixtures README 的隔离约束。

## 隔离 Resume -> Job 下游环境

已确认的 `PROFILE_T0` 可以在非系统盘建立可重复的下游验收环境：

```powershell
Set-Location backend
& .\.venv312\Scripts\python.exe scripts\evolve_bench\real_career_fixture.py `
  --workspace H:\tmp\offeru\evolve-bench\real-career-test-workspace
```

runner 会重建 `downstream\downstream.db`，通过 Operation Registry 读取岗位基准、生成仅供审核的简历提案和面试重点，并把过程写入：

```text
H:\tmp\offeru\evolve-bench\real-career-test-workspace\progress.json
H:\tmp\offeru\evolve-bench\real-career-test-workspace\run.log
```

数据库、jieba/ Python 临时缓存和 JSON 产物均固定在 H 盘；runner 拒绝 C 盘路径。邮箱纵向阶段只有在用户完成只读 OAuth 后才会从 `BLOCKED_EXTERNAL` 进入真实同步。
