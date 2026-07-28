# AI 面试反馈图片

页面会自动扫描本目录下的分类文件夹。新增已有类别的表情包时，只需把图片放进对应文件夹，不需要修改代码或重新训练模型。

支持 `.png`、`.jpg`、`.jpeg`、`.webp`、`.gif`；文件名可以任意填写。根目录里的图片不会参与识别。

## 分类目录

- `ready`：未开启镜头
- `calibrating`：正在校准
- `focused`：姿态优秀
- `steady`：姿态稳定
- `straighten`：需要坐直
- `center`：需要回到画面中央
- `missing`：未检测到人物
- `smiling`：微笑
- `laughing`：大笑
- `surprised`：惊讶
- `pouting`：噘嘴
- `tense`：表情紧绷
- `victory`：比耶
- `thumbs-up`：点赞
- `thumbs-down`：拇指向下
- `open-palm`：张开手掌
- `pointing-up`：食指向上
- `love`：I Love You
- `closed-fist`：握拳

页面打开时会读取素材；页面保持打开期间，每 15 秒以及窗口重新获得焦点时会重新扫描。每次再次识别到同一类别，会轮换显示该目录中的下一张图片。

新增一种列表中不存在的动作仍需要扩展识别规则或采集关键点训练小型分类器，但不需要大语言模型。
