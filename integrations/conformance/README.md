# OfferU Conformance 骨架（Slice 0）

对同一组场景，在可替换的 fake Harness adapter 之间验证 Agent Bridge 协议行为。
Slice 0 只覆盖协议层：畸形输入、未知版本、未知 message、stdout 契约、错误码与
幂等响应形状。不调用真实业务 Operation。

## 布局

```text
integrations/conformance/
  README.md            # 本文件：范围与运行方式
  runner.py            # 场景执行器：scenario → adapter → 断言
  scenarios.json       # Slice 0 协议场景（输入行 + 期望错误码/形状）
  adapters/
    fake_harness.py    # 最小 fake adapter：按场景发送行、收集响应
  fixtures/
    hello_ok.jsonl             # 合法握手 transcript
    bad_json.jsonl             # 畸形 JSON → schema_invalid
    unknown_version.jsonl      # v=2 → protocol_mismatch
    unknown_message.jsonl      # 未知 type → schema_invalid
    run_create_forbidden.jsonl # run.create 未公开 → schema_invalid
```

## 运行

```bash
cd backend
./.venv312/Scripts/python.exe -m integrations_runner  # 或直接运行 ../integrations/conformance/runner.py
```

runner 退出码：0 = 全部场景通过；1 = 任一失败。失败输出到 stderr，stdout 只写
一行 JSON 摘要（与 Bridge stdout 契约一致）。

## 与迁移路线的关系

- Slice 1 起把 `fake_harness.py` 替换为真实 adapter（DSH plugin / Codex app-server），
  场景文件保持不变即可复跑；
- Conformance 场景全集见 `docs/implementation/migration-roadmap.md` 的
  “Conformance 场景”一节；本骨架只实现其中协议子集（场景 1 的协议部分）。
