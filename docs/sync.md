# 云同步（S3 / R2，端到端加密）

OfferU 的数据可以同步到**用户自己的** S3 兼容存储桶（Cloudflare R2、AWS S3、MinIO 等）。上传前在本机加密，桶里只有密文；同一个引擎（`packages/sync`，包名 `@offeru/sync`）跑在浏览器、本机 companion（backend-ts）和 Worker 里。设计参考 SiYuan 的 dejavu（objects / indexes / refs）和 Obsidian / siyuan-unlock 的 S3 同步，代码是重新实现的，没有拷贝 GPL / AGPL 代码。

**零服务器成本**：OfferU 的 Worker 不存任何东西（没有 D1 / KV / R2），数据只在用户设备和用户自己的桶里。

- 引擎：`packages/sync/src`（只用 `fetch` + WebCrypto + `CompressionStream`，没有 `node:*`）：`engine.ts` 同步，`diagnose.ts` 测试连接，`bundle.ts` 加密备份包，`conflicts.ts` 冲突视图
- 控制器：`backend-ts/src/syncService.ts`（`SyncService`，运行时无关）。companion 用 `backend-ts/src/sync.ts`（`sync.json` / `sync-state.json`），网页版用 `frontend/src/lib/local/sync.ts`（IndexedDB）；HTTP 在 `backend-ts/src/routes/sync.ts`
- 前端：设置 › 数据 › 云同步（`SyncSettingsPanel.tsx` + `SyncWizard.tsx` + `SyncBackupCard.tsx`，纯逻辑 `frontend/src/lib/syncWizard.ts`，调用 `frontend/src/lib/syncClient.ts`）

三种运行形态都能同步：

| 形态 | 谁访问存储桶 | 设置存哪 | Secret / 口令 |
| --- | --- | --- | --- |
| 桌面版 / 本机后端（companion） | Node，不需要 CORS | 数据目录 `sync.json`（600） | 明文在 `sync.json`，和 SQLite 同一信任级别 |
| 网页版（`local-web`，页面内后端） | 浏览器直连，需要 CORS | IndexedDB `offeru-local-sync` | 默认「记住」：用本浏览器不可导出的设备密钥（`demo/keyVault`，和模型 API Key 同一把）AES-GCM 加密后存 IndexedDB；关掉「记住」= 只在内存里，刷新后重填 |
| 展示站（showcase） | 浏览器直连 | IndexedDB `offeru-demo-sync` | 同网页版；同步的是演示数据 |

为什么不用口令派生的密钥加密 Secret：口令本身就是要保护的秘密之一，用它加密就得每次打开都输口令，这正是「不记住」选项；设备密钥防的是磁盘镜像 / 别的浏览器配置读 IndexedDB，同源脚本仍能用它（和模型 Key 一样的取舍）。

## 怎么用

设置 › 数据 › 云同步，未设置时是一个五步向导，每步只露出这一步要填的东西：

1. **服务商**：Cloudflare R2 / AWS S3 / MinIO / 其他 S3 兼容。选了自动填 Endpoint 模板、区域（R2 = `auto`）、路径风格（R2 / MinIO 开，AWS 关）。已经在别的设备上设置过：这里粘贴「连接码」，存储桶信息全部填好并跳到第 3 步。
2. **存储桶**：R2 填账户 ID（32 位）自动生成 `https://<账户ID>.r2.cloudflarestorage.com`，也可以直接粘控制台里的「S3 API」地址（会顺带取出桶名、保留 `.eu` 管辖区）。前缀和路径风格收在「高级」里。
3. **密钥**：按服务商给出建只读写这个桶的密钥的做法。
4. **测试连接**（`POST /api/sync/test`，不保存任何东西）：分开报告每一层，失败的那层给出修法——

   | 检查 | 失败时说什么 |
   | --- | --- |
   | 网络 / DNS | 域名解析失败（`ENOTFOUND`）/ 连不上 Endpoint |
   | CORS（只在浏览器里） | 浏览器拦下了请求（先做一次 `no-cors` 探测：能到达 = CORS，到不了 = 网络）；写入被拦（PUT / DELETE / if-match 没放行）；读不到 ETag（没写 `ExposeHeaders`）。**界面直接给出要粘的 CORS JSON（来源 = 当前页面地址）和复制按钮，并说明粘到哪里** |
   | 本机时间 | `RequestTimeTooSkewed`，或响应 `Date` 头和本机差超过 15 分钟（SigV4 会拒） |
   | 密钥 | `InvalidAccessKeyId` / `SignatureDoesNotMatch` / `AccessDenied` 各一句话 |
   | 存储桶 | `NoSuchBucket`；区域不对（`AuthorizationHeaderMalformed` / 301） |
   | 写入权限 | 只读密钥；能写但没有 ETag |
   | 条件写 | 服务忽略 `If-None-Match`：警告（多设备同时同步可能互相覆盖），不阻止 |
   | 同步数据 | 空前缀（将初始化）/ 已有 OfferU 数据（填了口令就校验口令）/ 前缀下不是 OfferU 数据 |

   写入探测会 PUT 两次再 DELETE 一个 `<前缀>/diagnostics/<随机>`，不碰其他键。
