# 云同步（S3 / R2，端到端加密）

OfferU 的数据可以同步到**用户自己的** S3 兼容存储桶（Cloudflare R2、AWS S3、MinIO 等）。上传前在本机加密，桶里只有密文；同一个引擎（`packages/sync`，包名 `@offeru/sync`）跑在浏览器、本机 companion（backend-ts）和 Worker 里。设计参考 SiYuan 的 dejavu（objects / indexes / refs）和 Obsidian / siyuan-unlock 的 S3 同步，代码是重新实现的，没有拷贝 GPL / AGPL 代码。

- 引擎：`packages/sync/src`（只用 `fetch` + WebCrypto + `CompressionStream`，没有 `node:*`）
- companion：`backend-ts/src/sync.ts`（配置、状态文件）+ `backend-ts/src/routes/sync.ts`（HTTP）
- 前端：设置 › 数据 › 云同步（`frontend/src/components/settings/SyncSettingsPanel.tsx`，`frontend/src/lib/syncClient.ts`）

## 怎么用

1. 建一个存储桶和只能读写这个桶的密钥（R2：*R2 › Manage API tokens › Object Read & Write*，限定到该桶）。
2. 设置 › 数据 › 云同步：填 Endpoint、存储桶、区域（R2 填 `auto`）、Access Key、Secret、前缀（默认 `offeru`）、同步口令（≥ 8 位），点「保存并连接」。
   - 空桶：初始化同步配置。已有数据的桶：校验口令，口令不对立刻报错，不下载也不写入任何东西。
3. 点「立即同步」。其他设备填同一个桶、同一个前缀、同一个口令即可。

**口令丢了数据就解不开**，OfferU 和存储服务商都找不回。

HTTP（backend-ts）：

```
GET  /api/sync/status
POST /api/sync/configure   { endpoint, bucket, region, accessKeyId, secretAccessKey, prefix, pathStyle, passphrase }
                           secretAccessKey / passphrase / accessKeyId 留空 = 沿用已保存的；{ "clear": true } = 断开
POST /api/sync/now         -> { result: { pulled, pushed, uploaded, conflicts, resurrected, ... }, status }
```

错误码：`sync_config` / `sync_passphrase` 400，`sync_auth` 401，`sync_locked` / `sync_conflict` 409，`sync_format` / `sync_decrypt` 422，`sync_network` / `sync_http` 502。后端不支持同步时（例如没有这些路由的旧版本），设置页会提示「当前后端还不支持同步」。

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

第一次把一台**已有数据**的设备连到已有的桶时：内容完全相同的记录（类型 + 数据 + 创建时间）直接认领远端 uid，不会重复；两边各有一份档案（profile）时合并成一份，冲突字段照上表处理。其余记录按并集合并。

## 威胁模型

保护：存储服务商、拿到桶读权限的人、网络中间人，看不到任何记录内容、字段名、岗位/公司名、条数以外的结构。

仍然暴露：对象数量和大小（近似反映记录条数和长度，压缩后）、同步时间、设备何时活跃、KDF 参数和 repo_id。

拿到桶**写**权限的人：不能伪造或篡改内容（AEAD + 内容 id 校验会失败），但可以删对象让同步失败、或把 `refs/latest` 换成一个旧的合法快照（**回滚攻击目前检测不到**，见下面「未完成」）。

口令强度：拿到 `offeru-sync.json` 就可以离线猜口令（每次猜测 60 万次 PBKDF2）。用长口令；界面要求至少 8 位。

本机：companion 把 Secret 和口令明文存在数据目录的 `sync.json`（权限 600，Windows 依赖目录 ACL），和 SQLite 数据库本身同一信任级别；`sync-state.json` 存同步 base（含记录内容）。展示站（浏览器模式）只把非机密设置存 IndexedDB，Secret 和口令只在内存里，刷新后要重填。

## 存储桶 CORS（只有浏览器里同步才需要）

companion（Node）直接访问存储桶，不需要 CORS。在浏览器里（展示站或桌面版 WebView 直连）同步需要允许这些：

- 方法：`GET`、`PUT`、`HEAD`、`DELETE`
- 请求头：`authorization`、`content-type`、`x-amz-date`、`x-amz-content-sha256`、`x-amz-security-token`、`if-match`、`if-none-match`
- 暴露响应头：`ETag`（不暴露的话条件写拿不到 ETag，同步会一直冲突）
- 来源：你实际打开 OfferU 的地址，例如 `http://localhost:7410`、`http://127.0.0.1:7410`、`https://offeru.avabbbb.com`、`tauri://localhost`、`http://tauri.localhost`

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
cd backend-ts && npm test                                            # 真实 HTTP：configure/now/status，浏览器引擎 <-> companion 共用一个桶
```

`MemoryS3`（`packages/sync/src/memory-s3.ts`）是测试用的内存 S3：解析 path-style URL，校验签名头和 `x-amz-content-sha256`，实现 ETag 和条件 PUT，可以注入请求钩子模拟竞态。签名器另有 AWS 官方 SigV4 示例做向量测试。开发时也用 moto（`moto_server`）跑过真实 HTTP 的条件写和两设备同步。

## 未完成

- 没有垃圾回收：旧索引和不再引用的块不会删；墓碑永久保留。
- 没有自动 / 定时同步，只有「立即同步」。
- 回滚检测：`refs/latest` 被换成旧快照时不会发现（可以在本机记下见过的最新索引链来检测）。
- 只同步 records（5 种 type）；上传文件、附件目录、change 历史本身不同步。
- companion 的 Secret / 口令存在文件里，没有接系统钥匙串。
- 没有快照历史浏览 / 回退 UI（索引里有 `parent`，数据结构已经支持）。
- 没有在真实 R2 / AWS 账号上跑过，只验证了签名向量、内存 mock 和 moto。
