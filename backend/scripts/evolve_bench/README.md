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
