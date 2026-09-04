# OfferU Public Release Live Role Intelligence Evidence

更新时间：2026-09-01

## 结论

当前结论为 `NOT_VERIFIED`，不能把 Role Intelligence 的实时网页研究作为 Public Release claim。

隔离运行使用当前 OfferU 激活 Provider 的 staged 配置、Pi CLI `0.74.0`、临时 SQLite 和合成岗位。认证请求没有被判定为 blocked，但 Pi CLI 最终返回了说明性 Markdown，而不是 Role Intelligence 要求的结构化 JSON；因此 Runtime 将该任务正确记录为 `FAILED`，没有写入 benchmark snapshot，也没有伪造 `READY`。

## Evidence

| Check | Result | Evidence |
| --- | --- | --- |
| Pi CLI availability | PASS | `pi 0.74.0`，contract probe 可用 |
| Minimal structured-output smoke | PASS | 同一 staged Provider 返回符合 schema 的 JSON |
| Live Role Intelligence task | FAIL / NOT_VERIFIED | 真实采集任务返回非结构化说明文本，`valid_sample_count=0`，`benchmark_status=FAILED` |
| Database isolation | PASS | 临时 SQLite，脚本结束清理临时工作目录 |
| False-success prevention | PASS | `RoleBenchmarkRun` 保持失败状态，未生成完成结果 |

## Root cause boundary

`DeepExecutorRoleCollectionProvider` 的实时 Role Intelligence 契约要求受限的公开网页研究工具和结构化输出。当前 Pi CLI 的通用工具面不等于 OfferU 所需的 `WebSearch/WebFetch` 受限能力；本次运行中 Pi 明确表示无法执行网页采集并输出了 Markdown 说明。

因此已将 Pi/OMP runtime definition 的 `supports_live_web_search` 改为 `false`。这会让能力选择在任务开始前 fail closed，而不是让它进入一个没有受控网页工具的长任务。

Codex/Claude 仍保留 live web capability declaration，但本机 Codex 当前受外部认证阻塞；Claude 的真实生产账号也没有在本轮未经授权使用。

## Release mapping

- Public Release Goal R25：`PARTIAL`；真实 Role Intelligence Provider 尚未完整 E2E 通过。
- R26：`NOT_VERIFIED`；没有 10 个真实岗位的 raw → dedupe → cohort → Delta matrix。
- R100：当前产品/README 已明确 live claim 未通过，不得宣传实时全网岗位对比。

## Non-claims

- 不宣称实时市场数据已可用；
- 不宣称 Pi CLI 具备受控网页检索能力；
- 不把 fixture/replay benchmark 当作 live benchmark；
- 不修改用户 Provider 配置或正常数据库。
