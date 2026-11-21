# S3 数据同步（分支 ts/sync）

用户自带 S3 兼容存储（Cloudflare R2、AWS S3、MinIO、阿里云 OSS / 腾讯 COS 的 S3 兼容模式），零服务端。
参考 SiYuan dejavu（内容寻址对象 + 快照 + refs）、siyuan-unlock 的 S3 同步、Obsidian Remotely Save（端到端加密、冲突副本）。

## 代码
- `packages/core/src/sync/`（纯 TS，无 `node:*`，浏览器 / Worker / Node 同一份）
  - `sigv4.ts` 纯 WebCrypto 的 AWS SigV4（用 AWS 官方 GET Object 示例签名做测试）
  - `s3.ts` 最小 S3 客户端：GET / PUT（If-Match / If-None-Match，412 → `PreconditionFailed`）/ DELETE / ListObjectsV2，fetch 注入
  - `crypto.ts` 口令 → PBKDF2-SHA256（默认 310k 次，随机盐存 `repo.json`）→ AES-256-GCM 密钥 + HMAC-SHA256 密钥；`repo.json` 里存加密的校验串，用来区分“口令不对”和“数据坏了”
  - `merge.ts` 记录 / 文件级三方合并（纯函数）
  - `engine.ts` 一次同步；`service.ts` 配置（掩码视图）、状态、单飞运行、定时 / 启动时同步
- `backend-ts/src/routes/sync.ts` `/api/sync/{config,status,run}`；`backend-ts/src/sync-node.ts` 伴侣端配置文件（0600）与 `<data>/files` 目录文件仓
- `frontend/src/components/settings/DataSyncCard.tsx` + `frontend/src/lib/sync.ts`：设置 → 数据 → 数据同步

## 远端格式（`<prefix>` 下，默认 `offeru/`）
| 键 | 内容 |
| --- | --- |
| `repo.json` | 明文 JSON：格式版本、KDF 参数与盐、加密校验串（只用 If-None-Match 建一次） |
| `objects/<2位>/<id>` | 不可变对象，AES-GCM 加密：记录负载、文件分块（4 MiB）、文件清单。`id = HMAC(内容)`，相同内容跨设备去重，桶里看不到明文哈希 |
| `snapshots/<UTC时间>-<设备>.json` | 加密的快照：`uid → {对象 id, updated_at, 类型}` 或墓碑；`路径 → {清单 id, mtime, 大小}` 或墓碑；parent |
| `refs/latest` | `{"snapshot": "<名字>"}`；只用 If-Match（ETag）/ If-None-Match 写 |

记录负载 = `{type, data, job: <岗位 uid>, created_at, updated_at}`（键排序后的 JSON）。不同设备的本地自增 id 不同，所以跨设备身份用随机 uid；`records.job_id` 以岗位 uid 传输，落地时换回本地 id。首次连接时，内容完全相同的本地记录直接认领远端 uid，不重复。

## 一次同步
1. 读 / 建 `repo.json`，派生密钥（口令错 → 403 `forbidden`）。
2. 读 `refs/latest`（带 ETag）和它指向的快照（与本地基准同名时不下载）。
3. 扫本地：每条记录算负载与对象 id；本地删除（基准里有、本地没了）记墓碑；文件按 (size, mtime) 缓存哈希。
4. 三方合并（基准 = 上次两边一致的快照）：单边改动直接取；两边都改 → `updated_at` 新者胜（同秒按对象 id 定序，两端结果一致），输的一版存为**冲突副本**（新记录，标题加「（同步冲突副本）」，`data.sync_conflict={of, at, device}`；文件为 `名 (冲突 设备 日期).扩展名`）。删 vs 改 → 改的胜。档案（单例）不出副本：远端胜时覆盖写进改动记录可撤销；本地胜时把远端版本作为 before 记一条改动，撤销即换回。
5. 远端改动在**一个 store 事务**里写入本地，每条都写 change log（actor「同步」），可撤销；撤销一次同步删除后，下次同步会把记录复活到其他设备。
6. 上传远端没有的对象。进度存本地（`uploaded`），中断后续传只补没传完的（信任期 = GC 宽限期的一半，避免引用到已被 GC 的对象）。
7. 写新快照（If-None-Match），再以 If-Match 旧 ETag 移动 `refs/latest`。412 = 别的设备先写了 → 以刚合并进来的远端为新基准重新合并（最多 5 次，否则 409 `conflict`）。

