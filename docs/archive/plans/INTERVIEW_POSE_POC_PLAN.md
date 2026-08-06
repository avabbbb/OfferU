# 面试姿态 PoC 实施方案（修正版）

> 落盘日期：2026-07-01
> 状态：待执行（已通过用户 Decision Gate，等待 PoC 实现）
> 关联文件：`frontend/src/app/interview/page.tsx`（当前为空壳）

## 1. Reality Sync（参考对齐修正）

### 1.1 之前的错误假设

`docs/ALIGNMENT_2026.md` 与项目记忆里写的 "参考 `torinmb/mediapipe-TouchDesigner`，移植其 JS 层 PSI 评分逻辑" —— **是错的**。

实证查证（2026-07-01）：
- `torinmb/mediapipe-touchdesigner` v0.5.2（2025-11-06）实际是把 MediaPipe 关键点经 WebSocket 推给 TouchDesigner 做可视化的 TouchDesigner 插件，**不含姿态评分业务逻辑**。搜索仓库全树与 README 均未出现 PSI/PostureScore/评分函数。
- 项目记忆里"移植其 PSI 评分逻辑"是把不存在的东西当既定路径，必须修正。

### 1.2 真实参考仓库（按可移植度排序）

| 仓库 | 时间 | 用途 | 可移植内容 |
|---|---|---|---|
| `zahra640/PosturePal` | 2024 | React + MediaPipe Pose 浏览器端姿态评分 | **5 因子加权评分公式（已公开权重）+ 5s 校准流程** |
| `shoali2023/posture-pilot` | 2024 | TypeScript 姿态评分器 | `postureMath.ts` 三因子几何 + EMA 平滑（α=0.35 关键点 / α=0.15 显示值）+ 阈值常量 |
| `DarkBytezz/PosturePlus` | 2026-03 | 纯浏览器 PSI 时序稳定性 | 时序窗口（不单帧阈值）+ 0–100 PSI 综合分模型，IEEE CSPA 2026 收录 |
| `wtbates99/batesposture` | 2024-12 | Python 桌面姿态评分 | 7 因子权重 `(0.2,0.2,0.15,0.15,0.15,0.1,0.05)` + 6s 校准 |
| `argsdio/imposture` | — | Python 最小姿态评分 | `score_from_deviation(dev, bad_threshold)` + `REF_WEIGHT=0.8 / ABS_WEIGHT=0.2` 混合评分 |
| `MisbahAN/PostureGuard-AI` | 2026 | MediaPipe Tasks Vision 纯 TS | CVA / TrunkFlexion / PelvicTilt 角度计算 + One-Euro 滤波 |

**最终选型**：以 PosturePal 的 5 因子作为评分骨架 + posture-pilot 的 EMA 平滑与几何常量 + imposture 的 `score_from_deviation` 工具函数 + BatesPosture 的校准思路。PosturePlus 的时序稳定性留作 v2 增强（PoC 阶段单帧评分已足够）。

### 1.3 MediaPipe Tasks Vision 当前 API（核对官方文档 2026-05-28）

```ts
import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";

const vision = await FilesetResolver.forVisionTasks(
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
);
const landmarker = await PoseLandmarker.createFromOptions(vision, {
  baseOptions: {
    modelAssetPath:
      "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
  },
  runningMode: "VIDEO",
  numPoses: 1,
  minPoseDetectionConfidence: 0.5,
  minPosePresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
});
// 每帧
const result = landmarker.detectForVideo(videoEl, performance.now());
// result.landmarks[0] = 33 个 {x,y,z,visibility*} 归一化坐标
```

- `pose_landmarker_full.task`（精度优先，~10MB 首次加载）
- `runningMode: "VIDEO"` + `detectForVideo` 适合摄像头流
- 官方建议放 Web Worker 避免阻塞主线程；PoC 阶段先跑在主线程，若 <25fps 再切 Worker

## 2. Project Brief

- **目标**：在 `/interview` 页接入浏览器端 MediaPipe PoseLandmarker，实时输出面试姿态综合分 0–100 + 5 项子分 + 校准 + 实时反馈条
- **PoC 范围**：
  - 摄像头授权 + 实时骨架叠加
  - 5s 校准（采集个人基线）
  - 60s 会话实时评分（综合分 + 5 子分 + 实时颜色反馈）
  - 会话结束总评（平均分 + 分段柱状）