5. **同步口令**：空桶要输两遍；已有数据只输一遍（口令不对立刻报错，不下载也不写入）。浏览器里多一个「在这个浏览器记住」开关。点「保存并连接」。

已连接后：「立即同步」（主按钮）带进度条（阶段 + 已下载 / 上传的对象数和字节，跳过的已在桶里的块单独计），「存储桶设置」重新走向导（Secret / 口令留空 = 沿用），「换设备接入」给出连接码，有冲突时列在下面。

错误一律按错误码给出中文标题 + 修法（`frontend/src/lib/syncWizard.ts` 的 `describeSyncError`），原始说明放第二行。

**口令丢了数据就解不开**，OfferU 和存储服务商都找不回。

### 换设备接入（连接码）

`offeru-sync:` + base64url(JSON `{ v, p: 服务商, e: Endpoint, b: 存储桶, r: 区域, x: 前缀, s: 路径风格 }`)。**只有找到存储桶需要的非机密信息，永远不含 Access Key、Secret、口令**（有测试保证）。新设备在向导第一步粘贴，然后自己输入密钥和同步口令。还没有二维码（需要引入 QR 库，未做）。

### 加密备份包（导出 / 导入，离线）

「加密备份包」卡片：导出全部记录成一个 `.offeru` 文件，导入到任何一台 OfferU（网页版 ⇄ 桌面版），**不需要存储桶，不联网**。

- 格式：`"OUBK" | 版本 u8 | 条数 u32 | 条数 × (键长 u16 | 键 | 长度 u32 | 内容)`，内容就是桶里那些对象原样（`offeru-sync.json` + `refs/latest` + `indexes/*` + `objects/*`），**和云同步完全同一种 E2EE 格式**，用导出时设置的备份口令（可以和同步口令相同）加密。
- 导出 = 把本机记录同步进一个内存里的空仓库再序列化，本机数据不动。导入 = 把文件里的仓库同步进本机：普通三方合并（base 为空），完全相同的记录认出来、不重复，什么都不删，每条写一行可撤销的 change（actor「导入备份」）。口令不对 / 文件截断在写任何东西之前就失败。
- 和云同步一起用也不会重复：本机还没同步过的新记录，如果和远端一条本机没见过的记录内容完全相同（类型 + 数据 + 创建时间），会认领远端的 uid（以前只在第一次同步时这样做）。

### 冲突视图

真冲突仍然先按 `updated_at` 自动决定，输的值存成一篇冲突笔记（`sync_conflict` 里现在多了 `loser`、`device` 和冲突字段的原值 `values`）。设置页列出所有冲突：记录名、每个冲突字段「这台设备 / 另一台设备」的值、当前采用哪边；「保留这台设备的」/「用另一台设备的」：

- 选当前采用的那边 = 只删冲突笔记；
- 选另一边 = 把那几个字段写回记录（一条可撤销的 change）再删笔记。笔记是普通记录，处理结果会同步到所有设备。旧格式的冲突笔记（没有 `values`）只能保留当前版本。

### 进度与断点续传

`SyncEngine({ onProgress })` 报告 `{ phase: connect|lock|download|merge|upload|commit|done, attempt, download: {done,total,bytes}, upload: {done,total,bytes,skipped} }`；`SyncService` 在同步进行中把最新进度放进 `GET /api/sync/status` 的 `progress`，界面每 0.5 秒读一次。对象传输默认 4 路并发。

块是内容寻址的，所以天然可续传：上传时每完成 32 个（以及出错时）把已确认在桶里的块 id 存进本机状态 `uploaded`；下次同步这些块连 HEAD 都不发直接跳过，其余先 HEAD，已存在的计为 `skipped`。提交成功后清空。

HTTP（backend-ts，companion 和网页版页面内后端同一套）：