## 保留与 GC
默认保留最新 30 个快照 + 14 天内的全部 + `refs/latest` 指向的；墓碑 180 天后从新快照里去掉；每 7 天（或 `POST /api/sync/run {"gc": true}`）删多余快照，再删不被保留快照引用、且超过 24 小时宽限期的对象（宽限期防止删掉别的设备正在上传、还没提交的对象）。

## 接口
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/sync/config` | 掩码视图：`configured, endpoint, region, bucket, prefix, force_path_style, access_key_id(掩码), has_secret, has_passphrase, device_name, auto_minutes, sync_on_start` |
| PUT/POST | `/api/sync/config` | 合并保存；`secret_access_key` / `passphrase` 为空 = 保留已存的；口令 ≥ 8 位 |
| DELETE | `/api/sync/config` | 删本机凭证与口令（远端不动） |
| GET | `/api/sync/status` | `configured, running, device_id, last_run_at, last_ok_at, last_error, last_result, auto_minutes` |
| POST | `/api/sync/run` | `{"gc"?: true}` → `{ok, at, snapshot, pulled, pushed, uploaded_objects, conflicts[], attempts, gc?}` |

Python 没有这些接口（旧 WebDAV 只是前端 demo 的整包快照），无契约对拍；行为由 `backend-ts/test/sync.test.ts` 约束。无状态 Worker 没有 `deps.sync`，统一 501，凭证永远到不了 Worker。

## 存储接口（与 ts/local-runtime 协调）
`CoreStore` 新增**可选**方法（不实现的 store 照常编译，sync 会报 `unsupported`）：
- `allRecords?(): Promise<StoredRecord[]>` —— 枚举全部记录；缺省时 sync 按类型调 `all(type)`。
- `getLocalMeta?(key) / setLocalMeta?(key, value|null)` —— 设备本地 KV，不同步、不导出。SQLite：新表 `sync_state(key TEXT PRIMARY KEY, value TEXT NOT NULL)`（`CREATE TABLE IF NOT EXISTS`，Python 不读它，旧库打开即补表）。IDB：建议一个 `meta` object store。
- sync 依赖的既有语义：`put(..., {now})` 把 `now` **原样**写进 `updated_at`；`put` 不带 id 时分配新 id；`replace: true` 整体替换 data；顶层 `null` 字段被丢弃。

文件：`SyncFileStore { list(); read(path); write(path, bytes, mtime?); remove(path) }`，路径用 `/`。伴侣端是 `<data>/files`（`OFFERU_FILES_DIR`，与 ts/resume 的 `filesDirFor` 同一目录）；ts/resume 的 `FileStore`（read/write）补上 `list/remove` 即可同时满足两者。浏览器端由 local-runtime 用 OPFS/IDB 实现。

## 浏览器直连的 CORS
设置页「浏览器直连需要的桶 CORS 设置」里按当前网址生成。R2（桶 → Settings → CORS Policy）：
```json
[{"AllowedOrigins":["https://你的网址"],"AllowedMethods":["GET","PUT","DELETE","HEAD"],
  "AllowedHeaders":["authorization","content-type","x-amz-date","x-amz-content-sha256","x-amz-security-token","if-match","if-none-match"],
  "ExposeHeaders":["ETag"],"MaxAgeSeconds":3600}]
```
AWS S3：同一条规则包成 `{"CORSRules":[…]}`，`aws s3api put-bucket-cors --bucket 桶名 --cors-configuration file://cors.json`。

## 已知限制
- 条件写依赖服务端支持 If-Match / If-None-Match（R2、MinIO、AWS S3 2024-11 起都支持）。不支持的服务会忽略这两个头：两台设备恰好同时提交时后写的会覆盖 ref，先写那台的那次改动会在它下次同步时被当成“远端回退”覆盖掉（覆盖记在改动记录里，actor「同步」，可撤销找回）。这类服务建议只开手动同步。
- `updated_at` 是无时区、秒精度的本地时间（沿用 Python）；冲突胜负按“写入设备的本地时间”解释，跨时区设备同秒内的胜负可能不符合直觉，但两端结果一致、输的一版总有副本。
- 只重映射 `records.job_id`；data 里其他按 id 引用别的记录的字段（目前只在工具返回值里，如 `doc_id`）不重映射。
- 不压缩（WebCrypto 外不引依赖）；换口令需要换前缀重建仓库。
- 浏览器端的 `SyncService` 需要 local-runtime 提供带 `getLocalMeta/setLocalMeta` 的 IDB store、IDB 配置存储和 OPFS 文件仓后接入；在此之前网页版设置页显示“待开放”。
