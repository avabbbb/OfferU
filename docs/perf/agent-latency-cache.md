# 内置 Agent：首字延迟（TTFT）与提示缓存

> 2026-11-15，分支 `ts/llm-perf`。范围：`packages/core/src/agent/{prompt,loop,host,runtime}.ts`、`packages/core/src/llm.ts`、`packages/core/src/desensitize.ts`、`packages/core/src/research/evaluate.ts`、Worker `/llm-proxy`、前端进度文案。
> 数字分两类：**mock 基准实测**（本机、无网络）和**估算**（按服务商公开的缓存计价和行为推，未在真实网关上测）。不要把估算当实测引用。

## 1. 问题（评审发现）

| # | 现象 | 后果 |
|---|---|---|
| 1 | `agentSystemPrompt()` 开头就是 `今天是 ${today}`，接着 overview 摘要、记忆索引，最后才是固定的 RULES | system 消息从第 ~15 个字符起每天变、每次写入后变；自动前缀缓存（DeepSeek、OpenAI ≥1024 tok、Kimi、Qwen、GLM）只能命中工具定义，system 和全部历史都要重新预填 |
| 2 | `loop.ts maskMessages()` 每轮把整段历史重新脱敏，`desensitize()` 每次生成新随机 nonce | 只要历史里出现过手机号 / 邮箱，第 N 轮发出的占位符（`[__PII_PHONE_1_<nonce>__]`）就和第 N-1 轮不同，从第一个 PII 起后面全部 miss |
| 3 | `anthropicBody()` 没有 `cache_control` | Anthropic 不缓存，每轮全价、全量预填 |
| 4 | usage 只取 input/output | 看不到缓存命中，也就没法验证 1–3 |
| 5 | 模型的 reasoning delta 在 host 里被丢弃 | 推理模型先想十几秒，前台只显示「正在思考…」，看不出模型已经在出字 |
| 6 | `evaluate_jobs` 单岗位 152 秒：先拆 posting（一次模型调用），再评估（第二次调用），多个岗位也一个一个来 | 工具超过 60s，Agent 那一轮卡住 |

## 2. 改了什么

### 2.1 提示词布局：稳定前缀在前，动态上下文在后

服务商渲染顺序是 **工具定义 → system → messages**。现在每次请求：

```
tools        按 name 排序，schema 的 key 递归排序（stableToolSpecs）      ← 跨 run 不变
system       「你是 OfferU 里的求职助手。」+ RULES + 步数预算 + 已确认的口径偏好  ← 只有用户确认/修改偏好时变
messages[0]  user：<context>今天是… / overview 摘要 / 记忆索引</context> + 本轮请求   ← 每个 run 一次，run 内不重写
messages[1…] assistant / tool …（只追加）
```

- `prompt.ts agentPromptParts()` 返回 `{ system, context }`；overview、偏好规则、记忆索引用 `Promise.all` 并行读。`agentSystemPrompt()` 保留（system + context 拼成一个字符串），给只发单条 system 的调用方。
- 规则原文一个字没改，只调了顺序：日期 / overview / 记忆索引从 system 移到首条 user 消息的 `<context>` 块；「用户的口径和偏好（必须遵守，不当作事实）」从记忆索引后面移到 system 末尾（它只随用户确认而变，算稳定部分）。仓库里没有 system prompt 的 Python 契约夹具，所以没有夹具要改；唯一改的既有断言是 `agent.test.ts` 里工具顺序（现在按名字排序，**有意修改**）。
- context 只在**新 session**（新 run）里加；`answerInput` 续跑、中断恢复沿用 session 里已有的 context，不重写已经发过的字节（代价：续跑时 context 里的日期 / overview 可能是旧的，模型需要时会调 overview）。
- 为什么放进首条 user 消息而不是第二条 system：不少 OpenAI 兼容模板（部分 Ollama / vLLM 模板、个别网关）只认开头一条 system 或要求 user/assistant 交替；合进首条 user 对所有预设都安全。Anthropic 那边 system 只有静态块，断点更干净。

### 2.2 PII 占位符稳定

- `desensitize.ts` 新增 `PiiMasker`：一个 mapping、一个 tag、计数器跨调用延续；同一个值永远是同一个占位符。带 seed（session id = runId）时 tag 是 `FNV-1a(seed)`，恢复同一个 session 时重新逐条脱敏能得到**完全相同**的占位符，不用存 mapping。`desensitize()`（一次性调用，如 split_resume）行为不变，仍是随机 nonce。
- `loop.ts SessionMasker`：每条历史消息只脱敏一次并缓存，之后每轮直接复用；run 内历史只追加，所以每轮发出去的前缀和上一轮逐字节相同。图片 data url 仍不进脱敏。
- 风险档：脱敏属于 AGENTS.md 里的高风险区（`security_redaction` 同类），合 `main` 前需要 @avabbbb 点头；本次只合进 `test`。

### 2.3 服务商缓存参数