```
GET  /api/sync/status                  -> { configured, config{provider,endpoint,bucket,region,prefix,pathStyle,accessKeyId(打码)}, secrets: stored|session|missing,
                                            needs_secret, syncing, progress, device, last_sync_at, pending, last_result, last_error }
POST /api/sync/configure               { provider, endpoint, bucket, region, accessKeyId, secretAccessKey, prefix, pathStyle, passphrase, remember }
                                       secretAccessKey / passphrase / accessKeyId 留空 = 沿用已保存的；{ "clear": true } = 断开（桶里的数据不删）
POST /api/sync/test                    同 configure 的字段，不保存 -> { ok, checks:[{id,status:ok|fail|warn|skip,detail,code?}], repo, passphrase, skewMs }
POST /api/sync/now                     -> { result: { pulled, pushed, uploaded{objects,bytes}, downloaded{objects,bytes}, skipped, conflicts, resurrected, ... }, status }
GET  /api/sync/conflicts               -> { conflicts: [{ id, title, at, record{uid,type,id,label}, fields, mine, theirs, current, resolvable }] }
POST /api/sync/conflicts/:id/resolve   { keep: "mine" | "theirs" } -> { applied, conflicts }
POST /api/sync/export                  { passphrase } -> application/vnd.offeru.backup，Content-Disposition: offeru-backup-YYYY-MM-DD.offeru，X-OfferU-Records
POST /api/sync/import                  multipart: file, passphrase -> { result }（上限 256 MB）
```

错误码：`sync_config` / `sync_passphrase` 400，`sync_auth` 401，`sync_locked` / `sync_conflict` 409，`sync_format` / `sync_decrypt` 422，`sync_network` / `sync_http` 502。Python 后端（8766）没有这些路由，设置页会提示「当前后端还不支持同步」。

## 远端格式（v1）

```
<prefix>/offeru-sync.json      明文：{ format:"offeru-sync", version:1, repo_id, kdf:{alg,iterations,salt}, check, created_at }
<prefix>/objects/ab/cdef…      密文块，id = HMAC-SHA256(macKey, 明文)
<prefix>/indexes/<id>          密文快照索引，id = HMAC(索引的规范 JSON)
<prefix>/refs/latest           密文 { index, device, at }，只用 If-Match / If-None-Match 条件写
<prefix>/lock                  密文 { device, token, expires_at }，If-None-Match:* 创建
```

- **记录**：每条 record 序列化为规范 JSON（键排序、去掉 null）：`{ uid, type, job, data, created_at, updated_at }`。`uid` 是全局随机 id；本地整数 id 每台设备不同，映射保存在本机状态里。`job` 是关联岗位的 uid（`job_id` 在每台设备上重新映射）。
- **分块**：小记录一块；大记录（简历正文等）用内容定义分块（gear 滚动哈希，256 KiB / 1 MiB / 4 MiB），改动末尾只换最后一两块。
- **快照索引**：`{ v:1, parent, device, created_at, records: { uid: { c:[块 id…] } | { t: 删除时间 } } }`。删除是墓碑，不是缺席。
- **增量上传**：新快照里的块，凡是远端最新快照或本机 base 已引用的直接跳过，其余先 HEAD，不存在才 PUT。没有任何变化时不写索引、不动 `refs/latest`。
- **加密 blob**：`"OUS1" | iv(12) | AES-256-GCM(flag | payload)`，flag 1 = deflate-raw 压缩。AAD 是对象的逻辑名（如 `objects/ab/cd…`），挪到别的键会解密失败；块解密后再校验一次 HMAC id。

## 加密

```
passphrase ──PBKDF2-SHA256(salt 16B, 600 000 次)──> master(256 bit)
master ──HKDF-SHA256 "offeru-sync/v1/enc"──> AES-256-GCM 密钥（对象、索引、ref、锁）
master ──HKDF-SHA256 "offeru-sync/v1/mac"──> HMAC-SHA256 密钥（内容 id）
```

`check` 是用加密密钥封装的固定文本：口令不对时在第一步就失败。没有用 Argon2：WebCrypto 没有，引入纯 JS 实现在浏览器里又慢又大；PBKDF2 次数随 `kdf.iterations` 存在配置里，以后可以升级（格式里有 `alg` 字段）。

## 一次同步做什么