- **不在 PoC 范围**（v2 再做）：
  - 语音分析（WPM / 音量 / 清晰度 / 停顿 / Whisper）
  - 眼神接触 / 眨眼（Face Mesh）
  - 手势分析 / 头手抖动轨迹
  - LLM 面试官 / AI Coach / 答题评估
  - PDF 报告导出
  - 时序稳定性（PosturePlus PSI）
  - 背景标签页 keep-alive
- **隐私**：所有处理本地浏览器内，无后端调用，无视频/图像上传

## 3. 评分公式（具体数学）

### 3.1 MediaPipe 关键点索引（BlazePose 33 点，截取上半身）

| 名称 | idx | 用途 |
|---|---|---|
| nose | 0 | 头部位置 |
| left_ear / right_ear | 7 / 8 | 头部水平 / 倾角 |
| left_shoulder / right_shoulder | 11 / 12 | 肩线 |
| left_hip / right_hip | 23 / 24 | 髋部（前倾参考） |

### 3.2 五个特征（归一化以肩宽为标尺，跨距无关）

设 `W = dist(left_shoulder, right_shoulder)` 作为归一化标尺。

1. **HeadDrop（头下垂）** = `(nose.y - shoulderMid.y) / W`
   - 校准时记 `calib.headDrop`；实时 `dev_headDrop = cur - calib`
   - 越大越糟（头越往下沉）

2. **ForwardLean（前倾）** = `(shoulderMid.y - hipMid.y) / W`
   - 校准时记 `calib.forwardLean`；实时 `dev_forwardLean = cur - calib`
   - 越小越糟（肩越靠近髋 = 越前倾塌肩）

3. **ShoulderTilt（肩线倾斜）** = `|left_shoulder.y - right_shoulder.y| / W`
   - 不需要校准（绝对量）
   - 越大越糟

4. **EarTilt（耳朵水平倾斜）** = `|left_ear.y - right_ear.y| / W`
   - 不需要校准
   - 越大越糟（头侧倾）

5. **LateralLean（侧向平移）** = `(nose.x - shoulderMid.x) / W`
   - 校准时记 `calib.lateralLean`；实时 `dev_lateralLean = |cur - calib|`
   - 越大越糟（头偏中线）

### 3.3 评分函数（抄 imposture 的 `score_from_deviation`）

```ts
// scoreFromDeviation(dev, badThreshold): 偏离 0 时满分 100，达到 badThreshold 时 0 分
function scoreFromDeviation(dev: number, badThreshold: number): number {
  const abs = Math.abs(dev);
  if (abs >= badThreshold) return 0;
  return Math.round(100 * (1 - abs / badThreshold));
}
```

每个因子的 `badThreshold`（参考 PosturePal/posture-pilot 阈值，单位 = 归一化比值）

| 因子 | badThreshold | 说明 |
|---|---|---|
| headDrop | 0.25 | 校准后偏差 |
| forwardLean | 0.30 | 校准后偏差 |
| shoulderTilt | 0.06 | posture-pilot 阈值，绝对量 |
| earTilt | 0.06 | 同 shoulderTilt |
| lateralLean | 0.15 | 校准后偏差 |

### 3.4 综合分（抄 PosturePal 权重）

```ts
const WEIGHTS = { headDrop: 0.35, forwardLean: 0.25, shoulderTilt: 0.15, earTilt: 0.15, lateralLean: 0.10 };
const total = 35 * s_headDrop/100 + 25 * s_forwardLean/100 + 15 * s_shoulderTilt/100 + 15 * s_earTilt/100 + 10 * s_lateralLean/100;
// 等价于：100 * Σ(weight_i * score_i/100) = Σ(weight_i * score_i)
```

→ 最终 0–100 分，60+ 绿 / 40–60 黄 / <40 红。

### 3.5 EMA 平滑（抄 posture-pilot）

- 关键点 EMA：α=0.35（balanced），平滑 `x,y,z,visibility` 每点
- 评分显示 EMA：α=0.15，平滑 5 个子分与综合分显示值
- 校准采集：60 帧（约 2 秒@30fps）取均值，写入 `calib`

## 4. 架构（PoC 阶段最简）

### 4.1 文件结构

```
frontend/src/app/interview/
├── page.tsx                 # 主页面：UI + 摄像头 + 评分面板
├── poseEngine.ts            # MediaPipe 初始化 + detectForVideo 循环
├── postureMath.ts           # 评分公式（5 因子 + scoreFromDeviation + 权重）
├── smoothing.ts             # LandmarkSmoother + ScalarSmoother (EMA)
└── components/
    ├── SkeletonOverlay.tsx  # Canvas 叠加骨架（绿/黄/红）
    └── ScorePanel.tsx       # 综合分 + 5 子分 + 校准按钮 + 会话统计
```