| 服务商 | 做法 |
|---|---|
| Anthropic（含 anthropic 格式的自定义端点） | `ChatRequest.cacheKey` 存在时打 3 个 `cache_control: {type:"ephemeral"}` 断点：最后一个工具、第一个（静态）system 块、最后一条消息的最后一个块（下一轮读到这里为止的全部历史）。没有 cacheKey（一次性工具调用）时 body 和以前一样，不多付 25% 的写缓存费 |
| OpenAI（provider=openai 或 api.openai.com） | 发 `prompt_cache_key = offeru-<conversation_id>`，同一对话路由到同一缓存。放在「400 时去掉重试」的那组参数里，网关不认会自动去掉 |
| DeepSeek / Kimi / Qwen / GLM / SiliconFlow / Gemini compat / Groq / OpenRouter / Ollama | 不发额外参数，靠前缀逐字节稳定吃自动前缀缓存（Ollama/llama.cpp 的本地 KV cache 复用同理） |

### 2.4 遥测

- `LlmUsage` 增加 `cached_input_tokens`、`cache_creation_input_tokens`。`usageOf()` 解析：OpenAI / Qwen / GLM / Groq 的 `prompt_tokens_details.cached_tokens`，DeepSeek 的 `prompt_cache_hit_tokens`，Kimi 的 `cached_tokens`，Anthropic 的 `cache_read_input_tokens` / `cache_creation_input_tokens`（Anthropic 的 `input_tokens` 只是未缓存部分，`input_tokens` 现在记三者之和 = 整个 prompt）。
- loop 每轮计时：`ttft_ms`（请求交给客户端 → 第一个 delta，文本 / 推理 / 工具调用都算）、`llm_ms`（→ 流结束）、`turn_ms`（→ 本轮工具也跑完）。
- 落点：`runtime.turn_completed` 事件 payload 新增 `llm: { ttft_ms, llm_ms, turn_ms, input_tokens, output_tokens, cached_input_tokens, cache_creation_input_tokens, cache_hit_rate, estimated }`；Run 的 `final_result.llm_stats` 是汇总（`turns, input_tokens, cached_input_tokens, cache_hit_rate, first_ttft_ms, avg_ttft_ms, llm_ms, per_turn`）。

### 2.5 TTFT

- 文本 delta 一直是收到就 publish（非持久的 `message.delta`，攒够 512 字再落盘）。新增：每轮第一个 reasoning delta 发一条非持久的 `reasoning.delta`，前台进度显示「模型正在推理...」。
- host 在 run 一开始就并行构建提示词（overview + 记忆读取），和 resolveLlm、run 状态落盘同时进行；去掉了第一次 LLM 调用前一次多余的 `putSession`。
- Worker `/llm-proxy` 本来就是 `new Response(upstream.body)` 直通、请求体也是流，没有 `await res.text()`；补了一条测试证明上游第一个 SSE 块在上游结束前就能读到。浏览器侧 `createLlmFetch` 也是直接返回 Response。

### 2.6 evaluate_jobs

- 最多 3 个岗位同时在跑（`EVALUATE_CONCURRENCY`），事件顺序和写入顺序仍按岗位顺序（`start → job_start/job … → done` 不变）。
- 拆 posting 改成每个岗位自己拆，拆完立即评估（以前是全部拆完才开始评第一个）。
- **JD ≤ 3000 码点的岗位，拆 posting 和评估同时跑**：没有 posting 时评估 prompt 本来就带 JD 前 3000 码点（`jobText`），JD 全部在里面，两次调用没有数据依赖。代价：这类岗位的评估看不到 posting 里的推断项（岗位本质、证明要求的经历），这些推断仍写进 job.posting 给改简历用。JD 更长的仍是先拆后评。
- 写 store（posting、评估文档 + 分数）走一个 FIFO 锁，不会在浏览器 IndexedDB 存储里交错进别的事务。
- 没做：评估结果流式先出 verdict（JSON 里 breakdown / reasons 已经排在 markdown 前面，但 `evaluateJob` 用的是非流式 `chat()`，工具结果也要等整段才返回给模型）。

## 3. 怎么测

### 3.1 mock 基准（无网络）

```bash
cd backend-ts
npx tsx scripts/bench-agent-cache.ts                    # OpenAI 格式
npx tsx scripts/bench-agent-cache.ts --format anthropic
BENCH_FIRST_MS=800 BENCH_TOTAL_MS=6000 npx tsx scripts/bench-agent-cache.ts   # 换延迟
```

内存 store + `createAgentRuntime` + 真的 `createLlmClient`，fetch 是 mock：首个 SSE 事件 40ms 后到、整段 400ms。两个对话各一个 run（第 1 轮调 overview，第 2 轮回答），两个 run 之间新增一个岗位和一条已确认偏好。输出：