1. 读 `offeru-sync.json`，派生密钥，校验口令；拿锁（`lock`，默认 TTL 2 分钟，过期的锁用 If-Match 接管，所以两台设备抢同一把过期锁只有一台成功）。
2. 读 `refs/latest` → 索引；只下载块 id 和本机 base 不同的记录。
3. 在**一个存储事务里**：读本地全部记录 → 逐条三方合并（base = 本机上次同步的快照）→ 把和本地不同的结果写回，每条写一行 change（actor「同步」），可以在「最近改动」里撤销。
4. 生成新索引，上传缺的块，写索引，用 `If-Match: <旧 ETag>`（首次 `If-None-Match: *`）更新 `refs/latest`。条件写失败 = 别人先提交了：重新读、重新合并、再试（默认 4 次）。
5. 释放锁，保存本机状态（新 base、uid 映射）。

### 合并规则（每条记录）

| 本地 | 远端 | 结果 |
| --- | --- | --- |
| 没变 | 改了 / 删了 | 用远端 |
| 改了 / 删了 | 没变 | 用本地 |
| 改了 | 改了 | **按字段合并**：只有一边改的字段直接采用；两边都改成不同值的字段 = 真冲突，`updated_at` 晚的赢（相同则按内容确定性地选），**输的整条版本另存为一篇文档**（`type=doc, kind=note`，标题「同步冲突：…未采用的版本」，`sync_conflict` 字段记录原记录 uid 和冲突字段，挂在同一个岗位下） |
| 改了 | 删了（或反过来） | **修改赢**，记录保留；删除那台设备下次同步会把它恢复回来（尽量用原来的 id） |
| 删了 | 删了 | 墓碑 |

本机还没有 uid 的记录（第一次连接时的全部记录，之后是上次同步后新建或导入的）如果和远端一条本机没见过的记录内容完全相同（类型 + 数据 + 创建时间），直接认领远端 uid，不会重复。第一次把一台**已有数据**的设备连到已有的桶时，两边各有一份档案（profile）还会合并成一份，冲突字段照上表处理。其余记录按并集合并。

## 威胁模型

保护：存储服务商、拿到桶读权限的人、网络中间人，看不到任何记录内容、字段名、岗位/公司名、条数以外的结构。

仍然暴露：对象数量和大小（近似反映记录条数和长度，压缩后）、同步时间、设备何时活跃、KDF 参数和 repo_id。

拿到桶**写**权限的人：不能伪造或篡改内容（AEAD + 内容 id 校验会失败），但可以删对象让同步失败、或把 `refs/latest` 换成一个旧的合法快照（**回滚攻击目前检测不到**，见下面「未完成」）。

口令强度：拿到 `offeru-sync.json` 就可以离线猜口令（每次猜测 60 万次 PBKDF2）。用长口令；界面要求至少 8 位。

本机：companion 把 Secret 和口令明文存在数据目录的 `sync.json`（权限 600，Windows 依赖目录 ACL），和 SQLite 数据库本身同一信任级别；`sync-state.json` 存同步 base（含记录内容）。网页版 / 展示站见上面的表：默认用设备密钥加密存 IndexedDB，可选只留在会话里；同步 base 存 IndexedDB（和记录本身同一信任级别）。

加密备份包：和桶里的对象同等安全（只暴露对象数量 / 大小、KDF 参数）；拿到文件就能离线猜备份口令，所以同样要用长口令。连接码不含任何秘密，但会暴露 Endpoint / 桶名 / 前缀，别公开贴。

## 存储桶 CORS（只有浏览器里同步才需要）

companion（Node）直接访问存储桶，不需要 CORS。在浏览器里（展示站或桌面版 WebView 直连）同步需要允许这些：

- 方法：`GET`、`PUT`、`HEAD`、`DELETE`
- 请求头：`authorization`、`content-type`、`x-amz-date`、`x-amz-content-sha256`、`x-amz-security-token`、`if-match`、`if-none-match`
- 暴露响应头：`ETag`（不暴露的话条件写拿不到 ETag，同步会一直冲突）
- 来源：你实际打开 OfferU 的地址（向导「测试连接」失败时给出的 JSON 已经填好当前地址），例如 `http://localhost:7410`、`http://127.0.0.1:7410`、`https://offeru.avabbbb.com`、`tauri://localhost`、`http://tauri.localhost`

### Cloudflare R2

R2 › 存储桶 › Settings › CORS Policy › Add CORS policy：