### 4.2 数据流

```
getUserMedia(video) 
  → requestAnimationFrame loop
  → landmarker.detectForVideo(video, ts)
  → LandmarkSmoother.apply(landmarks)         # α=0.35
  → postureMath(landmarks, calib?) → 5 偏差 + 5 子分 + 综合分
  → ScalarSmoother.apply(scores)              # α=0.15
  → setState({ scores, landmarks })
  → SkeletonOverlay 画骨架 + ScorePanel 更新
```

### 4.3 状态机

```
idle → requestingCamera → loadingModel → calibrating(5s) → live → stopped
                                                    ↓
                                              missed landmarks >2s 回退 loadingModel
```

### 4.4 后端

PoC **无后端调用**。所有计算在浏览器内完成。
v2 可能新增 `POST /api/interview/session` 落库会话记录（不在本 PoC）。

## 5. 验收标准

| # | 测试场景 | 预期 |
|---|---|---|
| 1 | 首次进入 /interview → 点开始 → 浏览器弹摄像头授权 → 允许 → 视频显示 | 1s 内进入 calibrating |
| 2 | 校准 5s 端坐 → 看到"基线已建立"提示 | calib 写入 5 因子基线 |
| 3 | 正常端坐 60s | 综合分 80+，骨架绿色 |
| 4 | 故意低头 10s | headDrop 子分 <40，综合分降到 50–65，骨架变黄 |
| 5 | 故意前倾塌肩 10s | forwardLean 子分 <40，综合分降到 50–65 |
| 6 | 故意歪肩/歪头 10s | shoulderTilt/earTilt 子分 <40，骨架红 |
| 7 | 会话结束 → 显示平均分 + 5 子分柱状 | 数据可读 |
| 8 | 移出摄像头 2s → 检测丢失自动暂停 → 回归自动恢复 | 不崩、不卡死 |
| 9 | 切换浏览器标签页 5s 再回来 | 主线程版本可选暂停；不要求 keep-alive（v2） |

## 6. 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| MediaPipe 模型首次加载 10MB | CDN 速度不可控 | 显示 loading 进度条；后续考虑本地 wasm 静态托管 |
| 低端机 full 模型掉帧 | PoC 不优化 | <25fps 自动 fallback lite 模型；后续切 Worker |
| 阈值不普适 | 不同体型的人 | 校准 + 5 因子都是相对基线偏差，缓解个体差异；后续可加调节滑杆 |
| MediaPipe 在 Tab 不可见时 rAF 暂停 | 后台不计数 | 接受；属 v2 范围 |
| MediaPipe 在 macOS 摄像头权限被收回 | 常见 silent failure | 监听 `landmarks.length === 0` 超过 2s 进入 error 状态，提示用户重新授权 |

## 7. 实施顺序（落盘后执行）

1. `frontend/package.json` 加依赖 `@mediapipe/tasks-vision`
2. 落 `postureMath.ts`（纯函数 + 单元自测）
3. 落 `smoothing.ts`（LandmarkSmoother / ScalarSmoother）
4. 落 `poseEngine.ts`（init / detect 循环 / cleanup）
5. 落 `components/SkeletonOverlay.tsx` + `ScorePanel.tsx`
6. 重写 `interview/page.tsx` 串联
7. 浏览器联调过 9 条验收

## 8. 不在本 PoC（v2 Roadmap 摘记）

- PosturePlus 的时序稳定性 PSI（窗口 N 帧，离 0 越近越稳）
- Face Mesh 眼神接触 + 眨眼 EAR
- Whisper 语音 WPM / fillers / pause ratio
- LLM AI Coach nudge（参考 ethanchiou/interviewPrepping）
- 会话历史 + PDF 报告（参考 RecruitReady）
- Web Worker 化 detect 循环
- 本地静态托管 wasm 与 .task 模型

## 9. 引用

- MediaPipe Tasks Vision 官方文档（Web Pose Landmarker）：https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js
- PoseLandmarker API：https://developers.google.com/edge/api/mediapipe/js/tasks-vision.poselandmarker
- PosturePlus：https://github.com/DarkBytezz/PosturePlus
- PosturePal (zahra640)：https://github.com/zahra640/PosturePal
- posture-pilot (shoali2023)：https://github.com/shoali2023/posture-pilot
- batesposture：https://github.com/wtbates99/batesposture
- imposture：https://github.com/argsdio/imposture
- PostureGuard-AI：https://github.com/MisbahAN/PostureGuard-AI