- `ttft_ms` / `stream_ms`：请求开始 → UI listener 收到第一个 `message.delta` / 上游流结束；
- `turn_prefix`：run 1 第 2 轮请求逐字节重复了第 1 轮请求（tools + system + messages）的多少；
- `run_prefix`：run 2 第 1 轮重复了 run 1 第 1 轮的多少（跨 run 能被自动前缀缓存复用的部分）。

脚本只用公开 API，可以在旧提交上直接跑做对比。

### 3.2 单测

`backend-ts/test/agent-cache.test.ts`：延迟 SSE 下第一个 reasoning / 文本 delta 在上游流结束前、在工具开始前发出；两轮请求前缀逐字节相同（含 PII 占位符、工具结果复用同一占位符）；seed 相同的 masker 占位符可复现；两个 run 的 tools + system 完全相同、日期 / overview / 记忆进了首条 user 消息；Anthropic 三个断点位置；trace 里的 `llm` 和 `llm_stats`。`llm.test.ts`：各服务商 usage 缓存字段；`prompt_cache_key` 只发 OpenAI。`research.test.ts`：evaluate 并发与事件顺序。`worker.test.ts`：relay 不缓冲。

### 3.3 真实环境怎么看

- 每轮：Run 事件里 `runtime.turn_completed.payload.llm.cache_hit_rate`、`ttft_ms`；整轮：`final_result.llm_stats`。
- DeepSeek / OpenAI / Kimi 第一次请求 `cached_input_tokens` 应接近 0（或只有工具部分），同一 run 第 2 轮起应接近上一轮的 `input_tokens`。
- 对比实验要破缓存：同一 prompt 第二次调用会命中网关缓存（见 tailor-latency.md 第 4 节），A/B 要在 system 末尾加随机串或换对话。
- OpenAI 只缓存 ≥1024 token 的前缀、Anthropic Sonnet 断点前至少 1024 token（Haiku 2048），短对话命中率为 0 是正常的。

## 4. 结果

### 4.1 mock 基准实测（2026-11-15，本机 Node 22，同一脚本）

| 指标 | 改前（origin/test acb3a52） | 改后 | 说明 |
|---|---|---|---|
| run 内第 2 轮重复第 1 轮的字节（OpenAI 格式） | 10293 / 10316（0.998） | 10343 / 10343（1.000） | 改前在用户消息里第一个 PII 占位符处断开（nonce 变了）。基准里 PII 在最后一条消息，所以比例看着高；真实对话里 PII 出现在第一条用户消息或第一次 get 结果时，**之后的全部历史**都会 miss |
| 跨 run 第 1 轮重复的字节（OpenAI 格式） | 7902 / 10316（0.766，只有工具定义） | 9957 / 10343（0.963，tools + system 全部） | 剩下的不同只在首条 user 消息（context + 请求） |
| 同上（Anthropic 格式） | 7614 / 10052（0.757） | 9692 / 10104（0.959） | 改前 Anthropic 根本不发断点，比例只是「理论可复用」 |
| TTFT（mock 首包 40ms） | 41–42 ms | 41–42 ms | mock 下提示词构建只有几毫秒，TTFT 由上游首包决定；改动不增加首字延迟。Anthropic 格式 132–163ms 是 mock 的首个事件为 message_start（无 delta） |

### 4.2 估算（未在真实网关上测，按服务商公开行为）

- **run 内第 2 轮起**：缓存命中 ≈ 上一轮的全部 prompt。典型 6 轮工具调用、工具定义约 8k 字符 + system 约 2.5k 字符 + 历史逐轮增长时，整轮 prompt token 的命中率从「只有工具那段」（且一旦出现 PII 就为 0）提到约 70–85%。DeepSeek 缓存命中按约 1/10 价格计，Anthropic 读缓存 0.1×、写 1.25×，OpenAI 0.5×/0.25×（视模型）。
- **TTFT**：预填是 TTFT 的主要部分之一；服务商对命中部分跳过预填，长上下文时第 2 轮起首字延迟预计下降明显（Anthropic 官方说法长 prompt 最多约 85%），短上下文收益小。需要在真实网关用 3.3 的方法验证。
- **evaluate_jobs**：单岗位、JD ≤3000 码点时由「拆 posting + 评估」两次串行调用变为并行，预计 152s → 约等于两者中较慢的那次（评估输出更长，估 80–100s）。3 个岗位时由 3×(拆+评) 变为约 3 次拆（串行，写锁）+ 最后一个的评估，预计省 50% 左右。未实测。

## 5. 没做 / 后续

- 评估 verdict 流式先出（见 2.6）。
- 续跑时 context 不刷新（为缓存有意为之），如果 dogfood 发现模型用了旧 overview，再考虑追加一条「数据已更新」的短消息而不是重写。
- Anthropic 第 4 个断点（倒数第二轮）未用；对话很长、单轮新增内容超过 20 个块时可能回看不到上一个断点，届时再加。
- 真实网关上的 TTFT / 命中率实测（按 3.3），结果补到本文件第 4 节，标明时间、模型、网关。