```json
[
  {
    "AllowedOrigins": ["http://localhost:7410", "http://127.0.0.1:7410", "https://offeru.avabbbb.com", "tauri://localhost", "http://tauri.localhost"],
    "AllowedMethods": ["GET", "PUT", "HEAD", "DELETE"],
    "AllowedHeaders": ["authorization", "content-type", "x-amz-date", "x-amz-content-sha256", "x-amz-security-token", "if-match", "if-none-match"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Endpoint 用 `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`，区域 `auto`，路径风格打开。

### AWS S3

控制台：存储桶 › Permissions › Cross-origin resource sharing (CORS)，填上面同一段 JSON。或者：

```bash
aws s3api put-bucket-cors --bucket <bucket> --cors-configuration '{
  "CORSRules": [{
    "AllowedOrigins": ["http://localhost:7410", "https://offeru.avabbbb.com"],
    "AllowedMethods": ["GET", "PUT", "HEAD", "DELETE"],
    "AllowedHeaders": ["authorization", "content-type", "x-amz-date", "x-amz-content-sha256", "x-amz-security-token", "if-match", "if-none-match"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }]
}'
```

AWS 留空 Endpoint、填真实区域，默认用虚拟主机风格（`<bucket>.s3.<region>.amazonaws.com`）。IAM 策略需要该桶前缀下的 `s3:GetObject`、`s3:PutObject`、`s3:DeleteObject`，并**建议给 `s3:ListBucket`（限定前缀）**：没有它时 AWS 对不存在的对象回 403 而不是 404，第一次初始化空桶读配置时会被当成权限错误（引擎只对 HEAD 把 403 当作「不存在」）。

### MinIO / 其他

MinIO：`mc anonymous` 不用开；CORS 用 `mc admin config set <alias> api cors_allow_origin="http://localhost:7410"`，Endpoint 例如 `http://127.0.0.1:9000`，区域随意（常用 `us-east-1`），路径风格打开。

**条件写是必需的**：服务端必须支持 PUT 的 `If-None-Match: *` 和 `If-Match`（R2、AWS S3（2024 年起）、MinIO 都支持）。不支持的服务会忽略这两个头，锁和 `refs/latest` 的比较交换都会失效，多设备同时同步可能互相覆盖。

## 测试

```bash
cd packages/sync && npm install && npm test && npm run typecheck    # 引擎：加密、错口令、增量计数、分块、并发合并、删改冲突、锁、CAS 重试、首次认领、撤销
                                                                     # ux.test.ts：进度计数、中断后续传（不重传不重 HEAD）、备份导出/导入往返、
                                                                     # 测试连接每一层（DNS / CORS / 时间 / 密钥 / 桶 / 只读 / 无条件写 / ETag）、冲突视图
cd backend-ts && npm test                                            # 真实 HTTP：configure/now/status/test/export/import/conflicts，浏览器引擎 <-> companion 共用一个桶
cd frontend && npx vitest run src/lib/syncWizard.test.ts src/components/settings/SyncWizard.test.tsx src/lib/local/backend.test.ts
                                                                     # 向导状态、连接码不含秘密、CORS JSON、错误码说明；网页版页面内 /api/sync 端到端
```

`MemoryS3`（`packages/sync/src/memory-s3.ts`）是测试用的内存 S3：解析 path-style URL，校验签名头和 `x-amz-content-sha256`，实现 ETag 和条件 PUT，可以注入请求钩子模拟竞态，可以模拟时钟偏差（`now`）、只读密钥（`readOnly`）和不支持条件写的服务（`conditionalWrites = false`）。签名器另有 AWS 官方 SigV4 示例做向量测试。开发时也用 moto（`moto_server`）跑过真实 HTTP 的条件写和两设备同步。

## 未完成

- 没有垃圾回收：旧索引和不再引用的块不会删；墓碑永久保留。
- 没有自动 / 定时同步，只有「立即同步」。
- 连接码没有二维码（要引入 QR 库）。
- 测试连接只在发起请求的一端判断 CORS；桌面版 WebView 直连（不经 companion）还没接。
- 备份包导入是合并，不是「整库替换」；要干净恢复请在新设备 / 清空后导入。
- 回滚检测：`refs/latest` 被换成旧快照时不会发现（可以在本机记下见过的最新索引链来检测）。
- 只同步 records（5 种 type）；上传文件、附件目录、change 历史本身不同步。
- companion 的 Secret / 口令存在文件里，没有接系统钥匙串。
- 没有快照历史浏览 / 回退 UI（索引里有 `parent`，数据结构已经支持）。
- 没有在真实 R2 / AWS 账号上跑过，只验证了签名向量、内存 mock 和 moto。
